#!/usr/bin/env node
/**
 * _diag-mig-topic.mjs — 只读:迁移副本(1UaTxBQ) 选题登记表 1020-1080 行形态,
 * 查问题1这批(aura/houses/rahu) 在副本里到底有哪些列,确认源头完整度。
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const MIG = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const { token } = await getAccessToken(
  join(homedir(), '.config', 'gg', 'gg-writer-sa.json'),
  ['https://www.googleapis.com/auth/spreadsheets.readonly']
);
async function get(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${MIG}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}
const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };

const head = (await get('选题登记表!A1:BZ1'))[0] || [];
console.log(`副本 选题登记表表头 ${head.length} 列:`);
head.forEach((h, i) => { if (String(h ?? '').trim()) console.log(`  ${col(i)}[${i}] = ${h}`); });

const T = await get('选题登记表!A1010:BZ1090');
console.log('\n=== 副本 行1010-1090(全列) ===');
T.forEach((r, idx) => {
  const rowNum = 1010 + idx;
  const cells = r.map((c, ci) => { const v = String(c ?? '').trim(); return v ? `${col(ci)}=${v.slice(0, 20)}` : null; }).filter(Boolean).join(' | ');
  if (cells) console.log(`行${rowNum}: ${cells}`);
});
