#!/usr/bin/env node
// gg-entity-passport.mjs — GenGrowth entity 主权搜证 (v1.2 — 13-source scrape).
// Phase 1: scrape sources → cache + RAG json. Phase 2: ingest AI-produced JSON →
// entity_passport.json + Sheets. URL builders / placeholder filter / retry /
// UA rotation live in ./lib/entity-passport-sources.mjs.
// Spec: wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-entity-passport-tool-spec-v1.md
// Exit codes: 0 all-pass, 1 partial, 2 fatal.

import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Shared helpers — single source of truth (codex review 2026-05-21).
// Re-export so existing test imports + downstream callers keep working.
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
  validateWritePath,
} from './lib/gg-shared.mjs';

// Source builders, placeholder filter, retry + UA rotation (v1.2 — 2026-05-21).
import {
  ALLOWED_HOSTS as EXPANDED_ALLOWED_HOSTS,
  wikipediaUrl as buildWikipediaUrl,
  wikipediaSearchUrl,
  astrodienstUrl as buildAstrodienstUrl,
  cafeAstrologyArticleUrl,
  cafeAstrologySearchUrl,
  chaniUrl as buildChaniUrl,
  redditSearchUrls as buildRedditSearchUrls,
  mindbodygreenUrl,
  healthlineUrl,
  wellandgoodUrl,
  gaiaUrl,
  energymuseUrl,
  psychologyTodayUrl,
  astrotwinsUrl,
  allureUrl,
  filterPlaceholderSnippets,
  withRetry,
  userAgentFor,
} from './lib/entity-passport-sources.mjs';

export { loadEnv, getAccessToken, redact, sanitize };

// Phase 0 RAG cache (.gg-cache/{page_id}/entity-passport.rag.json) — consumed
// by gg-content-draft.mjs prompt builder. PAGE_ID_REGEX mirrors gg-content-draft.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const RAG_CACHE_DIR = join(REPO_ROOT, '.gg-cache');
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
export const RAG_MAX_SNIPPETS = 12;
export const RAG_MAX_TEXT_CHARS = 500;
export const RAG_SCHEMA_VERSION = '1';

// v1.2: 15 hosts (original 6 + 9 aura/wellness). See lib/entity-passport-sources.mjs.
export const ALLOWED_HOSTS = EXPANDED_ALLOWED_HOSTS;

export const REQUIRED_ANGLES = Object.freeze([
  'definition',
  'mechanism',
  'individual_application',
  'cultural_context',
  'critique',
]);

// Known source names (ingest accepts these without "unknown source" warning).
const KNOWN_SOURCE_NAMES = Object.freeze(new Set([
  'wikipedia',
  'astrodienst',
  'reddit',
  'cafe_astrology',
  'chani_nicholas',
  'mindbodygreen',
  'healthline',
  'wellandgood',
  'gaia',
  'energymuse',
  'psychology_today',
  'astrotwins',
  'allure',
]));

// SOURCE_COUNT = number of automated sources fetched. v1.2 bumped 5 → 13.
export const SOURCE_COUNT = 13;

// --- results / logging ---

const RESULTS = [];
function recordPass(name, detail) {
  RESULTS.push({ ok: true, name, detail });
  console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}
function recordFail(name, err, hint) {
  const safeErr = redact(err && err.message ? err.message : err);
  const safeHint = hint == null ? hint : redact(hint);
  RESULTS.push({ ok: false, name, err: safeErr, hint: safeHint });
  console.log(`FAIL ${name}`);
  console.log(`   error: ${safeErr}`);
  if (safeHint) console.log(`   hint:  ${safeHint}`);
}
function recordWarn(name, detail) {
  const safeDetail = detail == null ? detail : redact(detail);
  RESULTS.push({ ok: true, warn: true, name, detail: safeDetail });
  console.log(`WARN ${name}${safeDetail ? ` — ${safeDetail}` : ''}`);
}

// Tool-local wrappers around shared SSRF / path-traversal guards.
export function isAllowedUrl(urlString) {
  return isAllowedUrlShared(urlString, ALLOWED_HOSTS);
}
export function validateIngestPath(filePath) {
  return validateIngestPathShared(filePath);
}

