#!/usr/bin/env node
// gg-facts-audit.mjs — GenGrowth MVP W1 facts-audit binary diff tool
//
// 用途（RACI v1 §6 P0-1 W0 PM 1.5h ship）：
//   把 plan §2.4.2 "facts-audit.md 5 条预写断言" 改造为 automated diff binary，
//   每条断言 binary pass/fail；CRITICAL 任一 fail → 退出码 1 + wzb 必看。
//
// 用法：
//   node tools/scripts/gg-facts-audit.mjs [--config <path>] [--out <path>]
//                                          [--oracle-src <path>] [--dry-run]
//                                          [--skip-network]
//
// 默认值：
//   --config  ~/.gg-cache/facts-audit.yml  (不存在则自动写模板)
//   --out     ~/.gg-cache/facts-audit-<YYYY-MM-DD>.md
//   --oracle-src 探测 ~/oracle/src 与 ~/gengrowth/oracle/src（都不在 → 断言 #1/#2 graceful skip）
//
// 退出码：
//   0  全 pass（含 HIGH/INFO fail）
//   1  任一 CRITICAL fail
//   2  fatal（config IO / 网络协议错 / Sheets schema 完全无法解析等）
//
// 设计：
//   - 纯 Node 内置（fs/crypto/path/url/os/fetch），不引 npm
//   - oracle trackEvent 扫描用 regex（方案 B，MVP 够用，注释在报告中提示 dynamic event name 可能漏）
//   - Sheets reader SA: ~/.config/gg/gg-reader-sa.json
//   - GSC reader SA:    ~/.config/gg/gg-reader-sa.json
//   - 复用 gg-keyword-fallback.mjs 同款 redact / errorCode / loadEnv pattern
//   - PII blacklist 走 config YAML（首次跑自动建模板）
//   - runs 表 append: runs!A:G  [ts, tool, '', assertion_count, severity_summary_json, status, redacted_notes]
//
// spec 来源:
//   wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-落地plan-v1.1.md §2.4.2 L288-343
//   wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-facts-audit-tool-spec-v1.md

import {
  readFileSync,
  readdirSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';

// Shared helpers — single source of truth (codex review 2026-05-21).
// Re-export so existing test imports + downstream callers keep working.
import {
  loadEnv,
  getAccessToken,
  gFetch,
  redact,
  redactNote,
  errorCode,
} from './lib/gg-shared.mjs';

export { loadEnv, getAccessToken, gFetch, redact, errorCode };

// ============================================================
// constants
// ============================================================

export const EXPECTED_KEYWORD_HEADERS = Object.freeze([
  'run_id',
  'entity',
  'query',
  'source',
  'search_volume',
  'keyword_difficulty',
  'cpc',
  'serp_features',
  'geo_score',
  'ai_recommend',
  'wzb_approve',
]);

export const DEFAULT_PII_BLACKLIST = Object.freeze([
  'email',
  '@gmail.com',
  '@outlook.com',
  '@yahoo.com',
  'phone',
  'tel:',
  'ip:',
  'raw_gsc_query',
  'ssn',
  'passport',
]);

export const ORACLE_SRC_CANDIDATES = Object.freeze([
  join(homedir(), 'oracle', 'src'),
  join(homedir(), 'gengrowth', 'oracle', 'src'),
  join(homedir(), 'Code', 'oracle', 'src'),
  join(homedir(), 'Code', 'oracle'),
]);

// severity buckets
export const SEVERITY = Object.freeze({
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  INFO: 'INFO',
});

// ============================================================
// config: facts-audit.yml (minimal YAML reader)
// ============================================================

export const CONFIG_TEMPLATE = `# facts-audit config — generated 2026-05-21 by gg-facts-audit.mjs
# 修改后下次跑工具会读最新值；不要 commit 含 PRD 私字段的版本到 public repo。
#
# expected_events: PRD §3.1/§4.1 期望的 GA4 事件白名单（用于断言 #1, #5）
# 如果 PRD 没列具体事件名，wzb 自己写真理。空数组 → 断言 #1 退化为 INFO（只列 oracle 实际有什么）。

expected_events:
  - newsletter_submit_success
  - newsletter_submit_attempt
  - cta_click
  - article_view
  - signup_click

# pii_blacklist: 不允许出现在 GSC export / Sheets 中的 PII 关键词（用于断言 #4）
# 默认见 DEFAULT_PII_BLACKLIST in tool source
pii_blacklist:
  - email
  - "@gmail.com"
  - phone
  - "tel:"
  - "ip:"
  - raw_gsc_query
`;

export function parseSimpleYaml(text) {
  // 极简 YAML：仅支持
  //   key:
  //     - item
  //     - item
  // 和 key: value（行尾注释 #...）
  const out = {};
  const lines = text.split('\n');
  let currentKey = null;
  for (const rawLine of lines) {
    // strip trailing comment
    const line = rawLine.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    // list item
    const listM = line.match(/^\s*-\s+(.*)$/);
    if (listM && currentKey) {
      let val = listM[1].trim();
      // strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!Array.isArray(out[currentKey])) out[currentKey] = [];
      out[currentKey].push(val);
      continue;
    }
    // key: (block start)
    const keyOnlyM = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/);
    if (keyOnlyM) {
      currentKey = keyOnlyM[1];
      out[currentKey] = [];
      continue;
    }
    // key: value
    const kvM = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (kvM) {
      currentKey = null;
      let val = kvM[2].trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[kvM[1]] = val;
      continue;
    }
  }
  return out;
}

