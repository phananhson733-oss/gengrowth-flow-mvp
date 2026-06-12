#!/usr/bin/env node
/**
 * _v33-migrate.mjs — 关键词主表 v3.1 → v3.3 in-place 迁移（生产准入列拆分）
 *
 * 把活表/副本的 关键词主表 从 v3.1 升到 v3.3：
 *   - N 列 DR过滤 → 竞争建议（公式 ✅可做/⏸暂缓；不再删词）
 *   - O 列去掉 DR-skip 子句（高 DR 词仍进桶），负向词 token ❌跳过→❌无关（保留无 emoji 桶名 + 配置 tab）
 *   - 新列 V生产准入_自动 / W手动生产准入 / X生产准入 / Y生产状态 / Z page_id / AA发布URL / AB备注 / AC cluster_id
 *   - 旧数据：X备注→AB，Y cluster_id→AC（搬移，行对齐保留）
 *   - 新 🧩生产候选 视图（按 X 列筛 可生产/集群必需）
 *   - 4 个桶视图 FILTER 范围 A:X → A:AC
 *
 * 用法：
 *   node tools/scripts/_v33-migrate.mjs                 # dry-run（默认副本，只读，打印计划）
 *   node tools/scripts/_v33-migrate.mjs --apply         # 对副本执行
 *   node tools/scripts/_v33-migrate.mjs --workbook <id> --apply
 *
 * 安全：前置校验表头必须是 v3.1（N=DR过滤、V内容状态…Y cluster_id）；已迁移(N=竞争建议)则中止。
 */
