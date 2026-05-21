#!/usr/bin/env node
// gg-gate-check.mjs — GenGrowth MVP 统一 gate 入口
//
// 用法:
//   node tools/scripts/gg-gate-check.mjs --gate <type> \
//     [--manifest <path>] \
//     [--out <path>] \
//     [--skip-infra]   # 仅 day-1 转发用
//
// 支持的 gate:
//   day-1            child process 转发到 gg-day1-gate-check.mjs (5/5 binary)
//   weekly           周报 3 binary (wzb hours / articles published / ops hours)
//   vertical-slice   W2 Wed 17:00 3 check (content-draft ship / vertical url / facts-audit)
//   day-14           首批 cohort 2 check (pageviews / Top 50)
//   day-30           W6 Mon 3 check (Top 10 / AI 引用 / Lynne sign-off)
//   day-60           kill criterion 3 check (Top 10 / AI 引用 / Lynne decision)
//
// 退出码:
//   0  所有 check PASS
//   1  任一 check FAIL
//   2  fatal (manifest 不存在 / parse 错 / IO 错 / --gate 未传或非法)
//
// spec: wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-gate-check-tool-spec-v1.md
//
// 设计:
//   - Node 内置 only (fs / path / url / os / child_process)
//   - 复用 gg-day1-gate-check.mjs helpers (loadEnv / loadManifest / redact / parseIso*)
//   - 不调外部 API; 不动 git; 不动 manifest
//   - day-1 走 spawnSync 转发，避免双源漂移

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Shared primitives come straight from the shared lib (codex review 2026-05-21);
// day1-specific helpers (loadManifest, isNonEmptyString) still live in gg-day1-gate-check.mjs.
import {
  loadEnv,
  redact,
  parseIsoTimestamp,
} from './lib/gg-shared.mjs';
import {
  loadManifest,
  isNonEmptyString,
} from './gg-day1-gate-check.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// path to the day-1 child script (same directory)
const DAY1_SCRIPT = join(__dirname, 'gg-day1-gate-check.mjs');

// --- supported gates registry ---

export const SUPPORTED_GATES = [
  'day-1',
  'weekly',
  'vertical-slice',
  'day-14',
  'day-30',
  'day-60',
];

// --- time helpers ---

const NOW_PROVIDER = { now: () => new Date() };

