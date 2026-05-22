#!/usr/bin/env node
// gg-keyword-mine.mjs v0.2 — 上游"种子词 → DataForSEO Labs 扩词 → 过滤排序 → 关键词主表" 完整自动化
//
// 链路定位（spec keyword-research-sop.md §一来源 3 + §二 GEO 闸门）：
//   wzb 提供 5 个 seed → 本工具
//     ↓ DataForSEO Labs keyword_suggestions（每 seed 拿 100 candidate）
//     ↓ 过滤（KD ≤ max_kd, volume ≥ min_volume, NEGATIVE_KEYWORDS 否决）
//     ↓ GEO 分降序排序
//     ↓ 取 top N 写「关键词主表」A-E（关键词/来源/搜索量/KD/CPC）
//     ↓ 同时打印 AIO 风险预判 + 推荐 N→主表 T 列填什么
//   wzb 在主表填 F-I（Trends/DR/SERP弱度/自有站DR），R 列分桶自动算
//   → gg-keyword-promote → 选题登记表 draft → gg-sheet-to-brief → ...
//
// 用法：
//   node tools/scripts/gg-keyword-mine.mjs \
//     --seeds "blue aura,red aura,yellow aura,green aura,purple aura" \
//     --entity "aura"
//
//   node tools/scripts/gg-keyword-mine.mjs \
//     --seeds "chiron in 1st house,chiron in 7th house" \
//     --max-kd 30 --min-volume 100 --max-results 15 \
//     --dry-run
//
// flags:
//   --seeds <csv>            required（5-10 个 seed 词，逗号分隔）
//   --entity <str>           optional（标在 keyword_candidates run_id 里，便于后续 promote 筛选）
//   --location-code <n>      default 2840 (US)
//   --language-code <str>    default en
//   --max-kd <n>             default 50
//   --min-volume <n>         default 50
//   --max-results <n>        default 15
//   --dry-run                只打印 candidate JSON 不写 Sheets
//   --target-master          直接写「关键词主表」 A-E（默认行为：写 keyword_candidates 副表让 wzb approve）
//
// 设计：
//   - DataForSEO 不可用 → fail（不像 gg-keyword-fallback 那样 graceful skip — 本工具 DataForSEO 是核心）
//   - SERP Top10 DR 不在本工具范围（spec §零 + Ahrefs SERP overview 手填）
//   - AIO 风险预判仅显示 hint，不写主表 S/T 列（S 公式自动，T 人工）
//   - 严格不写公式列（J/K/M/N/O/R/S/U）

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAccessToken, gFetch, loadEnv, redact } from './lib/gg-shared.mjs';

export const DEFAULT_LOCATION_CODE = 2840; // US
export const DEFAULT_LANGUAGE_CODE = 'en';
export const DEFAULT_MAX_KD = 50;
export const DEFAULT_MIN_VOLUME = 50;
export const DEFAULT_MAX_RESULTS = 15;
export const PER_SEED_LIMIT = 100;

// AIO 风险预判词型（spec §二 第三关 + keyword-sheet-setup.gs v3.1 line 250-254）：
// 月搜索量 ≥ 500 且词型含 "what is" / "meaning" / "definition" / "how does" / "explained" → 疑似高风险
export const AIO_TRIGGER_REGEX = /\b(what\s+is|meaning|definition|how\s+does|explained)\b/i;
export const AIO_VOLUME_THRESHOLD = 500;

export function isAioHighRisk(keyword, volume) {
  const v = Number(volume);
  if (!Number.isFinite(v) || v < AIO_VOLUME_THRESHOLD) return false;
  return AIO_TRIGGER_REGEX.test(String(keyword || ''));
}

// GEO 分公式（直接复用 gg-keyword-fallback.mjs:146 同一套公式，避免分叉）：
//   0.4 * (volume/1000) + 0.3 * (1 - kd/100) + 0.2 * (1 - min(kd/100, 1)) + 0.1 * AIO_bonus
export function computeGeo({ volume, kd, serpFeatures }) {
  if (volume == null || Number.isNaN(volume)) return null;
  const v = Number(volume);
  const k = kd == null || Number.isNaN(kd) ? 50 : Number(kd);
  const features = Array.isArray(serpFeatures) ? serpFeatures : [];
  const volumeTerm = 0.4 * (v / 1000);
  const kdTerm = 0.3 * (1 - k / 100);
  const logRankingChance = 1 - Math.min(k / 100, 1);
  const logTerm = 0.2 * logRankingChance;
  const aiOverview = features.includes('ai_overview') ? 1 : 0;
  const aiTerm = 0.1 * aiOverview;
  return Math.round((volumeTerm + kdTerm + logTerm + aiTerm) * 10000) / 10000;
}