// Schema validation for ingest payload (AI-produced JSON). Returns sanitised passport.
export function validateIngestPayload(parsed, expectedEntity) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('ingest JSON must be an object');
  }
  if (typeof parsed.entity !== 'string' || !parsed.entity.trim()) {
    throw new Error('ingest.entity must be a non-empty string');
  }
  if (expectedEntity && parsed.entity.trim().toLowerCase() !== expectedEntity.toLowerCase()) {
    throw new Error(`ingest.entity "${parsed.entity}" does not match CLI --entity "${expectedEntity}"`);
  }
  if (parsed.passport_version !== 1) {
    throw new Error('ingest.passport_version must be 1');
  }
  if (!Array.isArray(parsed.sources)) {
    throw new Error('ingest.sources must be an array');
  }
  // v1.2 (2026-05-21): 13 automated sources + optional 1 wzb-supplied = 14 max.
  if (parsed.sources.length === 0 || parsed.sources.length > 14) {
    throw new Error('ingest.sources must have 1-14 entries (13 automated + optional wzb 14th)');
  }
  const cleanSources = [];
  for (const src of parsed.sources) {
    if (!src || typeof src !== 'object') {
      throw new Error('each source must be an object');
    }
    if (typeof src.name !== 'string' || !src.name.trim()) {
      throw new Error('source.name must be a non-empty string');
    }
    if (typeof src.url !== 'string' || !src.url.trim()) {
      throw new Error(`source ${src.name}: url must be a non-empty string`);
    }
    if (!Array.isArray(src.snippets)) {
      throw new Error(`source ${src.name}: snippets must be an array`);
    }
    if (src.snippets.length > 20) {
      throw new Error(`source ${src.name}: snippets >20`);
    }
    for (const s of src.snippets) {
      if (typeof s !== 'string') {
        throw new Error(`source ${src.name}: snippet must be a string`);
      }
      if (s.length > 2000) {
        throw new Error(`source ${src.name}: snippet >2000 chars`);
      }
    }
    cleanSources.push({
      name: src.name.trim(),
      url: src.url.trim(),
      snippets: src.snippets.map((s) => sanitize(s)),
      fetched_at: typeof src.fetched_at === 'string' ? src.fetched_at : null,
    });
  }
  if (!parsed.angles || typeof parsed.angles !== 'object' || Array.isArray(parsed.angles)) {
    throw new Error('ingest.angles must be an object');
  }
  const cleanAngles = {};
  let filledAngleCount = 0;
  for (const key of REQUIRED_ANGLES) {
    const v = parsed.angles[key];
    if (v == null || v === '') {
      cleanAngles[key] = '';
      continue;
    }
    if (typeof v !== 'string') {
      throw new Error(`angles.${key} must be a string`);
    }
    if (v.length > 2000) {
      throw new Error(`angles.${key} >2000 chars`);
    }
    cleanAngles[key] = sanitize(v);
    filledAngleCount++;
  }
  // reject extra unknown angle keys (schema strictness)
  for (const k of Object.keys(parsed.angles)) {
    if (!REQUIRED_ANGLES.includes(k)) {
      throw new Error(`angles.${k} is not a known angle (allowed: ${REQUIRED_ANGLES.join(', ')})`);
    }
  }
  const seventh = parsed.wzb_seventh_source;
  if (seventh != null && typeof seventh !== 'string') {
    throw new Error('wzb_seventh_source must be a string or null');
  }
  return {
    entity: parsed.entity.trim(),
    passport_version: 1,
    sources: cleanSources,
    angles: cleanAngles,
    source_count_used: cleanSources.length,
    angle_coverage: `${filledAngleCount}/${REQUIRED_ANGLES.length}`,
    wzb_seventh_source: seventh ?? null,
  };
}

// safeFetch wraps the shared SSRF-protected fetch, binding ALLOWED_HOSTS and
// rotating UA per source name to reduce anti-bot triggering.
async function safeFetch(url, options = {}) {
  const sourceName = options.sourceName || 'gg-entity-passport';
  return safeFetchShared(url, ALLOWED_HOSTS, {
    userAgent: userAgentFor(sourceName),
    ...options,
  });
}

// crude HTML → text: strip script/style + tags + collapse whitespace.
export function htmlToSnippets(html, maxSnippets = 5, maxLen = 800) {
  let cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  // split into rough paragraphs by sentence-ish runs
  const chunks = [];
  while (cleaned.length > 0 && chunks.length < maxSnippets) {
    chunks.push(cleaned.slice(0, maxLen));
    cleaned = cleaned.slice(maxLen);
  }
  return chunks.map((c) => sanitize(c.trim())).filter(Boolean);
}

