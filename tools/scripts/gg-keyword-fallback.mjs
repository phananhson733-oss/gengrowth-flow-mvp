#!/usr/bin/env node
// gg-keyword-fallback.mjs — GenGrowth MVP W1 zero-baseline keyword discovery
//
// 用法（两阶段）：
//   Phase 1 (社区抓取 → cache + Claude 喂料提示):
//     node tools/scripts/gg-keyword-fallback.mjs --entity "saturn return"
//
//   Phase 2 (读 AI 抽出的 query → DataForSEO → GEO → Sheets):
//     node tools/scripts/gg-keyword-fallback.mjs \
//       --ingest ~/.gg-cache/keyword-fallback-<ts>-step2.json \
//       --entity "saturn return"
//
// flag:
//   --entity <str>            必填（两阶段都要）
//   --ingest <path>           Phase 2：AI 输出的 JSON 文件
//   --dry-run                 不写 Sheets，只 console 输出
//   --target-count <n>        AI 输出目标候选数，默认 20
//   --persona-id <str>        默认 us-women-18-35-tiktok-reddit-entry
//
// spec 来源:
//   wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-keyword-fallback-tool-spec-v1.md
//
// 设计:
//   - 纯 Node 内置（fs/crypto/path/url/os/fetch）
//   - 不调任何 LLM API（wzb 在 Claude Code 会话内手动做 Step 2）
//   - SA: gg-writer-sa.json 写 Sheets, valueInputOption=RAW
//   - WebFetch subdomain 严格 allowlist
//   - DataForSEO 不可用时 graceful degrade，volume=null，GEO=null
//
// 退出码: 0 全绿；1 partial fail；2 fatal

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Shared helpers — single source of truth (codex review 2026-05-21).
// Tool-local re-exports preserved so smoke tests + downstream callers keep working.
import {
  loadEnv,
  getAccessToken,
  gFetch,
  redact,
  redactNote,
  sanitize,
  isAllowedUrl as isAllowedUrlShared,
  validateIngestPath as validateIngestPathShared,
  safeFetch as safeFetchShared,
} from './lib/gg-shared.mjs';

export { loadEnv, getAccessToken, redact, sanitize };

// ============================================================
// constants
// ============================================================
//
// NOTE: Quora removed 2026-05-21 per codex review:
//   anti-scrape + login wall + redirect instability;
//   Reddit + Google SERP sufficient for MVP.

export const ALLOWED_HOSTS = Object.freeze(new Set([
  'old.reddit.com',
  'np.reddit.com',
]));

// Legacy export kept for backward compat with external consumers; mirrors ALLOWED_HOSTS.
export const SUBDOMAIN_ALLOWLIST = Object.freeze([...ALLOWED_HOSTS]);

// ============================================================
// results / logging
// ============================================================

const RESULTS = [];
function recordPass(name, detail) {
  RESULTS.push({ ok: true, name, detail });
  console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function recordFail(name, err, hint) {
  const safeErr = redact(err && err.message ? err.message : err);
  const safeHint = hint == null ? hint : redact(hint);
  RESULTS.push({ ok: false, name, err: safeErr, hint: safeHint });
  console.log(`❌ ${name}`);
  console.log(`   error: ${safeErr}`);
  if (safeHint) console.log(`   hint:  ${safeHint}`);
}
function recordWarn(name, detail) {
  const safeDetail = detail == null ? detail : redact(detail);
  RESULTS.push({ ok: true, warn: true, name, detail: safeDetail });
  console.log(`⚠️  ${name}${safeDetail ? ` — ${safeDetail}` : ''}`);
}

// ============================================================
// tool-local wrappers around shared SSRF / path-traversal guards
// (so tests can call isAllowedUrl(url) without passing ALLOWED_HOSTS each time)
// ============================================================

export function isAllowedUrl(urlString) {
  return isAllowedUrlShared(urlString, ALLOWED_HOSTS);
}

// Legacy alias kept for existing call sites.
export function isUrlAllowed(rawUrl) {
  return isAllowedUrl(rawUrl);
}

export function validateIngestPath(filePath) {
  return validateIngestPathShared(filePath);
}

// Schema validation for ingest payload. Returns sanitised array.
export function validateIngestPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('ingest JSON must be an object with `queries` array');
  }
  const arr = parsed.queries;
  if (!Array.isArray(arr)) {
    throw new Error('ingest.queries must be an array');
  }
  if (arr.length > 100) {
    throw new Error('ingest.queries must be ≤100 items');
  }
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') {
      throw new Error('each query entry must be an object');
    }
    const q = item.query;
    const s = item.source;
    if (typeof q !== 'string' || !q.trim()) {
      throw new Error('query must be a non-empty string');
    }
    if (q.length > 200) {
      throw new Error('query length must be ≤200 chars');
    }
    if (s !== 'reddit' && s !== 'serp') {
      throw new Error(`source must be "reddit" or "serp", got: ${String(s)}`);
    }
    out.push({ query: q.trim(), source: s });
  }
  return out;
}

