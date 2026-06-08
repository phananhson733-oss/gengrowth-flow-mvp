#!/usr/bin/env node
// READ-ONLY: §5 criterion — N=待填 行中是否有 P0/Pillar 词被默认暂缓 (V→暂缓)。
import { getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const COPY = process.argv[2] || '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${COPY}`;
const getV = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];

const grid = await getV('关键词主表!A1:AC1500');
const hdr = grid[0]; const idx = {}; hdr.forEach((h, i) => idx[h] = i);
const rows = grid.slice(1).filter(r => (r[0] || '').toString().trim() !== '');
const nC = idx['竞争建议'], vC = idx['生产准入'], acC = idx['cluster_id'];

// P0 cluster ids
const clus = await getV('主题集群表!A1:S999');
const cH = clus[0]; const cidC = cH.indexOf('cluster_id'), prioC = cH.indexOf('priority');
const p0ids = new Set(clus.slice(1).filter(r => (r[prioC] || '').trim() === 'P0').map(r => (r[cidC] || '').trim()));
const p1ids = new Set(clus.slice(1).filter(r => (r[prioC] || '').trim() === 'P1').map(r => (r[cidC] || '').trim()));

// Pillar keywords from 选题登记表 (page_role=Pillar → Target Keyword)
const topic = await getV('选题登记表!A1:AC1530');
const tH = topic[0]; const tkC = tH.indexOf('Target Keyword'), roleC = tH.indexOf('page_role');
const pillarKw = new Set(topic.slice(1).filter(r => (r[roleC] || '').trim() === 'Pillar').map(r => (r[tkC] || '').toString().trim().toLowerCase()));

let tianpian = 0, tpHold = 0;
const flagged = [];
for (const r of rows) {
  if ((r[nC] || '').toString().trim() !== '待填') continue;
  tianpian++;
  const v = (r[vC] || '').toString().trim();
  if (v === '暂缓') tpHold++;
  const cid = (r[acC] || '').toString().trim();
  const kw = (r[0] || '').toString().trim().toLowerCase();
  const isP0 = p0ids.has(cid), isP1 = p1ids.has(cid), isPillar = pillarKw.has(kw);
  if (isP0 || isP1 || isPillar) flagged.push({ kw: r[0], cid, v, why: [isP0 && 'P0', isP1 && 'P1', isPillar && 'Pillar'].filter(Boolean).join('+') });
}
console.log(`N=待填 行数: ${tianpian} | 其中 V=暂缓: ${tpHold}`);
console.log(`待填 且属 P0/P1/Pillar 的词: ${flagged.length}`);
for (const f of flagged) console.log(`  ⚠️ ${f.kw} | cluster=${f.cid} | 生产准入=${f.v} | ${f.why}`);
if (!flagged.length) console.log('  ✅ 无 P0/P1/Pillar 词因 待填 被默认暂缓');
