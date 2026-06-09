#!/usr/bin/env node
// READ-ONLY: 抓 B3(待填P1/Pillar词的行+现W) + B5(生产候选A1/X2公式) 现状，供核验与写入。
import { getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const WB = process.argv[2] || '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WB}`;
const get = async (r, opt = '') => (await gFetch(`${base}/values/${encodeURIComponent(r)}${opt}`, token)).values || [];
const norm = (s) => String(s || '').trim().toLowerCase();

const grid = await get('关键词主表!A1:AC1500');
const H = grid[0]; const idx = {}; H.forEach((h, i) => idx[h] = i);
const rows = grid.slice(1);
// 集群优先级 + Pillar
const clus = await get('主题集群表!A1:S999');
const cH = clus[0]; const cidC = cH.indexOf('cluster_id'), prioC = cH.indexOf('priority');
const prio = {}; clus.slice(1).forEach(r => { const c = (r[cidC] || '').trim(); if (c) prio[c] = (r[prioC] || '').trim(); });
const topic = await get('选题登记表!A1:AC1530');
const tH = topic[0]; const tkC = tH.indexOf('Target Keyword'), roleC = tH.indexOf('page_role');
const pillar = new Set(topic.slice(1).filter(r => (r[roleC] || '').trim() === 'Pillar').map(r => norm(r[tkC])));

console.log('=== B3: N=待填 且属 P0/P1/Pillar 的行（拟标 W=集群必需）===');
const b3 = [];
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]; if (!(r[0] || '').toString().trim()) continue;
  if ((r[idx['竞争建议']] || '').trim() !== '待填') continue;
  const cid = (r[idx['cluster_id']] || '').trim(), kw = norm(r[0]);
  const p = prio[cid];
  if (p === 'P0' || p === 'P1' || pillar.has(kw)) {
    b3.push({ row: i + 2, kw: r[0], cid, prio: p || (pillar.has(kw) ? 'Pillar' : ''), curW: (r[idx['手动生产准入']] || '').trim() });
  }
}
b3.forEach(x => console.log(`  行${x.row} ${x.kw} | cluster=${x.cid}[${x.prio}] | 现W=「${x.curW}」`));
console.log(`B3 共 ${b3.length} 行；其中现W非空(会被跳过不覆盖): ${b3.filter(x => x.curW).length}`);

console.log('\n=== B5: 生产候选!A1 + 关键词主表!X2 现公式 ===');
const v = await get('生产候选!A1', '?valueRenderOption=FORMULA');
console.log('生产候选!A1 =', JSON.stringify((v[0] || [])[0] || ''));
const x = await get('关键词主表!X2', '?valueRenderOption=FORMULA');
console.log('关键词主表!X2 =', JSON.stringify((x[0] || [])[0] || ''));
console.log('\nB3_ROWS_JSON=' + JSON.stringify(b3.filter(x => !x.curW).map(x => x.row)));
