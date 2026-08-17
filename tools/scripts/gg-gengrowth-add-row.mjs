#!/usr/bin/env node
// gg-gengrowth-add-row.mjs — 往 gengrowth 选题登记表追加一行选题。
//
// 日历排到每天 1 篇，每篇建行都复制一个 oneoff 不合算，而且每复制一次就多一处会漂移的
// 表结构假设。这里把「怎么写」固定成脚本，「写什么」放进一个 JSON。
//
// 设计约束（都是踩过的）：
//   - **按列名写，不按列序**。v3.3 迁移期出过整片列错位。
//   - **JSON 里出现表头没有的列名 = 直接 abort**，不静默丢字段。
//   - **只追加，不改任何已有行**。幂等：page_id 已存在就退出。
//   - **表 ID 不从 GG_SHEETS_FLOW_MVP_WORKBOOK_ID 取** —— 那个变量在 .env 里指向
//     astrologywiki 主表，跨站写错账本不会报错。同 gg-gengrowth-backfill-ledger.mjs。
//
// USAGE
//   node tools/scripts/gg-gengrowth-add-row.mjs --json _staging/PG-CMP-007.row.json [--write]
//
// JSON 形如 { "page_id": "PG-CMP-007", "Target Keyword": "...", "cluster_id": "...", ... }
import { getAccessToken, loadEnv } from './lib/gg-shared.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const GENGROWTH_WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8';
const ASTROLOGYWIKI_WB = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const WB = process.env.GG_GENGROWTH_WORKBOOK_ID || GENGROWTH_WB;
if (WB === ASTROLOGYWIKI_WB) {
  console.error('拒绝执行：解析出的表是 astrologywiki 主表，这个脚本只写 gengrowth 账本。');
  process.exit(2);
}
const TAB = '选题登记表';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const jsonPath = argv[argv.indexOf('--json') + 1];
if (!jsonPath || jsonPath.startsWith('--')) {
  console.error('用法: --json <row.json> [--write]');
  process.exit(2);
}
const ROW = JSON.parse(readFileSync(jsonPath, 'utf8'));
if (!ROW.page_id) { console.error('JSON 缺 page_id'); process.exit(2); }

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}

const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets']);
const rows = (await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A1:AZ2000`)}?majorDimension=ROWS`,
  token,
)).values || [];
const hdr = rows[0] || [];
const pidCol = hdr.indexOf('page_id');
if (pidCol < 0) { console.error('表头缺 page_id 列，abort'); process.exit(1); }

const exists = rows.findIndex((r, i) => i > 0 && String(r[pidCol] || '').trim() === ROW.page_id);
if (exists > 0) { console.log(`${ROW.page_id} 已在行 ${exists + 1}，不重复建行。`); process.exit(0); }

const unknown = Object.keys(ROW).filter((k) => !hdr.includes(k));
if (unknown.length) { console.error(`这些字段在表头里找不到，abort: ${unknown.join(', ')}`); process.exit(1); }

const values = hdr.map((h) => (h in ROW ? ROW[h] : ''));
const targetRow = rows.length + 1;
console.log(`将在行 ${targetRow} 追加 ${ROW.page_id}：\n`);
hdr.forEach((h, i) => { if (values[i]) console.log(`  ${String(h).padEnd(20)} ${String(values[i]).slice(0, 96)}`); });

if (!WRITE) { console.log('\n[DRY-RUN] 加 --write 才真正写入。'); process.exit(0); }
const res = await greq(
  `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(`${TAB}!A${targetRow}`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
  token,
  { method: 'POST', body: JSON.stringify({ values: [values] }) },
);
console.log(`\n✅ 已写入 ${res.updates?.updatedRange}（${res.updates?.updatedCells} 个单元格）`);
