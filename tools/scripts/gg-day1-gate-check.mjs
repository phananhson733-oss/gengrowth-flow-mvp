#!/usr/bin/env node
// gg-day1-gate-check.mjs — GenGrowth MVP Day-1 18:00 binary 5/5 gate
//
// 用法:
//   node tools/scripts/gg-day1-gate-check.mjs \
//     [--manifest <path>] \
//     [--out <path>] \
//     [--skip-infra]
//
// 默认值:
//   --manifest  ~/.gg-cache/day1-manifest.json
//   --out       ~/.gg-cache/day1-gate-<YYYY-MM-DD>.md
//
// 退出码:
//   0  5/5 PASS → 主线 plan 起跑
//   1  n/5 FAIL → 切 §1B solo-fallback
//   2  fatal (manifest 不存在 / parse 错 / IO 错)
//
// spec 来源:
//   wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-day1-gate-check-tool-spec-v1.md
//
// 设计:
//   - 纯 Node 内置（fs/crypto/path/url/os/fetch）
//   - 不调任何 LLM API / 不动 git / 不动 manifest
//   - infrastructure cross-check（Sheets/GSC）→ 报告 §C，不阻断 5/5 binary
//   - secret redact: 所有 console.error + 报告写入前过一遍

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// Shared helpers — single source of truth (codex review 2026-05-21).
// `loadEnv`, `getAccessToken`, `redact`, `parseIsoTimestamp`, `parseIsoDate` are re-exported
// so existing test imports (and gg-gate-check.mjs's direct re-imports) keep working.
import {
  loadEnv,
  getAccessToken,
  gFetch,
  redact,
  parseIsoTimestamp,
  parseIsoDate,
} from './lib/gg-shared.mjs';

export { loadEnv, getAccessToken, redact, parseIsoTimestamp, parseIsoDate };

// ============================================================
// manifest loader
// ============================================================

export function loadManifest(path) {
  if (!existsSync(path)) {
    const err = new Error(`manifest not found: ${path}`);
    err.code = 'MANIFEST_MISSING';
    throw err;
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    const err = new Error(`manifest read failed: ${e.message}`);
    err.code = 'MANIFEST_IO';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error(`manifest JSON parse failed: ${e.message}`);
    err.code = 'MANIFEST_PARSE';
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('manifest must be a JSON object');
    err.code = 'MANIFEST_SHAPE';
    throw err;
  }
  return parsed;
}

// ============================================================
// helpers: tool-local validators
// ============================================================

export function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ============================================================
// 5 binary checks (exported for tests)
// ============================================================

const NOW_PROVIDER = { now: () => new Date() };

export function setNowProvider(fn) {
  NOW_PROVIDER.now = fn;
}

// Check 1 — Ops 合同已签
export function checkOpsContractSigned(manifest) {
  const field = 'ops_contract_signed_at';
  const v = manifest[field];
  if (v == null || v === '') {
    return { pass: false, name: 'Ops contract signed', field, evidence: `missing field: ${field}`, line_ref: 'plan §1.4 L165' };
  }
  const ts = parseIsoTimestamp(v);
  if (!ts) {
    return { pass: false, name: 'Ops contract signed', field, evidence: `not a valid ISO timestamp: ${redact(String(v))}`, line_ref: 'plan §1.4 L165' };
  }
  if (ts.getTime() > NOW_PROVIDER.now().getTime()) {
    return { pass: false, name: 'Ops contract signed', field, evidence: `timestamp in the future: ${v}`, line_ref: 'plan §1.4 L165' };
  }
  return { pass: true, name: 'Ops contract signed', field, evidence: String(v), line_ref: 'plan §1.4 L165' };
}

// Check 2 — Ops 已读 PRD §19 + plan §6/§11
export function checkOpsReadPrd(manifest) {
  const field = 'ops_read_prd_sec19_at';
  // accept legacy field name from spec example
  const v = manifest[field] != null ? manifest[field] : manifest.ops_prd_read_at;
  const usedField = manifest[field] != null ? field : 'ops_prd_read_at';
  if (v == null || v === '') {
    return { pass: false, name: 'Ops read PRD §19 + plan §6/§11', field, evidence: `missing field: ${field} (or legacy ops_prd_read_at)`, line_ref: 'plan §1.4 L166' };
  }
  const ts = parseIsoTimestamp(v);
  if (!ts) {
    return { pass: false, name: 'Ops read PRD §19 + plan §6/§11', field: usedField, evidence: `not a valid ISO timestamp: ${redact(String(v))}`, line_ref: 'plan §1.4 L166' };
  }
  if (ts.getTime() > NOW_PROVIDER.now().getTime()) {
    return { pass: false, name: 'Ops read PRD §19 + plan §6/§11', field: usedField, evidence: `timestamp in the future: ${v}`, line_ref: 'plan §1.4 L166' };
  }
  return { pass: true, name: 'Ops read PRD §19 + plan §6/§11', field: usedField, evidence: String(v), line_ref: 'plan §1.4 L166' };
}