// ============================================================
// GEO score (exported for tests)
// ============================================================

export function computeGeo({ volume, kd, serpFeatures }) {
  if (volume == null || Number.isNaN(volume)) return null;
  const v = Number(volume);
  const k = kd == null || Number.isNaN(kd) ? 50 : Number(kd);
  const features = Array.isArray(serpFeatures) ? serpFeatures : [];

  const volumeTerm = 0.4 * (v / 1000);
  const kdTerm = 0.3 * (1 - k / 100);
  // log_ranking_chance simplified per spec instruction
  const logRankingChance = 1 - Math.min(k / 100, 1);
  const logTerm = 0.2 * logRankingChance;
  const aiOverview = features.includes('ai_overview') ? 1 : 0;
  const aiTerm = 0.1 * aiOverview;

  return round4(volumeTerm + kdTerm + logTerm + aiTerm);
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// ============================================================
// Phase 1 — community scrape
// ============================================================

// Hardcoded Reddit endpoints (subreddit listings). Tool only reads, never crawls deep.
function redditEndpoints(entity) {
  const q = encodeURIComponent(entity);
  return [
    `https://old.reddit.com/r/AskAstrologers/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=50`,
    `https://old.reddit.com/r/astrology/search.json?q=${q}&restrict_sr=1&sort=top&t=month&limit=50`,
  ];
}

// safeFetch — thin wrapper around shared safeFetch, binding tool-local ALLOWED_HOSTS.
// Any allowlist/redirect failure throws; callers MUST graceful-skip
// (recordWarn + return []) rather than abort the pipeline.
async function safeFetch(url, options = {}) {
  return safeFetchShared(url, ALLOWED_HOSTS, {
    userAgent: 'gg-keyword-fallback/1.0 (+https://astrologywiki.com)',
    ...options,
  });
}

async function scrapeReddit(entity) {
  const out = [];
  for (const url of redditEndpoints(entity)) {
    try {
      const text = await safeFetch(url);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        continue;
      }
      const posts = body?.data?.children || [];
      // Reddit step 1 quota: ~30 posts total (15 per subreddit).
      for (const p of posts.slice(0, 15)) {
        const title = sanitize(p?.data?.title || '');
        const selftext = sanitize(p?.data?.selftext || '').slice(0, 400);
        if (!title) continue;
        out.push({
          source: 'reddit',
          subreddit: p?.data?.subreddit || '',
          title,
          excerpt: selftext,
          url: `https://old.reddit.com${p?.data?.permalink || ''}`,
        });
      }
    } catch (e) {
      recordWarn(`reddit scrape skipped: ${url}`, e.message);
    }
  }
  return out;
}

// SERP scrape: no built-in WebSearch binding here.
// Graceful skip — wzb folds SERP queries into Claude prompt manually.
// Target ~15 SERP entries (post-quora removal): reddit15 + serp15 = 30.
async function scrapeSerp(entity) {
  recordWarn(
    'serp scrape skipped',
    `no built-in WebSearch — wzb can paste Google SERP top-15 + PAA for "${entity}" into Claude prompt manually`,
  );
  return [];
}