// NEGATIVE_KEYWORDS 也是 spec 必检（keyword-sheet-setup.gs v3.1 line 97-108）。
// 在 candidate 含其一即否决（子串匹配，case-insensitive）。
// 这里只支持 CLI / env 注入，不调 Sheet（避免每次跑多一次 API call）。
export function isNegativeMatch(keyword, negatives) {
  if (!negatives || !negatives.length) return false;
  const lc = String(keyword || '').toLowerCase();
  return negatives.some((neg) => lc.includes(String(neg).toLowerCase()));
}

// 排序 + 过滤：去重 + KD/volume 闸门 + negative 否决 + GEO 分排序 → top N
export function filterAndRank(candidates, opts) {
  const {
    maxKd = DEFAULT_MAX_KD,
    minVolume = DEFAULT_MIN_VOLUME,
    maxResults = DEFAULT_MAX_RESULTS,
    negatives = [],
  } = opts || {};
  const seen = new Set();
  const filtered = [];
  for (const c of candidates) {
    const kw = String(c.keyword || '').trim().toLowerCase();
    if (!kw) continue;
    if (seen.has(kw)) continue;
    seen.add(kw);
    if (isNegativeMatch(c.keyword, negatives)) continue;
    const v = c.volume == null ? 0 : Number(c.volume);
    const k = c.kd == null ? 100 : Number(c.kd);
    if (Number.isFinite(v) && v < minVolume) continue;
    if (Number.isFinite(k) && k > maxKd) continue;
    filtered.push({
      ...c,
      geo_score: computeGeo({ volume: c.volume, kd: c.kd, serpFeatures: c.serp_features }),
      aio_risk: isAioHighRisk(c.keyword, c.volume) ? '⚠️疑似高风险' : '',
    });
  }
  // GEO 降序（null GEO 视为 -1）
  filtered.sort((a, b) => (b.geo_score ?? -1) - (a.geo_score ?? -1));
  return filtered.slice(0, maxResults);
}

// ---------- DataForSEO Labs keyword_suggestions ----------
// Endpoint doc:
//   https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live
// Request: [{ keyword, location_code, language_code, limit, include_seed_keyword }]
// Response: tasks[0].result[0].items[*] = { keyword, keyword_info: { search_volume, keyword_difficulty, cpc, competition_level }, search_intent_info: { main_intent } }
export async function callKeywordSuggestions({ seed, login, password, locationCode, languageCode, limit }) {
  if (!login || !password) {
    throw new Error('GG_DATAFORSEO_LOGIN / GG_DATAFORSEO_PASSWORD missing');
  }
  if (!seed) throw new Error('seed is required');
  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const url = 'https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_suggestions/live';
  const body = JSON.stringify([{
    keyword: seed,
    location_code: locationCode || DEFAULT_LOCATION_CODE,
    language_code: languageCode || DEFAULT_LANGUAGE_CODE,
    limit: limit || PER_SEED_LIMIT,
    include_seed_keyword: true,
    include_serp_info: true, // populate items[].serp_info.serp_item_types → drives GEO ai_overview bonus
  }]);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Basic ${auth}`,
      'content-type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(redact(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`));
  }
  const json = await res.json();
  // DataForSEO 2-level status check: top-level + task-level. 200xx = success.
  if (json?.status_code && json.status_code >= 40000) {
    throw new Error(redact(`DataForSEO top-level status_code=${json.status_code}: ${json.status_message || '(no message)'}`));
  }
  const task = json?.tasks?.[0];
  if (task?.status_code && task.status_code >= 40000) {
    throw new Error(redact(`DataForSEO task status_code=${task.status_code}: ${task.status_message || '(no message)'}`));
  }
  const items = task?.result?.[0]?.items || [];
  return items.map(parseLabsItem).filter(Boolean);
}