// Check 3 — Ops Week-2 起跑日期
export function checkOpsWeek2StartDate(manifest) {
  const field = 'ops_week2_start_date';
  const v = manifest[field];
  if (v == null || v === '') {
    return { pass: false, name: 'Ops Week-2 start date', field, evidence: `missing field: ${field}`, line_ref: 'plan §1.4 L167' };
  }
  const d = parseIsoDate(v);
  if (!d) {
    return { pass: false, name: 'Ops Week-2 start date', field, evidence: `not a valid YYYY-MM-DD: ${redact(String(v))}`, line_ref: 'plan §1.4 L167' };
  }
  return { pass: true, name: 'Ops Week-2 start date', field, evidence: String(v), line_ref: 'plan §1.4 L167' };
}

// Check 4 — Ops backup person ≥1
export function checkOpsBackupPerson(manifest) {
  // accept either `ops_backup_person` (singular non-empty string)
  // or `ops_backup_persons` (non-empty array of non-empty strings)
  const singular = manifest.ops_backup_person;
  const plural = manifest.ops_backup_persons;

  if (isNonEmptyString(singular)) {
    return { pass: true, name: 'Ops backup person ≥1', field: 'ops_backup_person', evidence: String(singular), line_ref: 'plan §1.4 L168' };
  }
  if (Array.isArray(plural) && plural.length > 0) {
    const valid = plural.filter((p) => isNonEmptyString(p));
    if (valid.length > 0) {
      return { pass: true, name: 'Ops backup person ≥1', field: 'ops_backup_persons', evidence: `${valid.length} person(s): ${valid[0]}${valid.length > 1 ? ` + ${valid.length - 1} more` : ''}`, line_ref: 'plan §1.4 L168' };
    }
    return { pass: false, name: 'Ops backup person ≥1', field: 'ops_backup_persons', evidence: 'array contains no non-empty strings', line_ref: 'plan §1.4 L168' };
  }
  return { pass: false, name: 'Ops backup person ≥1', field: 'ops_backup_person(s)', evidence: 'missing field: ops_backup_person (string) or ops_backup_persons (array)', line_ref: 'plan §1.4 L168' };
}

// Check 5 — Lynne Day 30/60 kill sign-off
//   (a) lynne_kill_commit_archived_at is valid ISO timestamp ≤ now
//   (b) lynne_kill_commit_evidence_path file exists + size > 0
export function checkLynneSignoff(manifest, opts = {}) {
  const tsField = 'lynne_kill_commit_archived_at';
  const pathField = 'lynne_kill_commit_evidence_path';
  const baseDir = opts.baseDir || process.cwd();

  const tsValue = manifest[tsField];
  const pathValue = manifest[pathField];

  if (tsValue == null || tsValue === '') {
    return { pass: false, name: 'Lynne sign-off', field: tsField, evidence: `missing field: ${tsField}`, line_ref: 'plan §1.4 L170' };
  }
  const ts = parseIsoTimestamp(tsValue);
  if (!ts) {
    return { pass: false, name: 'Lynne sign-off', field: tsField, evidence: `not a valid ISO timestamp: ${redact(String(tsValue))}`, line_ref: 'plan §1.4 L170' };
  }
  if (ts.getTime() > NOW_PROVIDER.now().getTime()) {
    return { pass: false, name: 'Lynne sign-off', field: tsField, evidence: `timestamp in the future: ${tsValue}`, line_ref: 'plan §1.4 L170' };
  }

  if (!isNonEmptyString(pathValue)) {
    return { pass: false, name: 'Lynne sign-off', field: pathField, evidence: `missing field: ${pathField}`, line_ref: 'plan §1.4 L170' };
  }
  const resolvedPath = pathValue.startsWith('/')
    ? pathValue
    : pathValue.startsWith('~')
      ? join(homedir(), pathValue.slice(1).replace(/^\/?/, ''))
      : join(baseDir, pathValue);

  if (!existsSync(resolvedPath)) {
    return { pass: false, name: 'Lynne sign-off', field: pathField, evidence: `evidence file not found: ${resolvedPath}`, line_ref: 'plan §1.4 L170' };
  }
  let stat;
  try {
    stat = statSync(resolvedPath);
  } catch (e) {
    return { pass: false, name: 'Lynne sign-off', field: pathField, evidence: `stat failed: ${e.message}`, line_ref: 'plan §1.4 L170' };
  }
  if (!stat.isFile()) {
    return { pass: false, name: 'Lynne sign-off', field: pathField, evidence: `evidence path is not a regular file: ${resolvedPath}`, line_ref: 'plan §1.4 L170' };
  }
  if (stat.size <= 0) {
    return { pass: false, name: 'Lynne sign-off', field: pathField, evidence: `evidence file is empty (size=0): ${resolvedPath}`, line_ref: 'plan §1.4 L170' };
  }

  return { pass: true, name: 'Lynne sign-off', field: `${tsField}+${pathField}`, evidence: `archived_at=${tsValue}, evidence=${resolvedPath} (size=${stat.size})`, line_ref: 'plan §1.4 L170' };
}