// ============================================================
// Phase 1 → cache file
// ============================================================

function cachePath(stamp, step) {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `keyword-fallback-${stamp}-step${step}.json`);
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runPhase1(args) {
  const stamp = ts();
  const entity = args.entity;
  console.log(`Phase 1 — community scrape for entity="${entity}"`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const reddit = await scrapeReddit(entity);
  recordPass('reddit scrape', `${reddit.length} posts`);

  const serp = await scrapeSerp(entity);
  recordPass('serp scrape', `${serp.length} entries (manual fallback)`);

  const corpus = [...reddit, ...serp];
  const cache = cachePath(stamp, 1);
  writeFileSync(
    cache,
    JSON.stringify(
      {
        run_id: stamp,
        entity,
        persona_id: args.personaId,
        target_count: args.targetCount,
        scraped_at: new Date().toISOString(),
        corpus,
      },
      null,
      2,
    ),
  );

  console.log('');
  console.log(`📦 Step 1 cache written: ${cache}`);
  console.log('');
  console.log('NEXT (Step 2 — AI抽 seed query, wzb 手动跑):');
  console.log('  在 Claude Code 会话里贴下面 prompt + 上面 cache 的 corpus 内容：');
  console.log('  ────────────────────────────────────────────────────────');
  console.log(`  从下列社区原文中，抽出普通用户实际会去 Google 搜的 query，`);
  console.log(`  每个 ≤6 词，必须包含 entity "${entity}"。`);
  console.log(`  排除：品牌词、dictionary lookup ("what is ...")。`);
  console.log(`  偏好：困惑/实操/对比型 query。`);
  console.log(`  输出 JSON：{"queries":[{"query":"...","source":"reddit|serp"}, ...]}`);
  console.log(`  目标 ${args.targetCount} 个候选，去重。`);
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  把 Claude 返回的 JSON 存为文件，例如：');
  console.log(`    ${cachePath(stamp, 2)}`);
  console.log('  然后跑 Phase 2：');
  console.log(
    `    node tools/scripts/gg-keyword-fallback.mjs --ingest ${cachePath(stamp, 2)} --entity "${entity}"${
      args.dryRun ? ' --dry-run' : ''
    }`,
  );
  console.log('');
}

// ============================================================
// Phase 2 — DataForSEO + GEO + Sheets
// ============================================================

async function callDataForSEO(queries, login, password) {
  if (!login || !password) {
    return { ok: false, reason: 'GG_DATAFORSEO_LOGIN/PASSWORD not set', data: {} };
  }
  if (!queries.length) return { ok: true, data: {} };

  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const url =
    'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live';
  const payload = [
    {
      location_code: 2840, // United States
      language_code: 'en',
      keywords: queries.slice(0, 200),
      include_serp_info: true,
    },
  ];
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      return { ok: false, reason: redact(`HTTP ${res.status}: ${await res.text()}`), data: {} };
    }
    const json = await res.json();
    const map = {};
    const items = json?.tasks?.[0]?.result || [];
    for (const it of items) {
      if (!it?.keyword) continue;
      map[it.keyword.toLowerCase()] = {
        volume: it.search_volume ?? null,
        cpc: it.cpc ?? null,
        competition: it.competition ?? null,
        // DataForSEO Google Ads endpoint doesn't give KD; we approximate from competition_index
        kd:
          it.competition_index != null
            ? Math.round(it.competition_index)
            : null,
        serpFeatures: extractSerpFeatures(it),
      };
    }
    return { ok: true, data: map };
  } catch (e) {
    return { ok: false, reason: redact(e.message), data: {} };
  }
}

