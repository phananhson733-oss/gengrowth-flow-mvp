#!/usr/bin/env node
/** 只读预演:结果复盘表 url ←→ GSC 快照 join,输出每行回填结果,供方案精确化。 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
loadEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);
async function get(range) {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(b.error?.message); return b.values || [];
}
// 读 GSC 快照 csv
const csv = readFileSync(join(__dirname, '..', '..', '..', '.gg-cache', 'gsc-pages-snapshot-2026-06-16.csv'), 'utf8').trim().split('\n');
const gsc = new Map();
for (let i = 1; i < csv.length; i++) {
  const [page, , top_keyword, clicks, impressions, , position] = csv[i].split(',');
  gsc.set(page.trim().replace(/\/$/, ''), { top_keyword, clicks: +clicks, impressions: +impressions, position: +position });
}
const R = await get('结果复盘表!A1:P200');
let joined = 0, zero = 0, nourl = 0;
console.log('row | page_id | url | GSC: imp / clicks / pos / topkw');
for (let i = 1; i < R.length; i++) {
  const pid = String(R[i][1] ?? '').trim();
  const url = String(R[i][3] ?? '').trim().replace(/\/$/, '');
  if (!pid && !url) continue;
  if (!url) { nourl++; continue; }
  const g = gsc.get(url);
  if (g) { joined++; console.log(`${i + 1} | ${pid} | ${url.replace('https://www.astrologywiki.com', '')} | ${g.impressions} / ${g.clicks} / ${g.position.toFixed(1)} / ${g.top_keyword}`); }
  else { zero++; console.log(`${i + 1} | ${pid} | ${url.replace('https://www.astrologywiki.com', '')} | (GSC近28天无展示→imp=0)`); }
}
console.log(`\n汇总: join上有数据=${joined}; 有url但GSC无展示=${zero}; 无url(本次不回填)=${nourl}`);
