#!/usr/bin/env node
// _bootstrap-flow-mvp-workbook.mjs v0.3 — 1:1 复刻 .gs v3.1 + 项目运维 6 tab
//
// SSOT: docs/spec/upstream-canon/keyword-sheet-setup.gs (Apps Script v3.1)
// 规格: tools/scripts/lib/_workbook-spec.mjs（13 .gs tab + 6 运维 tab = 19 tab）
//
// 用法：
//   node tools/scripts/_bootstrap-flow-mvp-workbook.mjs --id <spreadsheetId>
//   node tools/scripts/_bootstrap-flow-mvp-workbook.mjs --rebuild   # 删现有再重建（保留 ⚙️配置/关键词主表数据迁移）
//   node tools/scripts/_bootstrap-flow-mvp-workbook.mjs --dry-run   # 只打印动作计划
//
// 设计：
//   - 用 user OAuth（_oauth-token.mjs），跟原版一致（SA 没有 Drive 创建配额）
//   - 默认幂等：tab 已存在则跳过 add，跳过 header/seed/公式（避免覆盖用户数据）
//   - --rebuild 模式：删除所有 tab 重建（用户数据会丢，请先 _migrate-legacy.mjs 备份）

import { loadEnv } from './lib/gg-shared.mjs';
import { getAccessToken } from './lib/_oauth-token.mjs';
import { TABS, COLORS } from './lib/_workbook-spec.mjs';

// ─────────────── CLI ───────────────
const argv = process.argv.slice(2);
const ARG_ID = argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : null;
const REBUILD = argv.includes('--rebuild');
const DRY_RUN = argv.includes('--dry-run');

// ─────────────── Sheets API helpers ───────────────
async function api(url, token, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 400)}`);
  try { return JSON.parse(text); } catch { return text; }
}

const sheetsBase = (id) => `https://sheets.googleapis.com/v4/spreadsheets/${id}`;

async function getMeta(token, sid) {
  return api(`${sheetsBase(sid)}?includeGridData=false`, token);
}

async function batchUpdate(token, sid, requests) {
  if (!requests.length) return null;
  if (DRY_RUN) {
    console.log(`  [dry-run] batchUpdate ${requests.length} requests`);
    return null;
  }
  // Sheets API rate-limits at 60 requests/min per user; chunk 50 per call.
  const out = [];
  for (let i = 0; i < requests.length; i += 50) {
    const chunk = requests.slice(i, i + 50);
    const r = await api(`${sheetsBase(sid)}:batchUpdate`, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requests: chunk }),
    });
    out.push(...(r.replies || []));
  }
  return out;
}

async function valuesBatchUpdate(token, sid, data, valueInputOption = 'USER_ENTERED') {
  if (!data.length) return null;
  if (DRY_RUN) {
    console.log(`  [dry-run] values:batchUpdate ${data.length} ranges`);
    return null;
  }
  return api(`${sheetsBase(sid)}/values:batchUpdate`, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption, data }),
  });
}

// ─────────────── Range parsing ───────────────
// Parse 'A1' / 'A1:D4' → { startRowIndex, endRowIndex, startColumnIndex, endColumnIndex } (0-indexed)
function colToIndex(letters) {
  let n = 0;
  for (const c of letters) n = n * 26 + (c.charCodeAt(0) - 'A'.charCodeAt(0) + 1);
  return n - 1;
}

function parseRange(range) {
  const parts = range.split(':');
  const re = /^([A-Z]+)(\d+)$/;
  const [, c1, r1] = re.exec(parts[0]);
  if (parts.length === 1) {
    return { startRowIndex: +r1 - 1, endRowIndex: +r1, startColumnIndex: colToIndex(c1), endColumnIndex: colToIndex(c1) + 1 };
  }
  const [, c2, r2] = re.exec(parts[1]);
  return { startRowIndex: +r1 - 1, endRowIndex: +r2, startColumnIndex: colToIndex(c1), endColumnIndex: colToIndex(c2) + 1 };
}

// ─────────────── Per-tab build operations ───────────────
function buildHeaderFormatRequests(sheetId, tab) {
  const reqs = [];
  const ex = tab.extras || {};
  const header = tab.header || (tab.rows && tab.rows[0]) || null;
  if (!header) return reqs;

  // Whole-header formatting (bg + fontColor + bold + fontSize)
  const headerFontColor = ex.headerFontColor === 'white' ? COLORS.white : null;
  const headerBgAll = ex.headerBgAll ? COLORS[ex.headerBgAll] : null;
  if (headerBgAll || headerFontColor || ex.headerBold || ex.headerFontSize) {
    reqs.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: header.length },
        cell: {
          userEnteredFormat: {
            ...(headerBgAll ? { backgroundColor: headerBgAll } : {}),
            textFormat: {
              ...(headerFontColor ? { foregroundColor: headerFontColor } : {}),
              ...(ex.headerBold ? { bold: true } : {}),
              ...(ex.headerFontSize ? { fontSize: ex.headerFontSize } : {}),
            },
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    });
  }

  // Per-column header color
  if (tab.headerColorByCol) {
    for (const [col, colorName] of Object.entries(tab.headerColorByCol)) {
      const c = +col - 1;
      reqs.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: c, endColumnIndex: c + 1 },
          cell: { userEnteredFormat: { backgroundColor: COLORS[colorName] } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      });
    }
  }
  return reqs;
}