function extractSerpFeatures(it) {
  // Google Ads search_volume payload usually lacks SERP features.
  // Try to surface anything present; default to []
  const feats = [];
  const raw = it?.serp_info?.serp_item_types || it?.serp_features || [];
  if (Array.isArray(raw)) {
    for (const f of raw) feats.push(String(f));
  }
  return feats;
}

// ----- Sheets helpers -----

async function ensureSheet(token, workbookId, sheetTitle, headers) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`,
    token,
  );
  const exists = (meta.sheets || []).some(
    (s) => s.properties?.title === sheetTitle,
  );
  if (!exists) {
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}:batchUpdate`,
      token,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetTitle } } }],
        }),
      },
    );
    // write header row
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(
        sheetTitle + '!A1',
      )}?valueInputOption=RAW`,
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
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(
      `${sheetTitle}!${rangeCols}`,
    )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  );
}

// ----- Phase 2 main -----

async function runPhase2(args) {
  const entity = args.entity;
  const ingestPath = args.ingest;
  console.log(`Phase 2 — DataForSEO + GEO + Sheets`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`entity:  ${entity}`);
  console.log(`ingest:  ${ingestPath}`);
  console.log(`dry-run: ${args.dryRun ? 'YES' : 'no'}`);
  console.log('');

  // 1. load + validate ingest (path-traversal + schema)
  let realIngest;
  try {
    realIngest = validateIngestPath(ingestPath);
  } catch (e) {
    recordFail('validate ingest path', e, 'must be under ~/.gg-cache/, end in .json, ≤1MB');
    return;
  }
  let ingest;
  try {
    ingest = JSON.parse(readFileSync(realIngest, 'utf8'));
  } catch (e) {
    recordFail('parse ingest', e, 'expected JSON: {"queries":[{"query":"...","source":"reddit|serp"}, ...]}');
    return;
  }
  let validated;
  try {
    validated = validateIngestPayload(ingest);
  } catch (e) {
    recordFail('schema ingest', e, 'queries: array ≤100 of {query≤200 chars, source:"reddit"|"serp"}');
    return;
  }
  if (!validated.length) {
    recordFail('ingest content', 'no queries in ingest file', '检查 AI 输出 JSON 格式');
    return;
  }
  // dedupe by query string
  const seen = new Set();
  const uniq = [];
  for (const q of validated) {
    const k = q.query.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(q);
  }
  recordPass('load ingest', `${uniq.length} unique queries`);

  // 2. DataForSEO
  const dfsResult = await callDataForSEO(
    uniq.map((q) => q.query),
    process.env.GG_DATAFORSEO_LOGIN,
    process.env.GG_DATAFORSEO_PASSWORD,
  );
  if (dfsResult.ok) {
    recordPass('DataForSEO volume', `${Object.keys(dfsResult.data).length} keywords resolved`);
  } else {
    recordWarn('DataForSEO graceful skip', dfsResult.reason);
  }

  // 3. GEO score
  const runId = ingest.run_id || ts();
  const candidates = uniq.map((q) => {
    const meta = dfsResult.data[q.query.toLowerCase()] || {};
    const geo = computeGeo({
      volume: meta.volume,
      kd: meta.kd,
      serpFeatures: meta.serpFeatures,
    });
    return {
      runId,
      entity,
      query: q.query,
      source: q.source,
      volume: meta.volume ?? null,
      kd: meta.kd ?? null,
      cpc: meta.cpc ?? null,
      serpFeatures: Array.isArray(meta.serpFeatures)
        ? meta.serpFeatures.join('|')
        : '',
      geo,
    };
  });

  // sort by GEO desc, nulls last
  candidates.sort((a, b) => {
    if (a.geo == null && b.geo == null) return 0;
    if (a.geo == null) return 1;
    if (b.geo == null) return -1;
    return b.geo - a.geo;
  });
  for (let i = 0; i < candidates.length; i++) {
    candidates[i].ai_recommend = i < 5 && candidates[i].geo != null ? '★' : '';
  }
  recordPass('GEO scoring', `${candidates.length} candidates, top5 marked ★`);

  // 4. dry-run output OR write Sheets
  if (args.dryRun) {
    console.log('');
    console.log('=== DRY RUN — Top 10 by GEO ===');
    for (const c of candidates.slice(0, 10)) {
      console.log(
        `  ${c.ai_recommend.padEnd(2)} ${String(c.geo ?? 'null').padEnd(8)} vol=${String(
          c.volume ?? 'null',
        ).padEnd(6)} kd=${String(c.kd ?? 'null').padEnd(4)} | ${c.query}`,
      );
    }
    console.log('');
    recordPass('dry-run', 'Sheets write skipped');
  } else {
    await writeToSheets(candidates, runId, entity);
  }

  // 5. runs log
  if (!args.dryRun) {
    const note = dfsResult.ok ? '' : redactNote(dfsResult.reason);
    await writeRunsLog(candidates, entity, dfsResult.ok ? 'ok' : 'partial', note);
  }
}

// `_runId` / `_entity` are kept on the signature for symmetry with the call site
// and likely future use; per-row values come from `candidates[i].runId/.entity`.
async function writeToSheets(candidates, _runId, _entity) {
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    recordFail('Sheets write', 'GG_SHEETS_WORKBOOK_ID missing', 'set in _gg.env');
    return;
  }
  const writerSa =
    process.env.GG_WRITER_SA_JSON ||
    join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  try {
    const { token } = await getAccessToken(writerSa, [
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
    const SHEET = 'keyword_candidates';
    const HEADERS = [
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
    ];
    await ensureSheet(token, workbookId, SHEET, HEADERS);
    const rows = candidates.map((c) => [
      c.runId,
      c.entity,
      c.query,
      c.source,
      c.volume,
      c.kd,
      c.cpc,
      c.serpFeatures,
      c.geo,
      c.ai_recommend,
      '', // wzb_approve — wzb fills later
    ]);
    const r = await appendRows(token, workbookId, SHEET, 'A:K', rows);
    recordPass(
      'Sheets write keyword_candidates',
      `appended=${r.updates?.updatedRows ?? rows.length}`,
    );
  } catch (e) {
    recordFail('Sheets write keyword_candidates', e, 'verify writer SA has Editor on workbook');
  }
}

async function writeRunsLog(candidates, entity, status, note = '') {
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) return;
  const writerSa =
    process.env.GG_WRITER_SA_JSON ||
    join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  try {
    const { token } = await getAccessToken(writerSa, [
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
    const SHEET = 'runs';
    const HEADERS = ['ts', 'tool', 'entity', 'query_count', 'geo_top5', 'status', 'notes'];
    await ensureSheet(token, workbookId, SHEET, HEADERS);
    const top5 = candidates.slice(0, 5).map((c) => ({ q: c.query, geo: c.geo }));
    const safeNote = note ? redactNote(note) : '';
    const row = [
      new Date().toISOString(),
      'keyword-fallback',
      entity,
      candidates.length,
      JSON.stringify(top5),
      status,
      safeNote,
    ];
    await appendRows(token, workbookId, SHEET, 'A:G', [row]);
    recordPass('runs log append', `status=${status}`);
  } catch (e) {
    recordWarn('runs log append failed', redact(e.message));
  }
}

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const out = {
    entity: null,
    ingest: null,
    dryRun: false,
    smoke: false,
    targetCount: 20,
    personaId: 'us-women-18-35-tiktok-reddit-entry',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entity') out.entity = argv[++i];
    else if (a === '--ingest') out.ingest = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--smoke') out.smoke = true;
    else if (a === '--target-count') out.targetCount = parseInt(argv[++i], 10) || 20;
    else if (a === '--persona-id') out.personaId = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

// Quick DataForSEO connectivity check. Queries the keyword exactly as given
// (typically the entity name), prints volume/KD/CPC, writes nothing.
// Exits 0 if creds + network + API are all healthy, 2 otherwise.
async function runSmoke(args) {
  const entity = args.entity;
  console.log('Phase smoke — DataForSEO 1-query connectivity check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`query:   "${entity}"`);
  console.log('writes:  NONE (smoke test)');
  console.log('');

  const login = process.env.GG_DATAFORSEO_LOGIN;
  const password = process.env.GG_DATAFORSEO_PASSWORD;
  if (!login || !password) {
    console.error('FAIL — GG_DATAFORSEO_LOGIN and/or GG_DATAFORSEO_PASSWORD not set');
    console.error('       expected in ~/.config/gg/_gg.env or shell env');
    process.exit(2);
  }
  console.log(`creds:   GG_DATAFORSEO_LOGIN set (${login.length} chars), password set (${password.length} chars)`);
  console.log('');

  const result = await callDataForSEO([entity], login, password);
  if (!result.ok) {
    console.error(`FAIL — DataForSEO returned error:`);
    console.error(`       ${result.reason}`);
    process.exit(2);
  }

  const meta = result.data[entity.toLowerCase()];
  if (!meta) {
    console.log('OK — API reached, but no volume row for this query (DataForSEO returned 0 rows).');
    console.log('     Possible: keyword has <10 monthly searches in US, or unknown to Google Ads.');
    process.exit(0);
  }

  console.log('OK — DataForSEO live:');
  console.log(`     keyword       : ${entity}`);
  console.log(`     volume        : ${meta.volume ?? '(null)'}`);
  console.log(`     KD (approx)   : ${meta.kd ?? '(null)'}`);
  console.log(`     CPC           : ${meta.cpc ?? '(null)'}`);
  console.log(`     competition   : ${meta.competition ?? '(null)'}`);
  console.log(`     SERP features : ${meta.serpFeatures.length ? meta.serpFeatures.join(', ') : '(none)'}`);
  process.exit(0);
}

function printHelp() {
  console.log(`gg-keyword-fallback.mjs — zero-baseline keyword discovery

