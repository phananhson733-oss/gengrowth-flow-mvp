#!/usr/bin/env node
// _diff-flow-vs-migration.mjs — 只读：对核心 tab 做 key 集合 diff + 共有行单元格差异计数。不写任何数据。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';   // 正式目标
const MIG = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';    // 迁移副本(最新数据)

async function fetchTab(id, tab, token) {
  const range = encodeURIComponent(`${tab}!A:AZ`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${body.error?.message || res.statusText}`);
  return body.values || [];
}

const saPath = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(saPath, ['https://www.googleapis.com/auth/spreadsheets.readonly']);

const norm = (s) => String(s ?? '').trim().toLowerCase();
const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());

async function diff({ tab, keyCol = 0, label }) {
  const flow = await fetchTab(FLOW, tab, token);
  const mig = await fetchTab(MIG, tab, token);
  const fHead = flow[0] || [], mHead = mig[0] || [];
  console.log(`\n========== ${label || tab} ==========`);
  console.log(`  key列=${String.fromCharCode(65 + keyCol)} "${fHead[keyCol] ?? ''}"`);
  console.log(`  正式 数据行=${flow.length - 1}  副本 数据行=${mig.length - 1}`);

  const fKeys = new Map(), mKeys = new Map();
  for (let i = 1; i < flow.length; i++) { const k = norm(flow[i]?.[keyCol]); if (k && !isSection(flow[i]?.[keyCol])) fKeys.set(k, flow[i]); }
  for (let i = 1; i < mig.length; i++) { const k = norm(mig[i]?.[keyCol]); if (k && !isSection(mig[i]?.[keyCol])) mKeys.set(k, mig[i]); }

  const onlyMig = [...mKeys.keys()].filter((k) => !fKeys.has(k));   // 副本独有 = 待新增到正式
  const onlyFlow = [...fKeys.keys()].filter((k) => !mKeys.has(k));  // 正式独有 = 副本里没有
  const both = [...mKeys.keys()].filter((k) => fKeys.has(k));
  console.log(`  key集合: 共有=${both.length}  仅副本(待迁入)=${onlyMig.length}  仅正式=${onlyFlow.length}`);
  if (onlyMig.length) console.log('  仅副本(前40): ' + onlyMig.slice(0, 40).join(' | '));
  if (onlyFlow.length) console.log('  仅正式(前40): ' + onlyFlow.slice(0, 40).join(' | '));

  // 共有 key 的单元格差异（只比两边都存在的列范围，避免副本多列误报）
  const commonCols = Math.min(fHead.length, mHead.length);
  let changedRows = 0; const samples = [];
  for (const k of both) {
    const fr = fKeys.get(k), mr = mKeys.get(k);
    const diffCols = [];
    for (let c = 0; c < commonCols; c++) {
      if (String(fr[c] ?? '').trim() !== String(mr[c] ?? '').trim()) diffCols.push(c);
    }
    if (diffCols.length) {
      changedRows++;
      if (samples.length < 8) samples.push(`    "${k}" 变更列: ${diffCols.map((c) => String.fromCharCode(65 + c) + `(${fHead[c] ?? ''})`).join(', ')}`);
    }
  }
  console.log(`  共有key中内容有差异的行=${changedRows}（仅比对两边都有的前${commonCols}列）`);
  if (samples.length) console.log(samples.join('\n'));
}

await diff({ tab: '关键词主表', keyCol: 0 });
await diff({ tab: '生产候选', keyCol: 0 });
await diff({ tab: '趋势词', keyCol: 0 });
await diff({ tab: '快速胜利', keyCol: 0 });
await diff({ tab: '战略词', keyCol: 0 });
await diff({ tab: '长尾词', keyCol: 0 });
await diff({ tab: '主题集群表', keyCol: 0 });
await diff({ tab: '选题登记表', keyCol: 0 });
