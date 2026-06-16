#!/usr/bin/env node
/** 只读:写方案前的映射核查
 *  ① 选题登记表 C/D/E 是否公式列(确认能直接写值)
 *  ② 关键词主表 10 词的 C月搜索量/D KD/M意图 实际值(确认 join 干净)
 *  ③ 结果复盘表 B page_id + D url 全量(统计有 url 行,GSC join 覆盖面)
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);
async function get(range, opt = '') {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS${opt}`, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(b.error?.message); return b.values || [];
}
const norm = (s) => String(s ?? '').trim().toLowerCase();

// ① 选题登记表 C/D/E 公式检测(取一个完整行 1566 + 一个空行 1567)
console.log('=== ① 选题登记表 C/D/E 公式检测 ===');
const f1566 = (await get('选题登记表!A1566:F1566', '&valueRenderOption=FORMULA'))[0] || [];
const f1567 = (await get('选题登记表!A1567:F1567', '&valueRenderOption=FORMULA'))[0] || [];
console.log(`行1566(完整) C=${JSON.stringify(f1566[2])} D=${JSON.stringify(f1566[3])} E=${JSON.stringify(f1566[4])}`);
console.log(`行1567(缺列) C=${JSON.stringify(f1567[2])} D=${JSON.stringify(f1567[3])} E=${JSON.stringify(f1567[4])}`);

// ② 关键词主表 10 词 C/D/M
const KW = ['aura colors meaning', 'light green aura meaning', 'lime green aura meaning', 'aura colors and their meaning', '8th house in astrology', 'rahu in 2nd house and ketu in 8th house', 'dark green aura meaning', 'vedic astrology houses', 'rahu in 11th house and ketu in 5th house', 'light purple aura meaning'];
const M = await get('关键词主表!A1:AC2000');
console.log('\n=== ② 关键词主表 10 词 C月搜索量/D KD/M意图 ===');
for (const k of KW) {
  const r = M.find((row, i) => i > 0 && norm(row[0]) === norm(k));
  if (!r) { console.log(`✗ ${k}`); continue; }
  console.log(`  ${k}: C=${r[2] ?? ''} D=${r[3] ?? ''} M意图=${r[12] ?? ''}`);
}

// ③ 复盘表 B+D 全量
const R = await get('结果复盘表!A1:P200');
console.log('\n=== ③ 结果复盘表 page_id/url 覆盖 ===');
let withUrl = 0, noUrl = 0, noPid = 0;
const urls = [];
for (let i = 1; i < R.length; i++) {
  const pid = String(R[i][1] ?? '').trim();
  const url = String(R[i][3] ?? '').trim();
  if (!pid && !url) continue;
  if (!pid) noPid++;
  if (url) { withUrl++; urls.push(url); } else noUrl++;
}
console.log(`有 url 行: ${withUrl}; 无 url 行: ${noUrl}; 无 page_id 行: ${noPid}`);
console.log('有 url 的(可直接 GSC join):');
urls.forEach((u) => console.log('  ' + u.replace('https://www.astrologywiki.com', '')));