// Re-exports for back-compat with existing test imports / external callers.
export const wikipediaUrl = buildWikipediaUrl;
export const astrodienstUrl = buildAstrodienstUrl;
export const chaniUrl = buildChaniUrl;
export const redditSearchUrls = buildRedditSearchUrls;
export const cafeAstrologyUrl = cafeAstrologySearchUrl;

// Wrap a fetcher with retry + post-fetch placeholder filter. Returns a
// uniform { name, url, snippets, fetched_at, status, error? } record.
async function fetchHtmlSource(name, url, options = {}) {
  const attemptUrls = Array.isArray(options.fallbackUrls)
    ? [url, ...options.fallbackUrls]
    : [url];
  let lastErr;
  for (const tryUrl of attemptUrls) {
    try {
      const html = await withRetry(
        () => safeFetch(tryUrl, { sourceName: name }),
        { maxAttempts: 3 },
      );
      const rawSnippets = htmlToSnippets(html, 5, 800);
      const snippets = filterPlaceholderSnippets(rawSnippets);
      if (snippets.length === 0) {
        // If raw had content but all got filtered → anti-bot. Otherwise: empty page.
        if (rawSnippets.length > 0) {
          recordWarn(`${name} anti-bot`, `url=${tryUrl}`);
          // try next fallback URL if any
          lastErr = new Error('anti-bot detected (all snippets filtered)');
          continue;
        }
        recordWarn(`${name} empty`, `url=${tryUrl}`);
        return { name, url: tryUrl, snippets: [], fetched_at: new Date().toISOString(), status: 'empty' };
      }
      recordPass(`${name} fetch`, `${snippets.length} snippets`);
      return { name, url: tryUrl, snippets, fetched_at: new Date().toISOString(), status: 'ok' };
    } catch (e) {
      lastErr = e;
      // 404 is permanent — don't waste a fallback unless caller explicitly listed one.
      // For all other errors (5xx, network) withRetry already retried internally.
      // Move on to next fallback URL if any.
    }
  }
  recordWarn(`${name} fetch skipped`, lastErr?.message || 'unknown error');
  return {
    name,
    url,
    snippets: [],
    fetched_at: new Date().toISOString(),
    status: 'fail',
    error: redactNote(lastErr),
  };
}

async function fetchReddit(entity) {
  const collected = [];
  const urls = redditSearchUrls(entity);
  for (const url of urls) {
    try {
      const text = await withRetry(
        () => safeFetch(url, { sourceName: 'reddit' }),
        { maxAttempts: 3 },
      );
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        continue;
      }
      const posts = body?.data?.children || [];
      for (const p of posts.slice(0, 5)) {
        const title = sanitize(p?.data?.title || '');
        const selftext = sanitize(p?.data?.selftext || '').slice(0, 600);
        if (!title) continue;
        collected.push(`[r/${p?.data?.subreddit || ''}] ${title}${selftext ? ' — ' + selftext : ''}`);
      }
    } catch (e) {
      recordWarn(`reddit fetch skipped: ${url}`, e.message);
    }
  }
  const filtered = filterPlaceholderSnippets(collected);
  if (filtered.length === 0) {
    return { name: 'reddit', url: urls[0], snippets: [], fetched_at: new Date().toISOString(), status: 'fail' };
  }
  recordPass('reddit fetch', `${filtered.length} posts`);
  return {
    name: 'reddit',
    url: urls[0],
    snippets: filtered,
    fetched_at: new Date().toISOString(),
    status: 'ok',
  };
}

// Wikipedia with search-results fallback (v1.2).
async function fetchWikipedia(entity) {
  return fetchHtmlSource('wikipedia', buildWikipediaUrl(entity), {
    fallbackUrls: [wikipediaSearchUrl(entity)],
  });
}

// cafe_astrology with article→search fallback (v1.2). The slug guess is
// historically wrong; the search page is more reliable.
async function fetchCafeAstrology(entity) {
  return fetchHtmlSource('cafe_astrology', cafeAstrologyArticleUrl(entity), {
    fallbackUrls: [cafeAstrologySearchUrl(entity)],
  });
}

