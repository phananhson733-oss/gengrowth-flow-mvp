#!/usr/bin/env node
// READ-ONLY supplementary acceptance check for the v3.3 COPY:
//   1) full-sheet #ERROR scan on 关键词主表 (N/O/V/X gotcha + everything)
//   2) P0 cluster → 生产候选 coverage (§5 criterion)
//   3) structure metadata: sheets list, conditional-format counts, dropdowns on W/Y/V
//   4) the high-DR 无关/空 spot check
import { getAccessToken, gFetch } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COPY = process.argv[2] || '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${COPY}`;
const getV = async (r, opt = '') => (await gFetch(`${base}/values/${encodeURIComponent(r)}${opt}`, token)).values || [];
const colName = (i) => (i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26));
const ERR = /^#(ERROR|REF|VALUE|N\/A|NAME|DIV|NULL|NUM)/i;

console.log('===== 1) 关键词主表 全表 #ERROR 扫描 =====');
const grid = await getV('关键词主表!A1:AC1500');
const hdr = grid[0] || [];
const idx = {}; hdr.forEach((h, i) => { idx[h] = i; });
const errCells = [];
const errByCol = {};
for (let r = 1; r < grid.length; r++) {
  const row = grid[r] || [];
  for (let c = 0; c < row.length; c++) {
    const v = (row[c] ?? '').toString().trim();
    if (ERR.test(v)) {
      const col = hdr[c] || colName(c);
      errByCol[col] = (errByCol[col] || 0) + 1;
      if (errCells.length < 20) errCells.push(`${colName(c)}${r + 1}(${col})=${v}`);
    }
  }
}
console.log(`错误单元格总数: ${errCells.length === 0 ? 0 : '>=' + Object.values(errByCol).reduce((a, b) => a + b, 0)}`);
console.log(`按列: ${JSON.stringify(errByCol)}`);
if (errCells.length) console.log(`样本: ${errCells.join(' | ')}`);
// explicit N/O/V/X focus
for (const name of ['竞争建议', '分桶_自动', '生产准入_自动', '生产准入']) {
  console.log(`  ${name}(${colName(idx[name])}) 错误数: ${errByCol[name] || 0}`);
}

console.log('\n===== 2) P0 集群 → 生产候选 覆盖 (§5) =====');
const clus = await getV('主题集群表!A1:S999');
const cHdr = clus[0] || [];
const cidC = cHdr.indexOf('cluster_id'), prioC = cHdr.indexOf('priority'), nameC = cHdr.indexOf('cluster_name');
const p0 = clus.slice(1).filter(r => (r[prioC] || '').toString().trim() === 'P0').map(r => ({ id: (r[cidC] || '').toString().trim(), name: (r[nameC] || '').toString().trim() }));
console.log(`P0 集群: ${JSON.stringify(p0)}`);
const acC = idx['cluster_id'], xC = idx['生产准入'];
const rows = grid.slice(1).filter(r => (r[0] || '').toString().trim() !== '');
for (const cl of p0) {
  const inCluster = rows.filter(r => (r[acC] || '').toString().trim() === cl.id);
  const admit = inCluster.filter(r => { const v = (r[xC] || '').toString().trim(); return v === '可生产' || v === '集群必需'; });
  console.log(`  ${cl.id} (${cl.name}): 集群词 ${inCluster.length} | 可进生产候选 ${admit.length} ${admit.length >= 1 ? '✅' : '❌'}`);
}

console.log('\n===== 3) 高DR 无关/空 抽查 (J差值>30 且 R分桶∈{无关,空}) =====');
const jC = idx['DR差值'], rC = idx['分桶'], oC = idx['分桶_自动'];
for (const r of rows) {
  const jv = parseFloat((r[jC] || '').toString());
  if (Number.isFinite(jv) && jv > 30) {
    const bucket = (r[rC] || '').toString().trim();
    if (!bucket || bucket === '无关' || bucket === '❌无关') {
      console.log(`  ${r[0]} | J差值=${jv} | 分桶_自动=${(r[oC] || '').toString().trim()} | 分桶=${bucket || '(空)'} | 生产准入=${(r[xC] || '').toString().trim()}`);
    }
  }
}

console.log('\n===== 4) 结构元数据 (sheets / 条件格式 / 下拉) =====');
const meta = await (await gFetch(`${base}?fields=${encodeURIComponent('sheets(properties(title,sheetId,gridProperties(columnCount,rowCount)),conditionalFormats)')}`, token));
for (const s of meta.sheets || []) {
  const p = s.properties;
  console.log(`  [${p.title}] ${p.gridProperties.rowCount}×${p.gridProperties.columnCount} | 条件格式规则: ${(s.conditionalFormats || []).length}`);
}
// dropdowns: read dataValidation on W2/Y2/V2
const dv = await gFetch(`${base}?ranges=${encodeURIComponent('关键词主表!V2')}&ranges=${encodeURIComponent('关键词主表!W2')}&ranges=${encodeURIComponent('关键词主表!Y2')}&includeGridData=true&fields=${encodeURIComponent('sheets(data(startColumn,rowData(values(dataValidation))))')}`, token);
const labels = ['V生产准入_自动', 'W手动生产准入', 'Y生产状态'];
(dv.sheets || []).forEach((s) => {
  (s.data || []).forEach((d, di) => {
    const cell = d.rowData?.[0]?.values?.[0]?.dataValidation;
    const cond = cell?.condition;
    const vals = cond?.values?.map(v => v.userEnteredValue).join('/') || '(无下拉)';
    console.log(`  ${labels[di] || ('col' + d.startColumn)} 下拉: ${cond ? cond.type + ' [' + vals + ']' : '(无)'}`);
  });
});

console.log('\n===== DONE =====');
