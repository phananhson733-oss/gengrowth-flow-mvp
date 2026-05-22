#!/usr/bin/env node
// gg-sheet-pull.mjs — 拉 GenGrowth 关键词 workbook 中指定 tab 的 row → batch fixture JSON
//
// 默认拉 "选题登记表"（content brief），15 列。"关键词主表" 是 24 列的打分表，没 brief 字段。
//
// 用法：
//   node tools/scripts/gg-sheet-pull.mjs --row 3
//   node tools/scripts/gg-sheet-pull.mjs --rows 3-7 --out path/to/batch.json
//   node tools/scripts/gg-sheet-pull.mjs --tab 关键词主表 --rows 2-10 --dry-run
//
// 输入：
//   ~/.config/gg/_gg.env 含 GG_SHEETS_WORKBOOK_ID + OAuth (oauth-init.mjs 跑过)
//
// 输出：
//   默认 .gg-cache/batches/<ISO>-<tab-slug>-rows-<slice>.json
//
// 不做的事（保持薄）：
//   - 不调 RAG（那是 gg-render-batch 的活）
//   - 不补 placeholder（todo 字段列在 rows[i].todo 里，操作人自己看）
//   - 不写 prompt（renderer 的活）

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/_oauth-token.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

export const SCHEMA_VERSION = '1';
export const DEFAULT_TAB = '选题登记表';
export const DEFAULT_LIMIT = 100;

// renderAuraPrompt cfg 必填字段。少这些里任何一个 → status=incomplete。
export const REQUIRED_BRIEF_FIELDS = ['target_keyword', 'entity'];

// renderAuraPrompt cfg 可选但常用字段。缺失记到 todo[]。
export const OPTIONAL_BRIEF_FIELDS = [
  'associated_keywords',
  'search_volume',
  'cluster_jtbd',
  'content_angle',
  'internal_link_rule',
  'cta_text',
  'cta_target_url',
  'tier_gate_block',
  'rl6_hint',
  'friction_themes',
];

// ---------- env loader ----------
export function loadEnv(envPath) {
  const candidates = envPath
    ? [envPath]
    : [
        process.env.GG_ENV_FILE,
        join(homedir(), '.config', 'gg', '_gg.env'),
        join(REPO, '_gg.env'),
      ].filter(Boolean);
  for (const p of candidates) {
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      return p;
    }
  }
  return null;
}

// ---------- pure helpers (exported for tests) ----------
export function slugifyPageId(keyword) {
  if (!keyword) return null;
  const slug = String(keyword)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return slug ? `page_${slug}` : null;
}

export function parseSlice(spec, totalDataRows) {
  // spec: "3" | "3-7" | undefined (= all) → { start, end } 1-indexed within data rows
  // start/end are SHEET row numbers (header = row 1, first data = row 2)
  if (!spec) return { start: 2, end: 1 + totalDataRows };
  const single = /^(\d+)$/.exec(String(spec));
  if (single) {
    const n = Number(single[1]);
    return { start: n, end: n };
  }
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(String(spec));
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    if (b < a) throw new Error(`slice end < start: ${spec}`);
    return { start: a, end: b };
  }
  throw new Error(`invalid slice spec: ${spec} (use "N" or "N-M")`);
}

export function isSectionHeader(cellA) {
  if (!cellA) return false;
  const s = String(cellA).trim();
  // markdown heading inside cell (Lynne 在 row 2 用 "## 集群 1A：..." 做分组标记)
  return /^#{1,6}\s+/.test(s);
}

