#!/usr/bin/env node
/**
 * _diag-topic-tail.mjs — 只读诊断:正式表(1CkjOC) 选题登记表尾部行,排查"拷贝结果不对"。
 * 找出只有 A 列有值、其余列空的行,以及与表头列的对照。
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

async function get(range, opt = '') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS${opt}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}

const TAB = '选题登记表';
const head = (await get(`${TAB}!A1:AZ1`))[0] || [];
console.log(`表头 ${head.length} 列:`);
head.forEach((h, i) => console.log(`  [${i}] ${String.fromCharCode(65 + i)} = ${h}`));

const rows = await get(`${TAB}!A1:AZ2000`);
console.log(`\n总行数(含表头): ${rows.length}`);

// 找出只有 A 列、其余空的行(疑似坏拷贝)
console.log('\n=== 疑似坏行(A 有值,B 之后全空) ===');
let bad = 0;
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const a = String(r[0] ?? '').trim();
  if (!a) continue;
  const rest = r.slice(1).map((c) => String(c ?? '').trim()).filter(Boolean);
  if (rest.length === 0) {
    bad++;
    console.log(`  行${i + 1}: "${a}"`);
  }
}
console.log(`坏行总数: ${bad}`);

// 打印尾部 30 行全列,看实际形态
console.log('\n=== 尾部 30 行(全列) ===');
const start = Math.max(1, rows.length - 30);
for (let i = start; i < rows.length; i++) {
  const r = rows[i];
  const cells = r.map((c, ci) => `${String.fromCharCode(65 + ci)}=${String(c ?? '').trim().slice(0, 18)}`).filter((s) => !s.endsWith('=')).join(' | ');
  console.log(`行${i + 1}: ${cells || '(空)'}`);
}
