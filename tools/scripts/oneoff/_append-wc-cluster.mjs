#!/usr/bin/env node
// _append-wc-cluster.mjs — 把临时副本 主题集群表 的 worldcup2026_astro 行 append 进 prod 主表。
// 默认 dry-run（只预览）；加 --write 才真正写。幂等：prod 已有该 cluster 则跳过。
// 表头已验证一致（19 列），CTA Map 已一致无需补。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const TEMP = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const PROD = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const TAB = '主题集群表';
const CLUSTER = 'worldcup2026_astro';
const WRITE = process.argv.includes('--write');
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

async function greq(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) } });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
async function rows(wb, token) {
  const r = encodeURIComponent(`${TAB}!A1:AZ2000`);
  return (await greq(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${r}?majorDimension=ROWS`, token)).values || [];
}

const { token } = await getAccessToken(SA, SCOPE);
const t = await rows(TEMP, token);
const p = await rows(PROD, token);
const th = t[0] || [];
const idCol = th.findIndex((h) => /cluster_id/i.test(h));

const srcRow = t.find((r) => (r[idCol] || '').trim() === CLUSTER);
if (!srcRow) { console.error(`临时副本无 ${CLUSTER} 行，abort`); process.exit(1); }
const exists = p.some((r, i) => i > 0 && (r[idCol] || '').trim() === CLUSTER);

console.log(`源行 (${srcRow.length} 列):`);
srcRow.forEach((c, i) => console.log(`  [${i}] ${th[i] || '(note)'}: ${String(c).slice(0, 64)}`));
console.log(`\nprod 已有 ${CLUSTER}? ${exists ? '是 → 跳过（幂等）' : '否 → 待 append'}`);

if (exists) { console.log('幂等跳过，无需写。'); process.exit(0); }
if (!WRITE) { console.log('\n[DRY-RUN] 加 --write 才真正 append。'); process.exit(0); }

const res = await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${PROD}/values/${encodeURIComponent(TAB + '!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
  token,
  { method: 'POST', body: JSON.stringify({ values: [srcRow] }) },
);
console.log(`\n✅ appended. updatedRange: ${res.updates?.updatedRange}  updatedRows: ${res.updates?.updatedRows}`);
