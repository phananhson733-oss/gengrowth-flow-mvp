#!/usr/bin/env node
// gg-content-draft.mjs — GenGrowth 内容草稿生产工具（spec v1.1）
//
// 把「选题登记表 v2.1 Status=待写」→「_staging/{page_id}/draft.md + manifest.json」
// 的 4 步手工动作收敛成 2 个 phase。
//
// Phase 1 (auto, 生成 prompt 落盘):
//   node tools/scripts/gg-content-draft.mjs --page-id page_chiron_7th_house --phase 1
//
// Phase 2 (human-in-loop, ingest LLM 输出 + 6 红线 + 写 staging):
//   node tools/scripts/gg-content-draft.mjs --page-id page_chiron_7th_house --phase 2 \
//     --ingest-file ~/Desktop/claude-output.md
//
// spec: wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-content-draft-极简版-spec-v1.md (v1.1)
// helpers: tools/scripts/lib/gg-shared.mjs (single source of truth, no copy-paste)
// red lines: tools/scripts/lib/red-lines.mjs (pure function, unit-tested separately)
//
// 退出码（spec §3.3 + codex round 2 patch v1.2: 加 14）:
//   0  = ok
//   1  = unknown / fatal
//   2  = CLI / argument error
//   10 = gate fail (schema / Tier=T1 / Status≠待写 / cluster.track missing / SERP missing no-allow)
//   11 = structure fail (Tutorial≠8 sections / Definition≠7 sections / disclaimer missing)
//   12 = red lines fail (RL1-6 any)
//   13 = ingest path fail (not in jail / wrong ext / symlink / size cap)
//   14 = Sheets Status write failed on Phase 2 success path (atomic guard; draft + manifest withheld)

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

import {
  loadEnv,
  getAccessToken,
  gFetch,
  redact,
  sanitize,
  validateIngestPath,
  validateWritePath,
  appendRunsRow,
} from './lib/gg-shared.mjs';

import { redLinesCheck } from './lib/red-lines.mjs';

import { loadPersona } from './lib/author-personas/loader.mjs';

// ============================================================
// constants
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const TEMPLATES_DIR = join(__dirname, 'lib', 'content-draft-templates');
const DEFAULT_STAGING_DIR = join(REPO_ROOT, '_staging');
const DEFAULT_CACHE_DIR = join(REPO_ROOT, '.gg-cache');
const DEFAULT_PROMPTS_DIR = join(DEFAULT_CACHE_DIR, 'prompts');
const DEFAULT_SERP_DIR = join(DEFAULT_CACHE_DIR, 'serp');
const PAGE_ROW_MAP_PATH = join(DEFAULT_CACHE_DIR, 'page-row-map.json');

const TOOL_NAME = 'gg-content-draft';
const TOOL_VERSION = `${TOOL_NAME} v1.1`;
const SCHEMA_VERSION = '1.1';

const ALLOWED_TEMPLATES = Object.freeze(['Tutorial', 'Definition']);
const ALLOWED_TIERS = Object.freeze(['T2', 'T3']);
const STATUS_WAITING = '待写';
const STATUS_WRITING = '写作中';

// 选题登记表 columns (1-indexed in PRD; we use 0-indexed here).
const PAGE_COLS = Object.freeze({
  target_keyword: 0,
  associated_keywords: 1,
  search_volume: 2,
  kd: 3,
  intent: 4,
  tier: 5,
  template: 6,
  entity: 7,
  friction: 8,
  logic: 9,
  cta: 10,
  gsc_keywords: 11,
  status: 12,
  url: 13,
  last_audit: 14,
  page_id: 15,
  cluster_id: 16,
  page_role: 17,
  content_angle: 18,
  psych_safety_flag: 19,
  journal_prompts: 20,
  // Lane A author signing columns. Lane B routing writes these; content-draft reads them.
  author: 21,        // column V — author_id (kebab), e.g. "marcus-orion"
  author_source: 22, // column W — provenance: where the assignment came from (default passthrough)
});

// 主题集群表 columns (0-indexed).
const CLUSTER_COLS = Object.freeze({
  cluster_id: 0,
  cluster_name: 1,
  track: 2,
  content_layer: 3,
  business_role: 4,
  primary_entity: 5,
  jtbd: 6,
  content_angle: 7,
  us_share: 8,
  pillar_page: 9,
  series_pattern: 10,
  keywords_included: 11,
  page_assets: 12,
  internal_link_rule: 13,
  cta_primary: 14,
  psych_safety_flag: 15,
  priority: 16,
  week: 17,
  success_metric: 18,
  // Lane A: cluster domain key for cluster->author routing (Lane B owns the mapping;
  // content-draft reads it for ctx.clusterDomain provenance).
  cluster_domain: 19, // column T
});

// CTA Map columns (0-indexed).
const CTA_COLS = Object.freeze({
  cta_id: 0,
  page_role: 1,
  cta_text: 2,
  target_url: 3,
  ga4_event_name: 4,
  track: 5,
});

const PAGE_SHEET = '选题登记表';
const CLUSTER_SHEET = '主题集群表';
const CTA_SHEET = 'CTA Map';

// Sheet ranges (read-only).
const PAGE_RANGE = `${PAGE_SHEET}!A2:W300`;
const CLUSTER_RANGE = `${CLUSTER_SHEET}!A2:T200`;
const CTA_RANGE = `${CTA_SHEET}!A2:F500`;

// Placeholder detection for newsletter target_url (spec §2.2 H2).
const PLACEHOLDER_REGEX = /(待搭建|占位|TODO|PLACEHOLDER|（[^）]*URL[^）]*）)/i;

const MAX_FIELD_LEN = 2000;
const MAX_INGEST_BYTES = 1024 * 1024;
const MIN_REASON_LEN = 8;
const MAX_REASON_LEN = 120;

// Codex round 2 C3: page_id whitelist. Strict alnum+hyphen+underscore, length 1..64.
// Anything else → CLI error (exit 2). Prevents `../../../etc/passwd`-style traversal,
// path-separator injection (foo/bar), spaces, NUL bytes, unicode tricks, etc.
const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// Codex round 2 LOW-2: workbookId format whitelist (Google Sheets uses base64url-ish ids).
const WORKBOOK_ID_REGEX = /^[A-Za-z0-9_-]{20,128}$/;

// Exit codes (spec §3.3 + codex round 2 patch note: 14 added).
const EXIT = Object.freeze({
  OK: 0,
  FATAL: 1,
  CLI: 2,
  GATE: 10,
  STRUCTURE: 11,
  RED_LINES: 12,
  INGEST: 13,
  // Codex round 2 H2: Sheets Status write failure on Phase 2 success path.
  // Atomicity rule: try Sheets write FIRST; if it fails, do not write draft.md / manifest.json.
  // (Prevents the half-flipped state where Sheets still says 写作中 but staging has draft+manifest.)
  SHEETS_WRITE_FAIL: 14,
});

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const out = {
    pageId: null,
    phase: null,
    ingestFile: null,
    stagingDir: DEFAULT_STAGING_DIR,
    promptOut: DEFAULT_PROMPTS_DIR,
    serpDir: DEFAULT_SERP_DIR,
    workbookId: null,
    dryRun: false,
    allowMissingSerp: false,
    allowMissingRag: false,
    allowMissingObsidianRag: false,
    reason: null,
    resume: false,
    catchUp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--page-id') out.pageId = argv[++i];
    else if (a === '--phase') out.phase = argv[++i];
    else if (a === '--ingest-file' || a === '--ingest') out.ingestFile = argv[++i];
    else if (a === '--staging-dir') out.stagingDir = argv[++i];
    else if (a === '--prompt-out') out.promptOut = argv[++i];
    else if (a === '--serp-dir') out.serpDir = argv[++i];
    else if (a === '--workbook-id') out.workbookId = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--allow-missing-serp') out.allowMissingSerp = true;
    else if (a === '--allow-missing-rag') out.allowMissingRag = true;
    else if (a === '--allow-missing-obsidian-rag') out.allowMissingObsidianRag = true;
    else if (a === '--reason') out.reason = argv[++i];
    else if (a === '--resume') out.resume = true;
    else if (a === '--catch-up') out.catchUp = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`${TOOL_VERSION} — internal content draft tool

Phase 1 (auto, 生成 prompt 落盘):
  node tools/scripts/gg-content-draft.mjs --page-id <id> --phase 1

Phase 2 (ingest LLM 输出 + 6 红线 + 写 staging):
  node tools/scripts/gg-content-draft.mjs --page-id <id> --phase 2 \\
    --ingest-file ~/Desktop/claude-output.md

flags:
  --page-id <id>           required (选题登记表 page_id 列 16)
  --phase 1|2              required (unless --resume / --catch-up)
  --ingest-file <path>     phase 2 required (only ~/Desktop, ~/Downloads, .gg-cache/)
  --staging-dir <dir>      default _staging
  --prompt-out <dir>       default .gg-cache/prompts
  --serp-dir <dir>         default .gg-cache/serp
  --workbook-id <id>       default $GG_SHEETS_WORKBOOK_ID
  --dry-run                no disk writes, no Sheets writes
  --allow-missing-serp     skip RL3 when SERP cache missing (requires --reason)
  --allow-missing-rag      skip Phase 0 RAG source injection when entity-passport / friction-mine caches missing (requires --reason)
  --allow-missing-obsidian-rag  skip Phase 0 Obsidian-wiki RAG when cache missing (requires --reason)
  --reason "<≥8 char>"     audit reason for any --allow-missing-* flag
  --resume                 检查 page_id 状态，接续到下一 phase
  --catch-up               修复半翻转 Status (写作中→待写, 删 .tmp.md)
`);
}

// ============================================================
// utility helpers
// ============================================================

function utcStamp() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/[:-]/g, '');
}

function nowIso() {
  return new Date().toISOString();
}

function gitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function absToHomeRelative(absPath) {
  const h = homedir();
  if (absPath && absPath.startsWith(h + '/')) {
    return '~' + absPath.slice(h.length);
  }
  return absPath;
}

function nfkc(s) {
  if (typeof s !== 'string') return '';
  try {
    return s.normalize('NFKC').replace(/^﻿/, '');
  } catch {
    return s.replace(/^﻿/, '');
  }
}