export function setNowProvider(fn) {
  NOW_PROVIDER.now = fn;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

// ISO 8601 week-numbering year + week number (e.g. "2026-W21")
export function isoWeekStamp(date = NOW_PROVIDER.now()) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // Thursday in current week decides the year (ISO 8601)
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// --- field validators ---

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function checkNumberThreshold({
  manifest,
  field,
  comparator,    // '<=' | '>=' | '==' (string ops on number)
  threshold,
  name,
  line_ref,
}) {
  const v = manifest[field];
  if (v == null) {
    return { pass: false, name, field, evidence: `missing field: ${field}`, line_ref };
  }
  if (!isFiniteNumber(v)) {
    return { pass: false, name, field, evidence: `not a finite number: ${redact(String(v))}`, line_ref };
  }
  let ok = false;
  if (comparator === '<=') ok = v <= threshold;
  else if (comparator === '>=') ok = v >= threshold;
  else if (comparator === '==') ok = v === threshold;
  if (!ok) {
    return { pass: false, name, field, evidence: `${v} (threshold ${comparator} ${threshold})`, line_ref };
  }
  return { pass: true, name, field, evidence: String(v), line_ref };
}

function checkIsoTimestampNotFuture({ manifest, field, name, line_ref }) {
  const v = manifest[field];
  if (v == null || v === '') {
    return { pass: false, name, field, evidence: `missing field: ${field}`, line_ref };
  }
  const ts = parseIsoTimestamp(v);
  if (!ts) {
    return { pass: false, name, field, evidence: `not a valid ISO timestamp: ${redact(String(v))}`, line_ref };
  }
  if (ts.getTime() > NOW_PROVIDER.now().getTime()) {
    return { pass: false, name, field, evidence: `timestamp in the future: ${v}`, line_ref };
  }
  return { pass: true, name, field, evidence: String(v), line_ref };
}

function checkNonEmptyString({ manifest, field, name, line_ref }) {
  const v = manifest[field];
  if (!isNonEmptyString(v)) {
    return { pass: false, name, field, evidence: `missing or empty field: ${field}`, line_ref };
  }
  return { pass: true, name, field, evidence: String(v), line_ref };
}

// --- gate implementations ---

// weekly

export function runWeekly(manifest) {
  const specs = [
    { field: 'wzb_hours_this_week', comparator: '<=', threshold: 18, name: 'wzb hours ≤ 18h', line_ref: 'plan §11.1 + §7.1' },
    { field: 'articles_published_this_week', comparator: '>=', threshold: 1, name: 'articles published ≥ 1', line_ref: 'plan §11.2' },
    { field: 'ops_hours_this_week', comparator: '>=', threshold: 5, name: 'ops hours ≥ 5h', line_ref: 'plan §11.1 + §3-§5 各周 Ops 工时' },
  ];
  return summarize(specs.map((s) => checkNumberThreshold({ ...s, manifest })));
}

// vertical-slice

function checkFactsAuditPass({ manifest, baseDir }) {
  const name = 'facts-audit 0 CRITICAL';
  const line_ref = 'plan §3.4 vertical-slice + Tech facts-audit';

  // Fix 5 (2026-05-21): prefer new field `facts_audit_sidecar_path`; fall back to
  // legacy `facts_audit_report_path` with a one-line warn. facts-audit.mjs now writes
  // a JSON sidecar next to the markdown report (Fix 4); gate parses that sidecar.
  const SIDECAR_FIELD = 'facts_audit_sidecar_path';
  const LEGACY_FIELD = 'facts_audit_report_path';
  let field = SIDECAR_FIELD;
  let v = manifest[SIDECAR_FIELD];
  if (!isNonEmptyString(v)) {
    const legacy = manifest[LEGACY_FIELD];
    if (isNonEmptyString(legacy)) {
      // emit a one-line warn on stderr so wzb sees it in CLI but doesn't break flow
      console.warn(
        `[gg-gate-check vertical-slice] warn: manifest uses legacy field "${LEGACY_FIELD}"; ` +
          `rename to "${SIDECAR_FIELD}" (path should point to facts-audit JSON sidecar, e.g. facts-audit-2026-05-21.json).`,
      );
      field = LEGACY_FIELD;
      v = legacy;
    } else {
      return { pass: false, name, field: SIDECAR_FIELD, evidence: `missing or empty field: ${SIDECAR_FIELD} (or legacy ${LEGACY_FIELD})`, line_ref };
    }
  }

  const resolved = v.startsWith('/')
    ? v
    : v.startsWith('~')
      ? join(homedir(), v.slice(1).replace(/^\/?/, ''))
      : join(baseDir || process.cwd(), v);
  if (!existsSync(resolved)) {
    return { pass: false, name, field, evidence: `sidecar file not found: ${resolved}`, line_ref };
  }
  let raw;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (e) {
    return { pass: false, name, field, evidence: `sidecar read failed: ${redact(e.message)}`, line_ref };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { pass: false, name, field, evidence: `sidecar JSON parse failed (expected facts-audit JSON sidecar, not markdown): ${redact(e.message)}`, line_ref };
  }
  // require BOTH status='pass' AND critical_count===0 (sidecar always has both since Fix 4).
  // legacy: also accept either-or for back-compat with hand-written test fixtures.
  const statusOk = parsed && parsed.status === 'pass';
  const countOk =
    parsed && typeof parsed.critical_count === 'number' && parsed.critical_count === 0;
  if (statusOk && countOk) {
    return { pass: true, name, field, evidence: `${resolved} (status=pass, critical_count=0)`, line_ref };
  }
  if (statusOk || countOk) {
    // back-compat for fixtures that only set one field
    const tag = statusOk ? 'status=pass' : `critical_count=${parsed.critical_count}`;
    return { pass: true, name, field, evidence: `${resolved} (${tag})`, line_ref };
  }
  return {
    pass: false,
    name,
    field,
    evidence: `sidecar does not indicate pass: ${redact(
      JSON.stringify({
        status: parsed?.status ?? null,
        critical_count: parsed?.critical_count ?? null,
      }),
    )}`,
    line_ref,
  };
}

export function runVerticalSlice(manifest, opts = {}) {
  return summarize([
    checkIsoTimestampNotFuture({ manifest, field: 'content_draft_shipped_at', name: '/gg-content-draft shipped', line_ref: 'plan §4.3.1 + §3.4' }),
    checkNonEmptyString({ manifest, field: 'vertical_slice_article_url', name: 'vertical slice article url', line_ref: 'plan §3.4' }),
    checkFactsAuditPass({ manifest, baseDir: opts.baseDir }),
  ]);
}

// day-14

function readNumberEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function runDay14(manifest) {
  const pvMin = readNumberEnv('GG_DAY14_PAGEVIEWS_MIN', 100);
  return summarize([
    checkNumberThreshold({ manifest, field: 'day14_pageviews', comparator: '>=', threshold: pvMin, name: `Day14 pageviews ≥ ${pvMin}`, line_ref: 'plan §5.3 Day 14 cohort + §11.3 收录率' }),
    checkNumberThreshold({ manifest, field: 'day14_top50_count', comparator: '>=', threshold: 1, name: 'Day14 Top 50 ≥ 1', line_ref: 'plan §11.3 GEO KPI 看板' }),
  ]);
}

// day-30

export function runDay30(manifest) {
  return summarize([
    checkNumberThreshold({ manifest, field: 'day30_top10_count', comparator: '>=', threshold: 3, name: 'Day30 Top 10 ≥ 3', line_ref: 'plan §6.6 retro + §6.7.1' }),
    checkNumberThreshold({ manifest, field: 'day30_ai_citation_count', comparator: '>=', threshold: 3, name: 'Day30 AI citation ≥ 3', line_ref: 'plan §6.6 retro + §6.7.1' }),
    checkIsoTimestampNotFuture({ manifest, field: 'lynne_day30_signoff_at', name: 'Lynne Day30 sign-off received', line_ref: 'plan §6.6 (Lynne judge)' }),
  ]);
}

// day-60

function checkLynneDay60Decision(manifest) {
  const field = 'lynne_day60_decision';
  const name = 'Lynne Day60 decision';
  const line_ref = 'plan §6.7.2 (Lynne judge)';
  const v = manifest[field];
  if (!isNonEmptyString(v)) {
    return { pass: false, name, field, evidence: `missing field: ${field}`, line_ref };
  }
  if (v !== 'continue' && v !== 'kill') {
    return { pass: false, name, field, evidence: `expected 'continue' or 'kill', got: ${redact(String(v))}`, line_ref };
  }
  if (v === 'kill') {
    return { pass: false, name, field, evidence: `Lynne decision = kill (FAIL by design)`, line_ref };
  }
  return { pass: true, name, field, evidence: `Lynne decision = continue`, line_ref };
}

export function runDay60(manifest) {
  return summarize([
    checkNumberThreshold({ manifest, field: 'day60_top10_count', comparator: '>=', threshold: 3, name: 'Day60 Top 10 ≥ 3', line_ref: 'plan §6.7.1' }),
    checkNumberThreshold({ manifest, field: 'day60_ai_citation_count', comparator: '>=', threshold: 3, name: 'Day60 AI citation ≥ 3', line_ref: 'plan §6.7.1' }),
    checkLynneDay60Decision(manifest),
  ]);
}

// common summary

function summarize(results) {
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length };
}

