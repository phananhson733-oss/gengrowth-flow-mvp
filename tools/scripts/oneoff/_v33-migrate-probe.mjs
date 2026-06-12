#!/usr/bin/env node
// _v33-migrate-probe.mjs — READ-ONLY probe of the v3.3 migration copy.
// Confirms the writer SA can access the copy, dumps tab list + 关键词主表 real schema.
// Usage: node tools/scripts/_v33-migrate-probe.mjs [<workbookId>]
import { getAccessToken, gFetch, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 默认读原表 1CkjOC（SA 有权限；副本与原表 schema 一致）。传 id 可指定。
const COPY = process.argv[2] || '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);

const meta = await gFetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${COPY}?fields=properties.title,sheets(properties(title,index,gridProperties(rowCount,columnCount)))`,
  token,
);
console.log('WORKBOOK:', meta.properties?.title);
console.log('TABS:');
for (const s of meta.sheets || []) {
  const p = s.properties;
  console.log(`  [${p.index}] ${p.title}  (${p.gridProperties.rowCount}行 x ${p.gridProperties.columnCount}列)`);
}

const vals = await gFetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${COPY}/values/${encodeURIComponent('关键词主表!A1:AB3')}?valueRenderOption=FORMULA`,
  token,
);
const header = (vals.values && vals.values[0]) || [];
console.log('\n关键词主表 表头 (共 ' + header.length + ' 列):');
header.forEach((h, i) => {
  const col = i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26);
  console.log(`  ${col}(${i}) = ${h}`);
});
console.log('\nROW2 (FORMULA view):', JSON.stringify((vals.values && vals.values[1]) || []));

const colA = await gFetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${COPY}/values/${encodeURIComponent('关键词主表!A:A')}`,
  token,
);
console.log('\n关键词主表 A 列总行数(含表头):', (colA.values || []).length);
