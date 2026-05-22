#!/usr/bin/env node
// gg-friction-mine.mjs — GenGrowth MVP W1 friction (痛点/困惑/误区) 取证
//
// Phase 1 (Reddit 痛点抓 → cache + Claude 喂料提示):
//   node tools/scripts/gg-friction-mine.mjs --entity "saturn return"
// Phase 2 (读 AI 抽出的 friction_pack → schema → Sheets):
//   node tools/scripts/gg-friction-mine.mjs --entity "..." --ingest ~/.gg-cache/friction-mine-<ts>-step2.json
//
// flags: --entity <str>  --ingest <path>  --dry-run  --persona-id <str>
//
// spec: wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-friction-mine-tool-spec-v1.md
// design: pure Node 内置；不调 LLM/SERP API；不爬 Quora（codex v1.1）；exact hostname allowlist；
//         valueInputOption=RAW；helpers 与 gg-keyword-fallback.mjs 同型。
// 退出码: 0 全绿；1 partial；2 fatal

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

// Repo root — friction-mine RAG cache defaults here so gg-render-batch can
// read it from the same path (v0.18: fixes the ~/.gg-cache vs repo .gg-cache
// split that silently dropped real friction data).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const REPO_RAG_DIR = join(REPO, '.gg-cache');
const LEGACY_HOME_RAG_DIR = join(homedir(), '.gg-cache');

// Shared helpers — single source of truth (codex review 2026-05-21).
// Re-export so existing test imports + downstream callers keep working.
import {
  loadEnv,
  getAccessToken,
  gFetch,
  redact,
  redactNote,
  sanitize,
  scrubPII,
  isAllowedUrl as isAllowedUrlShared,
  validateIngestPath as validateIngestPathShared,
  validateWritePath,
  safeFetch as safeFetchShared,
} from './lib/gg-shared.mjs';

export { loadEnv, getAccessToken, redact, sanitize, scrubPII };

// constants — Quora removed per codex v1.1 (scrape/login/redirect 不稳)
export const ALLOWED_HOSTS = Object.freeze(new Set(['old.reddit.com', 'np.reddit.com']));
export const FRICTION_CATEGORIES = Object.freeze(['misconception', 'confusion', 'fear', 'practical_block']);
export const FREQUENCY_LEVELS = Object.freeze(['high', 'medium', 'low']);

const MAX_FRICTION_POINTS = 5;
const MIN_FRICTION_POINTS = 1; // graceful: <3 still accept (warn)
const SUMMARY_MAX = 200;
const QUOTE_MAX = 400;

// RAG cache constants (Phase 0 — for downstream prompt builders).
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const RAG_THEMES_MAX = 8;
const RAG_QUOTE_MAX = 300;
const TARGET_KEYWORD_MAX = 120;

const PAIN_KEYWORDS = [
  'problem', 'sucks', 'terrible', "don't understand", 'dont understand',
  'confused', 'confusing', 'hate', 'frustrated', 'frustrating',
  'why does', "doesn't make sense", 'makes no sense',
  'scared', 'afraid', 'help', 'struggling',
];

// --- results / logging ---

