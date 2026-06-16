#!/usr/bin/env node
// _probe-flow-vs-migration.mjs — 只读：dump flow-mvp(正式) 与 迁移副本 的 tab 结构，逐 tab 对齐表头。不写任何数据。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const SHEETS = {
  FLOW_MVP_1CkjOC: '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc',   // 正式目标
  MIGRATION_1UaTxBQ: '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M', // 临时迁移副本(ops 误写最新数据于此)
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
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title,sheets(properties(title,sheetId,gridProperties(rowCount,columnCount)))`, token);
  const tabs = meta.sheets.map((s) => s.properties);
  const ranges = tabs.map((t) => `${t.title}!A1:AZ2`);
  const batch = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')}&majorDimension=ROWS`, token);
  const aRanges = tabs.map((t) => `${t.title}!A:A`);
  const aBatch = await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchGet?${aRanges.map((r) => `ranges=${encodeURIComponent(r)}`).join('&')}&majorDimension=COLUMNS`, token);
  return {
    title: meta.properties.title,
    tabs: tabs.map((t, i) => {
      const aCol = aBatch.valueRanges[i]?.values?.[0] || [];
      return {
        title: t.title,
        sheetId: t.sheetId,
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
  let token;
  try { ({ token } = await getAccessToken(saPath, SCOPE)); } catch (e) { matrix[f] = { email, error: e.message }; continue; }
  tokens[f] = token;
  matrix[f] = { email, access: {} };
  for (const [label, id] of Object.entries(SHEETS)) {
    try { await gget(`https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties.title`, token); matrix[f].access[label] = 'OK'; }
    catch (e) { matrix[f].access[label] = e.status || e.message; }
  }
}
console.error('=== 权限矩阵 ===');
console.error(JSON.stringify(matrix, null, 2));

// 2) dump 两张表结构
const out = {};
for (const [label, id] of Object.entries(SHEETS)) {
  const f = SA_FILES.find((sf) => matrix[sf]?.access?.[label] === 'OK');
  if (!f) { out[label] = { __unreadable: true }; continue; }
  out[label] = await probe(id, tokens[f]);
}

// 3) 逐 tab 名对齐 + 表头逐列 diff
const flow = out.FLOW_MVP_1CkjOC, mig = out.MIGRATION_1UaTxBQ;
console.log('\n================ 结构对比 ================');
if (flow?.__unreadable || mig?.__unreadable) {
  console.log('至少一张表不可读，跳过对比。');
} else {
  console.log(`正式 flow-mvp 标题: "${flow.title}"  tab 数=${flow.tabs.length}`);
  console.log(`迁移副本   标题: "${mig.title}"  tab 数=${mig.tabs.length}`);
  const fByName = new Map(flow.tabs.map((t) => [t.title, t]));
  const mByName = new Map(mig.tabs.map((t) => [t.title, t]));
  const allNames = [...new Set([...fByName.keys(), ...mByName.keys()])];
  console.log('\n--- tab 名集合 ---');
  console.log('  仅正式有: ' + (flow.tabs.filter((t) => !mByName.has(t.title)).map((t) => t.title).join(' | ') || '(无)'));
  console.log('  仅副本有: ' + (mig.tabs.filter((t) => !fByName.has(t.title)).map((t) => t.title).join(' | ') || '(无)'));
  console.log('  两边都有: ' + allNames.filter((n) => fByName.has(n) && mByName.has(n)).join(' | '));

  for (const name of allNames) {
    const a = fByName.get(name), b = mByName.get(name);
    console.log(`\n========== tab "${name}" ==========`);
    if (!a) { console.log('  仅副本有'); continue; }
    if (!b) { console.log('  仅正式有'); continue; }
    console.log(`  正式: grid=${a.grid} 数据行=${a.dataRows} 列数=${a.headers.length}`);
    console.log(`  副本: grid=${b.grid} 数据行=${b.dataRows} 列数=${b.headers.length}`);
    const maxc = Math.max(a.headers.length, b.headers.length);
    const colDiffs = [];
    for (let i = 0; i < maxc; i++) {
      const x = String(a.headers[i] ?? ''), y = String(b.headers[i] ?? '');
      if (x !== y) colDiffs.push(`    col${i}(${String.fromCharCode(65 + i)}): 正式="${x}"  副本="${y}"`);
    }
    console.log(colDiffs.length ? `  表头列差异:\n${colDiffs.join('\n')}` : '  表头逐列完全一致');
  }
}