// ============================================================
// run all 5 checks (exported for tests)
// ============================================================

export function runAllChecks(manifest, opts = {}) {
  const results = [
    checkOpsContractSigned(manifest),
    checkOpsReadPrd(manifest),
    checkOpsWeek2StartDate(manifest),
    checkOpsBackupPerson(manifest),
    checkLynneSignoff(manifest, opts),
  ];
  const passed = results.filter((r) => r.pass).length;
  return { results, passed, total: results.length };
}

// ============================================================
// infrastructure cross-check (Sheets / GSC) — non-blocking
// ============================================================

async function checkSheetsReachable() {
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    return { ok: false, name: 'Sheets reader', detail: 'GG_SHEETS_WORKBOOK_ID unset' };
  }
  const readerSa =
    process.env.GG_READER_SA_JSON ||
    join(homedir(), '.config', 'gg', 'gg-reader-sa.json');
  try {
    const { token } = await getAccessToken(readerSa, [
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    ]);
    const body = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`,
      token,
    );
    return { ok: true, name: 'Sheets reader', detail: `workbook title="${body.properties?.title || '?'}"` };
  } catch (e) {
    return { ok: false, name: 'Sheets reader', detail: redact(e.message) };
  }
}

async function checkGscReachable() {
  const site = process.env.GG_GSC_SITE;
  if (!site) {
    return { ok: false, name: 'GSC reader', detail: 'GG_GSC_SITE unset' };
  }
  const readerSa =
    process.env.GG_READER_SA_JSON ||
    join(homedir(), '.config', 'gg', 'gg-reader-sa.json');
  try {
    const { token } = await getAccessToken(readerSa, [
      'https://www.googleapis.com/auth/webmasters.readonly',
    ]);
    const today = new Date();
    const end = today.toISOString().slice(0, 10);
    const startDate = new Date(today.getTime() - 7 * 86400 * 1000)
      .toISOString()
      .slice(0, 10);
    const body = await gFetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startDate, endDate: end, dimensions: ['date'], rowLimit: 7 }),
      },
    );
    return { ok: true, name: 'GSC reader', detail: `${startDate}..${end}, rows=${body.rows?.length ?? 0}` };
  } catch (e) {
    return { ok: false, name: 'GSC reader', detail: redact(e.message) };
  }
}

// ============================================================
// report renderers
// ============================================================

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function defaultOutPath() {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `day1-gate-${todayStamp()}.md`);
}

function renderConsole(summary) {
  const { results, passed, total } = summary;
  const lines = [];
  lines.push(`[gg-day1-gate-check] ${nowIso()}`);
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.pass ? 'PASS' : 'FAIL';
    const pad = r.name.padEnd(34, ' ');
    const evidence = redact(r.evidence || '');
    lines.push(`Check ${i + 1} ${pad} ........ ${status}  (${evidence})`);
  }
  lines.push('─────────────────────────────────────────────');
  if (passed === total) {
    lines.push(`RESULT: ${passed}/${total} PASS → 主线 plan 起跑`);
  } else {
    const failedIdxs = results
      .map((r, i) => (r.pass ? null : `${i + 1} (${r.name})`))
      .filter(Boolean)
      .join(', ');
    lines.push(`RESULT: ${passed}/${total} FAIL → 立刻 switch to §1B solo-fallback`);
    lines.push(`Failed checks: ${failedIdxs}`);
    lines.push('Action: 参考 plan §1B.1 / §1B.2 / §1B.3');
  }
  return lines.join('\n');
}

function renderMarkdown({ summary, manifestPath, infra }) {
  const { results, passed, total } = summary;
  const stamp = todayStamp();
  const lines = [];
  lines.push(`# Day-1 Binary Gate Report — ${stamp}`);
  lines.push('');
  lines.push('## §A 主 binary 结论');
  if (passed === total) {
    lines.push(`- **RESULT**: ${passed}/${total} PASS （主线）`);
  } else {
    lines.push(`- **RESULT**: ${passed}/${total} FAIL → §1B solo-fallback`);
  }
  lines.push(`- **生成时间**: ${nowIso()}`);
  lines.push(`- **manifest 路径**: ${manifestPath}`);
  lines.push('');
  lines.push('## §B 5 项 binary 明细');
  lines.push('| # | check | status | evidence | line ref |');
  lines.push('|---|-------|--------|----------|----------|');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const status = r.pass ? 'PASS' : 'FAIL';
    const evidence = redact(r.evidence || '').replace(/\|/g, '\\|');
    lines.push(`| ${i + 1} | ${r.name} | ${status} | ${evidence} | ${r.line_ref} |`);
  }
  lines.push('');
  lines.push('## §C 环境就绪（提示，不阻断主 binary）');
  if (!infra) {
    lines.push('- (infrastructure cross-check skipped via --skip-infra)');
  } else {
    for (const item of infra) {
      const mark = item.ok ? 'ready' : 'not-ready';
      lines.push(`- ${item.name}: ${mark} — ${item.detail}`);
    }
  }
  lines.push('');
  lines.push('## §D wzb 行动建议');
  if (passed === total) {
    lines.push('- 5/5 PASS → 按 plan §2 Week-1 起跑（standard-setting 8h + Claude spike）');
  } else {
    lines.push('- n/5 FAIL → 切 §1B（plan §1B.2 6 周里程碑）；**不要"明天再补"**');
    lines.push('- 决策权在 wzb（plan §1.4 v1.1.2 已锁，工具不自动切换）');
  }
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const out = {
    manifest: null,
    out: null,
    skipInfra: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') out.manifest = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--skip-infra') out.skipInfra = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-day1-gate-check.mjs — Day-1 18:00 binary 5/5 gate

