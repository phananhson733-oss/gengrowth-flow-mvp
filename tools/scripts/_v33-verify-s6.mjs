#!/usr/bin/env node
// READ-ONLY independent verification of §6 acceptance criteria.
import { getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COPY = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const ORIG = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);

function colName(i) { return i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26); }

async function getValues(wb, range, opt = '') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${encodeURIComponent(range)}${opt}`;
  const r = await gFetch(url, token);
  return r.values || [];
}

// ===== ORIGINAL: confirm still v3.1 (header col count) =====
console.log('===== ORIGINAL 1CkjOC schema check =====');
try {
  const oHdr = await getValues(ORIG, '关键词主表!A1:AB1', '?valueRenderOption=FORMULA');
  const h = oHdr[0] || [];
  console.log('原表 关键词主表 表头列数:', h.length);
  console.log('原表 表头:', JSON.stringify(h));
} catch (e) { console.log('原表读取异常:', e.message); }

// ===== COPY: 关键词主表 =====
console.log('\n===== COPY 1UaTxBQ 关键词主表 =====');
const kw = await getValues(COPY, '关键词主表!A1:AC1500'); // formatted values
const hdr = kw[0] || [];
console.log('表头列数:', hdr.length, '| 表头:', JSON.stringify(hdr));
const rows = kw.slice(1).filter(r => (r[0] || '').toString().trim() !== '');
console.log('数据行数 (A非空):', rows.length);

const idx = {};
hdr.forEach((h, i) => { idx[h] = i; });
const IN = (r, name) => (r[idx[name]] ?? '').toString().trim();

// X 生产准入 distribution
const xCounts = {};
for (const r of rows) { const v = IN(r, '生产准入') || '(空)'; xCounts[v] = (xCounts[v] || 0) + 1; }
console.log('X 生产准入 分布:', JSON.stringify(xCounts));

// Criterion 2: high-DR (J差值>30) words still bucketed (R分桶 != 无关/空)
const jIdx = idx['DR差值'], rIdx = idx['分桶'];
let highDR = 0, highDRbucketed = 0, highDRunrelated = 0;
const sample = [];
for (const r of rows) {
  const jv = parseFloat((r[jIdx] ?? '').toString());
  if (Number.isFinite(jv) && jv > 30) {
    highDR++;
    const bucket = (r[rIdx] ?? '').toString().trim();
    if (bucket && bucket !== '无关' && bucket !== '❌无关') highDRbucketed++;
    else highDRunrelated++;
    if (sample.length < 5) sample.push({ kw: r[0], J: jv, bucket });
  }
}
console.log(`高DR词 (J差值>30): ${highDR} | 进桶(R非空且非无关): ${highDRbucketed} | 无关/空: ${highDRunrelated}`);
console.log('高DR样本:', JSON.stringify(sample));

// Criterion 4: page_id (Z) backfill
const zIdx = idx['page_id'], yIdx = idx['生产状态'], aaIdx = idx['发布URL'], wIdx = idx['手动生产准入'], abIdx = idx['备注'];
let zFilled = 0, yFilled = 0, aaFilled = 0, wFilled = 0, abFilled = 0;
for (const r of rows) {
  if ((r[zIdx] ?? '').toString().trim() !== '') zFilled++;
  if ((r[yIdx] ?? '').toString().trim() !== '') yFilled++;
  if ((r[aaIdx] ?? '').toString().trim() !== '') aaFilled++;
  if ((r[wIdx] ?? '').toString().trim() !== '') wFilled++;
  if ((r[abIdx] ?? '').toString().trim() !== '') abFilled++;
}
console.log(`Z page_id 非空: ${zFilled} | Y 生产状态 非空: ${yFilled} | AA 发布URL 非空: ${aaFilled} | W 手动生产准入 非空: ${wFilled} | AB 备注 非空: ${abFilled}`);

// cluster_id column (AC) presence
const acIdx = idx['cluster_id'];
let acFilled = 0;
if (acIdx != null) for (const r of rows) { if ((r[acIdx] ?? '').toString().trim() !== '') acFilled++; }
console.log(`cluster_id 列存在: ${acIdx != null} (col ${acIdx != null ? colName(acIdx) : '-'}) | 非空: ${acFilled}`);

// ===== COPY: 生产候选视图 =====
console.log('\n===== COPY 生产候选 视图 =====');
const cand = await getValues(COPY, '生产候选!A1:A2000');
const candRows = cand.slice(1).filter(r => (r[0] || '').toString().trim() !== '');
console.log('生产候选 行数 (A非空, 不含表头):', candRows.length);
// cross-check: X in {可生产, 集群必需}
const xAdmit = rows.filter(r => { const v = IN(r, '生产准入'); return v === '可生产' || v === '集群必需'; }).length;
console.log('主表中 X=可生产/集群必需 词数:', xAdmit);

// ===== COPY: 选题登记表 =====
console.log('\n===== COPY 选题登记表 (一行=一page) =====');
const topic = await getValues(COPY, '选题登记表!A1:AC1530');
const tHdr = topic[0] || [];
console.log('表头:', JSON.stringify(tHdr));
// find page_id column
let pageIdCol = -1, pageRoleCol = -1, statusCol = -1, clusterCol = -1;
tHdr.forEach((h, i) => {
  const s = (h || '').toString().trim();
  if (/page[_\s]?id/i.test(s)) pageIdCol = i;
  if (/page[_\s]?role/i.test(s) || s === 'page_role') pageRoleCol = i;
  if (/status/i.test(s) || s === '状态') statusCol = i;
  if (/cluster[_\s]?id/i.test(s)) clusterCol = i;
});
console.log(`page_id列=${pageIdCol >= 0 ? colName(pageIdCol) + '(' + pageIdCol + ')' : '无'} | page_role列=${pageRoleCol >= 0 ? colName(pageRoleCol) : '无'} | status列=${statusCol >= 0 ? colName(statusCol) : '无'} | cluster_id列=${clusterCol >= 0 ? colName(clusterCol) : '无'}`);
// data rows: use a meaningful col (page_id or first col) for row count
const tRows = topic.slice(1).filter(r => r.some(c => (c || '').toString().trim() !== ''));
console.log('选题登记表 数据行数 (任一列非空):', tRows.length);
if (pageIdCol >= 0) {
  const pids = tRows.map(r => (r[pageIdCol] ?? '').toString().trim()).filter(v => v !== '');
  const uniq = new Set(pids);
  console.log(`page_id 非空: ${pids.length} | 唯一 page_id: ${uniq.size} | 重复: ${pids.length - uniq.size}`);
  // list duplicates
  const seen = {}; const dups = [];
  for (const p of pids) { seen[p] = (seen[p] || 0) + 1; }
  for (const [k, v] of Object.entries(seen)) if (v > 1) dups.push(`${k}×${v}`);
  if (dups.length) console.log('重复 page_id:', dups.join(', '));
}
if (statusCol >= 0) {
  const sc = {};
  for (const r of tRows) { const v = (r[statusCol] ?? '').toString().trim() || '(空)'; sc[v] = (sc[v] || 0) + 1; }
  console.log('Status 分布:', JSON.stringify(sc));
}
if (pageRoleCol >= 0) {
  const rc = {};
  for (const r of tRows) { const v = (r[pageRoleCol] ?? '').toString().trim() || '(空)'; rc[v] = (rc[v] || 0) + 1; }
  console.log('page_role 分布:', JSON.stringify(rc));
}

// ===== COPY: 主题集群表 (for P0 Pillar check) =====
console.log('\n===== COPY 主题集群表 (P0 / Pillar) =====');
const clus = await getValues(COPY, '主题集群表!A1:AA999');
const cHdr = clus[0] || [];
console.log('表头:', JSON.stringify(cHdr));
const cRows = clus.slice(1).filter(r => r.some(c => (c || '').toString().trim() !== ''));
console.log('主题集群表 数据行数:', cRows.length);
// find priority / P0 col
let prioCol = -1, cidCol = -1, pillarCol = -1;
cHdr.forEach((h, i) => {
  const s = (h || '').toString().trim();
  if (/优先|priority|P0|分层|tier/i.test(s)) prioCol = i;
  if (/cluster[_\s]?id/i.test(s)) cidCol = i;
  if (/pillar/i.test(s)) pillarCol = i;
});
console.log(`优先级列=${prioCol >= 0 ? colName(prioCol) + ':' + cHdr[prioCol] : '无'} | cluster_id列=${cidCol >= 0 ? colName(cidCol) : '无'} | pillar列=${pillarCol >= 0 ? colName(pillarCol) + ':' + cHdr[pillarCol] : '无'}`);
if (prioCol >= 0) {
  const pc = {};
  for (const r of cRows) { const v = (r[prioCol] ?? '').toString().trim() || '(空)'; pc[v] = (pc[v] || 0) + 1; }
  console.log('优先级分布:', JSON.stringify(pc));
}

console.log('\n===== DONE =====');
