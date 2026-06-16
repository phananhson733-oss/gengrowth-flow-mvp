#!/usr/bin/env node
/**
 * _diag-topic-dup.mjs — 只读:① 选题登记表 col>=23(X列起) 有数据的行范围(查重复脏数据)
 *  ② 10 个缺列新词在关键词主表的完整数据(查能否补)
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(
  join(homedir(), '.config', 'gg', 'gg-writer-sa.json'),
  ['https://www.googleapis.com/auth/spreadsheets.readonly']
);
async function get(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}
const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

// ① 选题登记表全宽扫描
const T = await get('选题登记表!A1:BZ1600');
const head = T[0] || [];
console.log(`选题登记表表头列数: ${head.length}`);
// 找出 index>=23 有值的行
console.log('\n=== col>=23 (X列起) 有数据的行 ===');
let dupRows = [];
let maxCol = head.length;
for (let i = 1; i < T.length; i++) {
  const r = T[i];
  if (r.length > maxCol) maxCol = r.length;
  const extra = r.slice(23).map((c) => String(c ?? '').trim()).filter(Boolean);
  if (extra.length) dupRows.push(i + 1);
}
console.log(`最宽行列数: ${maxCol} (=${col(maxCol - 1)}列)`);
console.log(`有 X+ 数据的行数: ${dupRows.length}`);
if (dupRows.length) console.log(`范围: 行${dupRows[0]} ~ 行${dupRows[dupRows.length - 1]}; 前20: ${dupRows.slice(0, 20).join(',')}`);
// 打印 1566 行 col>=23 的内容,看重复结构
const r1566 = T[1565] || [];
console.log('\n行1566 col 23+ 内容:');
r1566.slice(23).forEach((c, i) => { const v = String(c ?? '').trim(); if (v) console.log(`  ${col(23 + i)}[${23 + i}] = ${v.slice(0, 40)}`); });

// ② 10 个缺列词在关键词主表查
const KW = ['aura colors meaning', 'light green aura meaning', 'lime green aura meaning', 'aura colors and their meaning', '8th house in astrology', 'rahu in 2nd house and ketu in 8th house', 'dark green aura meaning', 'vedic astrology houses', 'rahu in 11th house and ketu in 5th house', 'light purple aura meaning'];
const M = await get('关键词主表!A1:AZ2000');
const mHead = M[0] || [];
const norm = (s) => String(s ?? '').trim().toLowerCase();
console.log('\n=== 关键词主表表头 ===');
mHead.forEach((h, i) => console.log(`  ${col(i)}[${i}] = ${h}`));
console.log('\n=== 10 词在关键词主表的命中 ===');
for (const k of KW) {
  const row = M.find((r, idx) => idx > 0 && norm(r[0]) === norm(k));
  if (!row) { console.log(`✗ 未命中: ${k}`); continue; }
  const filled = row.map((c, i) => String(c ?? '').trim() ? col(i) : null).filter(Boolean);
  console.log(`✓ ${k}\n    有值列: ${filled.join(',')}`);
}
