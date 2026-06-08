#!/usr/bin/env node
/**
 * _v33-backfill-audit.mjs — 回填前【只读】冲突审计（cutover 安全闸门，配合 _v33-backfill.mjs）
 *
 * 目的：在对线上原表跑回填 --apply 之前，先算出回填会写什么，逐行比对原表 Y(生产状态)/Z(page_id)
 *       的现值，把命中行分成三类：
 *         FILL   现值为空 → 回填安全（无覆盖）
 *         SAME   现值 == 计算值 → 幂等无操作
 *         CONFLICT 现值非空且 != 计算值 → 回填会【静默覆盖人工值】，必须人工裁决
 *       另报 codex P2 点的「同一关键词命中多个不同 page_id」候选冲突（折叠前的歧义）。
 *
 * 只读：本脚本绝不写任何单元格（仅 spreadsheets.readonly scope）。
 *
 * 用法：
 *   node tools/scripts/_v33-backfill-audit.mjs                 # 审计原表 1CkjOC（默认 = cutover 目标）
 *   node tools/scripts/_v33-backfill-audit.mjs --workbook <id> # 审计指定表（如副本 1UaTx）
 */
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIG_DEFAULT = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WORKBOOK = wbIdx >= 0 ? args[wbIdx + 1] : ORIG_DEFAULT;

const MASTER = '关键词主表';
const PAGES = '选题登记表';
// 与 _v33-backfill.mjs 同源映射（保持一致；改一处两处都要改）。
const STATUS_MAP = { '已发布': '已发布', '写作中': '已建卡', '待写': '已建卡', '已合并': '已合并', '暂停': '暂停' };
const norm = (s) => String(s || '').trim().toLowerCase();

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WORKBOOK}`;
const get = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];

// 前置校验：主表须 v3.3（Y=生产状态 idx24, Z=page_id idx25）
const mh = (await get(`${MASTER}!A1:AC1`))[0] || [];
if (mh[24] !== '生产状态' || mh[25] !== 'page_id') {
  throw new Error(`前置校验失败：${MASTER} 不是 v3.3 布局（Y(24)=${mh[24]} Z(25)=${mh[25]}）。`);
}

// 选题登记表表头 → 列 index（与 backfill 同）
const ph = (await get(`${PAGES}!A1:AC1`))[0] || [];
const pIdx = {};
ph.forEach((h, i) => { pIdx[String(h).trim()] = i; });
for (const need of ['Target Keyword', 'Associated Keywords', 'Status', 'page_id']) {
  if (pIdx[need] == null) throw new Error(`${PAGES} 缺列「${need}」`);
}

// 建 keyword(norm) → 折叠后命中 + 记录所有候选（为歧义审计）
const pages = await get(`${PAGES}!A2:AC2000`);
const map = new Map();        // kw -> {page_id,status,via}（折叠后，与 backfill 同优先级）
const allCands = new Map();   // kw -> Set(page_id)（折叠前所有不同 page_id）
const rank = (e) => (e.via === 'target' ? 2 : 0) + (e.status === '已发布' ? 1 : 0);
const consider = (kw, page_id, status, via) => {
  const k = norm(kw);
  if (!k) return;
  if (!allCands.has(k)) allCands.set(k, new Set());
  allCands.get(k).add(page_id);
  const ex = map.get(k);
  const cand = { page_id, status, via };
  if (!ex || rank(cand) > rank(ex)) map.set(k, cand);
};
for (const r of pages) {
  const tk = r[pIdx['Target Keyword']];
  if (!tk || /^#{1,6}\s/.test(String(tk))) continue;
  const pid = String(r[pIdx['page_id']] || '').trim();
  if (!pid) continue;
  const status = STATUS_MAP[String(r[pIdx['Status']] || '').trim()] || '已建卡';
  consider(tk, pid, status, 'target');
  const assoc = String(r[pIdx['Associated Keywords']] || '');
  if (assoc.includes(',') || assoc.includes('，')) {
    for (const a of assoc.split(/[,，]/)) consider(a, pid, status, 'assoc');
  }
}

// 读主表 A:AC（要 keyword=A、Y=生产状态(24)、Z=page_id(25)）
const grid = await get(`${MASTER}!A2:AC2000`);
const buckets = { Z: { FILL: [], SAME: [], CONFLICT: [] }, Y: { FILL: [], SAME: [], CONFLICT: [] } };
let matched = 0;
const ambiguous = [];
for (let i = 0; i < grid.length; i++) {
  const row = grid[i] || [];
  const kw = norm(row[0]);
  if (!kw) continue;
  const hit = map.get(kw);
  if (!hit) continue;
  matched++;
  const rowNo = i + 2;
  const curZ = String(row[25] || '').trim();
  const curY = String(row[24] || '').trim();
  const cls = (cur, want) => (cur === '' ? 'FILL' : cur === want ? 'SAME' : 'CONFLICT');
  buckets.Z[cls(curZ, hit.page_id)].push({ rowNo, kw: row[0], cur: curZ, want: hit.page_id, via: hit.via });
  buckets.Y[cls(curY, hit.status)].push({ rowNo, kw: row[0], cur: curY, want: hit.status, via: hit.via });
  const cands = allCands.get(kw);
  if (cands && cands.size > 1) ambiguous.push({ kw: row[0], rowNo, candidates: [...cands].join(', '), chosen: hit.page_id, via: hit.via });
}

const sum = (b) => `FILL ${b.FILL.length} | SAME ${b.SAME.length} | CONFLICT ${b.CONFLICT.length}`;
console.log(`审计【只读】 WORKBOOK: ${WORKBOOK}`);
console.log(`主表命中（选题登记表有 page_id 且主表关键词匹配）: ${matched} 行`);
console.log(`Z page_id : ${sum(buckets.Z)}`);
console.log(`Y 生产状态: ${sum(buckets.Y)}`);

for (const col of ['Z', 'Y']) {
  const c = buckets[col].CONFLICT;
  if (c.length) {
    console.log(`\n⚠️ ${col} 冲突（回填会覆盖人工值）共 ${c.length}，样本(前15):`);
    for (const x of c.slice(0, 15)) console.log(`  行${x.rowNo} ${x.kw}: 现值「${x.cur}」→ 拟写「${x.want}」(${x.via})`);
  } else {
    console.log(`\n✅ ${col} 无冲突（命中行现值要么空要么已等于计算值）`);
  }
}

if (ambiguous.length) {
  console.log(`\n⚠️ 同一关键词命中多个不同 page_id（折叠歧义，codex P2）共 ${ambiguous.length}，样本(前15):`);
  for (const x of ambiguous.slice(0, 15)) console.log(`  行${x.rowNo} ${x.kw}: 候选[${x.candidates}] → 选中 ${x.chosen} (${x.via})`);
} else {
  console.log(`\n✅ 无「同词多 page_id」歧义`);
}

const safe = buckets.Z.CONFLICT.length === 0 && buckets.Y.CONFLICT.length === 0;
console.log(`\n${safe ? '✅ 安全：可直接 _v33-backfill.mjs --apply（无覆盖人工值）' : '⛔ 有冲突：先人工裁决上列冲突行，再决定是否回填'}`);
process.exit(0);