// Pure: DataForSEO Labs item → our candidate shape (exported for tests).
// Real DataForSEO Labs Keyword Suggestions response shape (per
// https://docs.dataforseo.com/v3/dataforseo_labs-google-keyword_suggestions-live/ ):
//   items[i].keyword
//   items[i].keyword_info: { search_volume, cpc, competition, competition_level, ... }
//   items[i].keyword_properties: { keyword_difficulty, ... }   ← KD lives HERE, not keyword_info
//   items[i].search_intent_info: { main_intent }
//   items[i].serp_info.serp_item_types: [...]                  ← only present when request had include_serp_info=true
export function parseLabsItem(it) {
  if (!it || !it.keyword) return null;
  const info = it.keyword_info || {};
  const props = it.keyword_properties || {};
  return {
    keyword: String(it.keyword),
    volume: info.search_volume ?? null,
    // KD is in keyword_properties per official docs; fall back to keyword_info for
    // back-compat with older fixture-only tests that put it in keyword_info.
    kd: props.keyword_difficulty ?? info.keyword_difficulty ?? null,
    cpc: info.cpc ?? null,
    competition: info.competition_level ?? null,
    intent: it.search_intent_info?.main_intent ?? null,
    serp_features: Array.isArray(it.serp_info?.serp_item_types) ? it.serp_info.serp_item_types : [],
    source_seed: '', // filled by caller
  };
}

// ---------- Sheets I/O ----------
export const MASTER_TAB = '关键词主表';
export const CANDIDATES_TAB = 'keyword_candidates';

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

async function appendRows(workbookId, range, rows, token) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  );
}

// 把 final candidates 写入 keyword_candidates 副表（默认路径），让 wzb 在 Sheet 标 wzb_approve=Y
// 然后跑 gg-keyword-promote 进 24 列主表。
export function buildCandidateRow(c, { runId, entity }) {
  return [
    runId,
    entity || '',
    c.keyword,
    'seed',                              // source 列 (gg-keyword-promote 会 remap → 种子词拓展)
    c.volume ?? '',
    c.kd ?? '',
    c.cpc ?? '',
    Array.isArray(c.serp_features) ? c.serp_features.join(',') : '',
    c.geo_score ?? '',
    c.aio_risk || '',                    // 复用 ai_recommend 列存 AIO hint
    '',                                   // wzb_approve 留空让 wzb 后填
  ];
}

// 可选直写主表 A-E（如果 --target-master）。严格只写 A-E 5 列，不碰公式列。
export function buildMasterRowMine(c) {
  return [
    c.keyword,                            // A
    '种子词拓展',                          // B（gg-keyword-mine 固定用此 source）
    c.volume ?? '',                       // C
    c.kd ?? '',                           // D
    c.cpc ?? '',                          // E
  ];
}

// ---------- CLI parsing ----------
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function parseSeeds(raw) {
  if (!raw) return [];
  return String(raw).split(/[,，、\n]+/).map((s) => s.trim()).filter(Boolean);
}

export function parseNegatives(raw) {
  if (!raw) {
    const env = process.env.GG_NEGATIVE_KEYWORDS;
    if (env) return env.split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
    return [];
  }
  return String(raw).split(/[,，、]+/).map((s) => s.trim()).filter(Boolean);
}