export function loadOrInitConfig(configPath) {
  if (!existsSync(configPath)) {
    const dir = dirname(configPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, CONFIG_TEMPLATE);
    return {
      created: true,
      config: parseSimpleYaml(CONFIG_TEMPLATE),
    };
  }
  const text = readFileSync(configPath, 'utf8');
  const parsed = parseSimpleYaml(text);
  // backfill defaults if user wiped fields
  if (!Array.isArray(parsed.expected_events)) parsed.expected_events = [];
  if (!Array.isArray(parsed.pii_blacklist) || parsed.pii_blacklist.length === 0) {
    parsed.pii_blacklist = [...DEFAULT_PII_BLACKLIST];
  }
  return { created: false, config: parsed };
}

// ============================================================
// oracle trackEvent scan (regex — see ship report 决策理由)
// ============================================================

const ORACLE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx']);

// matches trackEvent('foo') / trackEvent("foo") / trackEvent(`foo`)
// captures the event name; ignores dynamic forms (trackEvent(eventName))
const TRACK_EVENT_RE = /\btrackEvent\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_.-]{0,80})['"`]/g;

// detect "probably dynamic" calls so we can warn in report
const TRACK_EVENT_DYNAMIC_RE = /\btrackEvent\s*\(\s*[A-Za-z_$][A-Za-z0-9_$.[\]]*\s*[,)]/g;

export function scanTrackEventsInSource(text) {
  const events = new Set();
  let m;
  TRACK_EVENT_RE.lastIndex = 0;
  while ((m = TRACK_EVENT_RE.exec(text)) != null) {
    events.add(m[1]);
  }
  // dynamic detection — exclude calls already matched as string literals.
  // The dynamic regex's char class [A-Za-z_$]... cannot start with a quote,
  // so it inherently rejects trackEvent('foo'). We additionally double-check
  // by examining the matched substring itself (NOT a larger window) to ensure
  // we don't double-count a subsequent call in the same line.
  const dynamicHits = [];
  TRACK_EVENT_DYNAMIC_RE.lastIndex = 0;
  while ((m = TRACK_EVENT_DYNAMIC_RE.exec(text)) != null) {
    const matched = m[0];
    // If the matched substring itself contains a quote between trackEvent( and the
    // identifier, treat as accidental (shouldn't happen given char class, but belt-and-suspenders).
    if (/trackEvent\s*\(\s*['"`]/.test(matched)) continue;
    dynamicHits.push(matched.replace(/\s+/g, ' ').trim().slice(0, 60));
  }
  return { events: [...events], dynamicHits };
}

export function scanOracleDir(rootDir, opts = {}) {
  const maxFiles = opts.maxFiles || 5000;
  const skipDirs = new Set(opts.skipDirs || ['node_modules', '.next', 'dist', 'build', '.git']);
  if (!existsSync(rootDir)) {
    return { ok: false, reason: `oracle dir not found: ${rootDir}`, events: [], dynamicHits: [], filesScanned: 0 };
  }
  let filesScanned = 0;
  const allEvents = new Set();
  const dynamicHits = [];
  const stack = [rootDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const p = join(cur, ent.name);
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        stack.push(p);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!ORACLE_EXTS.has(extname(ent.name))) continue;
      filesScanned++;
      if (filesScanned > maxFiles) {
        return { ok: true, reason: `truncated at ${maxFiles} files`, events: [...allEvents], dynamicHits, filesScanned };
      }
      let text;
      try {
        const st = statSync(p);
        if (st.size > 2 * 1024 * 1024) continue; // skip files >2MB
        text = readFileSync(p, 'utf8');
      } catch {
        continue;
      }
      const scan = scanTrackEventsInSource(text);
      for (const e of scan.events) allEvents.add(e);
      for (const d of scan.dynamicHits) dynamicHits.push({ file: p, hit: d });
    }
  }
  return { ok: true, reason: null, events: [...allEvents], dynamicHits, filesScanned };
}

// ============================================================
// validateOracleSrc — realpath jail for --oracle-src (file-enumeration防护)
// ============================================================
//
// Without realpath + root jail, an attacker who can pass --oracle-src (e.g. through
// a wrapped invocation) could point the scanner at /etc, /var/log, or a symlinked
// path that escapes the intended root, leaking file existence + readability via the
// dynamicHits report. We resolve the input, then require it to live under one of
// the well-known oracle roots that actually exist on this machine.
//
// Permissive fallback: if NONE of the well-known roots exist (e.g. wzb hasn't
// installed oracle yet on a fresh laptop), allow any path but print a warning.
// This keeps experimentation cheap while still being safe in real deployments.

export function getAllowedOracleRoots() {
  const roots = [];
  for (const candidate of ORACLE_SRC_CANDIDATES) {
    try {
      if (existsSync(candidate)) {
        roots.push(realpathSync(candidate));
      }
    } catch {
      // ignore
    }
  }
  return roots;
}

export function validateOracleSrc(srcPath, { warn = (msg) => console.warn(msg) } = {}) {
  if (typeof srcPath !== 'string' || !srcPath) {
    throw new Error('oracle-src must be a non-empty string');
  }
  let real;
  try {
    real = realpathSync(srcPath);
  } catch {
    throw new Error(`oracle-src not found: ${srcPath}`);
  }
  const allowedRoots = getAllowedOracleRoots();
  if (allowedRoots.length === 0) {
    // No well-known oracle roots installed on this machine — let it through
    // with a loud warning so wzb can still experiment locally.
    warn(
      `[oracle-src] warning: no well-known oracle roots present on this machine; ` +
        `accepting ${real} without jail. install ~/oracle, ~/gengrowth/oracle, or ~/Code/oracle ` +
        `to enable strict jailing.`,
    );
    return real;
  }
  const allowed = allowedRoots.some((root) => real === root || real.startsWith(root + '/'));
  if (!allowed) {
    throw new Error(
      `oracle-src must be under one of: ${allowedRoots.join(', ')} (got: ${real})`,
    );
  }
  return real;
}

export function findOracleSrc(explicit) {
  if (explicit) {
    return existsSync(explicit) ? explicit : null;
  }
  for (const c of ORACLE_SRC_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ============================================================
// Sheets readers
// ============================================================

async function fetchSheetValues(token, workbookId, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}`;
  return gFetch(url, token);
}

export async function readCtaMapEvents(token, workbookId) {
  const body = await fetchSheetValues(token, workbookId, 'cta_map!E:E');
  const rows = body?.values || [];
  const events = new Set();
  // skip header row (row 0). Accept either "event" header or first row = data.
  for (let i = 0; i < rows.length; i++) {
    const cell = (rows[i]?.[0] || '').trim();
    if (!cell) continue;
    if (i === 0 && /^(event|event_name|ga4_event)$/i.test(cell)) continue;
    // tolerate values like "newsletter_submit_success" — must look like an identifier
    if (/^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/.test(cell)) {
      events.add(cell);
    }
  }
  return [...events];
}

export async function readKeywordSheetHeaders(token, workbookId) {
  const body = await fetchSheetValues(token, workbookId, 'keyword_candidates!1:1');
  const row = body?.values?.[0] || [];
  return row.map((h) => String(h || '').trim());
}

// ============================================================
// GSC reader (for assertions #4 #5)
// ============================================================

export async function fetchGscTopQueries(token, site, { days = 7, rowLimit = 25 } = {}) {
  const today = new Date();
  const endDate = today.toISOString().slice(0, 10);
  const startDate = new Date(today.getTime() - days * 86400 * 1000)
    .toISOString()
    .slice(0, 10);
  const body = await gFetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['query'], rowLimit }),
    },
  );
  const rows = body?.rows || [];
  return rows.map((r) => ({ query: r.keys?.[0] || '', clicks: r.clicks, impressions: r.impressions }));
}

// ============================================================
// 5 assertions
// ============================================================

// #1 oracle trackEvent vs PRD expected
export function assertOracleVsExpected({ oracleEvents, expectedEvents, oracleScanOk, oracleScanReason }) {
  const name = '#1 oracle trackEvent ⊇ PRD expected events';
  if (!oracleScanOk) {
    return {
      id: 1,
      name,
      severity: SEVERITY.INFO, // degrade to INFO when source missing
      pass: true,
      evidence: `oracle source not found — graceful skip (${oracleScanReason})`,
      details: { oracle_events_count: 0, expected_count: expectedEvents.length, missing: [] },
    };
  }
  if (!expectedEvents.length) {
    return {
      id: 1,
      name,
      severity: SEVERITY.INFO,
      pass: true,
      evidence: `no expected_events configured — informational only (oracle has ${oracleEvents.length} events)`,
      details: { oracle_events: oracleEvents.slice().sort(), missing: [] },
    };
  }
  const oracleSet = new Set(oracleEvents);
  const missing = expectedEvents.filter((e) => !oracleSet.has(e));
  if (missing.length === 0) {
    return {
      id: 1,
      name,
      severity: SEVERITY.CRITICAL,
      pass: true,
      evidence: `all ${expectedEvents.length} PRD-expected events present in oracle (${oracleEvents.length} total)`,
      details: { oracle_events_count: oracleEvents.length, missing: [] },
    };
  }
  return {
    id: 1,
    name,
    severity: SEVERITY.CRITICAL,
    pass: false,
    evidence: `${missing.length} expected events MISSING from oracle: ${missing.join(', ')}`,
    details: { oracle_events_count: oracleEvents.length, missing },
  };
}

// #2 cta_map ⊆ oracle trackEvent
export function assertCtaMapVsOracle({ ctaMapEvents, oracleEvents, oracleScanOk, ctaMapOk, ctaMapReason }) {
  const name = '#2 CTA Map events ⊆ oracle trackEvent';
  if (!oracleScanOk) {
    return {
      id: 2,
      name,
      severity: SEVERITY.INFO,
      pass: true,
      evidence: 'oracle source not found — cannot diff (graceful skip)',
      details: { cta_map_count: (ctaMapEvents || []).length },
    };
  }
  if (!ctaMapOk) {
    return {
      id: 2,
      name,
      severity: SEVERITY.CRITICAL,
      pass: false,
      evidence: `cta_map read failed: ${ctaMapReason}`,
      details: {},
    };
  }
  const oracleSet = new Set(oracleEvents);
  const orphan = (ctaMapEvents || []).filter((e) => !oracleSet.has(e));
  if (orphan.length === 0) {
    return {
      id: 2,
      name,
      severity: SEVERITY.CRITICAL,
      pass: true,
      evidence: `all ${ctaMapEvents.length} cta_map events implemented in oracle`,
      details: { cta_map_count: ctaMapEvents.length, orphan: [] },
    };
  }
  return {
    id: 2,
    name,
    severity: SEVERITY.CRITICAL,
    pass: false,
    evidence: `${orphan.length} cta_map events NOT in oracle: ${orphan.join(', ')}`,
    details: { cta_map_count: ctaMapEvents.length, orphan },
  };
}

// #3 keyword_candidates header schema
export function assertKeywordSchema({ actualHeaders, expectedHeaders, headersOk, headersReason }) {
  const name = '#3 keyword_candidates header schema (A-K 11 cols)';
  if (!headersOk) {
    return {
      id: 3,
      name,
      severity: SEVERITY.HIGH,
      pass: false,
      evidence: `header read failed: ${headersReason}`,
      details: {},
    };
  }
  const actual = actualHeaders || [];
  const sameLen = actual.length === expectedHeaders.length;
  const diffs = [];
  for (let i = 0; i < Math.max(actual.length, expectedHeaders.length); i++) {
    if (actual[i] !== expectedHeaders[i]) {
      diffs.push(`col ${String.fromCharCode(65 + i)}: expected="${expectedHeaders[i] || ''}" actual="${actual[i] || ''}"`);
    }
  }
  if (sameLen && diffs.length === 0) {
    return {
      id: 3,
      name,
      severity: SEVERITY.HIGH,
      pass: true,
      evidence: `11 columns match: ${expectedHeaders.join(', ')}`,
      details: { headers: actual },
    };
  }
  return {
    id: 3,
    name,
    severity: SEVERITY.HIGH,
    pass: false,
    evidence: `${diffs.length} column mismatch(es): ${diffs.slice(0, 3).join(' | ')}${diffs.length > 3 ? ' ...' : ''}`,
    details: { actual, expected: expectedHeaders, diffs },
  };
}

// #4 PII blacklist absent from GSC export
export function assertPiiAbsent({ gscQueries, piiBlacklist, gscOk, gscReason }) {
  const name = '#4 PII blacklist absent from GSC top queries';
  if (!gscOk) {
    return {
      id: 4,
      name,
      severity: SEVERITY.CRITICAL,
      pass: false,
      evidence: `GSC read failed: ${gscReason}`,
      details: {},
    };
  }
  if (!piiBlacklist.length) {
    return {
      id: 4,
      name,
      severity: SEVERITY.CRITICAL,
      pass: true,
      evidence: 'no pii_blacklist configured — vacuous pass (run with default config to enable)',
      details: {},
    };
  }
  const hits = [];
  for (const row of gscQueries) {
    const q = String(row.query || '').toLowerCase();
    for (const term of piiBlacklist) {
      if (!term) continue;
      if (q.includes(String(term).toLowerCase())) {
        hits.push({ query: q, term });
      }
    }
  }
  if (hits.length === 0) {
    return {
      id: 4,
      name,
      severity: SEVERITY.CRITICAL,
      pass: true,
      evidence: `0 PII hits in ${gscQueries.length} GSC queries (terms checked: ${piiBlacklist.length})`,
      details: { queries_scanned: gscQueries.length },
    };
  }
  return {
    id: 4,
    name,
    severity: SEVERITY.CRITICAL,
    pass: false,
    evidence: `${hits.length} PII hit(s); first: term="${hits[0].term}" in query="${hits[0].query.slice(0, 50)}"`,
    details: { hits: hits.slice(0, 10) },
  };
}

// #5 GSC observed events vs PRD expected (cold-start empty is OK)
export function assertGscObservedVsExpected({ gscQueries, expectedEvents, gscOk, gscReason }) {
  const name = '#5 GSC observed events vs PRD expected (INFO)';
  if (!gscOk) {
    return {
      id: 5,
      name,
      severity: SEVERITY.INFO,
      pass: true,
      evidence: `GSC unavailable — cold-start baseline assumed (${gscReason})`,
      details: {},
    };
  }
  // GSC searchAnalytics returns search queries, not GA4 events. This assertion is
  // primarily a baseline placeholder; on a cold-start site (<300 imp/30d) the row
  // count is 0 and we record that fact for trend tracking.
  if (gscQueries.length === 0) {
    return {
      id: 5,
      name,
      severity: SEVERITY.INFO,
      pass: true,
      evidence: 'cold-start: no observed events / queries in GSC (0 rows last 7d)',
      details: { observed_count: 0, expected_count: expectedEvents.length },
    };
  }
  return {
    id: 5,
    name,
    severity: SEVERITY.INFO,
    pass: true,
    evidence: `GSC returned ${gscQueries.length} top queries (informational only)`,
    details: { observed_count: gscQueries.length, expected_count: expectedEvents.length },
  };
}

// ============================================================
// orchestration
// ============================================================

export function summarize(assertions) {
  const sevCount = { CRITICAL: { pass: 0, fail: 0 }, HIGH: { pass: 0, fail: 0 }, INFO: { pass: 0, fail: 0 } };
  for (const a of assertions) {
    const bucket = sevCount[a.severity] || sevCount.INFO;
    if (a.pass) bucket.pass++;
    else bucket.fail++;
  }
  const anyCriticalFail = sevCount.CRITICAL.fail > 0;
  const anyHighFail = sevCount.HIGH.fail > 0;
  const status = anyCriticalFail ? 'fail' : anyHighFail ? 'partial' : 'ok';
  return { sevCount, anyCriticalFail, anyHighFail, status };
}

// ============================================================
// report rendering
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
  return join(dir, `facts-audit-${todayStamp()}.md`);
}

// JSON sidecar path lives next to the markdown report (same basename, .json ext).
// This is what /gg-gate-check vertical-slice reads (Fix 5).
export function sidecarPathFor(mdPath) {
  if (typeof mdPath !== 'string' || !mdPath) {
    throw new Error('sidecarPathFor: md path required');
  }
  if (mdPath.toLowerCase().endsWith('.md')) {
    return mdPath.slice(0, -3) + '.json';
  }
  return mdPath + '.json';
}

export function buildSidecar({ assertions, summary }) {
  const sevCount = summary.sevCount || { CRITICAL: { pass: 0, fail: 0 }, HIGH: { pass: 0, fail: 0 }, INFO: { pass: 0, fail: 0 } };
  return {
    ts: nowIso(),
    status: summary.status,
    critical_count: sevCount.CRITICAL.fail,
    high_count: sevCount.HIGH.fail,
    info_count: sevCount.INFO.fail,
    assertions: assertions.map((a) => ({
      id: a.id,
      name: a.name,
      severity: a.severity,
      status: a.pass ? 'pass' : 'fail',
      evidence_summary: redact(a.evidence || '').slice(0, 240),
    })),
  };
}

function renderConsole(assertions, summary) {
  const lines = [];
  lines.push(`[gg-facts-audit] ${nowIso()}`);
  for (const a of assertions) {
    const status = a.pass ? 'PASS' : 'FAIL';
    const tag = a.severity.padEnd(8);
    lines.push(`  ${tag} ${status}  ${a.name}`);
    lines.push(`           └─ ${redact(a.evidence)}`);
  }
  lines.push('─────────────────────────────────────────────');
  const { sevCount, status } = summary;
  lines.push(
    `RESULT: status=${status}  CRITICAL ${sevCount.CRITICAL.pass}/${sevCount.CRITICAL.pass + sevCount.CRITICAL.fail}  HIGH ${sevCount.HIGH.pass}/${sevCount.HIGH.pass + sevCount.HIGH.fail}  INFO ${sevCount.INFO.pass}/${sevCount.INFO.pass + sevCount.INFO.fail}`,
  );
  return lines.join('\n');
}

function renderMarkdown({ assertions, summary, configPath, oraclePath, dynamicHits, scanFilesCount }) {
  const stamp = todayStamp();
  const lines = [];
  lines.push(`# Facts Audit Report — ${stamp}`);
  lines.push('');
  lines.push('## §A 主结论（wzb 看这一节）');
  const { sevCount, anyCriticalFail, anyHighFail, status } = summary;
  if (anyCriticalFail) {
    lines.push(`- **RESULT**: FAIL — ${sevCount.CRITICAL.fail} CRITICAL 断言失败，**Week-2 工程 stop，先修**`);
  } else if (anyHighFail) {
    lines.push(`- **RESULT**: PARTIAL — 0 CRITICAL fail（可开工），但 ${sevCount.HIGH.fail} HIGH fail（Week-3 ship 前必修）`);
  } else {
    lines.push('- **RESULT**: PASS — 所有 CRITICAL/HIGH 断言通过');
  }
  lines.push(`- **生成时间**: ${nowIso()}`);
  lines.push(`- **config**: ${configPath}`);
  lines.push(`- **oracle src**: ${oraclePath || '(not found — assertions #1/#2 graceful skip)'}`);
  lines.push(`- **status**: ${status}`);
  lines.push('');
  lines.push('## §B 5 条断言明细');
  lines.push('| # | severity | status | name | evidence |');
  lines.push('|---|----------|--------|------|----------|');
  for (const a of assertions) {
    const ev = redact(a.evidence || '').replace(/\|/g, '\\|');
    lines.push(`| ${a.id} | ${a.severity} | ${a.pass ? 'PASS' : 'FAIL'} | ${a.name} | ${ev} |`);
  }
  lines.push('');
  lines.push('## §C oracle 扫描元数据');
  lines.push(`- 扫描文件数: ${scanFilesCount}`);
  lines.push(`- AST 方案: regex (gg-keyword-fallback 同型号；MVP 够用)`);
  lines.push(`- **已知盲区**: regex 无法解析 \`trackEvent(varName)\` 动态调用。共发现 ${dynamicHits.length} 处疑似动态调用，建议人工 review。`);
  if (dynamicHits.length > 0) {
    lines.push('');
    lines.push('### 疑似动态调用（前 10）');
    for (const h of dynamicHits.slice(0, 10)) {
      lines.push(`- \`${h.file}\` → \`${h.hit}\``);
    }
  }
  lines.push('');
  lines.push('## §D wzb 行动建议');
  if (anyCriticalFail) {
    lines.push('- **不要** ship `/gg-keyword-mine`（plan §2.4.2 L307 红线）');
    lines.push('- 看 §B 表 CRITICAL FAIL 行 → 修 oracle / cta_map / config 后重跑');
  } else if (anyHighFail) {
    lines.push('- Week-2 可开工，但 Week-3 ship 前必须修 HIGH 断言');
  } else {
    lines.push('- 可继续 Week-2 plan；INFO 断言只记账');
  }
  lines.push('');
  return lines.join('\n');
}

// ============================================================
// runs log append
// ============================================================

async function appendRunsLog({ token, workbookId, assertionCount, summary, notes, dryRun }) {
  if (dryRun) return { skipped: true, reason: 'dry-run' };
  if (!workbookId) return { skipped: true, reason: 'no workbook id' };
  if (!token) return { skipped: true, reason: 'no token' };
  const sevSummary = JSON.stringify({
    critical: summary.sevCount.CRITICAL,
    high: summary.sevCount.HIGH,
    info: summary.sevCount.INFO,
  });
  const row = [
    new Date().toISOString(),
    'facts-audit',
    '',
    assertionCount,
    sevSummary,
    summary.status,
    notes || '',
  ];
  try {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent('runs!A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: [row] }),
      },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: redactNote(e) };
  }
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const out = {
    config: null,
    out: null,
    oracleSrc: null,
    dryRun: false,
    skipNetwork: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') out.config = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--oracle-src') out.oracleSrc = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--skip-network') out.skipNetwork = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-facts-audit.mjs — automated 5-assertion facts diff

usage:
  node tools/scripts/gg-facts-audit.mjs \\
    [--config <path>] [--out <path>] [--oracle-src <path>] \\
    [--dry-run] [--skip-network]

defaults:
  --config       ~/.gg-cache/facts-audit.yml (auto-created template if missing)
  --out          ~/.gg-cache/facts-audit-<YYYY-MM-DD>.md
  --oracle-src   auto-detect (~/oracle/src, ~/gengrowth/oracle/src, ~/Code/oracle/src)

exit codes:
  0  全 pass（含 HIGH/INFO fail）
  1  任一 CRITICAL fail
  2  fatal（config IO / 网络协议错）

flags:
  --dry-run        不写 Sheets runs log
  --skip-network   跳过所有 Sheets/GSC 调用（offline ）
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const envPath = loadEnv();

  console.log('GenGrowth /gg-facts-audit');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`env file:   ${envPath || '(none — relying on shell env)'}`);
  console.log('');

  // ---- config ----
  const configPath = args.config || join(homedir(), '.gg-cache', 'facts-audit.yml');
  let configResult;
  try {
    configResult = loadOrInitConfig(configPath);
  } catch (e) {
    console.error(`fatal: config IO failed: ${redact(e.message)}`);
    process.exit(2);
  }
  const { config, created } = configResult;
  if (created) {
    console.log(`[config] created template at ${configPath} — edit before next run for tighter assertions`);
  }
  const expectedEvents = Array.isArray(config.expected_events) ? config.expected_events : [];
  const piiBlacklist = Array.isArray(config.pii_blacklist) && config.pii_blacklist.length
    ? config.pii_blacklist
    : [...DEFAULT_PII_BLACKLIST];

  // ---- oracle scan ----
  let oraclePath = null;
  if (args.oracleSrc) {
    // explicit user-supplied path → must pass realpath jail (rejects /etc/passwd etc)
    try {
      oraclePath = validateOracleSrc(args.oracleSrc);
    } catch (e) {
      console.error(`fatal: invalid --oracle-src: ${redact(e.message)}`);
      process.exit(2);
    }
  } else {
    oraclePath = findOracleSrc(null);
  }
  const oracleScan = oraclePath
    ? scanOracleDir(oraclePath)
    : { ok: false, reason: 'no oracle source dir found in candidates', events: [], dynamicHits: [], filesScanned: 0 };

  // ---- Sheets reads ----
  let token = null;
  let ctaMapEvents = [];
  let ctaMapOk = false;
  let ctaMapReason = null;
  let headers = [];
  let headersOk = false;
  let headersReason = null;
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  const readerSa =
    process.env.GG_READER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-reader-sa.json');

  if (!args.skipNetwork) {
    if (!workbookId) {
      ctaMapReason = 'GG_SHEETS_WORKBOOK_ID unset';
      headersReason = 'GG_SHEETS_WORKBOOK_ID unset';
    } else {
      try {
        const tk = await getAccessToken(readerSa, [
          'https://www.googleapis.com/auth/spreadsheets.readonly',
          'https://www.googleapis.com/auth/webmasters.readonly',
        ]);
        token = tk.token;
      } catch (e) {
        ctaMapReason = `auth failed: ${redactNote(e)}`;
        headersReason = ctaMapReason;
      }
      if (token) {
        try {
          ctaMapEvents = await readCtaMapEvents(token, workbookId);
          ctaMapOk = true;
        } catch (e) {
          ctaMapReason = redactNote(e);
        }
        try {
          headers = await readKeywordSheetHeaders(token, workbookId);
          headersOk = true;
        } catch (e) {
          headersReason = redactNote(e);
        }
      }
    }
  } else {
    ctaMapReason = 'skipped via --skip-network';
    headersReason = 'skipped via --skip-network';
  }

  // ---- GSC reads ----
  let gscQueries = [];
  let gscOk = false;
  let gscReason = null;
  const gscSite = process.env.GG_GSC_SITE;
  if (args.skipNetwork) {
    gscReason = 'skipped via --skip-network';
  } else if (!gscSite) {
    gscReason = 'GG_GSC_SITE unset';
  } else if (!token) {
    // try GSC-only token if Sheets failed
    try {
      const tk = await getAccessToken(readerSa, [
        'https://www.googleapis.com/auth/webmasters.readonly',
      ]);
      token = tk.token;
    } catch (e) {
      gscReason = `gsc auth failed: ${redactNote(e)}`;
    }
  }
  if (token && gscSite && !args.skipNetwork) {
    try {
      gscQueries = await fetchGscTopQueries(token, gscSite, { days: 7, rowLimit: 25 });
      gscOk = true;
    } catch (e) {
      gscReason = redactNote(e);
    }
  }

  // ---- run 5 assertions ----
  const a1 = assertOracleVsExpected({
    oracleEvents: oracleScan.events,
    expectedEvents,
    oracleScanOk: oracleScan.ok,
    oracleScanReason: oracleScan.reason,
  });
  const a2 = assertCtaMapVsOracle({
    ctaMapEvents,
    oracleEvents: oracleScan.events,
    oracleScanOk: oracleScan.ok,
    ctaMapOk,
    ctaMapReason,
  });
  const a3 = assertKeywordSchema({
    actualHeaders: headers,
    expectedHeaders: [...EXPECTED_KEYWORD_HEADERS],
    headersOk,
    headersReason,
  });
  const a4 = assertPiiAbsent({ gscQueries, piiBlacklist, gscOk, gscReason });
  const a5 = assertGscObservedVsExpected({ gscQueries, expectedEvents, gscOk, gscReason });

  const assertions = [a1, a2, a3, a4, a5];
  const summary = summarize(assertions);

  // ---- console ----
  console.log(renderConsole(assertions, summary));
  console.log('');

  // ---- markdown report ----
  const outPath = args.out || defaultOutPath();
  const md = renderMarkdown({
    assertions,
    summary,
    configPath,
    oraclePath,
    dynamicHits: oracleScan.dynamicHits || [],
    scanFilesCount: oracleScan.filesScanned || 0,
  });
  try {
    const dir = dirname(outPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, md);
    console.log(`Report: ${outPath}`);
  } catch (e) {
    console.error(`fatal: report write failed: ${redact(e.message)}`);
    process.exit(2);
  }

  // ---- JSON sidecar (consumed by /gg-gate-check vertical-slice — Fix 5) ----
  const sidecarPath = sidecarPathFor(outPath);
  try {
    const sidecar = buildSidecar({ assertions, summary });
    writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
    console.log(`Sidecar: ${sidecarPath}`);
  } catch (e) {
    // Sidecar write failure is non-fatal: the markdown report is the primary
    // artifact for humans, the sidecar is only consumed by automation.
    console.warn(`warn: sidecar write failed: ${redact(e.message)}`);
  }

  // ---- runs log append ----
  const notes = summary.anyCriticalFail
    ? `CRITICAL fails=${summary.sevCount.CRITICAL.fail}`
    : summary.anyHighFail
      ? `HIGH fails=${summary.sevCount.HIGH.fail}`
      : '';
  const runRes = await appendRunsLog({
    token,
    workbookId,
    assertionCount: assertions.length,
    summary,
    notes: redactNote(notes),
    dryRun: args.dryRun || args.skipNetwork,
  });
  if (runRes.skipped) {
    console.log(`[runs log] skipped (${runRes.reason})`);
  } else if (runRes.ok) {
    console.log('[runs log] appended 1 row to runs!A:G');
  } else {
    console.log(`[runs log] append failed: ${runRes.reason}`);
  }

  if (summary.anyCriticalFail) process.exit(1);
  process.exit(0);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-facts-audit.mjs');
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${redact(e && e.message ? e.message : e)}`);
    process.exit(2);
  });
}
