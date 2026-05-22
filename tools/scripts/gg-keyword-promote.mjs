#!/usr/bin/env node
// gg-keyword-promote.mjs — 把 keyword_candidates 副表里 wzb_approve=Y 的行
// promote 到 24 列「关键词主表」的 A-I 手填列。严格只写 A-I，绝不触碰公式列
// J/K/M/N/O/R/S/U（spec §六 + keyword-sheet-setup.gs v3.1 硬禁）。
//
// 链路定位：
//   gg-keyword-fallback (Phase 2 → keyword_candidates 副表，wzb_approve 空)
//     ↓ wzb 在 Sheet 标 Y
//   gg-keyword-promote (本工具) → 关键词主表 A-I + 可选选题登记表 draft
//     ↓ wzb 在选题登记表补 cluster_id / page_role / friction / logic 等
//   gg-sheet-to-brief → v8 brief override
//     ↓
//   gg-batch-synth + gg-render-batch → LLM → ship
//
// 用法：
//   node tools/scripts/gg-keyword-promote.mjs --entity "blue aura"
//   node tools/scripts/gg-keyword-promote.mjs --dry-run
//   node tools/scripts/gg-keyword-promote.mjs --also-draft-pages   # 同时往选题登记表写 draft 行
//
// 安全保证：
//   1. 写主表只用 range "关键词主表!A:I" — Sheets API 会自动拒绝越界写
//   2. 同一 query 只 promote 一次（先读关键词主表 A 列查重）
//   3. wzb_approve 必须 === 'Y'（大小写敏感），其他值（含 y / yes / 是）都不算
//   4. 可选写选题登记表只填 A 列（target_keyword），其余 wzb 后填

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

export const CANDIDATES_TAB = 'keyword_candidates';
export const MASTER_TAB = '关键词主表';
export const PAGES_TAB = '选题登记表';

// candidate 副表 → 关键词主表 source 列映射（B 列下拉值）
// keyword-sheet-setup.gs v3.1 line 187 定义的 6 个合法值：
//   竞品映射 / 内容缺口 / 种子词拓展 / 社区挖掘 / 趋势词 / Social信号
export const SOURCE_REMAP = Object.freeze({
  reddit: '社区挖掘',
  serp: '内容缺口',
  competitor: '竞品映射',
  seed: '种子词拓展',
  trend: '趋势词',
  social: 'Social信号',
});

export function remapSource(raw) {
  if (!raw) return '社区挖掘'; // fallback default
  const key = String(raw).trim().toLowerCase();
  return SOURCE_REMAP[key] || raw;
}

// 严格检查：wzb_approve === 'Y'。其他值（含小写 y / yes / 是）都不算。
export function isApproved(value) {
  return String(value || '').trim() === 'Y';
}

// 从 candidates 表行 → 关键词主表 A-I 9 列。
// 公式列 J/K/M/N/O/R/S/U 完全不出现在 row 数组里，因为 range 是 A:I。
export function buildMasterRow(candidate) {
  return [
    candidate.query,                  // A 关键词
    remapSource(candidate.source),    // B 来源
    candidate.search_volume || '',    // C 月搜索量
    candidate.keyword_difficulty || '', // D KD
    candidate.cpc || '',              // E CPC
    '',                                // F Trends 比值（candidate 表无此列，留空）
    '',                                // G Top10 最低 2 站 DR 均值（人工查）
    '',                                // H SERP 弱度（人工查）
    '',                                // I 自有站 DR（人工查）
  ];
}

// 从 candidates 表行 → 选题登记表 A 列（仅 target_keyword）。
export function buildPageDraftRow(candidate) {
  return [candidate.query];
}

// ---------- pure helpers (header → field map) ----------
export const CANDIDATE_FIELDS = [
  'run_id', 'entity', 'query', 'source', 'search_volume',
  'keyword_difficulty', 'cpc', 'serp_features', 'geo_score', 'ai_recommend', 'wzb_approve',
];

// Required columns to operate at all. If the keyword_candidates sheet header drifts
// (schema migration / manual rename), we MUST fail loud instead of returning "no approved
// candidates" which would look identical to a normal empty-approval run.
export const REQUIRED_CANDIDATE_HEADERS = Object.freeze(['query', 'wzb_approve']);

// Returns the list of REQUIRED_CANDIDATE_HEADERS that are missing from the header row.
// Empty list = ok; non-empty = fatal wiring/schema problem.
export function validateCandidateHeader(headerRow) {
  const present = new Set((headerRow || []).map((h) => String(h || '').trim()));
  return REQUIRED_CANDIDATE_HEADERS.filter((h) => !present.has(h));
}

export function rowToCandidate(headerRow, dataRow) {
  const obj = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '').trim();
    if (!h) continue;
    obj[h] = dataRow[i] == null ? '' : String(dataRow[i]);
  }
  // canonical access: by exact column name
  const out = {};
  for (const f of CANDIDATE_FIELDS) out[f] = obj[f] || '';
  return out;
}

export function filterApprovedNotYetPromoted(candidates, alreadyInMaster) {
  // alreadyInMaster: Set<lowercase query>
  return candidates.filter((c) => {
    if (!isApproved(c.wzb_approve)) return false;
    if (!c.query) return false;
    if (alreadyInMaster.has(c.query.toLowerCase())) return false;
    return true;
  });
}