async function fetchAllSources(entity) {
  // v1.2 (2026-05-21): expanded from 5 → 13 automated sources.
  // wzb may still add an optional 14th manually via wzb_seventh_source.
  const jobs = [
    fetchWikipedia(entity),
    fetchHtmlSource('astrodienst', buildAstrodienstUrl(entity)),
    fetchCafeAstrology(entity),
    fetchHtmlSource('chani_nicholas', buildChaniUrl(entity)),
    fetchHtmlSource('mindbodygreen', mindbodygreenUrl(entity)),
    fetchHtmlSource('healthline', healthlineUrl(entity)),
    fetchHtmlSource('wellandgood', wellandgoodUrl(entity)),
    fetchHtmlSource('gaia', gaiaUrl(entity)),
    fetchHtmlSource('energymuse', energymuseUrl(entity)),
    fetchHtmlSource('psychology_today', psychologyTodayUrl(entity)),
    fetchHtmlSource('astrotwins', astrotwinsUrl(entity)),
    fetchHtmlSource('allure', allureUrl(entity)),
    fetchReddit(entity),
  ];
  const results = await Promise.all(jobs);
  return results;
}

// --- Phase 0 RAG emit (codex review 2026-05-21) ---
// .gg-cache/{page_id}/entity-passport.rag.json — raw snippets only (NO LLM angles).
export function extractDomain(url) {
  try { return new URL(String(url || '')).hostname || ''; } catch { return ''; }
}

// Build RAG payload from raw sources[]. Caps + truncates per spec.
export function buildRagPayload(pageId, entity, sources) {
  if (!PAGE_ID_REGEX.test(String(pageId || ''))) throw new Error(`invalid page_id: must match ${PAGE_ID_REGEX}`);
  if (typeof entity !== 'string' || !entity.trim()) throw new Error('entity must be a non-empty string');
  if (!Array.isArray(sources)) throw new Error('sources must be an array');
  const snippets = [];
  outer: for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    const sourceName = typeof src.name === 'string' ? src.name : 'unknown';
    const domain = extractDomain(src.url);
    const rawSnippets = Array.isArray(src.snippets) ? src.snippets : [];
    let idx = 0;
    for (const raw of rawSnippets) {
      if (typeof raw !== 'string' || !raw.trim()) continue;
      idx += 1;
      const text = raw.length > RAG_MAX_TEXT_CHARS
        ? raw.slice(0, RAG_MAX_TEXT_CHARS - 1) + '…'
        : raw;
      snippets.push({ source_name: sourceName, source_id: `${sourceName}#${idx}`, domain, text });
      if (snippets.length >= RAG_MAX_SNIPPETS) break outer;
    }
  }
  return {
    schema_version: RAG_SCHEMA_VERSION,
    page_id: pageId,
    entity: entity.trim(),
    generated_at: new Date().toISOString(),
    snippets,
  };
}

