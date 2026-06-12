#!/usr/bin/env node
// _find-wc-rows.mjs — 只读：在临时表选题登记表里定位 World Cup 行（page_id 含 WC 或关键词含 world cup/球员名）。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = process.argv[2] || '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const TAB = '选题登记表';
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

async function gget(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
const { token } = await getAccessToken(SA, SCOPE);
const range = encodeURIComponent(`${TAB}!A1:AC3000`);
const rows = (await gget(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${range}?majorDimension=ROWS`, token)).values || [];
const header = rows[0] || [];
const pidCol = header.indexOf('page_id');
const reWC = /\bWC\b|world cup|messi|ronaldo|mbappe|yamal|vinicius|argentina|soccer|world-cup/i;

console.log('header cols:', header.map((h, i) => `${i}:${h}`).join(' | '));
console.log(`page_id 在第 ${pidCol} 列\n`);
let n = 0;
rows.forEach((r, i) => {
  if (i === 0) return;
  const pid = (r[pidCol] || '').toString();
  const kw = (r[0] || '').toString();
  const assoc = (r[1] || '').toString();
  if (/WC/i.test(pid) || reWC.test(kw) || reWC.test(assoc)) {
    n++;
    console.log(`R${i + 1} [${pid}] kw="${kw}" | status="${r[12] || ''}" | tier=${r[5] || ''} | template=${r[6] || ''} | entity="${r[7] || ''}" | cluster=${r[16] || ''} | role=${r[17] || ''} | author=${r[22] || ''}`);
  }
});
console.log(`\n共 ${n} 行命中。表总行数 ${rows.length}。`);
