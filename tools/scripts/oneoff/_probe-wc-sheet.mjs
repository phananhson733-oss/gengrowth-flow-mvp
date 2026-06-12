#!/usr/bin/env node
// _probe-wc-sheet.mjs — 只读：dump World Cup 临时表的 tab 列表 + 指定 gid 的内容。
// 不写任何数据。用法：node tools/scripts/oneoff/_probe-wc-sheet.mjs [<workbookId>] [<gid>]
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = process.argv[2] || '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const GID = Number(process.argv[3] ?? 578086476);
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

async function gget(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${body.error?.message || res.statusText}`); e.status = res.status; throw e; }
  return body;
}

const { token } = await getAccessToken(SA, SCOPE);

let meta;
try {
  meta = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${WB}?fields=properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`, token);
} catch (e) {
  console.error(`无法访问临时表 (${e.message})。`);
  console.error('若 403：请把这张表共享给 SA（可读即可）：', JSON.parse((await import('node:fs')).readFileSync(SA, 'utf8')).client_email);
  process.exit(1);
}

console.log('=== workbook:', meta.properties?.title, '===');
let target = null;
for (const s of meta.sheets || []) {
  const p = s.properties;
  const mark = p.sheetId === GID ? `  <== TARGET gid ${GID}` : '';
  console.log(`  [gid ${p.sheetId}] "${p.title}"  ${p.gridProperties?.rowCount}r × ${p.gridProperties?.columnCount}c${mark}`);
  if (p.sheetId === GID) target = p.title;
}
if (!target) { console.error('\n找不到 gid', GID, '— dump 第一个 tab'); target = meta.sheets?.[0]?.properties?.title; }

const range = encodeURIComponent(`${target}!A1:AZ60`);
const vals = (await gget(`https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${range}?majorDimension=ROWS`, token)).values || [];
console.log(`\n=== tab "${target}" — ${vals.length} 行 ===`);
vals.forEach((row, i) => {
  const cells = row.map((c) => String(c ?? '').replace(/\s+/g, ' ').slice(0, 44));
  console.log(`R${String(i + 1).padStart(2)}: ${cells.join(' | ')}`);
});
