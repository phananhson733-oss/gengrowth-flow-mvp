#!/usr/bin/env node
/**
 * _diag-recap.mjs — 只读:正式表(1CkjOC) 结果复盘表现状,排查"没更新"。
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

const T = await get('结果复盘表!A1:AZ500');
const head = T[0] || [];
console.log(`结果复盘表表头 ${head.length} 列:`);
head.forEach((h, i) => console.log(`  ${col(i)}[${i}] = ${h}`));
console.log(`\n总行数(含表头): ${T.length}`);

// 数据行(A 有值且非 markdown section)
const dataRows = [];
for (let i = 1; i < T.length; i++) {
  const a = String(T[i][0] ?? '').trim();
  if (a && !/^#{1,6}\s+/.test(a)) dataRows.push(i + 1);
}
console.log(`有数据行(A 非空): ${dataRows.length}`);

console.log('\n=== 全部数据行 ===');
for (let i = 1; i < T.length; i++) {
  const r = T[i];
  const cells = r.map((c, ci) => { const v = String(c ?? '').trim(); return v ? `${col(ci)}=${v.slice(0, 22)}` : null; }).filter(Boolean).join(' | ');
  if (cells) console.log(`行${i + 1}: ${cells}`);
}