// ---------- main ----------
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`gg-keyword-mine v0.2 — DataForSEO Labs 扩词 + GEO 排序 → 关键词主表

usage:
  node tools/scripts/gg-keyword-mine.mjs --seeds "blue aura,red aura,yellow aura" --entity "aura"
  node tools/scripts/gg-keyword-mine.mjs --seeds "..." --dry-run
  node tools/scripts/gg-keyword-mine.mjs --seeds "..." --target-master --max-results 10

flags:
  --seeds <csv>            required (5-10 seed keywords, comma-separated)
  --entity <str>           candidate run_id tag, propagates to keyword_candidates row
  --location-code <n>      default 2840 (US)
  --language-code <str>    default en
  --max-kd <n>             default 50
  --min-volume <n>         default 50
  --max-results <n>        default 15
  --negatives <csv>        also accepts env GG_NEGATIVE_KEYWORDS (子串否决)
  --dry-run                stdout candidates JSON, no Sheets writes
  --target-master          write to 关键词主表 A-E directly (default: write keyword_candidates副表)

env required:
  GG_DATAFORSEO_LOGIN + GG_DATAFORSEO_PASSWORD + GG_SHEETS_WORKBOOK_ID + writer SA
`);
    return 0;
  }

  loadEnv();

  const seeds = parseSeeds(args.seeds);
  if (!seeds.length) {
    console.error('ERROR: --seeds is required (comma-separated list)');
    return 2;
  }

  const login = process.env.GG_DATAFORSEO_LOGIN;
  const password = process.env.GG_DATAFORSEO_PASSWORD;
  if (!login || !password) {
    console.error('ERROR: GG_DATAFORSEO_LOGIN / GG_DATAFORSEO_PASSWORD missing in env');
    console.error('       see docs/PIPELINE.md or run: node tools/scripts/gg-keyword-fallback.mjs --smoke');
    return 2;
  }

  const opts = {
    locationCode: Number(args.location_code) || DEFAULT_LOCATION_CODE,
    languageCode: args.language_code || DEFAULT_LANGUAGE_CODE,
    maxKd: Number(args.max_kd) || DEFAULT_MAX_KD,
    minVolume: Number(args.min_volume) || DEFAULT_MIN_VOLUME,
    maxResults: Number(args.max_results) || DEFAULT_MAX_RESULTS,
    negatives: parseNegatives(args.negatives),
  };

  console.error(`gg-keyword-mine v0.2 — ${seeds.length} seed(s), location=${opts.locationCode}, lang=${opts.languageCode}`);
  console.error(`thresholds: kd ≤ ${opts.maxKd}, volume ≥ ${opts.minVolume}, max ${opts.maxResults} results`);
  if (opts.negatives.length) console.error(`negatives: ${opts.negatives.length} terms`);
  console.error('');

  // 1. Fan out: call DataForSEO Labs once per seed.
  const allCandidates = [];
  let seedSuccess = 0;
  let seedFail = 0;
  for (const seed of seeds) {
    console.error(`fetching candidates for seed "${seed}" ...`);
    try {
      const items = await callKeywordSuggestions({
        seed, login, password,
        locationCode: opts.locationCode,
        languageCode: opts.languageCode,
        limit: PER_SEED_LIMIT,
      });
      items.forEach((it) => { it.source_seed = seed; });
      console.error(`  → ${items.length} candidates`);
      allCandidates.push(...items);
      seedSuccess++;
    } catch (e) {
      console.error(`  → FAIL: ${e.message}`);
      seedFail++;
    }
  }
  console.error(`\nseed summary: ${seedSuccess} ok, ${seedFail} fail`);
  console.error(`total raw candidates: ${allCandidates.length}`);

  // Fail-fast: if every seed failed, the API is broken / creds wrong / network down.
  // Don't silently exit 0 — that masks pipeline failures from cron/CI.
  if (seedFail === seeds.length) {
    console.error('FATAL: every seed failed; see errors above');
    return 2;
  }

  // 2. Filter + rank.
  const finalCandidates = filterAndRank(allCandidates, opts);
  console.error(`after filter (kd≤${opts.maxKd}, vol≥${opts.minVolume}, dedupe, negatives): ${finalCandidates.length}`);

  // 3. Output.
  const runId = `mine-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const entity = args.entity || seeds[0];

  if (args.dry_run) {
    process.stdout.write(JSON.stringify({
      _schema_version: '1',
      _run_id: runId,
      _entity: entity,
      _seeds: seeds,
      _opts: opts,
      _final_count: finalCandidates.length,
      candidates: finalCandidates,
      master_preview: finalCandidates.map(buildMasterRowMine),
      candidates_preview: finalCandidates.map((c) => buildCandidateRow(c, { runId, entity })),
    }, null, 2) + '\n');
    return 0;
  }

  if (!finalCandidates.length) {
    console.error('no candidates survived filter; nothing to write');
    return 0;
  }

  // 4. Write Sheets.
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    console.error('GG_SHEETS_WORKBOOK_ID missing — cannot write Sheets (use --dry-run to skip)');
    return 2;
  }
  const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(writerSa)) {
    console.error(`writer SA not found: ${writerSa}`);
    return 2;
  }
  const { token } = await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']);

  if (args.target_master) {
    // Direct write to 24-col 关键词主表 A-E (skips approve step).
    const rows = finalCandidates.map(buildMasterRowMine);
    const resp = await appendRows(workbookId, `${MASTER_TAB}!A:E`, rows, token);
    console.error(`appended ${resp.updates?.updatedRows ?? rows.length} rows to ${MASTER_TAB}!A:E`);
  } else {
    // Default: write to keyword_candidates 副表 (wzb approves first).
    const headers = [
      'run_id', 'entity', 'query', 'source', 'search_volume',
      'keyword_difficulty', 'cpc', 'serp_features', 'geo_score',
      'ai_recommend', 'wzb_approve',
    ];
    await ensureSheet(token, workbookId, CANDIDATES_TAB, headers);
    const rows = finalCandidates.map((c) => buildCandidateRow(c, { runId, entity }));
    const resp = await appendRows(workbookId, `${CANDIDATES_TAB}!A:K`, rows, token);
    console.error(`appended ${resp.updates?.updatedRows ?? rows.length} rows to ${CANDIDATES_TAB}!A:K`);
    console.error(`next: wzb 在 ${CANDIDATES_TAB} 标 wzb_approve=Y, 然后跑 gg-keyword-promote`);
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    console.error('fatal:', e.message);
    process.exit(1);
  });
}

export { main };