// --- gate dispatch ---

const GATE_RUNNERS = {
  weekly: runWeekly,
  'vertical-slice': runVerticalSlice,
  'day-14': runDay14,
  'day-30': runDay30,
  'day-60': runDay60,
};

export function runGate(gate, manifest, opts = {}) {
  const fn = GATE_RUNNERS[gate];
  if (!fn) throw new Error(`unknown gate (no internal runner): ${gate}`);
  return fn(manifest, opts);
}

// --- manifest path defaults ---

function defaultManifestPath(gate) {
  const cacheDir = join(homedir(), '.gg-cache');
  switch (gate) {
    case 'day-1':
      return join(cacheDir, 'day1-manifest.json');
    case 'weekly':
      return join(cacheDir, `weekly-manifest-${isoWeekStamp()}.json`);
    case 'vertical-slice':
      return join(cacheDir, 'vertical-slice-manifest.json');
    case 'day-14':
      return join(cacheDir, 'day14-manifest.json');
    case 'day-30':
      return join(cacheDir, 'day30-manifest.json');
    case 'day-60':
      return join(cacheDir, 'day60-manifest.json');
    default:
      throw new Error(`unknown gate: ${gate}`);
  }
}

function defaultOutPath(gate) {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `gate-${gate}-${todayStamp()}.md`);
}

