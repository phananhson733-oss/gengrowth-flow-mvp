#!/usr/bin/env node
// _probe-two-sheets.mjs — 只读：权限矩阵 + dump 两张 workbook 的 tab 结构。临时探查工具，不写任何数据。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const SHEETS = {
  FLOW_MVP_1CkjOC: '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc',
  RESEARCH_1uVCq: '1uVCq_nTBg59dwpKMZxVu7Z5plG78cIlEcqvtfo1e0Sg',
};
const SA_FILES = ['gg-reader-sa.json', 'gg-writer-sa.json', 'gg-admin-sa.json'];

async function gget(url, token) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(`${res.status}: ${body.error?.message || res.statusText}`); e.status = res.status; throw e; }
  return body;
}

async function probe(id, token) {
  const meta = await gget(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets(properties(title,gridProperties(rowCount,columnCount)))`, token);
  const tabs = meta.sheets.map((s) => s.properties);
  const ranges = tabs.map((t) => `${t.title}!A1:Z2`);
  const batch = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')}&majorDimension=ROWS`, token);
  const aRanges = tabs.map((t) => `${t.title}!A:A`);
  const aBatch = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${aRanges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')}&majorDimension=COLUMNS`, token);
  return {
    title: meta.properties.title,
    tabs: tabs.map((t, i) => {
      const aCol = aBatch.valueRanges[i]?.values?.[0] || [];
      return {
        title: t.title,
        grid: `${t.gridProperties.rowCount}x${t.gridProperties.columnCount}`,
        dataRows: aCol.filter((v) => String(v ?? '').trim() !== '').length,
        headers: batch.valueRanges[i]?.values?.[0] || [],
        firstDataRow: batch.valueRanges[i]?.values?.[1] || [],
      };
    }),
  };
}

// 1) 权限矩阵
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const matrix = {};
const tokens = {};
for (const f of SA_FILES) {
  const saPath = join(homedir(), '.config', 'gg', f);
  let email = '?';
  try { email = JSON.parse(readFileSync(saPath, 'utf8')).client_email; } catch {}
  const { token } = await getAccessToken(saPath, SCOPE);
  tokens[f] = token;
  matrix[f] = { email, access: {} };
  for (const [label, id] of Object.entries(SHEETS)) {
    try { await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title`, token); matrix[f].access[label] = 'OK'; }
    catch (e) { matrix[f].access[label] = e.status || e.message; }
  }
}
console.error('=== 权限矩阵 ===');
console.error(JSON.stringify(matrix, null, 2));

// 2) 对每张表，用任意一个 access==OK 的 SA dump（尽力而为）
const out = {};
for (const [label, id] of Object.entries(SHEETS)) {
  const f = SA_FILES.find((sf) => matrix[sf].access[label] === 'OK');
  if (!f) { out[label] = { __unreadable: true, share_to: matrix['gg-writer-sa.json'].email }; continue; }
  out[label] = await probe(id, tokens[f]);
}
console.log(JSON.stringify(out, null, 2));