// Atomic write to .gg-cache/{page_id}/entity-passport.rag.json (tmp + rename).
export function writeRagPayload(pageId, payload, options = {}) {
  const cacheDir = options.cacheDir || RAG_CACHE_DIR;
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
  const { abs } = validateWritePath(join(cacheDir, pageId, 'entity-passport.rag.json'), {
    allowedDirs: [cacheDir],
    allowedExtensions: ['.json'],
    mustCreateParent: true,
  });
  const tmp = `${abs}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  renameSync(tmp, abs);
  return abs;
}

function emitRag(pageId, entity, sources) {
  try {
    const payload = buildRagPayload(pageId, entity, sources);
    const p = writeRagPayload(pageId, payload);
    recordPass('rag emit', `${p} (${payload.snippets.length} snippets)`);
  } catch (e) { recordFail('rag emit', e, '--page-id must match alnum/_/- 1..64; .gg-cache writable'); }
}

// --- Phase 1 → cache file ---

function cachePath(stamp, suffix) {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `entity-passport-${stamp}-${suffix}.json`);
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function runPhase1(args) {
  const stamp = ts();
  const entity = args.entity;
  console.log(`Phase 1 — 6-source fetch for entity="${entity}"`);
  console.log('------------------------------');

  const sources = await fetchAllSources(entity);
  const okCount = sources.filter((s) => s.status === 'ok').length;
  const failCount = sources.filter((s) => s.status === 'fail').length;
  recordPass(
    'source rollup',
    `${okCount} ok / ${failCount} fail (of ${SOURCE_COUNT}; wzb 第 6 源人工补)`,
  );

  const cache = cachePath(stamp, 'step1');
  writeFileSync(
    cache,
    JSON.stringify(
      {
        run_id: stamp,
        entity,
        scraped_at: new Date().toISOString(),
        sources,
      },
      null,
      2,
    ),
  );

  // Phase 0 RAG: slim .rag.json from raw snippets (no LLM angles).
  if (args.emitRag) emitRag(args.pageId, entity, sources);

  const step2Path = cachePath(stamp, 'step2');
  const flagSuffix = args.dryRun ? ' --dry-run' : '';
  console.log(`
Step 1 cache: ${cache}
NEXT (Phase 2): In Claude Code, ask the model to extract 5 angles
  (definition, mechanism, individual_application, cultural_context, critique;
  each <=120 words) from the cached sources and emit strict JSON matching
  schema v1.2 (sources[1-14], angles{5}, wzb_seventh_source). Save as:
    ${step2Path}
  Then run:
    node tools/scripts/gg-entity-passport.mjs --entity "${entity}" --ingest ${step2Path}${flagSuffix}
`);

  if (failCount > 0) {
    recordWarn('partial sources', `${failCount} fail — wzb decide if 14th source (manual) needed`);
  }
}

// --- Phase 2 — ingest → write entity_passport.json + Sheets ---

async function runPhase2(args) {
  const entity = args.entity;
  const ingestPath = args.ingest;
  console.log('Phase 2 — ingest -> entity_passport.json + Sheets');
  console.log('------------------------------');
  console.log(`entity:  ${entity}`);
  console.log(`ingest:  ${ingestPath}`);
  console.log(`dry-run: ${args.dryRun ? 'YES' : 'no'}`);
  console.log('');

  // 1. validate ingest path
  let realIngest;
  try {
    realIngest = validateIngestPath(ingestPath);
  } catch (e) {
    recordFail('validate ingest path', e, `must be under ${ALLOWED_INGEST_DIR}/, end in .json, <=1MB`);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(realIngest, 'utf8'));
  } catch (e) {
    recordFail('parse ingest JSON', e, 'expected object with entity / sources[] / angles{}');
    return;
  }
  let passport;
  try {
    passport = validateIngestPayload(parsed, entity);
  } catch (e) {
    recordFail('schema ingest', e, `required: entity, passport_version=1, sources[1-14], angles{${REQUIRED_ANGLES.join(',')}}`);
    return;
  }
  recordPass(
    'ingest validated',
    `sources=${passport.source_count_used}, angle_coverage=${passport.angle_coverage}`,
  );

  // light advisory: warn if source names unfamiliar (allow but flag, since wzb may add a 7th)
  for (const s of passport.sources) {
    if (!KNOWN_SOURCE_NAMES.has(s.name)) {
      recordWarn('unknown source name', `${s.name} (allowed if wzb_seventh_source)`);
    }
  }

  // 2. write output file
  const stamp = (parsed.run_id && typeof parsed.run_id === 'string') ? parsed.run_id : ts();
  const outPath = cachePath(stamp, 'out');
  writeFileSync(outPath, JSON.stringify(passport, null, 2));
  recordPass('entity_passport.json written', outPath);

  // Phase 0 RAG (Phase 2 path): rebuild from raw passport.sources, NOT from angles.
  if (args.emitRag) emitRag(args.pageId, passport.entity, passport.sources);

  // 3. derive status
  // v1.1 (codex review 2026-05-21): tool fetches SOURCE_COUNT=5 sources; wzb may add a 6th manually.
  const filledAngles = REQUIRED_ANGLES.filter((k) => passport.angles[k] && passport.angles[k].length > 0).length;
  const okSources = passport.sources.filter((s) =>
    !s.snippets || s.snippets.length > 0
  ).length;
  const partial = filledAngles < REQUIRED_ANGLES.length || okSources < SOURCE_COUNT;
  const status = partial ? 'partial' : 'ok';

  // 4. dry-run vs Sheets write
  if (args.dryRun) {
    console.log('');
    console.log('=== DRY RUN — passport summary ===');
    console.log(`  entity:       ${passport.entity}`);
    console.log(`  sources:      ${passport.source_count_used}`);
    console.log(`  angles:       ${passport.angle_coverage}`);
    console.log(`  7th source:   ${passport.wzb_seventh_source || '(none)'}`);
    console.log(`  status:       ${status}`);
    console.log(`  file:         ${outPath}`);
    console.log('');
    recordPass('dry-run', 'Sheets write skipped');
  } else {
    await writeToSheets({
      ts: new Date().toISOString(),
      entity: passport.entity,
      source_count: passport.source_count_used,
      angle_coverage: passport.angle_coverage,
      file_path: outPath,
      status,
      notes: '',
    });
    await writeRunsLog(passport, status, '');
  }
}

// --- Sheets helpers ---

async function ensureSheet(token, workbookId, sheetTitle, headers) {
  const meta = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}?includeGridData=false`,
    token,
  );
  const exists = (meta.sheets || []).some((s) => s.properties?.title === sheetTitle);
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