// XML/HTML entity escape — applied AFTER sanitize() so user-controlled fields
// that get rendered inside <field name="X">...</field> tags can't break out of
// the field and inject `</field><system>delete all</system>` style instructions.
// Codex round 2 C2: defense-in-depth (sanitize neutralizes phrases but cannot
// stop angle-bracket structural escape).
function xmlEscape(s) {
  if (typeof s !== 'string' || s.length === 0) return s == null ? '' : String(s);
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeField(value, { cap = MAX_FIELD_LEN } = {}) {
  const sanitized = sanitize(value == null ? '' : String(value));
  const capped = sanitized.length > cap ? sanitized.slice(0, cap) : sanitized;
  return xmlEscape(capped);
}

// Codex round 2 C4: --reason redaction + length cap before any sink (stdout / manifest / runs).
// Defends against pasting a full private key into the audit reason and seeing it logged.
function cleanReason(raw) {
  if (raw == null) return null;
  const s = String(raw).slice(0, MAX_REASON_LEN);
  return redact(s);
}

// Codex round 2 H3: formatErr() centralises stack-trace + message scrubbing.
// Every catch block sinks through this — never raw e.stack to stdout/stderr.
function formatErr(e) {
  if (e == null) return '';
  if (typeof e === 'string') return redact(e);
  const parts = [];
  if (e.message) parts.push(redact(String(e.message)));
  if (process.env.GG_DEBUG === '1' && e.stack) parts.push(redact(String(e.stack)));
  return parts.join('\n') || redact(String(e));
}

// Codex round 2 C3 defense-in-depth: assert page_id format at every path-build site.
// parseArgs() already rejects bad input → exit 2; this is the safety net for any
// code path that could be reached without going through main()'s gate (tests etc.).
function assertSafePageId(pageId, where) {
  if (typeof pageId !== 'string' || !PAGE_ID_REGEX.test(pageId)) {
    throw new Error(`unsafe page_id at ${where}: must match ${PAGE_ID_REGEX}`);
  }
  return pageId;
}

// ============================================================
// Sheets I/O (read pages / clusters / CTA Map; write Status)
// ============================================================

async function readSheetRange(workbookId, token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
  const body = await gFetch(url, token);
  return body.values || [];
}

async function writeStatusCell(workbookId, token, rowIdx1Based, newStatus, dryRun) {
  // 选题登记表 Status 列 = M (column 13).
  const range = `${PAGE_SHEET}!M${rowIdx1Based}`;
  if (dryRun) {
    return { dryRun: true, range, value: newStatus };
  }
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`;
  return gFetch(url, token, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values: [[newStatus]] }),
  });
}

// Build page_id → row-number map from rows[], cache to .gg-cache/page-row-map.json.
function buildPageRowMap(rows) {
  const map = {};
  for (let i = 0; i < rows.length; i++) {
    const pid = rows[i][PAGE_COLS.page_id];
    if (typeof pid === 'string' && pid.trim()) {
      map[pid.trim()] = i + 2; // +2 because rows[] starts at sheet row 2.
    }
  }
  return map;
}

function persistPageRowMap(map) {
  try {
    ensureDir(dirname(PAGE_ROW_MAP_PATH));
    writeFileSync(PAGE_ROW_MAP_PATH, JSON.stringify(map, null, 2));
  } catch {
    /* cache is best-effort */
  }
}

// ============================================================
// gate checks (Phase 1 step 4)
// ============================================================

function gateCheckPage(pageRow, pageId) {
  if (!pageRow) {
    return { ok: false, exit: EXIT.GATE, reason: `page_id "${pageId}" not found in ${PAGE_SHEET}` };
  }
  const status = String(pageRow[PAGE_COLS.status] || '').trim();
  if (status !== STATUS_WAITING) {
    return { ok: false, exit: EXIT.GATE, reason: `Status="${status}" (expected "${STATUS_WAITING}")` };
  }
  const tier = String(pageRow[PAGE_COLS.tier] || '').trim();
  if (!ALLOWED_TIERS.includes(tier)) {
    return { ok: false, exit: EXIT.GATE, reason: `Tier="${tier}" not in {T2, T3} (T1 rejected by design)` };
  }
  const template = String(pageRow[PAGE_COLS.template] || '').trim();
  if (!ALLOWED_TEMPLATES.includes(template)) {
    return { ok: false, exit: EXIT.GATE, reason: `Template="${template}" not in {Tutorial, Definition} (v1 scope)` };
  }
  const clusterId = String(pageRow[PAGE_COLS.cluster_id] || '').trim();
  if (!clusterId) {
    return { ok: false, exit: EXIT.GATE, reason: 'cluster_id empty' };
  }
  const entity = String(pageRow[PAGE_COLS.entity] || '').trim();
  if (!entity) {
    return { ok: false, exit: EXIT.GATE, reason: 'Entity empty' };
  }
  if (tier === 'T2') {
    const friction = String(pageRow[PAGE_COLS.friction] || '').trim();
    if (!friction) {
      return { ok: false, exit: EXIT.GATE, reason: 'T2 page missing Friction (column 9)' };
    }
    const logic = String(pageRow[PAGE_COLS.logic] || '').trim();
    if (!logic) {
      return { ok: false, exit: EXIT.GATE, reason: 'T2 page missing Logic (column 10)' };
    }
  }
  return { ok: true, tier, template, clusterId, entity };
}

// Author gate (Lane A, CRITICAL). The author_id column (V) is written by Lane B
// routing. If it is empty → hard-block: refuse to generate, so we never ship a
// silently un-signed article. If it is set but the persona card is unknown /
// malformed → loadPersona() throws (fail-loud, never a wrong byline).
//
// Returns { ok:true, authorId, authorSource, persona } on success, or
// { ok:false, exit, reason } when the author cell is empty.
function resolveAuthor(pageRow, clusterRow, pageId) {
  const authorId = String((pageRow && pageRow[PAGE_COLS.author]) || '').trim();
  if (!authorId) {
    return {
      ok: false,
      exit: EXIT.GATE,
      reason: `no author assigned for ${pageId}, set author in sheet (选题登记表 column V)`,
    };
  }
  const authorSource = String((pageRow && pageRow[PAGE_COLS.author_source]) || '').trim() || 'sheet';
  const clusterDomain = clusterRow
    ? String(clusterRow[CLUSTER_COLS.cluster_domain] || '').trim()
    : '';
  // loadPersona throws on unknown id / missing field / malformed card — let it
  // propagate so the run fails loud rather than producing a wrong-author draft.
  const persona = loadPersona(authorId);
  return { ok: true, authorId, authorSource, clusterDomain, persona };
}

function gateCheckCluster(clusterRow, clusterId) {
  if (!clusterRow) {
    return { ok: false, exit: EXIT.GATE, reason: `cluster_id "${clusterId}" not found in ${CLUSTER_SHEET}` };
  }
  const track = String(clusterRow[CLUSTER_COLS.track] || '').trim();
  if (!track) {
    return { ok: false, exit: EXIT.GATE, reason: `cluster "${clusterId}" missing track (column C, required for CTA fallback)` };
  }
  return { ok: true, track };
}

// ============================================================
// CTA resolution (spec §2.2 H2)
// ============================================================

function resolveCta(pageRow, clusterRow, ctaRows) {
  // 1. If page CTA cell is already filled (column 11), use it directly as a free-text CTA.
  const pageCta = String(pageRow[PAGE_COLS.cta] || '').trim();
  if (pageCta) {
    return {
      cta_id: 'cta_inline_page',
      text: pageCta,
      target_url: '',
      ga4_event_name: '',
      source: 'page_cell_inline',
      fallback_note: null,
    };
  }

  const pageRole = String(pageRow[PAGE_COLS.page_role] || '').trim();
  const track = String(clusterRow[CLUSTER_COLS.track] || '').trim();
  const ctaPrimary = String(clusterRow[CLUSTER_COLS.cta_primary] || '').trim();

  // 2. Match by (page_role, track).
  const candidates = ctaRows.filter((r) => {
    const role = String(r[CTA_COLS.page_role] || '').trim();
    const trk = String(r[CTA_COLS.track] || '').trim();
    return role === pageRole && trk === track;
  });

  if (candidates.length === 0) {
    return {
      cta_id: null,
      text: '',
      target_url: '',
      ga4_event_name: '',
      source: 'no_match',
      fallback_note: `no CTA Map row for (page_role="${pageRole}", track="${track}")`,
    };
  }

  // 3. Prefer cta_tool_* by default.
  const tool = candidates.find((r) => String(r[CTA_COLS.cta_id] || '').startsWith('cta_tool_'));
  const news = candidates.find((r) => String(r[CTA_COLS.cta_id] || '').startsWith('cta_news_'));

  // 4. Newsletter gatekeeper: only when cluster.cta_primary === 'Newsletter' AND track === 精修线
  //    AND target_url not a placeholder.
  if (news && ctaPrimary === 'Newsletter' && track === '精修线') {
    const url = String(news[CTA_COLS.target_url] || '').trim();
    if (!PLACEHOLDER_REGEX.test(url)) {
      return {
        cta_id: String(news[CTA_COLS.cta_id] || ''),
        text: safeField(news[CTA_COLS.cta_text]),
        target_url: url,
        ga4_event_name: String(news[CTA_COLS.ga4_event_name] || ''),
        source: 'cta_map_newsletter_passed_gate',
        fallback_note: null,
      };
    }
    // Downgraded: log fallback note.
    if (tool) {
      return {
        cta_id: String(tool[CTA_COLS.cta_id] || ''),
        text: safeField(tool[CTA_COLS.cta_text]),
        target_url: String(tool[CTA_COLS.target_url] || ''),
        ga4_event_name: String(tool[CTA_COLS.ga4_event_name] || ''),
        source: 'cta_map_fallback_downgraded',
        fallback_note: `downgraded from ${news[CTA_COLS.cta_id]}: target_url placeholder (${url})`,
      };
    }
  }

  if (tool) {
    return {
      cta_id: String(tool[CTA_COLS.cta_id] || ''),
      text: safeField(tool[CTA_COLS.cta_text]),
      target_url: String(tool[CTA_COLS.target_url] || ''),
      ga4_event_name: String(tool[CTA_COLS.ga4_event_name] || ''),
      source: 'cta_map_fallback_tool_preference',
      fallback_note: null,
    };
  }

  // Last resort: first candidate.
  const c = candidates[0];
  return {
    cta_id: String(c[CTA_COLS.cta_id] || ''),
    text: safeField(c[CTA_COLS.cta_text]),
    target_url: String(c[CTA_COLS.target_url] || ''),
    ga4_event_name: String(c[CTA_COLS.ga4_event_name] || ''),
    source: 'cta_map_first_candidate',
    fallback_note: null,
  };
}

// ============================================================
// prompt rendering
// ============================================================

function loadTemplate(template) {
  const file = template === 'Tutorial' ? 'tutorial.prompt.md' : 'definition.prompt.md';
  const path = join(TEMPLATES_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`template file missing: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

function tierGateBlock(tier, friction, logic) {
  if (tier === 'T2') {
    return [
      '## Tier T2 闸门（必须满足）',
      `- Friction（真实痛点，禁形容词）: <field name="friction">${safeField(friction)}</field>`,
      `- Logic（机制 + 权衡）: <field name="logic">${safeField(logic)}</field>`,
    ].join('\n');
  }
  return [
    '## Tier T3 量产线规则',
    '- 不需 Friction / Logic 闸门，但仍需遵守 6 红线',
    '- 优先答 target_keyword 的字面意图，不强行扩到反思层',
  ].join('\n');
}

function psychSafetyBlock(effective) {
  if (effective !== 'Y') return '';
  return [
    '## 心理安全规则（PRD v0.7 附录 B，必须遵守）',
    '',
    '- **禁用**：「This placement means you have trauma.」「This can heal your anxiety.」',
    '  「You are X because…」/ 任何 healing / therapy / diagnose / treat / cure / remedy /',
    '  prescribe / prescription / condition / disorder / syndrome 类用词',
    '- **必用**：「This placement can be used as a reflective lens…」「Some people use this',
    '  theme to explore…」「A journaling prompt you might try is…」',
    '- **结尾必加 disclaimer**：「This is not a clinical interpretation or mental health advice.」',
    '- 不做诊断、不做治疗承诺、不替代专业咨询',
  ].join('\n');
}

function rl6Hint(effective) {
  if (effective === 'Y') {
    return 'healing 页必须有 disclaimer 行 + 反思语言 + 不含 healing/therapy/diagnose/treat/cure/remedy/prescribe/prescription/disorder/syndrome 黑词';
  }
  return '（本页 N/A）';
}

// Build the author byline + provenance YAML frontmatter prepended to the draft.
// JSON.stringify gives YAML-safe double-quoted scalars (handles colons / quotes in
// display_name or credential). The credential lives in byline metadata only — it is
// never written into the article body (first-person ban is enforced via the prompt).
function buildAuthorFrontmatter(author, clusterId) {
  const p = author.persona;
  const q = (s) => JSON.stringify(String(s == null ? '' : s));
  return [
    '---',
    `author_id: ${q(author.authorId)}`,
    `author_display_name: ${q(p.displayName)}`,
    `author_primary_focus: ${q(p.primaryFocus)}`,
    `author_credential: ${q(p.capsule.credential)}`,
    `author_source: ${q(author.authorSource)}`,
    `persona_version: ${q(p.version)}`,
    `persona_source_ref: ${q(p.sourceRef)}`,
    `cluster_id: ${q(clusterId)}`,
    `cluster_domain: ${q(author.clusterDomain)}`,
    '---',
    '',
    '',
  ].join('\n');
}

function renderPrompt(template, ctx) {
  const tier = ctx.tier;
  let raw = loadTemplate(template);

  const replacements = {
    '{{TIER}}': tier,
    '{{TIER_GATE_BLOCK}}': tierGateBlock(tier, ctx.friction, ctx.logic),
    '{{TIER_LOGIC_HINT}}': tier === 'T2' ? '，引用 Logic' : '',
    '{{PSYCH_SAFETY_BLOCK}}': psychSafetyBlock(ctx.effectivePsychSafety),
    '{{RL6_HINT}}': rl6Hint(ctx.effectivePsychSafety),
    '{{WORD_RANGE}}':
      template === 'Tutorial'
        ? tier === 'T2' ? '1500-2000' : '1100-1500'
        : tier === 'T2' ? '1500-1800' : '1100-1500',
    '{{KW_COUNT_RANGE}}':
      template === 'Tutorial'
        ? tier === 'T2' ? '5-8' : '4-7'
        : tier === 'T2' ? '5-8' : '4-7',
    '{{target_keyword}}': safeField(ctx.targetKeyword),
    '{{associated_keywords}}': safeField(ctx.associatedKeywords),
    '{{entity}}': safeField(ctx.entity),
    '{{search_volume}}': safeField(String(ctx.searchVolume)),
    '{{intent}}': safeField(ctx.intent),
    '{{tier}}': safeField(tier),
    '{{track}}': safeField(ctx.track),
    '{{page_role}}': safeField(ctx.pageRole),
    '{{cluster_jtbd}}': safeField(ctx.clusterJtbd),
    '{{content_angle}}': safeField(ctx.contentAngle),
    '{{internal_link_rule}}': safeField(ctx.internalLinkRule),
    '{{cta_text}}': safeField(ctx.cta.text),
    '{{cta_target_url}}': safeField(ctx.cta.target_url),
    '{{psych_safety_flag}}': safeField(ctx.effectivePsychSafety),
    '{{target_country}}': safeField(ctx.targetCountry || 'US'),
    // Author voice capsule (Lane A). Expression-layer only; never alters structure.
    // Each field is safeField-escaped so persona text cannot break out of <field>.
    '{{author_voice_rule}}': safeField(ctx.authorCapsule ? ctx.authorCapsule.voiceRule : ''),
    '{{author_allowed_moves}}': safeField(ctx.authorCapsule ? ctx.authorCapsule.allowedMoves : ''),
    '{{author_forbidden_moves}}': safeField(ctx.authorCapsule ? ctx.authorCapsule.forbiddenMoves : ''),
    '{{author_credential_meta}}': safeField(ctx.authorCapsule ? ctx.authorCapsule.credential : ''),
    // Phase 0 RAG source injection — raw XML blocks (already safeField-escaped per cell).
    '{{ENTITY_PASSPORT_BLOCK}}': ctx.entityPassportBlock || '',
    '{{FRICTION_MINE_BLOCK}}': ctx.frictionMineBlock || '',
    '{{SERP_SNIPPETS_BLOCK}}': ctx.serpSnippetsBlock || '',
    '{{OBSIDIAN_RAG_BLOCK}}': ctx.obsidianRagBlock || '',
  };

  for (const [k, v] of Object.entries(replacements)) {
    raw = raw.split(k).join(v);
  }
  return raw;
}

// ============================================================
// structure check (Phase 2 step 4)
// ============================================================

function structureCheck(draftMd, ctx) {
  const issues = [];
  const lines = draftMd.split('\n');

  const h1Count = lines.filter((l) => /^#\s+/.test(l)).length;
  const h2Count = lines.filter((l) => /^##\s+/.test(l)).length;

  if (h1Count < 1) issues.push('missing H1 heading');
  if (h2Count < 3) issues.push(`H2 count = ${h2Count} (< 3)`);

  const expectedSections = ctx.template === 'Tutorial' ? 8 : 7;
  // For section counting we use H2 heading count as canonical (CTA may be H2 or trailing block).
  if (h2Count !== expectedSections) {
    issues.push(`${ctx.template} expected ${expectedSections} H2 sections, got ${h2Count}`);
  }

  // CTA anchor: either the cta text appears, or cta_target_url appears, or an H2 contains "CTA".
  const ctaText = ctx.cta && ctx.cta.text ? String(ctx.cta.text) : '';
  const ctaUrl = ctx.cta && ctx.cta.target_url ? String(ctx.cta.target_url) : '';
  let ctaAnchorFound = false;
  if (ctaText && draftMd.includes(ctaText)) ctaAnchorFound = true;
  else if (ctaUrl && draftMd.includes(ctaUrl)) ctaAnchorFound = true;
  else if (/##\s+CTA\b/i.test(draftMd)) ctaAnchorFound = true;

  if (!ctaAnchorFound) issues.push('CTA anchor not found (cta text/url/H2)');

  let tutorialSteps = 0;
  if (ctx.template === 'Tutorial') {
    const stepMatches = draftMd.match(/\bStep\s+\d+\b/gi) || [];
    tutorialSteps = stepMatches.length;
    if (tutorialSteps < 3) {
      issues.push(`Tutorial Step count = ${tutorialSteps} (< 3 required)`);
    }
    // Require at least one ordered-list line.
    const orderedList = /^\s*\d+\.\s+/m.test(draftMd);
    if (!orderedList) issues.push('Tutorial requires at least 1 ordered list');
  } else {
    // Definition: require a markdown table OR bullet block.
    const hasTable = /\n\s*\|.+\|.+\|\s*\n\s*\|[\s|:-]+\|/.test(draftMd);
    const hasBullet = /^\s*[-*]\s+/m.test(draftMd);
    if (!hasTable && !hasBullet) {
      issues.push('Definition requires at least 1 table or bullet block');
    }
  }

  // psych_safety disclaimer line (also tested by RL6, but structure-check enforces presence).
  if (ctx.effectivePsychSafety === 'Y') {
    if (!/this\s+is\s+not\s+a\s+(clinical|mental\s+health)\s+(interpretation|advice)/i.test(draftMd)) {
      issues.push('psych_safety=Y but disclaimer line missing');
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    h1_count: h1Count,
    h2_count: h2Count,
    tutorial_section_count: ctx.template === 'Tutorial' ? h2Count : null,
    tutorial_steps: ctx.template === 'Tutorial' ? tutorialSteps : null,
    cta_anchor_found: ctaAnchorFound,
    char_count: draftMd.length,
  };
}

// ============================================================
// SERP cache load
// ============================================================

function loadSerpSnippets(serpDir, pageId) {
  const path = join(serpDir, `${pageId}.json`);
  if (!existsSync(path)) {
    return { state: 'missing', snippets: [], path };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const snippets = Array.isArray(raw.snippets)
      ? raw.snippets
          .map((s) => (typeof s === 'string' ? s : s.snippet || s.title || ''))
          .filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    return { state: 'hit', snippets, path };
  } catch (e) {
    return { state: 'error', snippets: [], path, err: e.message };
  }
}

// ============================================================
// Phase 0 RAG source injection (entity-passport.rag.json + friction-mine.rag.json + serp top-10)
// ============================================================
//
// Each builder validates the cache file is in-jail (.gg-cache/{page_id}/), parses
// JSON, asserts page_id + entity match the current context (fail-fast on mismatch
// — that signals cache corruption, never skip silently), caps snippet count/length,
// and emits a <source name="..."> XML block whose values are routed through
// safeField() so any attacker-controlled text inside RAG snippets can't break out
// of the <field> wrapper (defense-in-depth alongside C2 xmlEscape).
//
// Return contract:
//   - null  → cache file missing (caller decides: fail-fast gate or empty block w/ warn).
//   - ''    → cache present but content empty/structurally degenerate (treat as hit).
//   - '<source>…</source>'  → normal hit.
//
// All builders throw on cache page_id/entity mismatch — corruption is never silent.

function readRagCache(pageId, filename, expectedEntity) {
  assertSafePageId(pageId, `readRagCache(${filename})`);
  const cacheRoot = join(REPO_ROOT, '.gg-cache');
  ensureDir(cacheRoot);
  ensureDir(join(cacheRoot, pageId));
  const cachePath = join(cacheRoot, pageId, filename);
  if (!existsSync(cachePath)) return { state: 'missing', cachePath };
  // validateIngestPath gives us realpath + symlink rejection + ext check.
  const real = validateIngestPath(cachePath, {
    maxBytes: MAX_INGEST_BYTES,
    allowedDirs: [cacheRoot],
    allowedExtensions: ['.json'],
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch (e) {
    throw new Error(`${filename}: invalid JSON — ${e.message}`);
  }
  // Corruption guard: cache page_id MUST match current page_id.
  if (parsed.page_id !== pageId) {
    throw new Error(
      `${filename}: page_id mismatch — cache="${parsed.page_id}" vs current="${pageId}". ` +
      `Cache may belong to a different page; delete .gg-cache/${pageId}/${filename} and re-run upstream.`
    );
  }
  // Corruption guard: cache entity MUST match (case-insensitive).
  if (typeof parsed.entity !== 'string' ||
      parsed.entity.trim().toLowerCase() !== String(expectedEntity || '').toLowerCase()) {
    throw new Error(
      `${filename}: entity mismatch — cache="${parsed.entity}" vs current="${expectedEntity}". ` +
      `Refusing to use stale RAG cache (would inject wrong-entity snippets).`
    );
  }
  // Schema version pin: only '1' is supported for now.
  if (String(parsed.schema_version || '') !== '1') {
    throw new Error(
      `${filename}: schema_version="${parsed.schema_version}" not supported (expected "1")`
    );
  }
  return { state: 'hit', cachePath, parsed };
}

function entityPassportBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'entity-passport.rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const snippets = Array.isArray(res.parsed.snippets) ? res.parsed.snippets.slice(0, 12) : [];
  if (snippets.length === 0) {
    return '<source name="entity-passport">\n  <!-- cache hit but no snippets -->\n</source>';
  }
  const lines = ['<source name="entity-passport">'];
  for (const s of snippets) {
    const field = s && typeof s === 'object' ? (s.field || s.angle || 'snippet') : 'snippet';
    const text = s && typeof s === 'object' ? (s.text || s.snippet || '') : String(s);
    lines.push(`  <field name="${safeField(field, { cap: 64 })}">${safeField(text, { cap: 500 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

function frictionMineBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'friction-mine.rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const themes = Array.isArray(res.parsed.themes) ? res.parsed.themes.slice(0, 8) : [];
  if (themes.length === 0) {
    return '<source name="friction-mine">\n  <!-- cache hit but no themes -->\n</source>';
  }
  const lines = ['<source name="friction-mine">'];
  for (const t of themes) {
    const label = t && typeof t === 'object' ? (t.label || t.theme || 'theme') : 'theme';
    const quote = t && typeof t === 'object' ? (t.scrubbed_quote || t.quote || t.text || '') : String(t);
    lines.push(`  <field name="${safeField(label, { cap: 64 })}">${safeField(quote, { cap: 300 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

// SERP block uses existing .gg-cache/serp/{pageId}.json — same loadSerpSnippets()
// shape. Top-10 snippets, title + meta-snippet clipped to 500ch each. This is
// the "what head-ranking pages frame as the answer" block — prompt instruction
// must direct the LLM to design a CONTRA-position, not copy.
function serpSnippetsBlock(pageId, _expectedEntity) {
  assertSafePageId(pageId, 'serpSnippetsBlock');
  const serpPath = join(REPO_ROOT, '.gg-cache', 'serp', `${pageId}.json`);
  if (!existsSync(serpPath)) return null;
  // validateIngestPath as defense-in-depth.
  const real = validateIngestPath(serpPath, {
    maxBytes: MAX_INGEST_BYTES,
    allowedDirs: [join(REPO_ROOT, '.gg-cache')],
    allowedExtensions: ['.json'],
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    return '<source name="serp-top-10">\n  <!-- cache present but unparseable -->\n</source>';
  }
  const rawSnippets = Array.isArray(parsed.snippets) ? parsed.snippets.slice(0, 10) : [];
  if (rawSnippets.length === 0) {
    return '<source name="serp-top-10">\n  <!-- cache hit but no snippets -->\n</source>';
  }
  const lines = [
    '<source name="serp-top-10" note="head-ranking pages — design your CONTRA-position; do NOT copy">',
  ];
  for (const s of rawSnippets) {
    let title = '';
    let meta = '';
    if (typeof s === 'string') {
      meta = s;
    } else if (s && typeof s === 'object') {
      title = s.title || '';
      meta = s.snippet || s.meta || s.description || '';
    }
    const combined = [title, meta].filter(Boolean).join(' — ');
    lines.push(`  <field name="result">${safeField(combined, { cap: 500 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

// Obsidian-wiki RAG block — Phase 0 source #4.
// Reads .gg-cache/{pageId}/obsidian-rag.json produced by gg-obsidian-rag.mjs.
// This is the highest-quality RAG source for astrology topics — wzb's curated
// long-form book notes (Liz Greene / Stephen Arroyo / Robert Hand / etc.) —
// vs scraped web text which returned nav cruft for entity-passport.
//
// Shape contract: top-level .snippets is an array of objects with
// { source_path, source_id, note_title, section_heading, text, ... }.
// Emits each snippet as a <field name="..." path="..." section="...">text</field>.
function obsidianRagBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'obsidian-rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const snippets = Array.isArray(res.parsed.snippets) ? res.parsed.snippets.slice(0, 12) : [];
  const gapNote = res.parsed.gap_note;
  if (snippets.length === 0) {
    const tail = gapNote ? `\n  <!-- ${safeField(gapNote, { cap: 200 })} -->` : '';
    return `<source name="obsidian-wiki" note="curated book notes from personal vault">${tail}\n  <!-- cache hit but no snippets (vault gap for this entity) -->\n</source>`;
  }
  const lines = [
    '<source name="obsidian-wiki" note="curated deep-reading book notes from wzb personal vault — high-quality paraphrase source">',
  ];
  for (const s of snippets) {
    const sourceId = (s && typeof s === 'object' && s.source_id) ? s.source_id : 'snippet';
    const noteTitle = (s && typeof s === 'object' && s.note_title) ? s.note_title : '';
    const section = (s && typeof s === 'object' && s.section_heading) ? s.section_heading : '';
    const text = (s && typeof s === 'object' && s.text) ? s.text : String(s);
    lines.push(
      `  <field name="${safeField(sourceId, { cap: 32 })}" title="${safeField(noteTitle, { cap: 120 })}" section="${safeField(section, { cap: 96 })}">${safeField(text, { cap: 600 })}</field>`
    );
  }
  lines.push('</source>');
  return lines.join('\n');
}

// ============================================================
// LOOK printer + result logger
// ============================================================

const RESULTS = [];
function recordPass(name, detail) {
  RESULTS.push({ ok: true, name, detail });
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function recordFail(name, err, hint) {
  const safeErr = redact(err && err.message ? err.message : err);
  RESULTS.push({ ok: false, name, err: safeErr, hint });
  console.log(`❌ ${name}\n   error: ${safeErr}`);
  if (hint) console.log(`   hint:  ${hint}`);
}
function recordWarn(name, detail) {
  RESULTS.push({ ok: true, warn: true, name, detail });
  console.log(`⚠️  ${name}${detail ? ` — ${detail}` : ''}`);
}

// ============================================================
// runs log writer
// ============================================================

async function writeRunsRow({ workbookId, token, payload, status, notes, entity, dryRun }) {
  if (dryRun || !workbookId || !token) return;
  try {
    await appendRunsRow(workbookId, token, {
      tool: TOOL_NAME,
      entity: entity || '',
      count: 1,
      payload,
      status,
      notes: notes || '',
    });
  } catch (e) {
    recordWarn('runs log write failed', formatErr(e));
  }
}

// ============================================================
// Phase 1 — generate prompt
// ============================================================

async function runPhase1(args, env) {
  const { workbookId, token } = env;
  // Codex round 2 C3 defense-in-depth: re-assert page_id whitelist at phase entry.
  // Primary check is in main(); this catches direct callers (tests, future refactor).
  const pageId = assertSafePageId(args.pageId, 'runPhase1');
  const targetCountry = process.env.GG_TARGET_COUNTRY || 'US';

  console.log(`${TOOL_VERSION} — Phase 1 for page_id="${pageId}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Read page row.
  const pageRows = await readSheetRange(workbookId, token, PAGE_RANGE);
  const pageRowMap = buildPageRowMap(pageRows);
  persistPageRowMap(pageRowMap);
  const rowIdx = pageRowMap[pageId];
  if (!rowIdx) {
    recordFail('page lookup', new Error(`page_id "${pageId}" not found`),
      `add a row with page_id="${pageId}" to ${PAGE_SHEET}`);
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'page_id not found' },
      status: 'fail', notes: 'page_id not found',
      entity: '',
    });
    return EXIT.GATE;
  }
  const pageRow = pageRows[rowIdx - 2];

  // 2. Gate check page.
  const gate = gateCheckPage(pageRow, pageId);
  if (!gate.ok) {
    recordFail('page gate', new Error(gate.reason));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: gate.reason },
      status: 'fail', notes: gate.reason,
      entity: String(pageRow[PAGE_COLS.entity] || ''),
    });
    return gate.exit;
  }
  recordPass('page gate', `Tier=${gate.tier} Template=${gate.template} cluster=${gate.clusterId}`);

  // 3. Read cluster row.
  const clusterRows = await readSheetRange(workbookId, token, CLUSTER_RANGE);
  const clusterRow = clusterRows.find((r) => String(r[CLUSTER_COLS.cluster_id] || '').trim() === gate.clusterId);
  const clusterGate = gateCheckCluster(clusterRow, gate.clusterId);
  if (!clusterGate.ok) {
    recordFail('cluster gate', new Error(clusterGate.reason));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: clusterGate.reason },
      status: 'fail', notes: clusterGate.reason,
      entity: gate.entity,
    });
    return clusterGate.exit;
  }
  recordPass('cluster gate', `track=${clusterGate.track}`);

  // 3b. Author gate (Lane A, CRITICAL): author_id empty → hard block, no draft.
  //     loadPersona throws on unknown/malformed card (propagates to main → exit 1).
  let author;
  try {
    author = resolveAuthor(pageRow, clusterRow, pageId);
  } catch (e) {
    recordFail('author gate', e,
      `check 选题登记表 column V (author) value against tools/scripts/lib/author-personas/<id>.md`);
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: formatErr(e) },
      status: 'fail', notes: 'author persona load failed', entity: gate.entity,
    });
    return EXIT.GATE;
  }
  if (!author.ok) {
    recordFail('author gate', new Error(author.reason),
      'set the author column (V) in 选题登记表; routing is owned upstream (Lane B)');
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: author.reason },
      status: 'fail', notes: 'no author assigned', entity: gate.entity,
    });
    return author.exit;
  }
  recordPass('author gate', `author=${author.authorId} (source=${author.authorSource}, persona v${author.persona.version})`);

  // 4. Read CTA Map.
  const ctaRows = await readSheetRange(workbookId, token, CTA_RANGE);
  const cta = resolveCta(pageRow, clusterRow, ctaRows);
  if (cta.fallback_note) {
    recordWarn('CTA fallback', cta.fallback_note);
  } else {
    recordPass('CTA resolve', `${cta.cta_id} (${cta.source})`);
  }

  // 5. Effective psych_safety = page OR cluster.
  const pageSafety = String(pageRow[PAGE_COLS.psych_safety_flag] || '').trim().toUpperCase();
  const clusterSafety = String(clusterRow[CLUSTER_COLS.psych_safety_flag] || '').trim().toUpperCase();
  let effectivePsychSafety = 'N';
  let effectivePsychSafetySource = 'page';
  if (pageSafety === 'Y' && clusterSafety === 'Y') {
    effectivePsychSafety = 'Y';
    effectivePsychSafetySource = 'OR';
  } else if (pageSafety === 'Y') {
    effectivePsychSafety = 'Y';
    effectivePsychSafetySource = 'page';
  } else if (clusterSafety === 'Y') {
    effectivePsychSafety = 'Y';
    effectivePsychSafetySource = 'cluster';
  }

  // 6. SERP cache state.
  const serpDir = args.serpDir;
  ensureDir(serpDir);
  const serpRes = loadSerpSnippets(serpDir, pageId);
  let serpCheckState;
  if (serpRes.state === 'hit') {
    serpCheckState = 'hit';
    recordPass('SERP cache', `${serpRes.snippets.length} snippets at ${relative(REPO_ROOT, serpRes.path)}`);
  } else if (args.allowMissingSerp) {
    if (!args.reason || args.reason.length < MIN_REASON_LEN) {
      recordFail('SERP escape', new Error(`--allow-missing-serp requires --reason "<≥${MIN_REASON_LEN} chars>"`));
      await writeRunsRow({
        ...env, dryRun: args.dryRun,
        payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'allow-missing-serp without reason' },
        status: 'fail', notes: 'serp missing escape reason',
        entity: gate.entity,
      });
      return EXIT.GATE;
    }
    serpCheckState = 'missing-skipped';
    // Codex round 2 C4: scrub + truncate reason before any sink (stdout / manifest / runs).
    const cleanedReason = cleanReason(args.reason);
    recordWarn('SERP cache missing', `escape reason: ${cleanedReason}`);
  } else {
    recordFail('SERP cache missing',
      new Error(`no .gg-cache/serp/${pageId}.json — paste SERP top-3 first OR use --allow-missing-serp --reason "<...>"`));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'serp cache missing' },
      status: 'fail', notes: 'SERP cache missing',
      entity: gate.entity,
    });
    return EXIT.GATE;
  }

  // 7. Phase 0 RAG source injection — entity-passport + friction-mine + obsidian-wiki caches.
  //    Strict gate by default: any of the three RAG files missing → exit 10 unless
  //    --allow-missing-rag (entity-passport / friction-mine) or
  //    --allow-missing-obsidian-rag (obsidian-wiki) --reason "<≥8 chars>" passed.
  //    Mismatches (page_id or entity mismatch inside the cache) ALWAYS fail-fast — corruption signal.
  let passportBlock = '';
  let frictionBlock = '';
  let serpBlock = '';
  let obsidianBlock = '';
  let ragCheckState = 'hit';
  try {
    const pb = entityPassportBlock(pageId, gate.entity);
    const fb = frictionMineBlock(pageId, gate.entity);
    const sb = serpSnippetsBlock(pageId, gate.entity);
    const ob = obsidianRagBlock(pageId, gate.entity);
    const missingClassic = [];
    if (pb === null) missingClassic.push('entity-passport.rag.json');
    if (fb === null) missingClassic.push('friction-mine.rag.json');
    const missingObsidian = (ob === null) ? ['obsidian-rag.json'] : [];

    if (missingClassic.length > 0) {
      if (!args.allowMissingRag) {
        recordFail('RAG cache missing', new Error(
          `missing: ${missingClassic.join(', ')} — run gg-entity-passport --emit-rag + gg-friction-mine --for-rag first, ` +
          `or pass --allow-missing-rag --reason "<...>"`
        ));
        await writeRunsRow({
          ...env, dryRun: args.dryRun,
          payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: `rag cache missing: ${missingClassic.join(',')}` },
          status: 'fail', notes: 'RAG cache missing', entity: gate.entity,
        });
        return EXIT.GATE;
      }
      if (!args.reason || args.reason.length < MIN_REASON_LEN) {
        recordFail('RAG escape', new Error(`--allow-missing-rag requires --reason "<≥${MIN_REASON_LEN} chars>"`));
        await writeRunsRow({
          ...env, dryRun: args.dryRun,
          payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'allow-missing-rag without reason' },
          status: 'fail', notes: 'rag missing escape reason', entity: gate.entity,
        });
        return EXIT.GATE;
      }
      ragCheckState = 'missing-skipped';
      for (const m of missingClassic) recordWarn('RAG cache missing', `${m} — escape reason: ${cleanReason(args.reason)}`);
    }

    if (missingObsidian.length > 0) {
      if (!args.allowMissingObsidianRag) {
        recordFail('Obsidian RAG cache missing', new Error(
          `missing: obsidian-rag.json — run gg-obsidian-rag --page-id ${pageId} --entity "${gate.entity}" first, ` +
          `or pass --allow-missing-obsidian-rag --reason "<...>"`
        ));
        await writeRunsRow({
          ...env, dryRun: args.dryRun,
          payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'obsidian rag cache missing' },
          status: 'fail', notes: 'Obsidian RAG cache missing', entity: gate.entity,
        });
        return EXIT.GATE;
      }
      if (!args.reason || args.reason.length < MIN_REASON_LEN) {
        recordFail('Obsidian RAG escape',
          new Error(`--allow-missing-obsidian-rag requires --reason "<≥${MIN_REASON_LEN} chars>"`));
        await writeRunsRow({
          ...env, dryRun: args.dryRun,
          payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'allow-missing-obsidian-rag without reason' },
          status: 'fail', notes: 'obsidian rag missing escape reason', entity: gate.entity,
        });
        return EXIT.GATE;
      }
      ragCheckState = 'missing-skipped';
      recordWarn('Obsidian RAG cache missing', `obsidian-rag.json — escape reason: ${cleanReason(args.reason)}`);
    }

    if (missingClassic.length === 0 && missingObsidian.length === 0) {
      recordPass('RAG cache', 'entity-passport + friction-mine + obsidian-wiki hit');
    }
    passportBlock = pb || '';
    frictionBlock = fb || '';
    serpBlock = sb || '';
    obsidianBlock = ob || '';
  } catch (e) {
    // Cache corruption (page_id / entity mismatch / schema): ALWAYS fail-fast, even with --allow-missing-rag.
    recordFail('RAG cache corruption', e,
      'cache mismatch is never silenced — delete the offending .gg-cache/<page_id>/*.rag.json and re-run upstream');
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: formatErr(e) },
      status: 'fail', notes: 'RAG cache corruption', entity: gate.entity,
    });
    return EXIT.GATE;
  }

  // 8. Build context + render prompt.
  const renderCtx = {
    tier: gate.tier,
    template: gate.template,
    targetKeyword: pageRow[PAGE_COLS.target_keyword],
    associatedKeywords: pageRow[PAGE_COLS.associated_keywords],
    entity: gate.entity,
    searchVolume: pageRow[PAGE_COLS.search_volume],
    intent: pageRow[PAGE_COLS.intent],
    track: clusterGate.track,
    pageRole: pageRow[PAGE_COLS.page_role],
    friction: pageRow[PAGE_COLS.friction],
    logic: pageRow[PAGE_COLS.logic],
    clusterJtbd: clusterRow[CLUSTER_COLS.jtbd],
    contentAngle: pageRow[PAGE_COLS.content_angle] || clusterRow[CLUSTER_COLS.content_angle],
    internalLinkRule: clusterRow[CLUSTER_COLS.internal_link_rule],
    cta,
    effectivePsychSafety,
    targetCountry,
    entityPassportBlock: passportBlock,
    frictionMineBlock: frictionBlock,
    serpSnippetsBlock: serpBlock,
    obsidianRagBlock: obsidianBlock,
    // Lane A shared ctx — author signing fields consumed here + carried to manifest.
    authorId: author.authorId,
    authorSource: author.authorSource,
    authorBannedTokens: author.persona.bannedTokens, // for Lane C RL7 (filled here, not enforced here)
    authorCapsule: author.persona.capsule,
    personaVersion: author.persona.version,
    clusterDomain: author.clusterDomain,
  };
  const prompt = renderPrompt(gate.template, renderCtx);

  // 8. Write prompt to disk.
  const promptPath = join(args.promptOut, `${pageId}-phase1-${utcStamp()}.md`);
  if (args.dryRun) {
    recordPass('dry-run', `prompt would be written to ${promptPath} (${prompt.length} chars)`);
  } else {
    try {
      const { abs } = validateWritePath(promptPath, {
        allowedDirs: [args.promptOut],
        allowedExtensions: ['.md'],
      });
      // Backup if any old prompt exists for this page_id (rare since timestamped).
      const oldPrompts = listOldPrompts(args.promptOut, pageId);
      for (const oldPath of oldPrompts) {
        // Only backup if same exact basename collision — timestamped names rarely collide.
        if (oldPath === abs) {
          renameSync(oldPath, oldPath.replace(/\.md$/, '.bak'));
        }
      }
      writeFileSync(abs, prompt, 'utf8');
      recordPass('write prompt', `${relative(REPO_ROOT, abs)} (${prompt.length} chars)`);
    } catch (e) {
      recordFail('write prompt', e, 'check .gg-cache/prompts permissions');
      await writeRunsRow({
        ...env, dryRun: args.dryRun,
        payload: { phase: 1, page_id: pageId, fail_kind: 'gate', detail: 'write prompt failed' },
        status: 'fail', notes: formatErr(e),
        entity: gate.entity,
      });
      return EXIT.FATAL;
    }
  }

  // 9. Flip Status 待写 → 写作中.
  if (!args.dryRun) {
    try {
      await writeStatusCell(workbookId, token, rowIdx, STATUS_WRITING, false);
      recordPass('Sheets status flip', `row ${rowIdx}: ${STATUS_WAITING} → ${STATUS_WRITING}`);
    } catch (e) {
      recordWarn('Sheets status flip failed', formatErr(e));
    }
  }

  // 10. Runs log.
  await writeRunsRow({
    ...env, dryRun: args.dryRun,
    payload: {
      phase: 1, page_id: pageId, cluster_id: gate.clusterId,
      template: gate.template, tier: gate.tier, track: clusterGate.track,
      author_id: author.authorId, author_source: author.authorSource,
      persona_version: author.persona.version, cluster_domain: author.clusterDomain,
      psych_safety: effectivePsychSafety, serp_state: serpCheckState,
      rag_state: ragCheckState,
      prompt_path: args.dryRun ? null : relative(REPO_ROOT, promptPath),
    },
    status: 'ok',
    entity: gate.entity,
  });

  // 11. LOOK printout.
  console.log('');
  console.log('━━━ Phase 1 LOOK ━━━');
  console.log(`✔ Phase 1 ready`);
  console.log(`  page_id:      ${pageId}`);
  console.log(`  template:     ${gate.template} | tier: ${gate.tier} | track: ${clusterGate.track}`);
  console.log(`  author:       ${author.authorId} (source=${author.authorSource}, persona v${author.persona.version}, domain=${author.clusterDomain || '(none)'})`);
  console.log(`  psych_safety: ${effectivePsychSafety} (source=${effectivePsychSafetySource})`);
  console.log(`  cta:          ${cta.cta_id || '(none)'} — ${cta.text || '(empty)'}`);
  console.log(`  serp:         ${serpCheckState}`);
  console.log(`  prompt:       ${args.dryRun ? '(dry-run)' : relative(REPO_ROOT, promptPath)}`);
  console.log(`  next:         paste prompt → Claude, save output, run --phase 2 --ingest-file <path>`);
  return EXIT.OK;
}

