#!/usr/bin/env node
/**
 * _apply-flow-migration.mjs — 把迁移副本(1UaTxBQ)的结构+独有新数据并入正式表 flow-mvp(1CkjOC)。
 *
 *   A1. 4 词桶视图公式 A:X → A:AC（24→29 列，数据自动从已是 v3.3 的关键词主表带出）
 *   A2. 结果复盘表表头重建为副本 16 列 + 数据验证迁到正确列（无数据无代码引用，安全）
 *   B.  把副本独有的 11 个世界杯词补入关键词主表末尾（写输入列+人工列；公式列从上一行复制补齐）
 *
 * 用法：
 *   node tools/scripts/oneoff/_apply-flow-migration.mjs            # dry-run（只读，打印计划）
 *   node tools/scripts/oneoff/_apply-flow-migration.mjs --apply    # 执行写入正式表
 *
 * 数据策略：先只补副本独有新行；共有行的单元格冲突一律不动。
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const APPLY = process.argv.includes('--apply');
const MASTER = '关键词主表', RECAP = '结果复盘表';
const VIEW_TABS = ['趋势词', '快速胜利', '战略词', '长尾词'];
const LR = 1500;
const START = 628; // 正式表关键词主表下一可写行
const FORMULA_COLS = [9, 10, 12, 13, 14, 17, 18, 20, 21, 23]; // J K M N O R S U V X (0-indexed)

// 结果复盘表副本 16 列表头
const RECAP_HEADER = ['outcome_id', 'page_id', 'cluster_id', 'url', 'day14_收录', '申请时间', '索引修复状态', 'day14_impressions', '记录日期', 'day30_进Top50词数', '当前最高排名词（排名）', 'day30_clicks', 'day60_pv', 'day60_目标国pv', '决策', '备注'];

// B: 11 个世界杯词，仅输入列(A-I)+人工列(P手动分桶 / W手动生产准入 / Y生产状态 / Z page_id / AB备注 / AC cluster_id)
// 公式列(J/K/M/N/O/R/S/U/V/X)留给 copyPaste，不在此写。
const WC = [
  { A: 'saturn in aries 2026', B: '竞品映射', C: '1400', D: '2', E: '0.09', F: '', G: '24', H: '❌强', I: '0', P: '', W: '', Y: '', Z: '', AB: '', AC: '' },
  { A: 'mbappe birth chart', B: '趋势词', C: '20', D: '0', E: 'N/A', F: '', G: '25', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'lionel messi zodiac sign', B: '趋势词', C: '80', D: '0', E: 'N/A', F: '', G: '2', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'cristiano ronaldo zodiac sign', B: '趋势词', C: '150', D: '0', E: 'N/A', F: '', G: '27', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'lamine yamal birth chart', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '10', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'vinicius jr zodiac sign', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '11', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'world cup 2026 astrology prediction', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '22', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: 'PG-WC-001', AB: '', AC: '' },
  { A: 'best soccer players zodiac sign', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '45', H: '✅弱', I: '0', P: '趋势词', W: '集群必需', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'zodiac signs as world cup 2026 teams', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '32', H: '✅弱', I: '0', P: '趋势词', W: '集群必需', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'world cup 2026 june astrology', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '2', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
  { A: 'argentina world cup 2026 astrology', B: '趋势词', C: '0', D: 'N/A', E: 'N/A', F: '', G: '27', H: '✅弱', I: '0', P: '趋势词', W: '', Y: '已建卡', Z: '', AB: '', AC: '' },
];

loadEnv();
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(SA, [scope]);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}`;
async function api(url, opt) { const r = await fetch(url, opt); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${r.status}: ${b.error?.message || r.statusText}`); return b; }
const getF = (range) => api(`${base}/values/${encodeURIComponent(range)}?valueRenderOption=FORMULA`, { headers: { authorization: `Bearer ${token}` } });
const log = (...a) => console.log(...a);

log(`MODE: ${APPLY ? '⚠️ APPLY' : 'DRY-RUN'}  TARGET: 正式表 1CkjOC\n`);

// 元数据：sheetId
const meta = await api(`${base}?fields=sheets(properties(title,sheetId,gridProperties(columnCount)))`, { headers: { authorization: `Bearer ${token}` } });
const sid = (t) => meta.sheets.find((s) => s.properties.title === t)?.properties.sheetId;
const masterSid = sid(MASTER), recapSid = sid(RECAP);

// ---------- A1: 词桶公式 X→AC ----------
log('===== A1. 词桶视图公式 A:X → A:AC =====');
const viewWrites = [];
for (const t of VIEW_TABS) {
  const old = ((await getF(`${t}!A1`)).values?.[0]?.[0]) || '';
  const neu = old.replace(/A1:X1/g, 'A1:AC1').replace(new RegExp(`A2:X${LR}`, 'g'), `A2:AC${LR}`);
  if (neu !== old) { viewWrites.push({ range: `${t}!A1`, values: [[neu]] }); log(`  [${t}] X→AC ✓`); }
  else log(`  [${t}] 已是 AC 或无匹配，跳过`);
}

// ---------- A2: 结果复盘表表头 ----------
log('\n===== A2. 结果复盘表 → 16 列 =====');
const recapOld = (await api(`${base}/values/${encodeURIComponent(`${RECAP}!A1:P1`)}`, { headers: { authorization: `Bearer ${token}` } })).values?.[0] || [];
log('  现表头(' + recapOld.length + '):', recapOld.join(' | '));
log('  新表头(16):', RECAP_HEADER.join(' | '));
log('  数据验证：E列(Y/N)保留；清旧 K 列验证；O列(决策)设 继续/调整/暂停');

// ---------- B: 11 个 WC 词 ----------
log(`\n===== B. 补 ${WC.length} 个世界杯词 → 关键词主表 行 ${START}-${START + WC.length - 1} =====`);
// 安全校验：起始行必须为空，且这些 key 不在正式表
const existing = (await api(`${base}/values/${encodeURIComponent(`${MASTER}!A2:A${LR}`)}`, { headers: { authorization: `Bearer ${token}` } })).values || [];
const existSet = new Set(existing.map((r) => String(r[0] ?? '').trim().toLowerCase()).filter(Boolean));
const dup = WC.filter((w) => existSet.has(w.A.toLowerCase()));
if (dup.length) { log('  ✋ 以下词已存在于正式表，中止以防重复：', dup.map((d) => d.A).join(', ')); process.exit(1); }
const startCellNow = String(existing[START - 2]?.[0] ?? '').trim();
if (startCellNow) { log(`  ✋ 起始行 ${START} 非空(A="${startCellNow}")，中止。`); process.exit(1); }
log('  ✅ 校验通过：11 词均不在正式表，起始行为空');
WC.forEach((w, i) => log(`    行${START + i}: ${w.A}  [桶:${w.P || '自动'}${w.W ? ' / ' + w.W : ''}${w.Y ? ' / ' + w.Y : ''}${w.Z ? ' / ' + w.Z : ''}]`));
log('  公式列 J/K/M/N/O/R/S/U/V/X 将从行 627 复制补齐(628 行原公式不全)');

if (!APPLY) { log('\nDRY-RUN 完成，未写入。确认后加 --apply。'); process.exit(0); }

// =================== APPLY ===================
const valuesUpdate = (data, vio = 'USER_ENTERED') => api(`${base}/values:batchUpdate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ valueInputOption: vio, data }) });
const batchUpdate = (requests) => api(`${base}:batchUpdate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ requests }) });
const gr =(sCol, eCol, sRow, eRow) => ({ sheetId: masterSid, startRowIndex: sRow, endRowIndex: eRow, startColumnIndex: sCol, endColumnIndex: eCol });

// A1
if (viewWrites.length) { await valuesUpdate(viewWrites); log(`\n① 词桶公式更新 ${viewWrites.length}/4 ✓`); }

// A2 表头 + 数据验证
await valuesUpdate([{ range: `${RECAP}!A1:P1`, values: [RECAP_HEADER] }], 'RAW');
const dvRecap = (col, vals) => ({ setDataValidation: { range: { sheetId: recapSid, startRowIndex: 1, endRowIndex: LR, startColumnIndex: col, endColumnIndex: col + 1 }, rule: { condition: { type: 'ONE_OF_LIST', values: vals.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } });
const dvClearRecap = (col) => ({ setDataValidation: { range: { sheetId: recapSid, startRowIndex: 1, endRowIndex: LR, startColumnIndex: col, endColumnIndex: col + 1 } } });
await batchUpdate([
  dvClearRecap(10),                              // 清旧 K 列(原决策)验证
  dvRecap(4, ['Y', 'N']),                        // E day14_收录
  dvRecap(14, ['继续', '调整', '暂停']),         // O 决策(新位置)
]);
log('② 结果复盘表 16 列表头 + 数据验证 ✓');

// B 写值（按列）
const colWrites = [];
const byCol = (letter, key) => colWrites.push({ range: `${MASTER}!${letter}${START}:${letter}${START + WC.length - 1}`, values: WC.map((w) => [w[key] ?? '']) });
['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach((c) => byCol(c, c));
byCol('P', 'P'); byCol('W', 'W'); byCol('Y', 'Y'); byCol('Z', 'Z'); byCol('AB', 'AB'); byCol('AC', 'AC');
await valuesUpdate(colWrites, 'USER_ENTERED');
log('③ WC 词 输入列+人工列写入 ✓');

// B 公式列：从行627(index 626)复制到 628-638(index 627..637)
const copyReqs = FORMULA_COLS.map((c) => ({ copyPaste: { source: gr(c, c + 1, 626, 627), destination: gr(c, c + 1, START - 1, START - 1 + WC.length), pasteType: 'PASTE_FORMULA' } }));
await batchUpdate(copyReqs);
log('④ 公式列 J/K/M/N/O/R/S/U/V/X 复制补齐 ✓');

log('\n✅ APPLY 完成。');