const RESULTS = [];
function recordPass(name, detail) {
  RESULTS.push({ ok: true, name, detail });
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function recordFail(name, err, hint) {
  const safeErr = redact(err && err.message ? err.message : err);
  const safeHint = hint == null ? hint : redact(hint);
  RESULTS.push({ ok: false, name, err: safeErr, hint: safeHint });
  console.log(`❌ ${name}\n   error: ${safeErr}`);
  if (safeHint) console.log(`   hint:  ${safeHint}`);
}
function recordWarn(name, detail) {
  const safeDetail = detail == null ? detail : redact(detail);
  RESULTS.push({ ok: true, warn: true, name, detail: safeDetail });
  console.log(`⚠️  ${name}${safeDetail ? ` — ${safeDetail}` : ''}`);
}

// --- tool-local wrappers around shared SSRF / path-traversal guards ---

export function isAllowedUrl(urlString) {
  return isAllowedUrlShared(urlString, ALLOWED_HOSTS);
}
export function isUrlAllowed(rawUrl) { return isAllowedUrl(rawUrl); }

export function validateIngestPath(filePath) {
  return validateIngestPathShared(filePath);
}

// --- RAG cache helpers (Phase 0 — feeds gg-content-draft prompt builder) ---

/**
 * Validate --page-id against strict slug regex (path-traversal protection).
 * @param {string} pageId
 * @returns {string} the validated pageId (unchanged on success)
 * @throws {Error} if not a slug matching PAGE_ID_REGEX.
 */
export function validatePageId(pageId) {
  if (typeof pageId !== 'string' || !pageId) {
    throw new Error('--page-id required (slug, [A-Za-z0-9_-]{1,64})');
  }
  if (!PAGE_ID_REGEX.test(pageId)) {
    throw new Error(`--page-id must match ${PAGE_ID_REGEX} (got: ${pageId.slice(0, 40)})`);
  }
  return pageId;
}

/**
 * Build the RAG payload from validated friction_points + step1 corpus.
 * Pure function — no fs writes — exported for unit tests.
 *
 * @param {object} args
 * @param {string} args.pageId
 * @param {string} args.entity
 * @param {string} args.targetKeyword
 * @param {object[]} args.frictionPoints  validated points from validateFrictionPack
 * @param {object[]} [args.corpus]        step1 reddit posts (for mention_count)
 * @returns {object} RAG schema (schema_version="1")
 */
export function buildRagPayload({ pageId, entity, targetKeyword, frictionPoints, corpus = [] }) {
  const auditByType = {};
  const themes = frictionPoints.slice(0, RAG_THEMES_MAX).map((p, idx) => {
    const scrubbed = scrubPII(p.quote);
    for (const t of scrubbed.matches) auditByType[t] = (auditByType[t] || 0) + 1;
    let domain = '';
    try { domain = new URL(p.source_url).hostname; } catch { /* leave empty */ }
    const mention_count = countMentions(p.category, corpus);
    return {
      theme: p.category,
      scrubbed_quote: scrubbed.text.slice(0, RAG_QUOTE_MAX),
      source_id: `reddit#${idx + 1}`,
      domain,
      mention_count,
    };
  });
  const total_redactions = Object.values(auditByType).reduce((a, b) => a + b, 0);
  return {
    schema_version: '1',
    page_id: pageId,
    entity,
    target_keyword: targetKeyword || '',
    generated_at: new Date().toISOString(),
    themes,
    pii_audit: { total_redactions, by_type: auditByType },
  };
}

// Best-effort mention_count: count step1 corpus posts whose title+excerpt+top_comment
// contains a substring keyword for the theme category. Substring buckets keep
// the heuristic simple (no LLM) and reproducible.
const THEME_KEYWORDS = Object.freeze({
  misconception: ['think', 'thought', 'assumed', 'misread', 'misunderstand'],
  confusion: ['confused', 'confusing', "don't understand", 'dont understand', 'unclear'],
  fear: ['scared', 'afraid', 'fear', 'anxious', 'worried'],
  practical_block: ['how do i', 'how to', 'help', 'stuck', 'struggling'],
});

function countMentions(category, corpus) {
  const kws = THEME_KEYWORDS[category] || [];
  if (!Array.isArray(corpus) || corpus.length === 0 || kws.length === 0) return 0;
  let n = 0;
  for (const post of corpus) {
    const blob = `${post?.title || ''} ${post?.excerpt || ''} ${post?.top_comment || ''}`.toLowerCase();
    for (const kw of kws) {
      if (blob.includes(kw)) { n++; break; }
    }
  }
  return n;
}

// ============================================================
// friction_pack schema (exported)
//   Returns { valid, skipped, entity }.
//   Missing/invalid source_url → graceful skip (warn), NOT throw.
//   Top-level structural errors → throw.
// ============================================================

export function validateFrictionPack(parsed, _entity) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('friction_pack JSON must be an object');
  }
  if (typeof parsed.entity !== 'string' || !parsed.entity.trim()) {
    throw new Error('friction_pack.entity must be a non-empty string');
  }
  const arr = parsed.friction_points;
  if (!Array.isArray(arr)) throw new Error('friction_pack.friction_points must be an array');
  if (arr.length === 0) throw new Error('friction_pack.friction_points is empty');
  if (arr.length > MAX_FRICTION_POINTS) {
    throw new Error(`friction_pack.friction_points must be ≤${MAX_FRICTION_POINTS}`);
  }
  const valid = [];
  const skipped = [];
  for (let i = 0; i < arr.length; i++) {
    const p = arr[i];
    const reason = validateOnePoint(p, i);
    if (reason) {
      let raw;
      try { raw = JSON.stringify(p); } catch { raw = String(p); }
      skipped.push({ index: i, reason, raw: raw.slice(0, 200) });
      continue;
    }
    valid.push({
      category: p.category,
      summary: sanitize(p.summary).slice(0, SUMMARY_MAX),
      quote: sanitize(p.quote).slice(0, QUOTE_MAX),
      source_url: p.source_url,
      frequency_estimate: p.frequency_estimate,
    });
  }
  if (valid.length < MIN_FRICTION_POINTS) {
    throw new Error(
      `friction_pack: only ${valid.length} valid points after schema check (need ≥${MIN_FRICTION_POINTS})`,
    );
  }
  return { valid, skipped, entity: parsed.entity };
}

