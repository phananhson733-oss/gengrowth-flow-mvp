#!/usr/bin/env node
/** READ-ONLY: cross-tab impact + does any topic keyword map to slug signs-of-a-highly-sensitive-person? */
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

// 1. recap data row count
const recap = await get('结果复盘表!A1:P1004');
let dataRows = 0, withPid = 0, dupPids = {};
for (let i = 1; i < recap.length; i++) {
  const r = recap[i] || [];
  const a = String(r[0] ?? '').trim(), b = String(r[1] ?? '').trim();
  if (b) { withPid++; dupPids[b] = (dupPids[b] || 0) + 1; }
  if (a || b || r.slice(2).some((c) => String(c ?? '').trim())) dataRows++;
}
console.log(`复盘表: 非空行=${dataRows}, 有page_id行=${withPid}`);
const dups = Object.entries(dupPids).filter(([, n]) => n > 1);
console.log(`重复 page_id: ${dups.length ? JSON.stringify(dups) : '仅 PG-EMPATH-004 (已知)'}`);

// 2. does any topic register keyword have slug "signs-of-a-highly-sensitive-person"?
const topic = await get('选题登记表!A1:W2000');
console.log('\n=== 选题登记表 含 "signs of a highly sensitive" 或 slug 候选 ===');
for (let i = 1; i < topic.length; i++) {
  const r = topic[i] || [];
  const joined = r.map((c) => String(c ?? '')).join(' ').toLowerCase();
  if (/signs of a highly sensitive|signs-of-a-highly/.test(joined)) {
    console.log(`行${i + 1}: A="${r[0]}" | P=${r[15]} | N=${r[13]}`);
  }
}
console.log('(若无输出 = 选题登记表里没有为 row59 slug 分配的 page_id)');

// 3. cross-tab: CTA Map / pipeline-status / publish-log / 内容追踪 referencing PG-EMPATH-004 or the two aura/houses topics
const tabs = ['CTA Map', 'pipeline-status', 'publish-log', '内容追踪'];
for (const t of tabs) {
  try {
    const v = await get(`${t}!A1:AZ2000`);
    const hits = [];
    for (let i = 1; i < v.length; i++) {
      const joined = (v[i] || []).map((c) => String(c ?? '')).join(' ');
      if (/PG-EMPATH-004|highly-sensitive-person/i.test(joined)) hits.push(`行${i + 1}`);
    }
    console.log(`\n[${t}] EMPATH-004/hsp 相关行: ${hits.length ? hits.join(',') : '无'} (总行${v.length})`);
  } catch (e) { console.log(`\n[${t}] 读取失败: ${e.message}`); }
}
console.log('\nDONE.');
