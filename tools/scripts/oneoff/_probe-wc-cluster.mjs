#!/usr/bin/env node
// _probe-wc-cluster.mjs — 只读：对比临时副本与 prod 主表的 主题集群表 + CTA Map，
// 定位 worldcup2026_astro 集群行（临时副本有、prod 缺），核对表头对齐 + CTA 是否需补。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const TEMP = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const PROD = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

async function gget(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
async function tab(wb, name, token) {
  const r = encodeURIComponent(`${name}!A1:AZ2000`);
  return (await gget(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${r}?majorDimension=ROWS`, token)).values || [];
}
const { token } = await getAccessToken(SA, SCOPE);

for (const tabName of ['主题集群表', 'CTA Map']) {
  console.log(`\n═══════════ ${tabName} ═══════════`);
  const t = await tab(TEMP, tabName, token);
  const p = await tab(PROD, tabName, token);
  const th = t[0] || [], ph = p[0] || [];
  console.log(`临时副本: ${t.length} 行, ${th.length} 列`);
  console.log(`prod    : ${p.length} 行, ${ph.length} 列`);
  console.log(`表头一致: ${JSON.stringify(th) === JSON.stringify(ph) ? '✅ 是' : '❌ 不一致'}`);
  if (JSON.stringify(th) !== JSON.stringify(ph)) {
    console.log('  临时副本表头:', th.join(' | '));
    console.log('  prod 表头   :', ph.join(' | '));
  } else {
    console.log('  表头:', th.join(' | '));
  }
  if (tabName === '主题集群表') {
    const idCol = th.findIndex((h) => /cluster_id/i.test(h));
    console.log(`  cluster_id 在第 ${idCol} 列`);
    const tw = t.find((r) => (r[idCol] || '').trim() === 'worldcup2026_astro');
    const pw = p.find((r) => (r[idCol] || '').trim() === 'worldcup2026_astro');
    console.log(`  临时副本 worldcup2026_astro: ${tw ? '有' : '无'}  | prod: ${pw ? '有' : '无（待补）'}`);
    if (tw) { console.log('  临时副本该行全列:'); tw.forEach((c, i) => console.log(`    [${i}] ${th[i] || '?'}: ${String(c).slice(0, 70)}`)); }
    console.log(`  prod 现有数据行数(非空 cluster_id): ${p.filter((r, i) => i > 0 && (r[idCol] || '').trim()).length}`);
  }
}