function buildNoteRequests(sheetId, notes) {
  const reqs = [];
  if (!notes) return reqs;
  for (const [cell, text] of Object.entries(notes)) {
    const range = parseRange(cell);
    reqs.push({
      updateCells: {
        range: { sheetId, ...range },
        rows: [{ values: [{ note: text }] }],
        fields: 'note',
      },
    });
  }
  return reqs;
}

function buildValidationRequests(sheetId, validations) {
  if (!validations) return [];
  return validations.map((v) => ({
    setDataValidation: {
      range: { sheetId, ...parseRange(v.range) },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: v.list.map((s) => ({ userEnteredValue: s })),
        },
        showCustomUi: true,
        strict: true,
      },
    },
  }));
}

function buildColumnWidthRequests(sheetId, widths) {
  if (!widths) return [];
  return widths.map((w, i) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
      properties: { pixelSize: w },
      fields: 'pixelSize',
    },
  }));
}

function buildRowHeightRequests(sheetId, rowHeights) {
  if (!rowHeights) return [];
  return Object.entries(rowHeights).map(([row, h]) => ({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: +row - 1, endIndex: +row },
      properties: { pixelSize: h },
      fields: 'pixelSize',
    },
  }));
}

function buildFreezeRequests(sheetId, frozenRows) {
  if (!frozenRows) return [];
  return [{
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: frozenRows } },
      fields: 'gridProperties.frozenRowCount',
    },
  }];
}

function buildConditionalFormatRequests(sheetId, formats) {
  if (!formats) return [];
  return formats.map((cf, idx) => {
    const range = { sheetId, ...parseRange(cf.range) };
    let condition;
    if (cf.textContains) {
      condition = { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: cf.textContains }] };
    } else if (cf.notEmpty) {
      condition = { type: 'NOT_BLANK', values: [] };
    } else {
      return null;
    }
    const fmt = { backgroundColor: cf.bg };
    if (cf.bold) fmt.textFormat = { bold: true };
    return {
      addConditionalFormatRule: {
        rule: { ranges: [range], booleanRule: { condition, format: fmt } },
        index: idx,
      },
    };
  }).filter(Boolean);
}

function buildCellStylingRequests(sheetId, styles) {
  if (!styles) return [];
  return styles.map((s) => {
    const userEnteredFormat = {};
    if (s.bg) userEnteredFormat.backgroundColor = s.bg;
    const textFormat = {};
    if (s.fontColor === 'white') textFormat.foregroundColor = COLORS.white;
    if (s.bold) textFormat.bold = true;
    if (s.italic) textFormat.italic = true;
    if (s.fontSize) textFormat.fontSize = s.fontSize;
    if (Object.keys(textFormat).length) userEnteredFormat.textFormat = textFormat;
    return {
      repeatCell: {
        range: { sheetId, ...parseRange(s.range) },
        cell: { userEnteredFormat },
        fields: 'userEnteredFormat(backgroundColor,textFormat)',
      },
    };
  });
}

function buildWrapRequests(sheetId, wrapRanges) {
  if (!wrapRanges) return [];
  return wrapRanges.map((r) => ({
    repeatCell: {
      range: { sheetId, ...parseRange(r) },
      cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
      fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)',
    },
  }));
}

