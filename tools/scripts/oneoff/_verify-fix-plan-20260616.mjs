#!/usr/bin/env node
/**
 * _verify-fix-plan-20260616.mjs — READ-ONLY safety verification of FIX-PLAN-2026-06-16.md
 * Verifies destructive/irreversible actions against actual sheet state. Writes nothing.
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

async function meta() {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}?fields=sheets.properties(title,gridProperties)`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`META FAIL: ${r.status} ${b.error?.message || ''}`);
  return b.sheets.map((s) => s.properties);
}
async function get(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}
const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const rowStr = (r) => r.map((c, ci) => { const v = String(c ?? '').trim(); return v ? `${col(ci)}=${JSON.stringify(v.slice(0, 60))}` : null; }).filter(Boolean).join(' | ');

console.log('=== WORKBOOK TABS ===');
const props = await meta();
for (const p of props) console.log(`  ${p.title}  (${p.gridProperties?.rowCount}x${p.gridProperties?.columnCount})`);

const RECAP = '结果复盘表';
const TOPIC = '选题登记表';

console.log('\n=== 结果复盘表 HEADER ===');
const recap = await get(`${RECAP}!A1:AZ200`);
const recapHead = recap[0] || [];
recapHead.forEach((h, i) => { if (String(h ?? '').trim()) console.log(`  ${col(i)}[${i}] = ${h}`); });

console.log('\n=== 3A.1 行66 (清空整行) ===');
console.log(`行66: ${rowStr(recap[65] || [])}`);
console.log(`行65: ${rowStr(recap[64] || [])}`);
console.log(`行67: ${rowStr(recap[66] || [])}`);
console.log(`行71 (应空): ${rowStr(recap[70] || [])}`);

console.log('\n=== 3A.3 行59 / 行85 page_id 冲突 (PG-EMPATH-004) ===');
console.log(`行59 FULL: ${rowStr(recap[58] || [])}`);
console.log(`行85 FULL: ${rowStr(recap[84] || [])}`);

console.log('\n=== 复盘表所有 PG-EMPATH-* page_id (定位 B 列?) ===');
// find page_id column by header
let pidCol = -1;
recapHead.forEach((h, i) => { if (/page_id/i.test(String(h ?? ''))) pidCol = i; });
console.log(`(page_id 列 = ${pidCol >= 0 ? col(pidCol) : 'NOT FOUND, scanning all cells'})`);
for (let i = 1; i < recap.length; i++) {
  const r = recap[i] || [];
  const joined = r.map((c) => String(c ?? '')).join(' ');
  if (/PG-EMPATH/i.test(joined)) console.log(`  行${i + 1}: ${rowStr(r)}`);
}

console.log('\n=== 3A.4 aura 行2-9 K列 vs O列 + 全表 K列"调整"扫描 ===');
// K = index 10, O = index 14
for (let i = 1; i <= 9 && i < recap.length; i++) {
  const r = recap[i] || [];
  console.log(`  行${i + 1}: A=${JSON.stringify(String(r[0] ?? '').slice(0, 20))} K=${JSON.stringify(String(r[10] ?? ''))} O=${JSON.stringify(String(r[14] ?? ''))}`);
}
console.log('  -- 全表 K列="调整" 的行 --');
let kAdjust = [];
let oNonEmpty = [];
for (let i = 1; i < recap.length; i++) {
  const r = recap[i] || [];
  const k = String(r[10] ?? '').trim();
  const o = String(r[14] ?? '').trim();
  if (k === '调整') kAdjust.push(i + 1);
  if (o) oNonEmpty.push(`行${i + 1}:O=${JSON.stringify(o)}`);
}
console.log(`  K列="调整" 的行: ${JSON.stringify(kAdjust)} (count=${kAdjust.length})`);
console.log(`  O列非空的行: ${oNonEmpty.length ? oNonEmpty.join(' | ') : '(none — O全空)'}`);
// also show what K column otherwise contains for the aura rows target & any non-empty non-调整 K
console.log('  -- 全表 K列非空且非"调整" --');
for (let i = 1; i < recap.length; i++) {
  const r = recap[i] || [];
  const k = String(r[10] ?? '').trim();
  if (k && k !== '调整') console.log(`    行${i + 1}: K=${JSON.stringify(k.slice(0, 40))}`);
}

console.log('\n=== 选题登记表: PG-EMPATH page_id 分配 ===');
const topic = await get(`${TOPIC}!A1:AZ2000`);
const topicHead = topic[0] || [];
console.log('选题登记表 HEADER:');
topicHead.forEach((h, i) => { if (String(h ?? '').trim()) console.log(`  ${col(i)}[${i}] = ${h}`); });
let tPidCol = -1;
topicHead.forEach((h, i) => { if (/page_id/i.test(String(h ?? ''))) tPidCol = i; });
console.log(`(选题登记表 page_id 列 = ${tPidCol >= 0 ? col(tPidCol) : 'NOT FOUND'})`);
console.log('  -- 含 PG-EMPATH 的行 --');
for (let i = 1; i < topic.length; i++) {
  const r = topic[i] || [];
  const joined = r.map((c) => String(c ?? '')).join(' ');
  if (/PG-EMPATH/i.test(joined)) console.log(`  行${i + 1}: ${rowStr(r)}`);
}

console.log('\n=== 选题登记表 行1566-1576 (问题1 上下文) ===');
for (let i = 1565; i <= 1576 && i < topic.length; i++) {
  console.log(`  行${i + 1}: ${rowStr(topic[i] || [])}`);
}

console.log('\nDONE (read-only).');