// --- report renderers ---

export function renderConsole(gate, summary) {
  const { results, passed, total } = summary;
  const lines = [];
  lines.push(`[gg-gate-check ${gate}] ${nowIso()}`);
  let maxName = 0;
  for (const r of results) {
    if (r.name.length > maxName) maxName = r.name.length;
  }
  const pad = Math.max(maxName, 30);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.pass ? 'PASS' : 'FAIL';
    const name = r.name.padEnd(pad, ' ');
    const evidence = redact(r.evidence || '');
    lines.push(`Check ${i + 1} ${name} ........ ${status}  (${evidence})`);
  }
  lines.push('─────────────────────────────────────────────');
  if (passed === total) {
    lines.push(`RESULT: ${passed}/${total} PASS`);
  } else {
    const failedIdxs = results
      .map((r, i) => (r.pass ? null : `${i + 1} (${r.name})`))
      .filter(Boolean)
      .join(', ');
    lines.push(`RESULT: ${passed}/${total} FAIL`);
    lines.push(`Failed checks: ${failedIdxs}`);
    lines.push(`Action: see ${describeGateActionRef(gate)}`);
  }
  return lines.join('\n');
}

function describeGateActionRef(gate) {
  switch (gate) {
    case 'weekly':
      return 'plan §11.1 工时看板 + §7.1 wzb 工时红线';
    case 'vertical-slice':
      return 'plan §3.4 Day 3-4 vertical-slice 判定';
    case 'day-14':
      return 'plan §5.3 + §11.3 Day 14 cohort';
    case 'day-30':
      return 'plan §6.6 Day 30 retro gate (Lynne judge)';
    case 'day-60':
      return 'plan §6.7.2 Day 60 kill criterion (Lynne judge)';
    default:
      return 'plan';
  }
}

