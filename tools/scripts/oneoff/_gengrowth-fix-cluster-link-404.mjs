#!/usr/bin/env node
// _gengrowth-fix-cluster-link-404.mjs — 主题集群表 keyword_opportunity.internal_link_rule
// 里写的 /tools/low-competition-keywords 线上是 404（2026-08-07 核验）。站点上真实存在的
// 是 /tools/hidden-keywords（页面标题 "Keyword Opportunity Map"，正是该 cluster 的
// cta_primary「免费工具·关键词机会地图」）。这条规则会被 bridge 原样喂进写作 prompt，
// 不修就会在两篇新文章里写出死链。
//
// 默认 dry-run；--write 才写。幂等：目标串已不存在则跳过。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const TAB = '主题集群表';
const CLUSTER = 'keyword_opportunity';
const BAD = '/tools/low-competition-keywords';
const GOOD = '/tools/hidden-keywords';
const WRITE = process.argv.includes('--write');
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
function colLetter(idx) {
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const { token } = await getAccessToken(SA, SCOPE);
const range = encodeURIComponent(`${TAB}!A1:AZ2000`);
const rows = (await greq(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${range}?majorDimension=ROWS`, token)).values || [];
const header = rows[0] || [];
const idCol = header.findIndex((h) => /^cluster_id$/i.test(String(h).trim()));
const ruleCol = header.findIndex((h) => /^internal_link_rule$/i.test(String(h).trim()));
if (idCol < 0 || ruleCol < 0) { console.error('缺 cluster_id / internal_link_rule 列，abort'); process.exit(1); }

const rowIdx = rows.findIndex((r, i) => i > 0 && String(r[idCol] || '').trim() === CLUSTER);
if (rowIdx < 0) { console.error(`无 ${CLUSTER} 行，abort`); process.exit(1); }

const rowNum = rowIdx + 1;
const cur = String(rows[rowIdx][ruleCol] ?? '');
console.log(`行 ${rowNum} (${CLUSTER}) internal_link_rule:`);
console.log(`  现值: ${cur}`);
if (!cur.includes(BAD)) { console.log(`\n已不含 ${BAD} — 幂等跳过。`); process.exit(0); }
const next = cur.split(BAD).join(GOOD);
console.log(`  新值: ${next}`);

if (!WRITE) { console.log('\n[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }
const a1 = `${TAB}!${colLetter(ruleCol)}${rowNum}`;
const res = await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(a1)}?valueInputOption=USER_ENTERED`,
  token,
  { method: 'PUT', body: JSON.stringify({ values: [[next]] }) },
);
console.log(`\n✅ updated ${res.updatedRange} (${res.updatedCells} cell)`);