import { getAccessToken, gFetch, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const COPY_DEFAULT = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WORKBOOK = wbIdx >= 0 ? args[wbIdx + 1] : COPY_DEFAULT;
const APPLY = args.includes('--apply');

const MASTER = '关键词主表';
const CFG = '配置';
const LR = 1500; // 公式/数据填充下界（与 grid rowCount 一致）
const VIEW_TABS = ['趋势词', '快速胜利', '战略词', '长尾词'];

// v3.3 公式（活表适配：配置 tab、无 emoji 桶名、❌无关）
const fN = '=IF(J2="待填","待填",IF(ISNUMBER(J2),IF(J2>30,"⏸暂缓","✅可做"),"待填"))';
const fO = `=IF(A2="","",IF(SUMPRODUCT(('${CFG}'!$A$28:$A$45<>"")*ISNUMBER(SEARCH('${CFG}'!$A$28:$A$45,A2)))>0,"❌无关",IF(AND(ISNUMBER(F2),F2>1.2,ISNUMBER(D2),D2<35,K2="✅相关",L2="Y"),"趋势词",IF(AND(ISNUMBER(D2),D2<20,ISNUMBER(C2),C2>=100),"快速胜利",IF(AND(ISNUMBER(D2),D2<20,OR(M2="Problem-aware",M2="Informational"),ISNUMBER(C2),C2>=50),"快速胜利",IF(AND(ISNUMBER(D2),D2>=20,D2<=50,OR(M2="Commercial",M2="Transactional")),"战略词","长尾词"))))))`;
const fV = '=IF(A2="","",IF(O2="❌无关","无关",IF(N2="✅可做","可生产",IF(N2="⏸暂缓","暂缓","暂缓"))))';
const fX = '=IF(A2="","",IF(W2<>"",W2,V2))';
const NEW_HEADERS = ['生产准入_自动', '手动生产准入', '生产准入', '生产状态', 'page_id', '发布URL', '备注', 'cluster_id']; // V..AC
const PROD_VIEW = '生产候选'; // tab 名无 emoji（用户偏好 + 活表既有约定 配置/趋势词 均无 emoji）
const fProdView = `=IF(COUNTIF('${MASTER}'!X:X,"可生产")+COUNTIF('${MASTER}'!X:X,"集群必需")>0,{'${MASTER}'!A1:AC1;FILTER('${MASTER}'!A2:AC${LR},REGEXMATCH('${MASTER}'!X2:X${LR},"可生产|集群必需"))},{"暂无生产候选"})`;

// 公式括号平衡自检（防止漏删/多写 ) 导致 #ERROR!，live cutover 前快速失败）
for (const [name, f] of [['fN', fN], ['fO', fO], ['fV', fV], ['fX', fX], ['fProdView', fProdView]]) {
  const o = (f.match(/\(/g) || []).length, c = (f.match(/\)/g) || []).length;
  if (o !== c) { console.error(`公式 ${name} 括号不平衡：${o} 开 / ${c} 闭 — 拒绝运行`); process.exit(1); }
}

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(SA, [scope]);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WORKBOOK}`;

const hex = (h) => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 });
const log = (...a) => console.log(...a);

// ---- 0) 元数据 + 前置校验 ----
const meta = await gFetch(`${base}?fields=sheets(properties(title,sheetId,gridProperties(rowCount,columnCount)))`, token);
const masterSheet = meta.sheets.find((s) => s.properties.title === MASTER);
if (!masterSheet) throw new Error(`未找到 tab「${MASTER}」`);
const SID = masterSheet.properties.sheetId;
const colCount = masterSheet.properties.gridProperties.columnCount;
const hdrResp = await gFetch(`${base}/values/${encodeURIComponent(`${MASTER}!A1:AC1`)}`, token);
const hdr = (hdrResp.values && hdrResp.values[0]) || [];
log(`MODE: ${APPLY ? 'APPLY ⚠️' : 'DRY-RUN'}  WORKBOOK: ${WORKBOOK}`);
log(`${MASTER} sheetId=${SID} 当前列数=${colCount} 表头(${hdr.length}):`, hdr.join(' | '));

if (hdr[13] === '竞争建议') { log('\n✋ 已迁移（N=竞争建议），无需重复。'); process.exit(0); }
const expect = { 13: 'DR过滤', 21: '内容状态', 22: '发布URL', 23: '备注', 24: 'cluster_id' };
const bad = Object.entries(expect).filter(([i, v]) => hdr[i] !== v);
if (bad.length) {
  throw new Error(`前置校验失败，表头非预期 v3.1：${bad.map(([i, v]) => `col${i} 期望「${v}」实得「${hdr[i] || ''}」`).join('；')}`);
}
log('✅ 前置校验通过（v3.1 布局）');

// ---- 1) 读旧数据（搬移用）----
const xResp = await gFetch(`${base}/values/${encodeURIComponent(`${MASTER}!X2:X${LR}`)}`, token);
const yResp = await gFetch(`${base}/values/${encodeURIComponent(`${MASTER}!Y2:Y${LR}`)}`, token);
const xVals = xResp.values || []; // 备注
const yVals = yResp.values || []; // cluster_id
const cnt = (rows) => rows.filter((r) => String((r && r[0]) || '').trim()).length;
log(`\n搬移数据：X备注 ${cnt(xVals)} 条 → AB；Y cluster_id ${cnt(yVals)} 条 → AC`);

// ---- 计划摘要 ----
log('\n=== 操作计划 ===');
log(`1. 加宽 grid: ${colCount} → 29 列 (appendDimension +${Math.max(0, 29 - colCount)})`);
log(`2. 搬 X(备注)→AB2:AB${1 + xVals.length}，Y(cluster_id)→AC2:AC${1 + yVals.length}`);
log(`3. 清 X2:X${LR}、Y2:Y${LR}`);
log(`4. 表头 N1=竞争建议；V1:AC1=${NEW_HEADERS.join('/')}`);
log(`5. 公式 N2/O2/V2/X2 + PASTE_FORMULA 填到第 ${LR} 行`);
log('6. 下拉：清 V(内容状态)；W=可生产/暂缓/集群必需/无关；Y=未开始/已建卡/已发布/已合并/暂停');
log('7. 条件格式：V:X 准入色、Y 状态色');
log(`8. 新视图「${PROD_VIEW}」按 X 列筛`);
log(`9. 桶视图 ${VIEW_TABS.join('/')} FILTER A:X → A:AC`);

if (!APPLY) {
  log('\nDRY-RUN 完成（未写入）。确认后加 --apply 执行。');
  // 打印将写入的视图新公式（替换后）供复核
  for (const t of VIEW_TABS) {
    const r = await gFetch(`${base}/values/${encodeURIComponent(`${t}!A1`)}?valueRenderOption=FORMULA`, token);
    const old = (r.values && r.values[0] && r.values[0][0]) || '';
    const neu = old.replace(/A1:X1/g, 'A1:AC1').replace(new RegExp(`A2:X${LR}`, 'g'), `A2:AC${LR}`);
    log(`\n[${t}] 改后:\n${neu}`);
  }
  process.exit(0);
}

// =================== APPLY ===================
const batchUpdate = (requests) => gFetch(`${base}:batchUpdate`, token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requests }) });
const valuesUpdate = (data, valueInputOption) => gFetch(`${base}/values:batchUpdate`, token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valueInputOption, data }) });
const valuesClear = (ranges) => gFetch(`${base}/values:batchClear`, token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ranges }) });
const gr = (sCol, eCol, sRow = 1, eRow = LR) => ({ sheetId: SID, startRowIndex: sRow, endRowIndex: eRow, startColumnIndex: sCol, endColumnIndex: eCol });

// 1) 加宽 grid
if (colCount < 29) { await batchUpdate([{ appendDimension: { sheetId: SID, dimension: 'COLUMNS', length: 29 - colCount } }]); log('① grid 加宽到 29 列 ✓'); }

// 2) 搬数据 + 4) 表头（RAW）
const rawData = [
  { range: `${MASTER}!N1`, values: [['竞争建议']] },
  { range: `${MASTER}!V1:AC1`, values: [NEW_HEADERS] },
];
if (xVals.length) rawData.push({ range: `${MASTER}!AB2`, values: xVals });
if (yVals.length) rawData.push({ range: `${MASTER}!AC2`, values: yVals });
await valuesUpdate(rawData, 'RAW');
log('②④ 搬移 X→AB / Y→AC + 表头 ✓');

// 3) 清旧 X、Y（搬移后）
await valuesClear([`${MASTER}!X2:X${LR}`, `${MASTER}!Y2:Y${LR}`]);
log('③ 清 X、Y ✓');

// 5) 种子公式（USER_ENTERED）+ PASTE_FORMULA 下填
await valuesUpdate([
  { range: `${MASTER}!N2`, values: [[fN]] },
  { range: `${MASTER}!O2`, values: [[fO]] },
  { range: `${MASTER}!V2`, values: [[fV]] },
  { range: `${MASTER}!X2`, values: [[fX]] },
], 'USER_ENTERED');
const copyFormula = (col) => ({ copyPaste: { source: gr(col, col + 1, 1, 2), destination: gr(col, col + 1, 2, LR), pasteType: 'PASTE_FORMULA' } });
await batchUpdate([copyFormula(13), copyFormula(14), copyFormula(21), copyFormula(23)]);
log('⑤ N/O/V/X 公式填充 ✓');

// 6) 下拉 + 7) 条件格式
const dv = (col, vals) => ({ setDataValidation: { range: gr(col, col + 1, 1, LR), rule: { condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } });
const dvClear = (col) => ({ setDataValidation: { range: gr(col, col + 1, 1, LR) } });
const cf = (range, val, color) => ({ addConditionalFormatRule: { index: 0, rule: { ranges: [range], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: val }] }, format: { backgroundColor: hex(color) } } } } });
await batchUpdate([
  dvClear(21), // 清 V 旧 内容状态 下拉
  dv(22, ['可生产', '暂缓', '集群必需', '无关']), // W
  dv(24, ['未开始', '已建卡', '已发布', '已合并', '暂停']), // Y
  cf(gr(21, 24, 1, LR), '可生产', '#e8f5e9'),
  cf(gr(21, 24, 1, LR), '集群必需', '#d1c4e9'),
  cf(gr(21, 24, 1, LR), '暂缓', '#fff9c4'),
  cf(gr(21, 24, 1, LR), '无关', '#eeeeee'),
  cf(gr(24, 25, 1, LR), '已建卡', '#bbdefb'),
  cf(gr(24, 25, 1, LR), '已发布', '#c8e6c9'),
  cf(gr(24, 25, 1, LR), '已合并', '#e0e0e0'),
  cf(gr(24, 25, 1, LR), '暂停', '#ffcdd2'),
]);
log('⑥⑦ 下拉 + 条件格式 ✓');

// 8) 🧩生产候选 视图
const existing = meta.sheets.find((s) => s.properties.title === PROD_VIEW);
if (!existing) {
  await batchUpdate([{ addSheet: { properties: { title: PROD_VIEW, index: 6 } } }]);
  log(`⑧ 新建视图「${PROD_VIEW}」✓`);
}
await valuesUpdate([{ range: `${PROD_VIEW}!A1`, values: [[fProdView]] }], 'USER_ENTERED');
log('⑧ 生产候选 FILTER 公式 ✓');

// 9) 桶视图范围加宽
const viewData = [];
for (const t of VIEW_TABS) {
  const r = await gFetch(`${base}/values/${encodeURIComponent(`${t}!A1`)}?valueRenderOption=FORMULA`, token);
  const old = (r.values && r.values[0] && r.values[0][0]) || '';
  const neu = old.replace(/A1:X1/g, 'A1:AC1').replace(new RegExp(`A2:X${LR}`, 'g'), `A2:AC${LR}`);
  if (neu !== old) viewData.push({ range: `${t}!A1`, values: [[neu]] });
}
if (viewData.length) await valuesUpdate(viewData, 'USER_ENTERED');
log(`⑨ 桶视图范围加宽 ${viewData.length}/${VIEW_TABS.length} ✓`);

log('\n✅ APPLY 完成。请跑验收查询核对。');