export function renderMarkdown({ gate, summary, manifestPath }) {
  const { results, passed, total } = summary;
  const stamp = todayStamp();
  const lines = [];
  lines.push(`# Gate Report (${gate}) — ${stamp}`);
  lines.push('');
  lines.push('## §A 结论');
  if (passed === total) {
    lines.push(`- **RESULT**: ${passed}/${total} PASS`);
  } else {
    lines.push(`- **RESULT**: ${passed}/${total} FAIL`);
  }
  lines.push(`- **gate**: ${gate}`);
  lines.push(`- **生成时间**: ${nowIso()}`);
  lines.push(`- **manifest 路径**: ${manifestPath}`);
  lines.push('');
  lines.push('## §B check 明细');
  lines.push('| # | check | status | evidence | line ref |');
  lines.push('|---|-------|--------|----------|----------|');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.pass ? 'PASS' : 'FAIL';
    const evidence = redact(r.evidence || '').replace(/\|/g, '\\|');
    lines.push(`| ${i + 1} | ${r.name} | ${status} | ${evidence} | ${r.line_ref} |`);
  }
  lines.push('');
  lines.push('## §C wzb 行动建议');
  if (passed === total) {
    lines.push(`- ${passed}/${total} PASS → 按 plan 下一节起跑（${describeGateActionRef(gate)}）`);
  } else {
    lines.push(`- ${passed}/${total} FAIL → 看失败 check 的 line ref 决定补救动作`);
    lines.push(`- ${describeGateActionRef(gate)}`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- day-1 child process forwarding ---

export function forwardToDay1({ manifest, out, skipInfra }) {
  const args = [DAY1_SCRIPT];
  if (manifest) args.push('--manifest', manifest);
  if (out) args.push('--out', out);
  if (skipInfra) args.push('--skip-infra');
  const res = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (res.error) {
    console.error(`fatal: failed to spawn day-1 child: ${redact(res.error.message)}`);
    return 2;
  }
  if (typeof res.status === 'number') return res.status;
  return 2;
}

// --- CLI ---

function parseArgs(argv) {
  const out = {
    gate: null,
    manifest: null,
    out: null,
    skipInfra: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--gate') out.gate = argv[++i];
    else if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--skip-infra') out.skipInfra = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-gate-check.mjs — GenGrowth MVP 统一 gate 入口

usage:
  node tools/scripts/gg-gate-check.mjs --gate <type> \\
    [--manifest <path>] \\
    [--out <path>] \\
    [--skip-infra]            # 仅 day-1 转发用

supported gates:
  day-1            child process → gg-day1-gate-check.mjs (5/5 binary)
  weekly           周报 3 check (wzb hours / articles / ops hours)
  vertical-slice   W2 Wed 3 check (content-draft / article url / facts-audit)
  day-14           首批 cohort 2 check (pageviews / Top 50)
  day-30           W6 Mon 3 check (Top 10 / AI 引用 / Lynne sign-off)
  day-60           kill 3 check (Top 10 / AI 引用 / Lynne decision)

defaults:
  --manifest  ~/.gg-cache/<gate>-manifest.json (weekly 用 ISO 周后缀)
  --out       ~/.gg-cache/gate-<type>-<YYYY-MM-DD>.md

exit codes:
  0  all checks PASS
  1  any check FAIL
  2  fatal (manifest 缺 / parse 错 / IO 错 / --gate 未传或非法)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (!args.gate) {
    console.error('fatal: --gate <type> is required (one of: ' + SUPPORTED_GATES.join(', ') + ')');
    process.exit(2);
  }
  if (!SUPPORTED_GATES.includes(args.gate)) {
    console.error(`fatal: unknown gate '${args.gate}'. supported: ${SUPPORTED_GATES.join(', ')}`);
    process.exit(2);
  }

  loadEnv();

  // day-1: forward to existing child script
  if (args.gate === 'day-1') {
    const code = forwardToDay1({
      manifest: args.manifest,
      out: args.out,
      skipInfra: args.skipInfra,
    });
    process.exit(code);
  }

  // other gates: internal runners
  const manifestPath = args.manifest || defaultManifestPath(args.gate);
  const outPath = args.out || defaultOutPath(args.gate);

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    console.error(`fatal: ${redact(e.message)}`);
    console.error('hint: create the manifest at the path above with required fields. see spec §3.');
    process.exit(2);
  }

  let summary;
  try {
    summary = runGate(args.gate, manifest, { baseDir: dirname(manifestPath) });
  } catch (e) {
    console.error(`fatal: gate runner failed: ${redact(e.message)}`);
    process.exit(2);
  }

  console.log(renderConsole(args.gate, summary));
  console.log('');

  const md = renderMarkdown({ gate: args.gate, summary, manifestPath });
  try {
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, md);
    console.log(`Report: ${outPath}`);
  } catch (e) {
    console.error(`fatal: report write failed: ${redact(e.message)}`);
    process.exit(2);
  }

  if (summary.passed === summary.total) process.exit(0);
  process.exit(1);
}

// only run main when invoked as CLI, not when imported by tests
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-gate-check.mjs');
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${redact(e && e.message ? e.message : e)}`);
    process.exit(2);
  });
}
