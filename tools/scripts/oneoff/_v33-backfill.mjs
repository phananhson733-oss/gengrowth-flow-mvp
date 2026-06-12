#!/usr/bin/env node
/**
 * _v33-backfill.mjs — 把选题登记表的 page_id / 生产状态 回填到 关键词主表 Z / Y（§6-4 / §3 step4,7）
 *
 * 匹配：关键词主表.关键词 == 选题登记表.Target Keyword（精确，归一小写）为主；
 *       Associated Keywords 仅当含逗号才拆分补充（无分隔符拼接的不碰，避免误匹配）。
 *       Target 匹配优先于 Associated；同一关键词命中多页时 Target/已发布 优先。
 * 写：关键词主表 Z(page_id) + Y(生产状态)。生产状态映射 已发布→已发布 / 写作中,待写→已建卡。
 *     AA 发布URL 不回填——选题登记表 URL 列全空，无源数据。
 * 幂等：重跑写同值；前置校验主表须 v3.3（Z=page_id、Y=生产状态 表头）。
 *
 * 用法：
 *   node tools/scripts/_v33-backfill.mjs               # dry-run（默认副本，只读）
 *   node tools/scripts/_v33-backfill.mjs --apply       # 对副本写
 *   node tools/scripts/_v33-backfill.mjs --workbook <id> --apply
 */
import { getAccessToken, gFetch, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COPY_DEFAULT = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WORKBOOK = wbIdx >= 0 ? args[wbIdx + 1] : COPY_DEFAULT;
const APPLY = args.includes('--apply');

const MASTER = '关键词主表';
const PAGES = '选题登记表';
const STATUS_MAP = { '已发布': '已发布', '写作中': '已建卡', '待写': '已建卡', '已合并': '已合并', '暂停': '暂停' };
const norm = (s) => String(s || '').trim().toLowerCase();

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(SA, [scope]);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WORKBOOK}`;
const get = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];

// 前置校验：主表须 v3.3
const mh = (await get(`${MASTER}!A1:AC1`))[0] || [];
if (mh[24] !== '生产状态' || mh[25] !== 'page_id') {
  throw new Error(`前置校验失败：${MASTER} 不是 v3.3 布局（Y(24)=${mh[24]} Z(25)=${mh[25]}，期望 生产状态/page_id）。先迁移。`);
}

// 选题登记表表头 → 列 index
const ph = (await get(`${PAGES}!A1:AC1`))[0] || [];
const pIdx = {};
ph.forEach((h, i) => { pIdx[String(h).trim()] = i; });
for (const need of ['Target Keyword', 'Associated Keywords', 'Status', 'page_id']) {
  if (pIdx[need] == null) throw new Error(`${PAGES} 缺列「${need}」`);
}

// 读选题登记表，建 keyword(norm) → {page_id, status, via}
const pages = await get(`${PAGES}!A2:AC2000`);
const map = new Map(); // kw -> {page_id, status, via:'target'|'assoc'}
let pageRows = 0, commaAssoc = 0, blobAssoc = 0;
const consider = (kw, page_id, status, via) => {
  const k = norm(kw);
  if (!k) return;
  const ex = map.get(k);
  // 优先级：target > assoc；同级 已发布 > 其它
  const rank = (e) => (e.via === 'target' ? 2 : 0) + (e.status === '已发布' ? 1 : 0);
  const cand = { page_id, status, via };
  if (!ex || rank(cand) > rank(ex)) map.set(k, cand);
};
for (const r of pages) {
  const tk = r[pIdx['Target Keyword']];
  if (!tk || /^#{1,6}\s/.test(String(tk))) continue;
  const pid = String(r[pIdx['page_id']] || '').trim();
  if (!pid) continue;
  pageRows++;
  const status = STATUS_MAP[String(r[pIdx['Status']] || '').trim()] || '已建卡';
  consider(tk, pid, status, 'target');
  const assoc = String(r[pIdx['Associated Keywords']] || '');
  if (assoc.includes(',') || assoc.includes('，')) {
    commaAssoc++;
    for (const a of assoc.split(/[,，]/)) consider(a, pid, status, 'assoc');
  } else if (assoc.trim()) {
    blobAssoc++; // 无分隔符拼接，跳过（不可靠）
  }
}

// 读主表关键词 → 行号
const mkw = await get(`${MASTER}!A2:A2000`);
const updates = []; // {row, page_id, status}
let masterMatched = 0;
for (let i = 0; i < mkw.length; i++) {
  const kw = norm((mkw[i] || [])[0]);
  if (!kw) continue;
  const hit = map.get(kw);
  if (hit) { updates.push({ row: i + 2, page_id: hit.page_id, status: hit.status, via: hit.via }); masterMatched++; }
}

console.log(`MODE: ${APPLY ? 'APPLY ⚠️' : 'DRY-RUN'}  WORKBOOK: ${WORKBOOK}`);
console.log(`选题登记表 有 page_id 的页: ${pageRows} | Associated 逗号分隔 ${commaAssoc} 页 / 无分隔拼接(跳过) ${blobAssoc} 页`);
console.log(`映射关键词(去重): ${map.size}（target 优先）`);
console.log(`主表命中回填: ${masterMatched} 行（Z page_id + Y 生产状态）`);
const byStatus = updates.reduce((m, u) => ((m[u.status] = (m[u.status] || 0) + 1), m), {});
const byVia = updates.reduce((m, u) => ((m[u.via] = (m[u.via] || 0) + 1), m), {});
console.log(`  生产状态分布: ${JSON.stringify(byStatus)} | 命中来源: ${JSON.stringify(byVia)}`);
console.log('  样本(前8):');
for (const u of updates.slice(0, 8)) console.log(`    行${u.row}: ${norm((mkw[u.row - 2] || [])[0])} → Z=${u.page_id} Y=${u.status} (${u.via})`);
console.log('  注: AA 发布URL 不回填（选题登记表 URL 列全空，无源数据）。');

if (!APPLY) { console.log('\nDRY-RUN 完成（未写入）。确认后加 --apply。'); process.exit(0); }

// 写：每命中行写 Z + Y（RAW）
const data = [];
for (const u of updates) {
  data.push({ range: `${MASTER}!Z${u.row}`, values: [[u.page_id]] });
  data.push({ range: `${MASTER}!Y${u.row}`, values: [[u.status]] });
}
if (data.length) {
  await gFetch(`${base}/values:batchUpdate`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}
console.log(`\n✅ APPLY 完成：回填 ${updates.length} 行 Z/Y（${data.length} 单元格）。`);