Phase 1 (community scrape → Claude feed cache):
  node tools/scripts/gg-keyword-fallback.mjs --entity "saturn return"

Phase 2 (ingest AI output → DataForSEO → GEO → Sheets):
  node tools/scripts/gg-keyword-fallback.mjs \\
    --entity "saturn return" \\
    --ingest ~/.gg-cache/keyword-fallback-<ts>-step2.json [--dry-run]

Smoke test (DataForSEO connectivity check, no Sheets write):
  node tools/scripts/gg-keyword-fallback.mjs --smoke --entity "blue aura"

flags:
  --entity <str>          required
  --ingest <path>         Phase 2 only — AI-produced JSON
  --dry-run               Phase 2 only — skip Sheets writes
  --smoke                 1-query DataForSEO check; prints volume/KD/CPC, writes nothing
  --target-count <n>      default 20
  --persona-id <str>      default us-women-18-35-tiktok-reddit-entry
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const envPath = loadEnv();

  console.log('GenGrowth /gg-keyword-fallback');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`env file:   ${envPath || '(none — relying on shell env)'}`);
  console.log('');

  if (!args.entity) {
    console.error('ERROR: --entity required');
    printHelp();
    process.exit(2);
  }

  try {
    if (args.smoke) {
      await runSmoke(args);
      return; // runSmoke calls process.exit itself
    } else if (args.ingest) {
      await runPhase2(args);
    } else {
      await runPhase1(args);
    }
  } catch (e) {
    console.error('fatal:', redact(e && e.message ? e.message : e));
    process.exit(2);
  }

  // summary
  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (failed.length === 0) {
    console.log(`ALL GREEN (${RESULTS.length}/${RESULTS.length})`);
    process.exit(0);
  } else {
    console.log(
      `${RESULTS.length - failed.length}/${RESULTS.length} passed; ${failed.length} failed — see hints above`,
    );
    process.exit(1);
  }
}

// only run main when invoked as CLI, not when imported by tests
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-keyword-fallback.mjs');
if (isMain) {
  main();
}