export function parseAssociated(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s || /^[（(]\s*无\s*[)）]$/.test(s)) return [];
  return s
    .split(/[,，、\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function parseEntity(raw) {
  // Entity 列允许多行（primary on line 1，related on lines 2+）
  if (!raw) return { primary: null, related: [] };
  const lines = String(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { primary: lines[0] || null, related: lines.slice(1) };
}

export function normalizeNumericStr(raw) {
  // "9100" → "9100"; "未找到" / "" / null → ""
  if (raw == null) return '';
  const s = String(raw).trim();
  if (!s || /未找到/.test(s)) return '';
  return s;
}

// header 名 → brief 字段。trim 处理掉 " KD" 这种前导空格。
// 选题登记表 21 列规范见 /Users/wzb/gengrowth-wiki/docs/03-marketing/03-seo/keyword-sheet-setup.gs
// （v3.1: page_id / cluster_id / page_role / content_angle / psych_safety_flag / journal_prompts
// 是 v0.18 新增列，gg-sheet-to-brief 桥要靠它们派生 v8 cfg。）
const HEADER_MAP = {
  'Target Keyword': 'target_keyword',
  '关键词': 'target_keyword',
  'Associated Keywords': 'associated_keywords',
  '月搜索量': 'search_volume',
  'KD': 'kd',
  'Intent': 'intent',
  '意图': 'intent',
  'Tier': 'tier',
  'Template': 'template',
  'Entity': 'entity_raw',
  'Friction': 'friction_brief',
  'Logic': 'logic_brief',
  'CTA': 'cta_target_url',
  'GSC Keywords': 'gsc_keywords',
  'Status': 'status',
  '内容状态': 'status',
  'URL': 'publish_url',
  '发布URL': 'publish_url',
  'Last Audit': 'last_audit',
  'page_id': 'page_id_sheet',
  'cluster_id': 'cluster_id',
  'page_role': 'page_role',
  'content_angle': 'content_angle',
  'psych_safety_flag': 'psych_safety_flag',
  'journal_prompts': 'journal_prompts',
};

export function mapRowToBrief(header, row) {
  const raw = {};
  const brief = {};
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').trim();
    if (!h) continue;
    const v = row[i] == null ? '' : String(row[i]);
    raw[h] = v;
    const field = HEADER_MAP[h];
    if (!field) continue;
    if (field === 'associated_keywords') brief[field] = parseAssociated(v);
    else if (field === 'search_volume' || field === 'kd') brief[field] = normalizeNumericStr(v);
    else if (field === 'entity_raw') {
      const e = parseEntity(v);
      brief.entity = e.primary;
      if (e.related.length) brief.related_entities = e.related;
    } else brief[field] = v;
  }
  return { raw, brief };
}

export function identifyGaps(brief) {
  const todo = [];
  for (const k of OPTIONAL_BRIEF_FIELDS) {
    if (k === 'associated_keywords') {
      if (!Array.isArray(brief[k]) || brief[k].length === 0) todo.push(k);
    } else if (!brief[k]) {
      todo.push(k);
    }
  }
  return todo;
}

// Stable foreign-key regex (matches gg-friction-mine PAGE_ID_REGEX). page_id
// flows into file-system write paths (.gg-cache/<page_id>/...), so we MUST
// fail-closed on invalid values — never trust raw Sheet data.
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// page_id 取值规则（v0.18+ 严格外键）：
//   1. 选题登记表 page_id 列非空 + 命中 PAGE_ID_REGEX → 用它
//   2. 否则用 slugify(target_keyword) — slugify 本身只输出合法字符
//   3. 都没有 → null（行不可数据化）
//   4. 任何最终结果都必须命中 PAGE_ID_REGEX，否则返回 null（防止 traversal）
export function resolvePageId(brief, isDataRow) {
  if (!isDataRow) return null;
  const fromSheet = brief.page_id_sheet ? String(brief.page_id_sheet).trim() : '';
  let candidate = '';
  if (fromSheet) {
    candidate = fromSheet;
  } else if (brief.target_keyword) {
    candidate = slugifyPageId(brief.target_keyword) || '';
  }
  if (!candidate) return null;
  if (!PAGE_ID_REGEX.test(candidate)) return null;
  return candidate;
}

export function classifyRow(rawA, brief) {
  if (!rawA || !String(rawA).trim()) return 'empty';
  if (isSectionHeader(rawA)) return 'section';
  for (const f of REQUIRED_BRIEF_FIELDS) {
    if (!brief[f] || (Array.isArray(brief[f]) && !brief[f].length)) return 'incomplete';
  }
  return 'ready';
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

// ---------- Sheets fetch ----------
async function fetchTab(workbookId, tab, token) {
  // Pull A1:Z<lots> — 26 cols covers both 24-col 关键词主表 and 15-col 选题登记表.
  const range = encodeURIComponent(`${tab}!A1:Z2000`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${range}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Sheets fetch failed (${res.status}): ${body.error?.message || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return body.values || [];
}

// ---------- main ----------
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  loadEnv();
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    console.error('GG_SHEETS_WORKBOOK_ID missing in env');
    return 2;
  }
  const tab = args.tab || DEFAULT_TAB;
  const limit = Number(args.limit) || DEFAULT_LIMIT;

  const token = await getAccessToken();
  const rows = await fetchTab(workbookId, tab, token);
  if (!rows.length) {
    console.error(`tab "${tab}" empty`);
    return 2;
  }
  const header = rows[0];
  const dataRows = rows.slice(1);
  const slice = parseSlice(args.row || args.rows, dataRows.length);
  // sheet-row → data-row index: data[i] is sheet row i+2
  const startIdx = Math.max(0, slice.start - 2);
  const endIdx = Math.min(dataRows.length - 1, slice.end - 2);
  if (startIdx > endIdx) {
    console.error(`slice ${slice.start}-${slice.end} out of range (data rows ${2}..${dataRows.length + 1})`);
    return 2;
  }
  const sliceLen = endIdx - startIdx + 1;
  if (sliceLen > limit) {
    console.error(`slice size ${sliceLen} > --limit ${limit}; raise --limit or narrow --rows`);
    return 2;
  }

  const pulled_at = new Date().toISOString();
  const stats = { total: 0, ready: 0, incomplete: 0, section: 0, empty: 0 };
  const outRows = [];
  for (let i = startIdx; i <= endIdx; i++) {
    const row = dataRows[i] || [];
    const sheetRow = i + 2;
    const { raw, brief } = mapRowToBrief(header, row);
    const status = classifyRow(row[0], brief);
    stats.total += 1;
    stats[status] += 1;
    const isDataRow = status === 'ready' || status === 'incomplete';
    const entry = {
      source_row: sheetRow,
      status,
      page_id: resolvePageId(brief, isDataRow),
      raw,
      brief: isDataRow ? brief : null,
      todo: isDataRow ? identifyGaps(brief) : [],
    };
    outRows.push(entry);
  }

  const tabSlug = String(tab).replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
  const isoCompact = pulled_at.replace(/[-:.]/g, '').replace(/T/, 'T').slice(0, 15);
  const sliceTag = slice.start === slice.end ? `row-${slice.start}` : `rows-${slice.start}-${slice.end}`;
  const defaultOut = join(REPO, '.gg-cache', 'batches', `${isoCompact}-${tabSlug}-${sliceTag}.json`);
  const outPath = args.out || defaultOut;

  const payload = {
    schema_version: SCHEMA_VERSION,
    batch_id: `${isoCompact}-${tabSlug}-${sliceTag}`,
    workbook_id: workbookId,
    tab,
    header,
    slice: { start: slice.start, end: slice.end },
    pulled_at,
    stats,
    rows: outRows,
  };

  const statsLine = `stats: total=${stats.total} ready=${stats.ready} incomplete=${stats.incomplete} section=${stats.section} empty=${stats.empty}`;
  if (args.dry_run) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.stderr.write(statsLine + '\n');
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    process.stderr.write(`batch written: ${outPath}\n`);
    process.stderr.write(statsLine + '\n');
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    console.error('fatal:', e.message);
    process.exit(1);
  });
}

export { main, fetchTab };