// ---------- CLI arg parser ----------
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

// ---------- Sheets I/O ----------
async function fetchValues(workbookId, range, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const res = await gFetch(url, token);
  return res.values || [];
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

// ---------- main ----------
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`gg-keyword-promote — keyword_candidates → 关键词主表

usage:
  node tools/scripts/gg-keyword-promote.mjs
  node tools/scripts/gg-keyword-promote.mjs --entity "blue aura"
  node tools/scripts/gg-keyword-promote.mjs --dry-run
  node tools/scripts/gg-keyword-promote.mjs --also-draft-pages

flags:
  --entity <str>           only promote candidates with matching entity
  --dry-run                show what would be written, no actual writes
  --also-draft-pages       additionally create rows in 选题登记表 (A col only)

env required:
  GG_SHEETS_WORKBOOK_ID + writer SA (gg-writer-sa.json)

safety:
  - writes ONLY range '关键词主表!A:I' — formula cols J/K/M/N/O/R/S/U untouched
  - dedupes against existing main-table A column (case-insensitive)
  - wzb_approve must be exactly 'Y' (not y, yes, 是)
`);
    return 0;
  }

  loadEnv();
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    console.error('GG_SHEETS_WORKBOOK_ID missing in env');
    return 2;
  }
  const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(writerSa) && !args.dry_run) {
    console.error(`writer SA not found: ${writerSa}`);
    return 2;
  }

  const { token } = args.dry_run
    ? { token: null }
    : await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']);

  let candidatesRaw;
  let masterRaw;
  if (args.dry_run && !token) {
    // Dry-run without creds: try to read with an OAuth-style getAccessToken from gg-shared
    // (lib/_oauth-token.mjs). If that also fails, can't dry-run live; user must run with creds.
    try {
      const { getAccessToken: getOauthToken } = await import('./lib/_oauth-token.mjs');
      const oauthToken = await getOauthToken();
      candidatesRaw = await fetchValues(workbookId, `${CANDIDATES_TAB}!A1:Z2000`, oauthToken);
      masterRaw = await fetchValues(workbookId, `${MASTER_TAB}!A1:A2000`, oauthToken);
    } catch (e) {
      console.error('dry-run requires either writer SA or reader OAuth; both failed:', e.message);
      return 2;
    }
  } else {
    candidatesRaw = await fetchValues(workbookId, `${CANDIDATES_TAB}!A1:Z2000`, token);
    masterRaw = await fetchValues(workbookId, `${MASTER_TAB}!A1:A2000`, token);
  }

  if (!candidatesRaw.length) {
    console.error(`${CANDIDATES_TAB} empty or unreadable`);
    return 2;
  }
  const candHeader = candidatesRaw[0];
  // Validate header against schema BEFORE counting approvals. Otherwise a renamed/dropped
  // 'wzb_approve' column would silently yield 0 approved and exit 0, masking schema drift.
  const missingHeaders = validateCandidateHeader(candHeader);
  if (missingHeaders.length) {
    console.error(`FATAL: ${CANDIDATES_TAB} header missing required columns: ${missingHeaders.join(', ')}`);
    console.error(`       found header: ${candHeader.join(' | ')}`);
    return 2;
  }
  const candRows = candidatesRaw.slice(1);
  const candidates = candRows.map((r) => rowToCandidate(candHeader, r));

  const masterQueries = new Set(
    masterRaw.slice(1).map((r) => String((r && r[0]) || '').trim().toLowerCase()).filter(Boolean),
  );

  let filtered = filterApprovedNotYetPromoted(candidates, masterQueries);
  if (args.entity) {
    const ent = String(args.entity).trim().toLowerCase();
    filtered = filtered.filter((c) => String(c.entity || '').trim().toLowerCase() === ent);
  }

  if (!filtered.length) {
    console.error(`no approved candidates to promote (looked at ${candidates.length} rows)`);
    return 0;
  }

  const masterRows = filtered.map(buildMasterRow);
  const draftRows = args.also_draft_pages ? filtered.map(buildPageDraftRow) : [];

  console.error(`promoting ${filtered.length} approved candidate(s) → ${MASTER_TAB}!A:I`);
  for (const c of filtered) console.error(`  - ${c.query} (source=${remapSource(c.source)})`);

  if (args.dry_run) {
    process.stdout.write(JSON.stringify({
      _schema_version: '1',
      _dry_run: true,
      master_writes: { range: `${MASTER_TAB}!A:I`, rows: masterRows },
      ...(draftRows.length ? { pages_writes: { range: `${PAGES_TAB}!A:A`, rows: draftRows } } : {}),
    }, null, 2) + '\n');
    return 0;
  }

  const masterResp = await appendRows(workbookId, `${MASTER_TAB}!A:I`, masterRows, token);
  console.error(`appended ${masterResp.updates?.updatedRows ?? masterRows.length} rows to ${MASTER_TAB}!A:I`);

  if (draftRows.length) {
    const draftResp = await appendRows(workbookId, `${PAGES_TAB}!A:A`, draftRows, token);
    console.error(`appended ${draftResp.updates?.updatedRows ?? draftRows.length} draft rows to ${PAGES_TAB}!A:A`);
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