function validateOnePoint(p, i) {
  if (!p || typeof p !== 'object') return `point[${i}] not an object`;
  if (!FRICTION_CATEGORIES.includes(p.category)) {
    return `point[${i}].category must be one of ${FRICTION_CATEGORIES.join('|')}, got: ${String(p.category)}`;
  }
  if (typeof p.summary !== 'string' || !p.summary.trim()) {
    return `point[${i}].summary must be non-empty string`;
  }
  if (p.summary.length > SUMMARY_MAX * 2) return `point[${i}].summary too long`;
  if (typeof p.quote !== 'string' || !p.quote.trim()) {
    return `point[${i}].quote must be non-empty string`;
  }
  if (p.quote.length > QUOTE_MAX * 2) return `point[${i}].quote too long`;
  if (typeof p.source_url !== 'string' || !p.source_url) {
    return `point[${i}].source_url missing (graceful skip)`;
  }
  if (!isAllowedUrl(p.source_url)) {
    return `point[${i}].source_url not in allowlist: ${p.source_url}`;
  }
  if (!FREQUENCY_LEVELS.includes(p.frequency_estimate)) {
    return `point[${i}].frequency_estimate must be one of ${FREQUENCY_LEVELS.join('|')}, got: ${String(p.frequency_estimate)}`;
  }
  return null;
}

export function topCategory(points) {
  if (!points.length) return '';
  const counts = {};
  for (const p of points) counts[p.category] = (counts[p.category] || 0) + 1;
  let best = ''; let n = -1;
  for (const [cat, c] of Object.entries(counts)) {
    if (c > n) { best = cat; n = c; }
  }
  return best;
}

// --- Phase 1 — Reddit pain scrape ---

function redditEndpoints(entity) {
  const q = encodeURIComponent(entity);
  return [
    `https://old.reddit.com/r/AskAstrologers/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=50`,
    `https://old.reddit.com/r/astrology/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=50`,
  ];
}

function commentEndpoint(permalink) {
  if (!permalink) return null;
  const url = `https://old.reddit.com${permalink}.json?limit=2`;
  return isAllowedUrl(url) ? url : null;
}

async function safeFetch(url, options = {}) {
  return safeFetchShared(url, ALLOWED_HOSTS, {
    userAgent: 'gg-friction-mine/1.0 (+https://astrologywiki.com)',
    ...options,
  });
}

function hasPainSignal(text) {
  if (!text) return false;
  const low = text.toLowerCase();
  for (const kw of PAIN_KEYWORDS) if (low.includes(kw)) return true;
  return false;
}

async function fetchTopComment(permalink) {
  const url = commentEndpoint(permalink);
  if (!url) return '';
  try {
    const text = await safeFetch(url);
    const body = JSON.parse(text);
    const commentListing = Array.isArray(body) ? body[1] : null;
    const children = commentListing?.data?.children || [];
    for (const c of children) {
      const b = c?.data?.body;
      if (typeof b === 'string' && b.trim() && b !== '[deleted]' && b !== '[removed]') {
        return sanitize(b).slice(0, 300);
      }
    }
  } catch { /* graceful — comments are bonus */ }
  return '';
}

async function scrapeRedditPain(entity, { maxTotal = 30, includeComments = true } = {}) {
  const out = [];
  for (const url of redditEndpoints(entity)) {
    if (out.length >= maxTotal) break;
    try {
      const text = await safeFetch(url);
      let body;
      try { body = JSON.parse(text); } catch { continue; }
      const posts = body?.data?.children || [];
      let perSub = 0;
      for (const p of posts) {
        if (out.length >= maxTotal) break;
        if (perSub >= 15) break;
        const title = sanitize(p?.data?.title || '');
        const selftext = sanitize(p?.data?.selftext || '').slice(0, 400);
        const permalink = p?.data?.permalink || '';
        if (!title) continue;
        if (!hasPainSignal(title) && !hasPainSignal(selftext)) continue;
        const entry = {
          source: 'reddit',
          subreddit: p?.data?.subreddit || '',
          title, excerpt: selftext,
          url: `https://old.reddit.com${permalink}`,
          top_comment: '',
        };
        if (includeComments && permalink) {
          entry.top_comment = await fetchTopComment(permalink);
        }
        out.push(entry);
        perSub++;
      }
    } catch (e) {
      recordWarn(`reddit scrape skipped: ${url}`, e.message);
    }
  }
  return out;
}