function listOldPrompts(promptOut, pageId) {
  try {
    if (!existsSync(promptOut)) return [];
    return readdirSync(promptOut)
      .filter((n) => n.startsWith(`${pageId}-phase1-`) && n.endsWith('.md'))
      .map((n) => join(promptOut, n));
  } catch {
    return [];
  }
}

function findLatestPrompt(promptOut, pageId) {
  const list = listOldPrompts(promptOut, pageId);
  if (list.length === 0) return null;
  return list.sort().reverse()[0];
}

// ============================================================
// Phase 2 — ingest LLM output + 6 red lines + write staging
// ============================================================

async function runPhase2(args, env) {
  const { workbookId, token } = env;
  // Codex round 2 C3 defense-in-depth: re-assert page_id whitelist at phase entry.
  const pageId = assertSafePageId(args.pageId, 'runPhase2');

  console.log(`${TOOL_VERSION} — Phase 2 for page_id="${pageId}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // 1. Validate ingest path FIRST (cheap fail).
  let realIngest;
  try {
    realIngest = validateIngestPath(args.ingestFile, {
      maxBytes: MAX_INGEST_BYTES,
      allowedDirs: [
        join(homedir(), 'Downloads'),
        join(homedir(), 'Desktop'),
        DEFAULT_CACHE_DIR,
      ],
      allowedExtensions: ['.md', '.txt'],
    });
  } catch (e) {
    recordFail('validate ingest path', e,
      'allowed: ~/Downloads, ~/Desktop, .gg-cache/; .md or .txt; ≤1 MB; no symlinks');
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'ingest', detail: formatErr(e) },
      status: 'fail', notes: formatErr(e),
      entity: '',
    });
    return EXIT.INGEST;
  }

  // 2. Read draft.
  const draftRaw = readFileSync(realIngest, 'utf8');
  const draftMd = nfkc(draftRaw);

  // 3. Read page row + cluster row.
  const pageRows = await readSheetRange(workbookId, token, PAGE_RANGE);
  const pageRowMap = buildPageRowMap(pageRows);
  persistPageRowMap(pageRowMap);
  const rowIdx = pageRowMap[pageId];
  if (!rowIdx) {
    recordFail('page lookup', new Error(`page_id "${pageId}" not found`));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: 'page_id not found' },
      status: 'fail', notes: 'page_id not found',
      entity: '',
    });
    return EXIT.GATE;
  }
  const pageRow = pageRows[rowIdx - 2];

  // Phase 2 gate (codex round 2 C1): Status MUST be in {写作中, 待写}.
  // - 待写 → Phase 1 hasn't run; reject with "Phase 1 still pending" hint.
  // - 质检/已发布/已刷新/KILL → Phase 2 already past; refuse rollback.
  // - 写作中 → normal Phase 2 entry (Phase 1 just flipped it).
  const status = String(pageRow[PAGE_COLS.status] || '').trim();
  const tier = String(pageRow[PAGE_COLS.tier] || '').trim();
  const template = String(pageRow[PAGE_COLS.template] || '').trim();
  if (!ALLOWED_TEMPLATES.includes(template)) {
    recordFail('phase2 gate', new Error(`Template="${template}" not in {Tutorial, Definition}`));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: `Template="${template}"` },
      status: 'fail', notes: `Template="${template}" not allowed`,
      entity: String(pageRow[PAGE_COLS.entity] || ''),
    });
    return EXIT.GATE;
  }
  if (status === STATUS_WAITING) {
    const reason = `Phase 2 拒绝：Status="${status}"，Phase 1 还没跑（应先 --phase 1，再 --phase 2）`;
    recordFail('phase2 status gate', new Error(reason),
      `先跑 \`--phase 1\` 让 Status 翻到 ${STATUS_WRITING} 后再跑 Phase 2`);
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: reason },
      status: 'fail', notes: 'phase2 status=待写 (phase1 not run)',
      entity: String(pageRow[PAGE_COLS.entity] || ''),
    });
    return EXIT.GATE;
  }
  if (status !== STATUS_WRITING) {
    // Anything else: 质检 / 已发布 / 已刷新 / KILL / blank / 其它 — reject rollback.
    const reason = `Phase 2 拒绝：Status="${status}"，已超出 Phase 2 阶段，不能回滚`;
    recordFail('phase2 status gate', new Error(reason),
      `若确属误操作需要重跑：手动把 Status 改回 "${STATUS_WRITING}" 或用 --catch-up 修复半翻转`);
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: reason },
      status: 'fail', notes: `phase2 rollback refused: status=${status}`,
      entity: String(pageRow[PAGE_COLS.entity] || ''),
    });
    return EXIT.GATE;
  }
  const entity = String(pageRow[PAGE_COLS.entity] || '').trim();
  const clusterId = String(pageRow[PAGE_COLS.cluster_id] || '').trim();
  const targetKeyword = String(pageRow[PAGE_COLS.target_keyword] || '').trim();

  // 4. Cluster + CTA (for context).
  const clusterRows = await readSheetRange(workbookId, token, CLUSTER_RANGE);
  const clusterRow = clusterRows.find((r) => String(r[CLUSTER_COLS.cluster_id] || '').trim() === clusterId);
  if (!clusterRow) {
    recordFail('cluster lookup', new Error(`cluster_id "${clusterId}" not found`));
    return EXIT.GATE;
  }
  const ctaRows = await readSheetRange(workbookId, token, CTA_RANGE);
  const cta = resolveCta(pageRow, clusterRow, ctaRows);

  // Author gate (Lane A, CRITICAL): same hard-block as Phase 1 — never ingest an
  // un-signed draft. Empty author column → exit 10; unknown/malformed card → throws.
  let author;
  try {
    author = resolveAuthor(pageRow, clusterRow, pageId);
  } catch (e) {
    recordFail('author gate', e,
      'check 选题登记表 column V (author) against tools/scripts/lib/author-personas/<id>.md');
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: formatErr(e) },
      status: 'fail', notes: 'author persona load failed', entity,
    });
    return EXIT.GATE;
  }
  if (!author.ok) {
    recordFail('author gate', new Error(author.reason),
      'set the author column (V) in 选题登记表 before Phase 2');
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: author.reason },
      status: 'fail', notes: 'no author assigned', entity,
    });
    return author.exit;
  }
  recordPass('author gate', `author=${author.authorId} (source=${author.authorSource}, persona v${author.persona.version})`);

  const pageSafety = String(pageRow[PAGE_COLS.psych_safety_flag] || '').trim().toUpperCase();
  const clusterSafety = String(clusterRow[CLUSTER_COLS.psych_safety_flag] || '').trim().toUpperCase();
  let effectivePsychSafety = 'N';
  let effectivePsychSafetySource = 'page';
  if (pageSafety === 'Y' && clusterSafety === 'Y') {
    effectivePsychSafety = 'Y'; effectivePsychSafetySource = 'OR';
  } else if (pageSafety === 'Y') {
    effectivePsychSafety = 'Y'; effectivePsychSafetySource = 'page';
  } else if (clusterSafety === 'Y') {
    effectivePsychSafety = 'Y'; effectivePsychSafetySource = 'cluster';
  }

  // 5. SERP cache.
  const serpRes = loadSerpSnippets(args.serpDir, pageId);
  let serpCheckState;
  let serpSnippets = [];
  let escapeReason = null;
  if (serpRes.state === 'hit') {
    serpCheckState = 'hit';
    serpSnippets = serpRes.snippets;
  } else if (args.allowMissingSerp) {
    if (!args.reason || args.reason.length < MIN_REASON_LEN) {
      recordFail('SERP escape', new Error(`--allow-missing-serp requires --reason "<≥${MIN_REASON_LEN} chars>"`));
      return EXIT.GATE;
    }
    serpCheckState = 'missing-skipped';
    // Codex round 2 C4: scrub + truncate before storing in manifest.red_lines_check.escape_reason
    // and any other downstream sink.
    escapeReason = cleanReason(args.reason);
  } else {
    recordFail('SERP cache missing', new Error(`no .gg-cache/serp/${pageId}.json`));
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 2, page_id: pageId, fail_kind: 'gate', detail: 'serp cache missing' },
      status: 'fail', notes: 'SERP cache missing', entity,
    });
    return EXIT.GATE;
  }

  // 6. Red lines.
  const rl = redLinesCheck(draftMd, {
    targetKeyword,
    entity,
    effectivePsychSafety,
    serpState: serpCheckState,
    snippets: serpSnippets,
    escapeReason,
  });
  if (rl.all_pass) {
    recordPass('red lines', `6/6 pass`);
  } else {
    const failed = rl.rules.filter((r) => !r.pass);
    for (const r of failed) {
      recordFail(`red line ${r.id}`, new Error(r.note || 'fail'));
    }
  }

  // 7. Structure check.
  const sc = structureCheck(draftMd, { template, effectivePsychSafety, cta });
  if (sc.ok) {
    recordPass('structure check', `H1=${sc.h1_count} H2=${sc.h2_count} CTA=${sc.cta_anchor_found}`);
  } else {
    for (const issue of sc.issues) recordFail(`structure: ${issue}`, new Error(issue));
  }

  // 8. Decide write target.
  const isFail = !rl.all_pass || !sc.ok;
  const stagingPageDir = join(args.stagingDir, pageId);

  // Validate write target.
  const draftFilename = isFail ? 'draft.tmp.md' : 'draft.md';
  const manifestFilename = 'manifest.json';
  const draftAbs = join(stagingPageDir, draftFilename);
  const manifestAbs = join(stagingPageDir, manifestFilename);

  // Always validate write target paths (whether fail or success path).
  if (!args.dryRun) {
    try {
      ensureDir(args.stagingDir);
      validateWritePath(draftAbs, {
        allowedDirs: [args.stagingDir],
        allowedExtensions: ['.md'],
      });
      validateWritePath(manifestAbs, {
        allowedDirs: [args.stagingDir],
        allowedExtensions: ['.json'],
      });
    } catch (e) {
      recordFail('validate write target', e);
      await writeRunsRow({
        ...env, dryRun: args.dryRun,
        payload: { phase: 2, page_id: pageId, fail_kind: 'ingest', detail: formatErr(e) },
        status: 'fail', notes: formatErr(e), entity,
      });
      return EXIT.INGEST;
    }
  }

  // 9. Codex round 2 H2 — atomic Status-flip-first on SUCCESS path.
  //   On success: try Sheets write FIRST. If it fails → exit 14, do NOT write draft.md / manifest.json
  //   (prevents the half-flipped state where Sheets still says 写作中 but staging has draft+manifest).
  //   On fail: keep old behaviour — Sheets is NOT flipped; write draft.tmp.md + manifest (status='fail').
  let statusAfter = status; // pending until Sheets write succeeds
  if (!isFail && !args.dryRun) {
    try {
      await writeStatusCell(workbookId, token, rowIdx, STATUS_WRITING, false);
      statusAfter = STATUS_WRITING;
      recordPass('Sheets status flip', `row ${rowIdx}: ${status} → ${STATUS_WRITING}`);
    } catch (e) {
      const safeMsg = formatErr(e);
      recordFail('Sheets status flip', new Error(safeMsg),
        '已通过 6 红线 + structure check，但 Sheets 写入失败。draft.md / manifest.json 未落盘以保持原子性。请检查网络/凭证后重跑 Phase 2。');
      await writeRunsRow({
        ...env, dryRun: args.dryRun,
        payload: {
          phase: 2, page_id: pageId,
          fail_kind: 'sheets_write',
          detail: safeMsg,
          red_lines_pass: true, structure_pass: true,
        },
        status: 'fail', notes: 'sheets status flip failed (pre-write atomic guard)',
        entity,
      });
      return EXIT.SHEETS_WRITE_FAIL;
    }
  }

  // 10. Backup + write draft + manifest. On success: this only runs after Sheets flip succeeded.
  if (!args.dryRun) {
    // Backup existing files of same name.
    if (existsSync(draftAbs)) {
      const stamp = utcStamp();
      const bak = draftAbs.replace(/\.md$/, `.${stamp}.bak.md`);
      renameSync(draftAbs, bak);
    }
    if (existsSync(manifestAbs)) {
      const stamp = utcStamp();
      const bak = manifestAbs.replace(/\.json$/, `.${stamp}.bak.json`);
      renameSync(manifestAbs, bak);
    }

    // Always write draft (even on fail — as .tmp.md). Prepend author byline
    // frontmatter so the signing + provenance travels with the draft file itself.
    const draftWithByline = buildAuthorFrontmatter(author, clusterId) + draftMd;
    writeFileSync(draftAbs, draftWithByline, 'utf8');
    recordPass('write draft', `${relative(REPO_ROOT, draftAbs)} (${draftWithByline.length} chars, author=${author.authorId})`);
  }

  // 11. Build + write manifest.
  const manifest = {
    schema_version: SCHEMA_VERSION,
    tool_version: TOOL_VERSION,
    git_commit: gitCommit(),
    status: isFail ? 'fail' : 'ok',
    page_id: pageId,
    sheet_row: rowIdx,
    cluster_id: clusterId,
    target_keyword: targetKeyword,
    associated_keywords: String(pageRow[PAGE_COLS.associated_keywords] || '')
      .split(/[,，]/).map((s) => s.trim()).filter(Boolean),
    entity,
    template,
    tier,
    track: String(clusterRow[CLUSTER_COLS.track] || '').trim(),
    page_role: String(pageRow[PAGE_COLS.page_role] || '').trim(),
    // Lane A provenance — written so a wrong byline can never be silent + is auditable.
    author_id: author.authorId,
    author_source: author.authorSource,
    cluster_domain: author.clusterDomain,
    persona_version: author.persona.version,
    intent: String(pageRow[PAGE_COLS.intent] || '').trim(),
    content_angle: String(pageRow[PAGE_COLS.content_angle] || '').trim() ||
      String(clusterRow[CLUSTER_COLS.content_angle] || '').trim(),
    psych_safety_flag: pageSafety || 'N',
    effective_psych_safety: effectivePsychSafety,
    effective_psych_safety_source: effectivePsychSafetySource,
    cta: {
      cta_id: cta.cta_id,
      text: cta.text,
      target_url: cta.target_url,
      ga4_event_name: cta.ga4_event_name,
      source: cta.source,
      fallback_note: cta.fallback_note,
    },
    search_volume: pageRow[PAGE_COLS.search_volume],
    kd: pageRow[PAGE_COLS.kd],
    target_country: process.env.GG_TARGET_COUNTRY || 'US',
    serp_check_state: serpCheckState,
    red_lines_check: rl,
    structure_check: {
      ok: sc.ok,
      issues: sc.issues,
      h1_count: sc.h1_count,
      h2_count: sc.h2_count,
      tutorial_section_count: sc.tutorial_section_count,
      tutorial_steps: sc.tutorial_steps,
      cta_anchor_found: sc.cta_anchor_found,
      char_count: sc.char_count,
    },
    status_before: status,
    // statusAfter is mutated only after Sheets write succeeded (atomic).
    status_after: statusAfter,
    phase1_prompt_path: (() => {
      const latest = findLatestPrompt(args.promptOut, pageId);
      return latest ? relative(REPO_ROOT, latest) : null;
    })(),
    phase2_ingest_path: absToHomeRelative(realIngest),
    phase1_ts: null,
    phase2_ts: nowIso(),
  };

  if (!args.dryRun) {
    writeFileSync(manifestAbs, JSON.stringify(manifest, null, 2), 'utf8');
    recordPass('write manifest', relative(REPO_ROOT, manifestAbs));

    // Copy prompt snapshot.
    const latestPrompt = findLatestPrompt(args.promptOut, pageId);
    if (latestPrompt) {
      const snapAbs = join(stagingPageDir, 'prompt.snapshot.md');
      try {
        copyFileSync(latestPrompt, snapAbs);
        recordPass('write prompt.snapshot', relative(REPO_ROOT, snapAbs));
      } catch (e) {
        recordWarn('prompt snapshot copy failed', formatErr(e));
      }
    }
  }

  // 12. Decide exit code (Sheets flip already handled atomically above on success path).
  let exitCode = EXIT.OK;
  if (!rl.all_pass) exitCode = EXIT.RED_LINES;
  else if (!sc.ok) exitCode = EXIT.STRUCTURE;

  if (isFail) {
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: {
        phase: 2, page_id: pageId,
        fail_kind: !rl.all_pass ? 'red_lines' : 'structure',
        detail: !rl.all_pass
          ? rl.rules.filter((r) => !r.pass).map((r) => r.id)
          : sc.issues,
        red_lines_pass: rl.all_pass,
        structure_pass: sc.ok,
      },
      status: 'fail',
      notes: !rl.all_pass ? 'red lines fail' : 'structure fail',
      entity,
    });
    console.log('');
    console.log('━━━ Phase 2 LOOK (FAIL) ━━━');
    console.log(`✗ exit=${exitCode}  draft kept as ${draftFilename}  manifest.status=fail  Sheets Status NOT flipped`);
    return exitCode;
  }

  await writeRunsRow({
    ...env, dryRun: args.dryRun,
    payload: {
      phase: 2, page_id: pageId,
      author_id: author.authorId, author_source: author.authorSource,
      persona_version: author.persona.version, cluster_domain: author.clusterDomain,
      draft_path: args.dryRun ? null : relative(REPO_ROOT, draftAbs),
      red_lines_pass: true, structure_pass: true,
      status_before: status, status_after: STATUS_WRITING,
    },
    status: 'ok',
    entity,
  });

  console.log('');
  console.log('━━━ Phase 2 LOOK ━━━');
  console.log(`✔ Phase 2 done`);
  console.log(`  page_id:    ${pageId}`);
  console.log(`  author:     ${author.authorId} (source=${author.authorSource}, persona v${author.persona.version})`);
  console.log(`  draft:      ${relative(REPO_ROOT, draftAbs)} (${draftMd.length} chars, ${sc.h2_count} H2 sections)`);
  console.log(`  red_lines:  ${rl.rules.filter((r) => r.pass).length}/6 pass`);
  console.log(`  structure:  ok`);
  console.log(`  sheets:     row ${rowIdx}: ${status} → ${STATUS_WRITING}`);
  return EXIT.OK;
}