usage:
  node tools/scripts/gg-day1-gate-check.mjs \\
    [--manifest <path>] \\
    [--out <path>] \\
    [--skip-infra]

defaults:
  --manifest  ~/.gg-cache/day1-manifest.json
  --out       ~/.gg-cache/day1-gate-<YYYY-MM-DD>.md

exit codes:
  0  5/5 PASS  → 主线 plan 起跑
  1  n/5 FAIL  → 切 §1B solo-fallback
  2  fatal     (manifest 不存在 / parse 错 / IO 错)
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  loadEnv();

  const manifestPath =
    args.manifest || join(homedir(), '.gg-cache', 'day1-manifest.json');
  const outPath = args.out || defaultOutPath();

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    console.error(`fatal: ${redact(e.message)}`);
    console.error('hint: create the manifest at the path above with required fields. see spec §2.1.');
    process.exit(2);
  }

  // 5 binary checks
  const summary = runAllChecks(manifest);

  // infrastructure cross-check (non-blocking)
  let infra = null;
  if (!args.skipInfra) {
    const [sheets, gsc] = await Promise.all([
      checkSheetsReachable(),
      checkGscReachable(),
    ]);
    infra = [sheets, gsc];
  }

  // console output
  console.log(renderConsole(summary));
  console.log('');

  // markdown report
  const md = renderMarkdown({ summary, manifestPath, infra });
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
  process.argv[1]?.endsWith('gg-day1-gate-check.mjs');
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${redact(e && e.message ? e.message : e)}`);
    process.exit(2);
  });
}