// --- Phase 1 → cache ---

function cachePath(stamp, suffix) {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `friction-mine-${stamp}-${suffix}.json`);
}

function ts() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function runPhase1(args) {
  const stamp = ts();
  const entity = args.entity;
  console.log(`Phase 1 — Reddit pain scrape for entity="${entity}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const reddit = await scrapeRedditPain(entity);
  recordPass('reddit pain scrape', `${reddit.length} posts (pain-filtered)`);
  recordWarn(
    'serp scrape skipped',
    `no built-in WebSearch — wzb can paste Google SERP top-10 + PAA for "${entity}" "I'm confused"|"why does"|"doesn't make sense" into Claude prompt manually`,
  );

  const cache = cachePath(stamp, 'step1');
  writeFileSync(cache, JSON.stringify({
    run_id: stamp, entity, persona_id: args.personaId,
    scraped_at: new Date().toISOString(),
    corpus: reddit,
  }, null, 2));

  console.log('');
  console.log(`📦 Step 1 cache written: ${cache}`);
  console.log('');
  console.log('NEXT (Phase 2 — AI 抽 friction 点, wzb 在 Claude 会话内手跑):');
  console.log('  贴下面 prompt + cache 内容 + 你手粘的 Google SERP：');
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  从下列原文抽出 3-5 个最有代表性的 friction（痛点/困惑/误区/操作障碍），针对 entity "${entity}"。`);
  console.log(`  每个 friction 必须含：`);
  console.log(`    category ∈ {misconception, confusion, fear, practical_block}`);
  console.log(`    summary ≤100字 | quote 原文≤200字 | source_url（reddit URL）| frequency_estimate ∈ {high,medium,low}`);
  console.log(`  输出 JSON：{"entity":"${entity}","friction_points":[...]}`);
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  把 Claude 返回的 JSON 存到：');
  console.log(`    ${cachePath(stamp, 'step2')}`);
  console.log('  然后跑 Phase 2：');
  console.log(
    `    node tools/scripts/gg-friction-mine.mjs --ingest ${cachePath(stamp, 'step2')} --entity "${entity}"${args.dryRun ? ' --dry-run' : ''}`,
  );
  console.log('');

  if (reddit.length === 0) {
    recordWarn('zero pain posts', 'Reddit returned 0 pain-filtered posts → fallback to wzb 手抓 per spec §5');
  }
}

// --- Phase 2 — ingest → friction_pack.json + Sheets ---

async function ensureSheet(token, workbookId, sheetTitle, headers) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`,
    token,
  );
  const exists = (meta.sheets || []).some((s) => s.properties?.title === sheetTitle);
  if (!exists) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`, token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requests: [{ addSheet: { properties: { title: sheetTitle } } }] }),
      },
    );
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(sheetTitle + '!A1')}?valueInputOption=RAW`,
      token,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: [headers] }),
      },
    );
  }
}

async function appendRows(token, workbookId, sheetTitle, rangeCols, rows) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${sheetTitle}!${rangeCols}`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  );
}

// Resolve the RAG cache root. Priority:
//   1. CLI --rag-dir <path>      (per-run override)
//   2. env GG_FRICTION_RAG_DIR   (per-machine config)
//   3. repo .gg-cache/           (default — matches what gg-render-batch reads)
// Legacy ~/.gg-cache/ is allowed too (back-compat) but no longer the default.
export function resolveRagRoot(args) {
  const cli = args && (args.ragDir || args.rag_dir);
  if (cli) return String(cli);
  if (process.env.GG_FRICTION_RAG_DIR) return process.env.GG_FRICTION_RAG_DIR;
  return REPO_RAG_DIR;
}

