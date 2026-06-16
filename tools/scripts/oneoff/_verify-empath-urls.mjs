#!/usr/bin/env node
/** READ-ONLY: full URLs + slug analysis for PG-EMPATH-004 conflict (rows 59/85 recap, rows 57-60 topic). */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);
async function get(range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(`${r.status} ${b.error?.message}`); return b.values || [];
}
const recap = await get('结果复盘表!A1:P200');
console.log('=== 复盘表 full URLs ===');
console.log('行59:', 'B=' + recap[58][1], '| C=' + recap[58][2], '| D=' + recap[58][3]);
console.log('行85:', 'B=' + recap[84][1], '| C=' + recap[84][2], '| D=' + recap[84][3]);
const topic = await get('选题登记表!A1:W2000');
console.log('\n=== 选题登记表 EMPATH series page_id <-> Target Keyword <-> URL(N) ===');
for (const i of [57, 58, 59, 60]) {
  const r = topic[i] || [];
  console.log(`行${i + 1}: P=${r[15]} | A="${r[0]}" | M=${r[12]} | N(URL)=${r[13] || '(empty)'}`);
}
console.log('\n注：选题登记表 PG-EMPATH-004 = Target Keyword "signs you\'re a highly sensitive person"');
console.log('对照复盘表两行的 slug:');
console.log('  行59 slug = signs-of-a-highly-sensitive-person');
console.log('  行85 slug = signs-you-re-a-highly-sensitive-person');
