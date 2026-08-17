#!/usr/bin/env node
// _gengrowth-0817-add-spd002.mjs — 为 8/17 发布日历第 1 篇在选题登记表建行。
//
// 追加一行（PG-SPD-002），不改动任何已有行。默认 dry-run，--write 才写。
// 幂等：page_id 已存在就直接退出，绝不写第二行。
//
// 月搜索量 / KD 留空是**有意**的：日历没给这两个数，Ahrefs 当前计划返回
// "Insufficient plan" 取不到真值。宁可空着也不填估算值 —— 同簇的 PG-CMP-005/006
// 同样空量级且已正常发布，说明这两列不是发布阻断项。SERP 判定依据在日历里
// （三问全过：seeindie.com 2026-06-10 注册、月访 0，排第 8）。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const TAB = '选题登记表';
const WRITE = process.argv.includes('--write');
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const PAGE_ID = 'PG-SPD-002';

// 按列名填，不按列序 —— 表结构变了也不会错位（v3.3 迁移期出过整片错位）。
const ROW = {
  'Target Keyword': 'google algorithm update august 2026',
  'Associated Keywords':
    'seo traffic drop checklist, unconfirmed google update, google ranking volatility august 2026, search status dashboard ranking event, is there a google update',
  月搜索量: '',
  KD: '',
  Intent: 'Informational',
  Tier: 'T2',
  Template: 'Guide',
  Entity: 'Google Algorithm Update / Google Search Status Dashboard',
  Friction:
    'Traffic falls in a week when third-party rank trackers spike but Google confirms nothing, so the owner cannot tell whether to wait or act — and rewrites pages that were never the cause.',
  Logic:
    'Unconfirmed volatility and a self-inflicted technical problem produce the same Search Console shape, so the separation has to be mechanical: segment by page group and date range before reading any site-wide number. The trade-off is that site-wide CTR is the fastest number to reach for and the most misleading — pages ranking past position 20 dominate the denominator.',
  CTA: 'cta_tool_traffic_drop',
  'GSC Keywords': '',
  Status: '待写',
  URL: '',
  'Last Audit': '',
  page_id: PAGE_ID,
  cluster_id: 'search_performance_diagnosis',
  page_role: 'Series',
  content_angle:
    'An audit log, not an update explainer. We checked our own August drop and none of the five findings was the algorithm — retired URLs still taking impressions, AI citations landing on dead links, a CTR benchmark that no longer exists, a site-wide CTR whose denominator is junk, and a share that fell while the absolute number rose. The checklist ends at the diagnosis tool.',
  psych_safety_flag: 'N',
  journal_prompts: '',
  target_keyword_zh: '2026 年 8 月谷歌算法更新',
  author: 'Alex Chen',
};

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}

const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
const rows =
  (await greq(
    `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A1:AZ2000`)}?majorDimension=ROWS`,
    token,
  )).values || [];
const hdr = rows[0] || [];
const pidCol = hdr.indexOf('page_id');
if (pidCol < 0) { console.error('表头缺 page_id 列，abort'); process.exit(1); }

const exists = rows.findIndex((r, i) => i > 0 && String(r[pidCol] || '').trim() === PAGE_ID);
if (exists > 0) {
  console.log(`${PAGE_ID} 已在行 ${exists + 1}，不重复建行。`);
  process.exit(0);
}

// 未知列名 = 表结构与预期不符，停下来而不是静默丢字段。
const unknown = Object.keys(ROW).filter((k) => !hdr.includes(k));
if (unknown.length) { console.error(`这些字段在表头里找不到，abort: ${unknown.join(', ')}`); process.exit(1); }

const values = hdr.map((h) => (h in ROW ? ROW[h] : ''));
const targetRow = rows.length + 1;
console.log(`将在行 ${targetRow} 追加 ${PAGE_ID}：\n`);
hdr.forEach((h, i) => { if (values[i]) console.log(`  ${String(h).padEnd(20)} ${String(values[i]).slice(0, 100)}`); });

if (!WRITE) { console.log('\n[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }
const res = await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A${targetRow}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
  token,
  { method: 'POST', body: JSON.stringify({ values: [values] }) },
);
console.log(`\n✅ 已写入 ${res.updates?.updatedRange}（${res.updates?.updatedCells} 个单元格）`);
