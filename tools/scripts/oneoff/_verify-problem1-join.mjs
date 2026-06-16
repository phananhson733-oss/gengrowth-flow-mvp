#!/usr/bin/env node
/** 只读独立验证 — 问题1 join 正确性核查（不信任方案数字，现场重算）
 *  A. 选题登记表 + 关键词主表 表头（列定义对照）
 *  B. 10 词在关键词主表是否存在且唯一（重复/歧义检测）
 *  C. 方案表格 C/D 值 vs 关键词主表实际值 逐一比对
 *  D. 关键词主表「意图」列是否全 Informational
 *  E. 选题登记表 C/D/E 是否公式（FORMULA render，1566 完整 + 1567 空）
 *  F. 关键词主表 10 词其他非空列 vs 选题登记表列定义 → 找漏补
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(
  join(homedir(), '.config', 'gg', 'gg-writer-sa.json'),
  ['https://www.googleapis.com/auth/spreadsheets.readonly'],
);
async function get(range, opt = '') {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS${opt}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const b = await r.json();
  if (!r.ok) throw new Error(b.error?.message);
  return b.values || [];
}
const norm = (s) => String(s ?? '').trim().toLowerCase();
const colLetter = (i) => {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
};

// 方案声明的期望值（仅用于比对，不作为事实源）
const PLAN = [
  { row: 1567, kw: 'aura colors meaning', C: 1300, D: 1 },
  { row: 1568, kw: 'light green aura meaning', C: 350, D: 1 },
  { row: 1569, kw: 'lime green aura meaning', C: 250, D: 3 },
  { row: 1570, kw: 'aura colors and their meaning', C: 250, D: 9 },
  { row: 1571, kw: '8th house in astrology', C: 250, D: 14 },
  { row: 1572, kw: 'rahu in 2nd house and ketu in 8th house', C: 200, D: 0 },
  { row: 1573, kw: 'dark green aura meaning', C: 200, D: 1 },
  { row: 1574, kw: 'vedic astrology houses', C: 200, D: 7 },
  { row: 1575, kw: 'rahu in 11th house and ketu in 5th house', C: 200, D: 0 },
  { row: 1576, kw: 'light purple aura meaning', C: 200, D: 1 },
];

console.log('================ A. 表头对照 ================');
const dengHeader = (await get('选题登记表!A1:AZ1'))[0] || [];
const kwHeader = (await get('关键词主表!A1:AZ1'))[0] || [];
console.log('--- 选题登记表 表头 ---');
dengHeader.forEach((h, i) => { if (h) console.log(`  ${colLetter(i)} = ${h}`); });
console.log('--- 关键词主表 表头 ---');
kwHeader.forEach((h, i) => { if (h) console.log(`  ${colLetter(i)} = ${h}`); });

console.log('\n================ B+C+D+F. 关键词主表 join ================');
const KW = await get('关键词主表!A1:AZ3000');
// 关键词主表 列名 → index 映射
const kwIdx = {};
kwHeader.forEach((h, i) => { if (h) kwIdx[String(h).trim()] = i; });
// 选题登记表 列名集合（用于判断主表某列能否补进登记表）
const dengNames = new Set(dengHeader.filter(Boolean).map((h) => String(h).trim()));
console.log('选题登记表列名集合:', [...dengNames].join(' | '));

let intentColIdx = -1;
for (let i = 0; i < kwHeader.length; i++) {
  if (String(kwHeader[i]).trim() === '意图' || String(kwHeader[i]).trim().toLowerCase() === 'intent') intentColIdx = i;
}
console.log(`关键词主表「意图」列 index = ${intentColIdx} (${intentColIdx >= 0 ? colLetter(intentColIdx) : 'N/A'})`);

console.log('\n行 | 关键词 | 匹配数 | 主表C | 主表D | 主表意图 | 方案C | 方案D | C一致 | D一致');
const issues = [];
for (const p of PLAN) {
  const matches = [];
  for (let i = 1; i < KW.length; i++) {
    if (norm(KW[i][0]) === norm(p.kw)) matches.push(i + 1); // 1-based row
  }
  if (matches.length === 0) {
    console.log(`${p.row} | ${p.kw} | 0 | — | — | — | — | — | MISSING`);
    issues.push(`${p.kw}: 主表无匹配`);
    continue;
  }
  const rowI = matches[0] - 1;
  const row = KW[rowI];
  const realC = row[2];
  const realD = row[3];
  const realIntent = intentColIdx >= 0 ? row[intentColIdx] : '';
  const cOk = String(realC ?? '').trim() === String(p.C);
  const dOk = String(realD ?? '').trim() === String(p.D);
  console.log(
    `${p.row} | ${p.kw} | ${matches.length}${matches.length > 1 ? '(' + matches.join(',') + ')' : ''} | ${realC} | ${realD} | ${realIntent} | ${p.C} | ${p.D} | ${cOk ? 'Y' : 'NO'} | ${dOk ? 'Y' : 'NO'}`,
  );
  if (matches.length > 1) issues.push(`${p.kw}: 主表 ${matches.length} 个匹配 (歧义) rows=${matches.join(',')}`);
  if (!cOk) issues.push(`${p.kw}: C不一致 主表=${realC} 方案=${p.C}`);
  if (!dOk) issues.push(`${p.kw}: D不一致 主表=${realD} 方案=${p.D}`);
  if (norm(realIntent) !== 'informational') issues.push(`${p.kw}: 意图非Informational = "${realIntent}"`);

  // F: 主表该行其他非空列 + 登记表也有同名列 → 潜在漏补
  const leftover = [];
  for (let c = 0; c < row.length; c++) {
    const name = String(kwHeader[c] ?? '').trim();
    if (!name) continue;
    const val = String(row[c] ?? '').trim();
    if (!val) continue;
    if (['关键词', 'A'].includes(name)) continue;
    if (c === 2 || c === 3 || c === intentColIdx) continue; // 已补 C/D/Intent
    if (dengNames.has(name)) leftover.push(`${colLetter(c)}「${name}」=${val}`);
  }
  if (leftover.length) console.log(`     ↳ 潜在漏补(主表非空且登记表有同名列): ${leftover.join('; ')}`);
}

console.log('\n================ E. 选题登记表 C/D/E 公式检测 (FORMULA render) ================');
const f1566 = (await get('选题登记表!A1566:F1566', '&valueRenderOption=FORMULA'))[0] || [];
const f1567 = (await get('选题登记表!A1567:F1567', '&valueRenderOption=FORMULA'))[0] || [];
const dumpRow = (label, r) => {
  console.log(`${label}: A=${JSON.stringify(r[0])} C=${JSON.stringify(r[2])} D=${JSON.stringify(r[3])} E=${JSON.stringify(r[4])}`);
  for (const idx of [2, 3, 4]) {
    const v = String(r[idx] ?? '');
    if (v.startsWith('=')) issues.push(`选题登记表 ${colLetter(idx)} 含公式: ${v}`);
  }
};
dumpRow('行1566(完整)', f1566);
dumpRow('行1567(应空)', f1567);

console.log('\n================ 问题清单 ================');
if (issues.length === 0) console.log('无 — 全部一致');
else issues.forEach((x) => console.log('  ✗ ' + x));