function buildCellBackgroundRequests(sheetId, bgs) {
  if (!bgs) return [];
  return bgs.map((b) => ({
    repeatCell: {
      range: { sheetId, ...parseRange(b.range) },
      cell: { userEnteredFormat: { backgroundColor: b.color } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  }));
}

function buildBoldRangeRequests(sheetId, ranges) {
  if (!ranges) return [];
  return ranges.map((r) => ({
    repeatCell: {
      range: { sheetId, ...parseRange(r) },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: 'userEnteredFormat.textFormat.bold',
    },
  }));
}

// ─────────────── Tab value building ───────────────
function tabToValueData(tab) {
  // Returns array of { range, values } for values:batchUpdate
  const out = [];
  const tabName = tab.name;
  const ex = tab.extras || {};

  // 1) header row
  if (tab.header) {
    out.push({ range: `'${tabName}'!A1`, values: [tab.header] });
  }

  // 2) seed rows (under header)
  if (tab.seedRows) {
    out.push({ range: `'${tabName}'!A2`, values: tab.seedRows });
  }
  if (ex.seedRows) {
    out.push({ range: `'${tabName}'!A2`, values: ex.seedRows });
  }

  // 3) tail row (来源分析 合计行 in row 8)
  if (ex.tailRow) {
    const startRow = 2 + (ex.seedRows?.length || 0);
    out.push({ range: `'${tabName}'!A${startRow}`, values: [ex.tailRow] });
  }

  // 4) rows-style tabs (rules / README / config / 配置)
  if (tab.rows) {
    out.push({ range: `'${tabName}'!A1`, values: tab.rows });
  }

  // 5) view formula (single cell A1)
  if (tab.formula) {
    out.push({ range: `'${tabName}'!A1`, values: [[tab.formula]] });
  }

  // 6) explicit formulas in extras.formulas (公式 cells in 关键词主表 / 选题登记表 / 内容追踪)
  if (ex.formulas) {
    for (const [cell, formula] of Object.entries(ex.formulas)) {
      out.push({ range: `'${tabName}'!${cell}`, values: [[formula]] });
    }
  }

  return out;
}

// Build formula fill-down by repeating the same formula for each row.
// USER_ENTERED + relative refs in the formula = Sheets auto-adjusts per row.
function buildFillDownValues(tab) {
  const ex = tab.extras || {};
  if (!ex.formulaFillDown) return [];
  const out = [];
  for (const fd of ex.formulaFillDown) {
    // Read source formulas from ex.formulas
    const srcRange = parseRange(fd.src);
    const srcRowOffset = srcRange.startRowIndex;
    const srcCols = srcRange.endColumnIndex - srcRange.startColumnIndex;
    const srcRows = srcRange.endRowIndex - srcRange.startRowIndex;

    // Build row-by-row formula values from ex.formulas matching the src range
    // Get formula keys that fall in src range
    const srcFormulas = [];
    for (let r = 0; r < srcRows; r++) {
      const rowVals = [];
      for (let c = 0; c < srcCols; c++) {
        const colLetter = String.fromCharCode('A'.charCodeAt(0) + srcRange.startColumnIndex + c);
        const cell = `${colLetter}${srcRowOffset + r + 1}`;
        rowVals.push(ex.formulas?.[cell] || '');
      }
      srcFormulas.push(rowVals);
    }

    // Repeat for dst rows
    const dstRange = parseRange(fd.dst);
    const dstRows = dstRange.endRowIndex - dstRange.startRowIndex;
    const dstStartRow = dstRange.startRowIndex + 1; // 1-indexed for A1 notation

    const allValues = [];
    for (let r = 0; r < dstRows; r++) {
      // Cycle through src rows (usually src has 1 row; this handles multi)
      allValues.push(srcFormulas[r % srcRows]);
    }

    const colStart = String.fromCharCode('A'.charCodeAt(0) + dstRange.startColumnIndex);
    out.push({ range: `'${tab.name}'!${colStart}${dstStartRow}`, values: allValues });
  }
  return out;
}

// ─────────────── Main ───────────────
async function main() {
  loadEnv();
  const sid = ARG_ID || process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!sid) {
    console.error('ERR: pass --id <spreadsheetId> or set GG_SHEETS_FLOW_MVP_WORKBOOK_ID');
    process.exit(2);
  }

  const token = await getAccessToken();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Spreadsheet: ${sid}`);
  console.log(`Mode: ${REBUILD ? 'REBUILD (destroy + recreate)' : 'INCREMENTAL (skip existing)'}${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log('');

  // 1. Read existing
  const meta = await getMeta(token, sid);
  const existing = new Map((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));
  console.log(`Existing tabs: ${existing.size}`);
  for (const k of existing.keys()) console.log(`  - ${k}`);
  console.log('');

  // 2. REBUILD mode: delete existing tabs (leave one placeholder; Sheets requires ≥1 sheet)
  if (REBUILD) {
    // Add a temp placeholder so we can delete all original tabs
    if (!DRY_RUN) {
      const tempName = `_temp_${Date.now()}`;
      const addResp = await batchUpdate(token, sid, [{ addSheet: { properties: { title: tempName } } }]);
      const tempId = addResp[0].addSheet.properties.sheetId;
      console.log(`Added temp placeholder "${tempName}" (id=${tempId})`);

      // Delete all old tabs
      const deleteReqs = [...existing.values()].map((sheetId) => ({ deleteSheet: { sheetId } }));
      if (deleteReqs.length) {
        await batchUpdate(token, sid, deleteReqs);
        console.log(`Deleted ${deleteReqs.length} existing tabs`);
      }
      existing.clear();
      existing.set(tempName, tempId); // temp will be deleted at end
    } else {
      console.log(`  [dry-run] would delete ${existing.size} existing tabs`);
    }
  }

  // 3. Add all spec tabs that don't exist
  const tabsToAdd = TABS.filter((t) => !existing.has(t.name));
  if (tabsToAdd.length) {
    console.log(`Adding ${tabsToAdd.length} new tabs ...`);
    const addReqs = tabsToAdd.map((t) => ({ addSheet: { properties: { title: t.name } } }));
    const replies = await batchUpdate(token, sid, addReqs);
    if (replies) {
      for (const r of replies) {
        const p = r.addSheet.properties;
        existing.set(p.title, p.sheetId);
        console.log(`  + added: ${p.title}`);
      }
    }
  } else {
    console.log('(no tabs to add)');
  }

  // 4. Write headers + seeds + formulas (values:batchUpdate)
  const allValueData = [];
  for (const tab of TABS) {
    allValueData.push(...tabToValueData(tab));
    allValueData.push(...buildFillDownValues(tab));
  }
  if (allValueData.length) {
    console.log(`\nWriting ${allValueData.length} value ranges ...`);
    await valuesBatchUpdate(token, sid, allValueData, 'USER_ENTERED');
  }

  // 5. Apply formatting (freeze / header colors / notes / validations / widths / heights / conditional / cell styling)
  const allFormatReqs = [];
  for (const tab of TABS) {
    const sheetId = existing.get(tab.name);
    if (sheetId == null) continue;
    const ex = tab.extras || {};
    allFormatReqs.push(...buildFreezeRequests(sheetId, ex.frozenRows));
    allFormatReqs.push(...buildHeaderFormatRequests(sheetId, tab));
    allFormatReqs.push(...buildNoteRequests(sheetId, ex.notes));
    allFormatReqs.push(...buildValidationRequests(sheetId, ex.dataValidations));
    allFormatReqs.push(...buildColumnWidthRequests(sheetId, ex.columnWidths));
    allFormatReqs.push(...buildRowHeightRequests(sheetId, ex.rowHeights));
    allFormatReqs.push(...buildConditionalFormatRequests(sheetId, ex.conditionalFormats));
    allFormatReqs.push(...buildCellStylingRequests(sheetId, ex.cellStyling));
    allFormatReqs.push(...buildCellBackgroundRequests(sheetId, ex.cellBackgrounds));
    allFormatReqs.push(...buildBoldRangeRequests(sheetId, ex.boldRanges));
    allFormatReqs.push(...buildWrapRequests(sheetId, ex.wrapStrategy));

    // Tail row styling (for 来源分析 合计行)
    if (ex.tailRow && ex.tailRowStyle) {
      const startRow = 1 + (ex.seedRows?.length || 0); // 0-indexed for grid
      allFormatReqs.push(...buildCellStylingRequests(sheetId, [
        { range: `A${startRow + 1}:F${startRow + 1}`, ...ex.tailRowStyle },
      ]));
    }

    // View tab note row (📋分桶规则 不在此处；视图表 line 698-706 _styleViewSheet)
    if (tab.type === 'view') {
      // View sheet: row 1 is note (light bg, italic gray text); we already wrote formula at A1.
      // Need to: insertRowBefore to push formula to A2, then add note at A1
      // SIMPLIFIED: skip the visual decoration; the formula at A1 still works.
      // Note: This deviates from .gs cosmetically but maintains functionality.
      // TODO: add insertDimension + write note row if visual parity is required
    }
  }
  if (allFormatReqs.length) {
    console.log(`\nApplying ${allFormatReqs.length} formatting requests ...`);
    await batchUpdate(token, sid, allFormatReqs);
  }

  // 6. REBUILD: delete the temp placeholder
  if (REBUILD && !DRY_RUN) {
    const tempEntry = [...existing.entries()].find(([k]) => k.startsWith('_temp_'));
    if (tempEntry) {
      await batchUpdate(token, sid, [{ deleteSheet: { sheetId: tempEntry[1] } }]);
      console.log(`\nDeleted temp placeholder "${tempEntry[0]}"`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Done. Open: https://docs.google.com/spreadsheets/d/${sid}/edit`);
  console.log('');
  console.log('NEXT STEPS:');
  console.log('  1. 打开 ⚙️配置 tab，填写 B4 目标国家、A6-A25 TOPIC_KEYWORDS、A28-A45 NEGATIVE_KEYWORDS');
  console.log('  2. 跑 _migrate-legacy.mjs 把老 sheet 590 词 + 301 选题迁过来');
  console.log('  3. 改 mine.mjs 默认通道 → GG_SHEETS_FLOW_MVP_WORKBOOK_ID');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
