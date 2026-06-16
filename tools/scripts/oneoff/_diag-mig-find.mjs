#!/usr/bin/env node
/** 只读:副本选题登记表 A 列定位这 10 词 + #REF! 行范围 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();
const MIG = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);
async function get(range) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${MIG}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(b.error?.message); return b.values || [];
}
const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const KW = ['aura colors meaning', 'light green aura meaning', 'lime green aura meaning', 'aura colors and their meaning', '8th house in astrology', 'rahu in 2nd house and ketu in 8th house', 'dark green aura meaning', 'vedic astrology houses', 'rahu in 11th house and ketu in 5th house', 'light purple aura meaning'];
const norm = (s) => String(s ?? '').trim().toLowerCase();
const T = await get('选题登记表!A1:BZ1600');
console.log('=== 10 词在副本选题登记表命中行(全列) ===');
for (const k of KW) {
  const idx = T.findIndex((r, i) => i > 0 && norm(r[0]) === norm(k));
  if (idx < 0) { console.log(`✗ 未命中: ${k}`); continue; }
  const r = T[idx];
  const cells = r.map((c, ci) => { const v = String(c ?? '').trim(); return v ? `${col(ci)}=${v.slice(0, 18)}` : null; }).filter(Boolean).join(' | ');
  console.log(`✓ 行${idx + 1}: ${cells}`);
}
// #REF! 行统计
let refRows = [];
for (let i = 1; i < T.length; i++) { if (T[i].some((c) => String(c ?? '').includes('#REF!'))) refRows.push(i + 1); }
console.log(`\n#REF! 行数: ${refRows.length}; 范围 ${refRows[0]}~${refRows[refRows.length - 1]}`);
