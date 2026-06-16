#!/usr/bin/env node
/** 只读独立验证 — 问题3 GSC join 核查（重算方案的 54/34/20/41 数字 + url 匹配抽查）
 *  1. 复盘表 D url 统计：有 url 行 / 无 url 行 / join 上 / 0展示
 *  2. url 归一化抽查：trailing slash / http vs https / /en/ 前缀 是否漏配错配
 *  3. 列出 join 上 + 未 join 的 url，供人工核对
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
loadEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const { token } = await getAccessToken(
  join(homedir(), '.config', 'gg', 'gg-writer-sa.json'),
  ['https://www.googleapis.com/auth/spreadsheets.readonly'],
);
async function get(range) {
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const b = await r.json();
  if (!r.ok) throw new Error(b.error?.message);
  return b.values || [];
}

// 读 GSC 快照 csv（方案预演用的同一份）
const csvPath = join(__dirname, '..', '..', '..', '.gg-cache', 'gsc-pages-snapshot-2026-06-16.csv');
const csv = readFileSync(csvPath, 'utf8').trim().split('\n');
// 方案 join 用的归一化：仅去尾斜杠（与 _plan-recap-join.mjs 一致）
const stripSlash = (u) => String(u ?? '').trim().replace(/\/$/, '');
// 更宽松归一化（探测潜在错配）：lowercase + 去协议 + 去尾斜杠
const loose = (u) => String(u ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');

const gscByStrict = new Map(); // 方案口径
const gscByLoose = new Map();  // 宽松口径
const gscPages = [];
for (let i = 1; i < csv.length; i++) {
  const cols = csv[i].split(',');
  const page = cols[0];
  const rec = { page, top_keyword: cols[2], clicks: +cols[3], impressions: +cols[4], position: +cols[6] };
  gscByStrict.set(stripSlash(page), rec);
  gscByLoose.set(loose(page), rec);
  gscPages.push(page);
}
console.log(`GSC 快照行数(数据): ${gscPages.length}`);

const R = await get('结果复盘表!A1:P200');
let withUrl = 0, noUrl = 0;
let joinedStrict = 0, zeroStrict = 0;
let onlyLoose = 0;       // 方案口径没匹配上但宽松能匹配 → 潜在错配/漏配
const onlyLooseList = [];
const joinedList = [];
const zeroList = [];
let dataRows = 0;

for (let i = 1; i < R.length; i++) {
  const pid = String(R[i][1] ?? '').trim();
  const url = String(R[i][3] ?? '').trim();
  if (!pid && !url) continue;
  dataRows++;
  if (!url) { noUrl++; continue; }
  withUrl++;
  const s = stripSlash(url);
  const g = gscByStrict.get(s);
  if (g) {
    joinedStrict++;
    joinedList.push({ row: i + 1, url: s, g });
  } else {
    // 方案口径 miss：检查宽松口径能否匹配（暴露 http/https、大小写、前缀差异）
    const gl = gscByLoose.get(loose(url));
    if (gl) {
      onlyLoose++;
      onlyLooseList.push({ row: i + 1, url, matched: gl.page });
    } else {
      zeroStrict++;
      zeroList.push({ row: i + 1, url: s });
    }
  }
}

console.log('\n================ 数字核对（方案声称 vs 重算）================');
console.log(`复盘表数据行(有 pid 或 url): ${dataRows}   [方案说 54 行有 url]`);
console.log(`有 url 行: ${withUrl}   [方案: 54]`);
console.log(`无 url 行: ${noUrl}   [方案: 41]`);
console.log(`join 上(方案严格口径): ${joinedStrict}   [方案: 34]`);
console.log(`有 url 但 GSC 0 展示: ${zeroStrict}   [方案: 20]`);
console.log(`★ 仅宽松口径能匹配(方案严格口径漏配): ${onlyLoose}  ← 若 >0 说明 join 键有 http/大小写/前缀缺陷`);

console.log('\n================ url 归一化抽查（前 5 个 join 上的）================');
joinedList.slice(0, 5).forEach((j) => {
  // 校验严格匹配的 url 与 GSC page 是否真的逐字相等（去尾斜杠后）
  const exact = stripSlash(j.g.page) === j.url;
  console.log(`行${j.row}: 复盘url=${j.url}`);
  console.log(`        GSC page=${stripSlash(j.g.page)}  逐字相等=${exact ? 'Y' : 'NO'}`);
  console.log(`        imp=${j.g.impressions} clicks=${j.g.clicks} pos=${j.g.position.toFixed(1)} topkw=${j.g.top_keyword}`);
});

if (onlyLooseList.length) {
  console.log('\n★★ 潜在漏配（严格口径没配上、宽松能配）：');
  onlyLooseList.forEach((x) => console.log(`  行${x.row}: 复盘url=${x.url}  →宽松匹配到 GSC=${x.matched}`));
} else {
  console.log('\n宽松口径未发现额外匹配 → 方案的去尾斜杠 join 没漏 http/大小写/前缀差异。');
}

console.log('\n================ url 协议/前缀分布（探测脏数据）================');
const protoStats = {};
for (let i = 1; i < R.length; i++) {
  const url = String(R[i][3] ?? '').trim();
  if (!url) continue;
  const proto = url.startsWith('https://') ? 'https' : url.startsWith('http://') ? 'http' : (url.startsWith('/') ? 'relative' : 'other');
  protoStats[proto] = (protoStats[proto] || 0) + 1;
}
console.log(JSON.stringify(protoStats));

console.log('\n================ 有 url 但 0 展示（前 10）================');
zeroList.slice(0, 10).forEach((z) => console.log(`  行${z.row}: ${z.url}`));
console.log(`(共 ${zeroList.length} 行)`);