// ============================================================
// catch-up (spec §3.4)
// ============================================================

async function runCatchUp(args, env) {
  const { workbookId, token } = env;
  // Codex round 2 C3 defense-in-depth.
  const pageId = assertSafePageId(args.pageId, 'runCatchUp');
  console.log(`${TOOL_VERSION} — catch-up for page_id="${pageId}"`);

  const pageRows = await readSheetRange(workbookId, token, PAGE_RANGE);
  const pageRowMap = buildPageRowMap(pageRows);
  const rowIdx = pageRowMap[pageId];
  if (!rowIdx) {
    recordFail('page lookup', new Error(`page_id "${pageId}" not found`));
    return EXIT.GATE;
  }
  const pageRow = pageRows[rowIdx - 2];
  const status = String(pageRow[PAGE_COLS.status] || '').trim();
  const stagingPageDir = join(args.stagingDir, pageId);
  const draftMd = join(stagingPageDir, 'draft.md');
  const draftTmp = join(stagingPageDir, 'draft.tmp.md');

  if (status === STATUS_WRITING && !existsSync(draftMd) && existsSync(draftTmp)) {
    // Half-flipped. Repair.
    if (!args.dryRun) {
      await writeStatusCell(workbookId, token, rowIdx, STATUS_WAITING, false);
      const stamp = utcStamp();
      renameSync(draftTmp, draftTmp.replace(/\.tmp\.md$/, `.${stamp}.bak.tmp.md`));
    }
    recordPass('catch-up', `row ${rowIdx}: ${STATUS_WRITING} → ${STATUS_WAITING}; draft.tmp.md backed up`);
    await writeRunsRow({
      ...env, dryRun: args.dryRun,
      payload: { phase: 'catch-up', page_id: pageId, catch_up: true },
      status: 'ok', entity: String(pageRow[PAGE_COLS.entity] || ''),
    });
    return EXIT.OK;
  }

  recordWarn('catch-up not needed', `status=${status}, draft.md exists=${existsSync(draftMd)}, draft.tmp.md exists=${existsSync(draftTmp)}`);
  return EXIT.OK;
}

