#!/usr/bin/env node
// _diff-two-sheets.mjs — 只读：核心数据表逐列表头对齐 + 关键词/cluster 集合差异。不写任何数据。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';   // 规范表（目标）
const RES = '1uVCq_nTBg59dwpKMZxVu7Z5plG78cIlEcqvtfo1e0Sg';    // 最新数据（源）

async function fetchTab(id, tab, token) {
  const range = encodeURIComponent(`${tab}!A:AC`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?majorDimension=ROWS`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${body.error?.message || res.statusText}`);
  return body.values || [];
}

const saPath = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(saPath, ['https://www.googleapis.com/auth/spreadsheets.readonly']);

const norm = (s) => String(s ?? '').trim().toLowerCase();

async function diffKeyedTab({ flowTab, resTab, keyCol = 0, label }) {
  const flow = await fetchTab(FLOW, flowTab, token);
  const res = await fetchTab(RES, resTab, token);
  const fHead = flow[0] || [], rHead = res[0] || [];
  console.log(`\n========== ${label} ==========`);
  console.log(`目标(1CkjOC) tab="${flowTab}" 行=${flow.length - 1} 列=${fHead.length}`);
  console.log(`源(1uVCq)   tab="${resTab}" 行=${res.length - 1} 列=${rHead.length}`);
  // 表头逐列对齐
  const maxc = Math.max(fHead.length, rHead.length);
  const colDiffs = [];
  for (let i = 0; i < maxc; i++) {
    const a = String(fHead[i] ?? ''), b = String(rHead[i] ?? '');
    if (a !== b) colDiffs.push(`  col${i} (${String.fromCharCode(65 + i)}): 目标="${a}"  源="${b}"`);
  }
  console.log(colDiffs.length ? `表头列差异:\n${colDiffs.join('\n')}` : '表头逐列完全一致');
  // key 集合差异（跳过 markdown section 行）
  const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());
  const fKeys = new Map(), rKeys = new Map();
  for (let i = 1; i < flow.length; i++) { const k = norm(flow[i]?.[keyCol]); if (k && !isSection(flow[i]?.[keyCol])) fKeys.set(k, flow[i]); }
  for (let i = 1; i < res.length; i++) { const k = norm(res[i]?.[keyCol]); if (k && !isSection(res[i]?.[keyCol])) rKeys.set(k, res[i]); }
  const onlyRes = [...rKeys.keys()].filter((k) => !fKeys.has(k));   // 源有目标无 = 待新增
  const onlyFlow = [...fKeys.keys()].filter((k) => !rKeys.has(k));  // 目标有源无 = 规范表独有
  const both = [...rKeys.keys()].filter((k) => fKeys.has(k));
  console.log(`\nkey(${String.fromCharCode(65 + keyCol)}列) 集合: 共有=${both.length}  仅源(待新增)=${onlyRes.length}  仅目标(规范独有)=${onlyFlow.length}`);
  if (onlyRes.length) console.log(`  仅源(前30): ${onlyRes.slice(0, 30).join(' | ')}`);
  if (onlyFlow.length) console.log(`  仅目标(前30): ${onlyFlow.slice(0, 30).join(' | ')}`);
  return { fKeys, rKeys, onlyRes, onlyFlow, both, fHead, rHead };
}

// 关键词主表：手动输入列（要导入的真数据），跳过公式列
const KW_MANUAL_COLS = { 0: '关键词', 1: '来源', 2: '月搜索量', 3: 'KD', 4: 'CPC', 5: 'Trends', 6: 'Top10DR', 7: 'SERP弱度', 8: '自有站DR', 11: 'G2可承接', 15: '手动分桶', 16: '调整原因', 19: 'AIO风险', 21: '内容状态', 22: '发布URL', 23: '备注' };

const kw = await diffKeyedTab({ flowTab: '关键词主表', resTab: '关键词主表', keyCol: 0, label: '关键词主表' });
// 共有词里，手动列值有差异的（= 数据被刷新）
let changed = 0; const samples = [];
for (const k of kw.both) {
  const f = kw.fKeys.get(k), r = kw.rKeys.get(k);
  const diffs = [];
  for (const [ci, name] of Object.entries(KW_MANUAL_COLS)) {
    const fv = String(f?.[ci] ?? '').trim(), rv = String(r?.[ci] ?? '').trim();
    if (fv !== rv) diffs.push(`${name}: "${fv}"→"${rv}"`);
  }
  if (diffs.length) { changed++; if (samples.length < 15) samples.push(`  [${k}] ${diffs.join('; ')}`); }
}
console.log(`\n共有词中手动列值有差异(数据刷新)的: ${changed} 个`);
if (samples.length) console.log(samples.join('\n'));

await diffKeyedTab({ flowTab: '主题集群表', resTab: '主题集群表', keyCol: 0, label: '主题集群表' });
await diffKeyedTab({ flowTab: '选题登记表', resTab: '选题登记表', keyCol: 0, label: '选题登记表(按 Target Keyword)' });

// 追加：16 个新词的明细
console.log('\n========== 1uVCq 新词明细（关键词主表 仅源）==========');
const flowKw = await fetchTab(FLOW, '关键词主表', token);
const resKw = await fetchTab(RES, '关键词主表', token);
const fset = new Set(flowKw.slice(1).map(r => norm(r?.[0])));
const newRows = resKw.slice(1).filter(r => { const k = norm(r?.[0]); return k && !fset.has(k) && !/^#{1,6}\s/.test(String(r?.[0]).trim()); });
console.log('词 | 来源 | 月搜索量 | KD | 意图(M) | 分桶(R)');
for (const r of newRows) console.log(`${r[0]} | ${r[1]||''} | ${r[2]||''} | ${r[3]||''} | ${r[12]||''} | ${r[17]||''}`);