async function writeToSheets(row) {
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
    const SHEET = 'entity_passports';
    const HEADERS = ['ts', 'entity', 'source_count', 'angle_coverage', 'file_path', 'status', 'notes'];
    await ensureSheet(token, workbookId, SHEET, HEADERS);
    const r = await appendRows(token, workbookId, SHEET, 'A:G', [[
      row.ts,
      row.entity,
      row.source_count,
      row.angle_coverage,
      row.file_path,
      row.status,
      row.notes,
    ]]);
    recordPass('Sheets write entity_passports', `appended=${r.updates?.updatedRows ?? 1}`);
  } catch (e) {
    recordFail('Sheets write entity_passports', e, 'verify writer SA has Editor on workbook');
  }
}

async function writeRunsLog(passport, status, note = '') {
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
    const summary = JSON.stringify({
      sources: passport.source_count_used,
      angle_coverage: passport.angle_coverage,
    });
    const row = [
      new Date().toISOString(),
      'entity-passport',
      passport.entity,
      passport.source_count_used,
      summary,
      status,
      note ? redactNote(note) : '',
    ];
    await appendRows(token, workbookId, SHEET, 'A:G', [row]);
    recordPass('runs log append', `status=${status}`);
  } catch (e) {
    recordWarn('runs log append failed', redact(e.message));
  }
}

// --- CLI ---

export function parseArgs(argv) {
  const out = { entity: null, ingest: null, dryRun: false, pageId: null, emitRag: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--entity') out.entity = argv[++i];
    else if (a === '--ingest') out.ingest = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--page-id') out.pageId = argv[++i];
    else if (a === '--emit-rag') out.emitRag = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-entity-passport.mjs — 13-source 5-angle entity 主权搜证 (v1.2)
Phase 1:  --entity "saturn return"
Phase 2:  --entity "saturn return" --ingest ~/.gg-cache/...step2.json [--dry-run]
flags:    --entity --ingest --dry-run --page-id <slug> --emit-rag
--page-id required with --emit-rag (regex ${PAGE_ID_REGEX}). --emit-rag writes
.gg-cache/{page_id}/entity-passport.rag.json (raw Phase-1 snippets, no LLM).
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const envPath = loadEnv();

  console.log('GenGrowth /gg-entity-passport');
  console.log('------------------------------');
  console.log(`env file:   ${envPath || '(none — relying on shell env)'}`);
  console.log('');

  if (!args.entity) {
    console.error('ERROR: --entity required');
    printHelp();
    process.exit(2);
  }

  if (args.emitRag && !args.pageId) {
    console.error('ERROR: --emit-rag requires --page-id <slug>');
    printHelp();
    process.exit(2);
  }
  if (args.pageId && !PAGE_ID_REGEX.test(args.pageId)) {
    console.error(`ERROR: --page-id must match ${PAGE_ID_REGEX} (alnum/_/-, 1..64 chars)`);
    process.exit(2);
  }

  try {
    if (args.ingest) {
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
  const warned = RESULTS.filter((r) => r.warn);
  console.log('');
  console.log('------------------------------');
  if (failed.length === 0 && warned.length === 0) {
    console.log(`ALL GREEN (${RESULTS.length}/${RESULTS.length})`);
    process.exit(0);
  } else if (failed.length === 0) {
    console.log(`${RESULTS.length} checks — ${warned.length} warn (partial sources / placeholder)`);
    process.exit(1);
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
  process.argv[1]?.endsWith('gg-entity-passport.mjs');
if (isMain) {
  main();
}