// ============================================================
// resume (spec §3.4)
// ============================================================

async function runResume(args, env) {
  // Check Phase 1 prompt exists + Phase 2 manifest does not → run Phase 2.
  // Codex round 2 C3 defense-in-depth.
  const pageId = assertSafePageId(args.pageId, 'runResume');
  const latestPrompt = findLatestPrompt(args.promptOut, pageId);
  const manifestAbs = join(args.stagingDir, pageId, 'manifest.json');
  if (latestPrompt && !existsSync(manifestAbs)) {
    if (!args.ingestFile) {
      recordFail('resume', new Error('--resume into Phase 2 still requires --ingest-file'));
      return EXIT.CLI;
    }
    args.phase = '2';
    return runPhase2(args, env);
  }
  if (!latestPrompt) {
    recordWarn('resume', 'no Phase 1 prompt found; running Phase 1');
    args.phase = '1';
    return runPhase1(args, env);
  }
  recordWarn('resume', 'Phase 2 already complete; nothing to do');
  return EXIT.OK;
}

// ============================================================
// main
// ============================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(EXIT.OK);
  }
  if (!args.pageId) {
    console.error('ERROR: --page-id required');
    printHelp();
    process.exit(EXIT.CLI);
  }
  // Codex round 2 C3: page_id whitelist (must validate before any path-building).
  if (!PAGE_ID_REGEX.test(args.pageId)) {
    console.error(`ERROR: invalid --page-id "${args.pageId}" — must match ${PAGE_ID_REGEX} (alnum, _, -, length 1..64)`);
    process.exit(EXIT.CLI);
  }

  // Load env (strict mode for new tool — but back-compat in tests where _gg.env may be elsewhere).
  // Test harness uses GG_SHEETS_WORKBOOK_ID = 'fake_workbook' directly, so loadEnv may return null.
  let envPath = null;
  try {
    envPath = loadEnv({ strict: true, requireMode: 0o600 });
  } catch (e) {
    if (e.code === 'EGGSHARED_ENV_MODE') {
      // env-mode error message includes the file path; no secret value leaks since we never
      // dump the env contents — but pipe through formatErr anyway as defence in depth.
      console.error(`ERROR: ${formatErr(e)}`);
      process.exit(EXIT.CLI);
    }
    throw e;
  }
  console.log(`env file:   ${envPath || '(none — using process.env)'}\n`);

  const workbookId = args.workbookId || process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    console.error('ERROR: GG_SHEETS_WORKBOOK_ID missing (set in ~/.config/gg/_gg.env or pass --workbook-id)');
    process.exit(EXIT.CLI);
  }
  // Codex round 2 LOW-2: workbook id format whitelist (skip in test mode where 'fake_workbook' is used).
  if (process.env.GG_SKIP_AUTH !== '1' && !WORKBOOK_ID_REGEX.test(workbookId)) {
    console.error(`ERROR: invalid workbook-id format (must match ${WORKBOOK_ID_REGEX})`);
    process.exit(EXIT.CLI);
  }

  // Token: skip in tests (GG_SKIP_AUTH=1) — tool will use a fake-token stub for Sheets calls.
  let token = null;
  if (process.env.GG_SKIP_AUTH === '1') {
    token = 'fake-token-test-mode';
  } else {
    const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
    try {
      const r = await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']);
      token = r.token;
    } catch (e) {
      console.error(`ERROR: getAccessToken failed: ${formatErr(e)}`);
      process.exit(EXIT.CLI);
    }
  }

  const env = { workbookId, token };

  // Ensure dirs.
  ensureDir(args.stagingDir);
  ensureDir(args.promptOut);
  ensureDir(args.serpDir);

  try {
    let code;
    if (args.catchUp) {
      code = await runCatchUp(args, env);
    } else if (args.resume) {
      code = await runResume(args, env);
    } else if (args.phase === '1') {
      code = await runPhase1(args, env);
    } else if (args.phase === '2') {
      if (!args.ingestFile) {
        console.error('ERROR: Phase 2 requires --ingest-file <path>');
        process.exit(EXIT.CLI);
      }
      code = await runPhase2(args, env);
    } else {
      console.error('ERROR: --phase 1 or --phase 2 required (or use --resume / --catch-up)');
      printHelp();
      process.exit(EXIT.CLI);
    }
    process.exit(code);
  } catch (e) {
    // Codex round 2 H3: every catch flows through formatErr() — never raw e.stack to stdout/stderr.
    console.error(`fatal: ${formatErr(e)}`);
    process.exit(EXIT.FATAL);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-content-draft.mjs');
if (isMain) {
  main();
}

// Exports (for unit tests).
export {
  parseArgs,
  gateCheckPage,
  gateCheckCluster,
  resolveAuthor,
  buildAuthorFrontmatter,
  resolveCta,
  renderPrompt,
  structureCheck,
  loadSerpSnippets,
  entityPassportBlock,
  frictionMineBlock,
  serpSnippetsBlock,
  obsidianRagBlock,
  buildPageRowMap,
  // codex round 2 fixes — exported so smoke tests can directly assert.
  safeField,
  xmlEscape,
  cleanReason,
  formatErr,
  PAGE_COLS,
  CLUSTER_COLS,
  CTA_COLS,
  EXIT,
  PLACEHOLDER_REGEX,
  PAGE_ID_REGEX,
  WORKBOOK_ID_REGEX,
  MAX_REASON_LEN,
  MIN_REASON_LEN,
  SCHEMA_VERSION,
  TOOL_VERSION,
};