// Write the PII-scrubbed RAG cache for downstream prompt builders.
// validatePageId + validateWritePath jail prevent path-traversal escape.
function writeRagCache(args, validPoints, step1Ingest) {
  const pageId = validatePageId(args.pageId);
  const ragRootRaw = resolveRagRoot(args);
  if (!existsSync(ragRootRaw)) mkdirSync(ragRootRaw, { recursive: true });
  const ragDir = join(ragRootRaw, pageId);
  const ragPath = join(ragDir, 'friction-mine.rag.json');
  // Jail: allow chosen root + legacy home-dir root (so older configs keep working)
  // + repo root (default). Path-traversal still blocked by validateWritePath.
  const allowedDirs = [ragRootRaw];
  if (!allowedDirs.includes(REPO_RAG_DIR)) allowedDirs.push(REPO_RAG_DIR);
  if (!allowedDirs.includes(LEGACY_HOME_RAG_DIR)) allowedDirs.push(LEGACY_HOME_RAG_DIR);
  const { abs } = validateWritePath(ragPath, {
    allowedDirs,
    allowedExtensions: ['.json'],
    mustCreateParent: true,
  });
  const payload = buildRagPayload({
    pageId,
    entity: args.entity,
    targetKeyword: args.targetKeyword || '',
    frictionPoints: validPoints,
    corpus: Array.isArray(step1Ingest?.corpus) ? step1Ingest.corpus : [],
  });
  writeFileSync(abs, JSON.stringify(payload, null, 2));
  recordPass(
    'write rag cache',
    `${abs} (${payload.themes.length} themes, ${payload.pii_audit.total_redactions} redactions)`,
  );
}

async function runPhase2(args) {
  const entity = args.entity;
  const ingestPath = args.ingest;
  console.log(`Phase 2 — friction_pack ingest + Sheets`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`entity:  ${entity}\ningest:  ${ingestPath}\ndry-run: ${args.dryRun ? 'YES' : 'no'}\n`);

  let realIngest;
  try { realIngest = validateIngestPath(ingestPath); }
  catch (e) {
    recordFail('validate ingest path', e, 'must be under ~/.gg-cache/, end in .json, ≤1MB');
    return;
  }

  let ingest;
  try { ingest = JSON.parse(readFileSync(realIngest, 'utf8')); }
  catch (e) {
    recordFail('parse ingest', e, 'expected JSON: {"entity":"...","friction_points":[...]}');
    return;
  }

  let result;
  try { result = validateFrictionPack(ingest, entity); }
  catch (e) {
    recordFail(
      'schema friction_pack', e,
      'expected: {entity, friction_points:[{category, summary, quote, source_url, frequency_estimate}]} — 1..5',
    );
    return;
  }
  recordPass('schema friction_pack', `${result.valid.length} valid / ${result.skipped.length} skipped`);
  for (const s of result.skipped) recordWarn(`friction point skipped[${s.index}]`, s.reason);

  const runId = ingest.run_id || ts();
  const outPath = cachePath(ts(), 'out');
  const frictionPack = {
    run_id: runId, entity,
    persona_id: args.personaId,
    generated_at: new Date().toISOString(),
    friction_points: result.valid,
  };
  writeFileSync(outPath, JSON.stringify(frictionPack, null, 2));
  recordPass('write friction_pack.json', outPath);

  // Phase 0 RAG cache — feeds gg-content-draft prompt builder so it doesn't
  // fabricate "common misreadings" out of thin air.
  if (args.forRag) {
    try { writeRagCache(args, result.valid, ingest); }
    catch (e) { recordFail('write rag cache', e, 'verify --page-id slug + .gg-cache writable'); }
  }

  const top = topCategory(result.valid);

  if (args.dryRun) {
    console.log('\n=== DRY RUN — friction_pack summary ===');
    console.log(`entity:            ${entity}`);
    console.log(`friction_count:    ${result.valid.length}`);
    console.log(`top_category:      ${top}`);
    console.log(`skipped_count:     ${result.skipped.length}\n`);
    for (const p of result.valid) {
      console.log(`  [${p.category.padEnd(15)}] freq=${p.frequency_estimate.padEnd(6)} — ${p.summary.slice(0, 80)}`);
    }
    console.log('');
    recordPass('dry-run', 'Sheets write skipped');
    return;
  }

  await writeToSheets(frictionPack, top, outPath);
  const status = result.skipped.length > 0 ? 'partial' : 'ok';
  const note = result.skipped.length > 0 ? `${result.skipped.length} points skipped (schema)` : '';
  await writeRunsLog(entity, result.valid.length, top, status, note);
}

async function writeToSheets(frictionPack, top, filePath) {
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    recordFail('Sheets write', 'GG_SHEETS_WORKBOOK_ID missing', 'set in _gg.env');
    return;
  }
  const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  try {
    const { token } = await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']);
    const SHEET = 'friction_packs';
    const HEADERS = ['ts', 'entity', 'friction_count', 'top_category', 'file_path', 'status', 'notes'];
    await ensureSheet(token, workbookId, SHEET, HEADERS);
    const row = [
      new Date().toISOString(),
      frictionPack.entity,
      frictionPack.friction_points.length,
      top, filePath, 'ok', '',
    ];
    const r = await appendRows(token, workbookId, SHEET, 'A:G', [row]);
    recordPass('Sheets write friction_packs', `appended=${r.updates?.updatedRows ?? 1}`);
  } catch (e) {
    recordFail('Sheets write friction_packs', e, 'verify writer SA has Editor on workbook');
  }
}

async function writeRunsLog(entity, count, top, status, note = '') {
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) return;
  const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  try {
    const { token } = await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']);
    const SHEET = 'runs';
    const HEADERS = ['ts', 'tool', 'entity', 'friction_count', 'top_category', 'status', 'notes'];
    await ensureSheet(token, workbookId, SHEET, HEADERS);
    const safeNote = note ? redactNote(note) : '';
    const row = [new Date().toISOString(), 'friction-mine', entity, count, top, status, safeNote];
    await appendRows(token, workbookId, SHEET, 'A:G', [row]);
    recordPass('runs log append', `status=${status}`);
  } catch (e) {
    recordWarn('runs log append failed', redact(e.message));
  }
}

// --- CLI ---

function parseArgs(argv) {
  const out = {
    entity: null, ingest: null, dryRun: false,
    personaId: 'us-women-18-35-tiktok-reddit-entry',
    pageId: null, targetKeyword: null, forRag: false,
    ragDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entity') out.entity = argv[++i];
    else if (a === '--ingest') out.ingest = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--persona-id') out.personaId = argv[++i];
    else if (a === '--page-id') out.pageId = argv[++i];
    else if (a === '--target-keyword') {
      const raw = argv[++i] || '';
      out.targetKeyword = sanitize(raw).slice(0, TARGET_KEYWORD_MAX);
    }
    else if (a === '--for-rag') out.forRag = true;
    else if (a === '--rag-dir') out.ragDir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-friction-mine.mjs — Reddit-sourced friction 取证

Phase 1 (Reddit pain scrape → cache + Claude prompt):
  node tools/scripts/gg-friction-mine.mjs --entity "saturn return"

Phase 2 (ingest AI friction_pack → schema → Sheets):
  node tools/scripts/gg-friction-mine.mjs --entity "saturn return" \\
    --ingest ~/.gg-cache/friction-mine-<ts>-step2.json [--dry-run]

flags:
  --entity <str>           required
  --ingest <path>          Phase 2 — AI-produced friction_pack JSON
  --dry-run                Phase 2 — skip Sheets writes
  --persona-id <str>       default us-women-18-35-tiktok-reddit-entry
  --page-id <slug>         Phase 2 — required with --for-rag, [A-Za-z0-9_-]{1,64}
  --target-keyword <str>   Phase 2 — context stored in RAG cache (<=120 chars)
  --for-rag                Phase 2 — also write <rag-dir>/{page_id}/friction-mine.rag.json
  --rag-dir <path>         override RAG output root (default: <repo>/.gg-cache/)
                           env GG_FRICTION_RAG_DIR also honored
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  const envPath = loadEnv();
  console.log('GenGrowth /gg-friction-mine');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`env file:   ${envPath || '(none — relying on shell env)'}\n`);

  if (!args.entity) {
    console.error('ERROR: --entity required');
    printHelp();
    process.exit(2);
  }

  if (args.forRag && !args.pageId) {
    console.error('ERROR: --for-rag requires --page-id <slug>');
    printHelp();
    process.exit(2);
  }

  try {
    if (args.ingest) await runPhase2(args);
    else await runPhase1(args);
  } catch (e) {
    console.error('fatal:', redact(e && e.message ? e.message : e));
    process.exit(2);
  }

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (failed.length === 0) {
    console.log(`ALL GREEN (${RESULTS.length}/${RESULTS.length})`);
    process.exit(0);
  } else {
    console.log(`${RESULTS.length - failed.length}/${RESULTS.length} passed; ${failed.length} failed — see hints above`);
    process.exit(1);
  }
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-friction-mine.mjs');
if (isMain) { main(); }
