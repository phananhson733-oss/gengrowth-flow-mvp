#!/usr/bin/env node
// _migrate-legacy-to-flow-mvp.mjs — 把老 sheet 数据迁到新 flow-mvp sheet
//
// 迁移规则：
//   关键词主表 → A-I 9 列（公式列 J/K/M/N/O/R/S/U + 人工列 L/P/Q/T 让新 sheet 重算/重填）
//   选题登记表 → A,B + E-U 共 20 列（C/D VLOOKUP 公式自动）
//   keyword_candidates → 全 11 列原样（含 wzb_approve 状态）
//
// 用法：
//   node tools/scripts/_migrate-legacy-to-flow-mvp.mjs --dry-run
//   node tools/scripts/_migrate-legacy-to-flow-mvp.mjs
//   node tools/scripts/_migrate-legacy-to-flow-mvp.mjs --tabs 关键词主表,选题登记表
//
// env required:
//   GG_SHEETS_WORKBOOK_ID            老 sheet (读)
//   GG_SHEETS_FLOW_MVP_WORKBOOK_ID   新 sheet (写)
//   gg-writer-sa.json                SA（读老 sheet + 写新 sheet）

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const TABS_ARG = argv.includes('--tabs') ? argv[argv.indexOf('--tabs') + 1].split(',') : null;

// 迁移配置：每个 tab 的源列范围 / 目标列范围 / 过滤函数
const MIGRATIONS = [
  {
    name: '关键词主表',
    srcRange: 'A2:I1000',   // skip header; only A-I (人工填 + 来源 + KPI)
    dstStart: 'A2',
    description: '590 词，仅 A-I 9 列；公式列 J/K/M/N/O/R/S/U 由新 sheet 重算',
    filter: (row) => row && row[0] && String(row[0]).trim(), // 关键词非空
  },
  {
    name: '选题登记表',
    srcRange: null, // special: skip cols C/D (VLOOKUP), keep A,B,E-U
    dstStart: 'A2',
    description: '301 行；跳过 C/D 公式列，迁 A,B + E-U',
    custom: true,
  },
  {
    name: 'keyword_candidates',
    srcRange: 'A2:K1000',   // full 11 cols
    dstStart: 'A2',
    description: '保留 wzb_approve 状态供 promote 继续工作',
    filter: (row) => row && row[2] && String(row[2]).trim(), // query 非空
  },
];

async function fetchValues(token, sid, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  const r = await gFetch(url, token);
  return r.values || [];
}

// values.update: PUT to exact range. Does NOT skip past existing values like append does.
// Required when target sheet has fill-down formulas in row 2-N (append would jump past them).
async function updateValues(token, sid, range, values, valueInputOption = 'RAW') {
  if (!values.length) return { updatedRows: 0 };
  if (DRY_RUN) {
    console.log(`  [dry-run] would PUT ${values.length} rows at exact range ${range}`);
    return { updatedRows: values.length };
  }
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

async function main() {
  loadEnv();
  const oldSid = process.env.GG_SHEETS_WORKBOOK_ID;
  const newSid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!oldSid || !newSid) {
    console.error('ERR: both GG_SHEETS_WORKBOOK_ID and GG_SHEETS_FLOW_MVP_WORKBOOK_ID required');
    process.exit(2);
  }
  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(sa)) {
    console.error(`ERR: writer SA not found: ${sa}`);
    process.exit(2);
  }
  const { token } = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Source (legacy): ${oldSid}`);
  console.log(`Target (flow-mvp): ${newSid}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  console.log('');

  const tabsToMigrate = TABS_ARG ? MIGRATIONS.filter((m) => TABS_ARG.includes(m.name)) : MIGRATIONS;

  for (const mig of tabsToMigrate) {
    console.log(`━━━ ${mig.name}`);
    console.log(`    ${mig.description}`);

    let rows;
    if (mig.custom && mig.name === '选题登记表') {
      // Read all 29 src cols, drop C/D, keep A,B + E-Y (老 sheet 选题登记表 29 列)
      // 新 sheet 选题登记表只 21 列（v2.1 = v2.0 15 + 新 6）
      // 老 sheet 29 列结构未知，先读 A1 header 看
      const header = await fetchValues(token, oldSid, `${mig.name}!A1:Z1`);
      console.log(`    legacy header: ${(header[0] || []).slice(0, 8).join(' | ')}... (${(header[0] || []).length} cols)`);
      const full = await fetchValues(token, oldSid, `${mig.name}!A2:Z1000`);
      console.log(`    legacy data rows: ${full.length}`);
      // For each row: A,B = target/associated keyword. Skip C/D (would be VLOOKUP on new sheet).
      // Then E onwards = whatever legacy had (Intent, Tier, Template, ...).
      // New sheet expects: A=Target / B=Associated / C,D=auto / E=Intent / ... / U=journal_prompts (21 cols total).
      // Strategy: take A,B as-is + E onwards, but cap at 19 more cols (to fit dst 21 = A,B + 19 more).
      rows = full
        .filter((r) => r && r[0] && String(r[0]).trim())
        .map((r) => {
          // dst layout: [A, B, '', '', ...rest...]
          // SAFER: leave C/D empty, copy E onwards verbatim up to col U
          const dstRow = new Array(21).fill('');
          dstRow[0] = r[0] || '';   // A
          dstRow[1] = r[1] || '';   // B
          // C, D leave empty - 新 sheet 有 VLOOKUP 公式会自动填
          for (let i = 4; i < Math.min(r.length, 23); i++) {  // E-Y (idx 4-22) → 新 sheet E-U (idx 4-20)
            const dstIdx = i;
            if (dstIdx >= 21) break;
            dstRow[dstIdx] = r[i] || '';
          }
          return dstRow;
        });
    } else {
      const data = await fetchValues(token, oldSid, `${mig.name}!${mig.srcRange}`);
      console.log(`    source rows: ${data.length}`);
      rows = mig.filter ? data.filter(mig.filter) : data;
    }

    console.log(`    will migrate: ${rows.length} rows`);
    if (!rows.length) {
      console.log('    (no rows to migrate, skip)');
      continue;
    }

    // Sample first 3 rows
    for (const r of rows.slice(0, 3)) {
      console.log(`      - ${JSON.stringify(r).slice(0, 120)}${JSON.stringify(r).length > 120 ? '...' : ''}`);
    }
    if (rows.length > 3) console.log(`      ... (+${rows.length - 3} more)`);

    // PUT to exact A2:{col}{N+1} range — append would jump past fill-down formula cells (row 2-1500)
    const colEnd = mig.custom ? 'U' : (mig.name === 'keyword_candidates' ? 'K' : 'I');
    const lastRow = 1 + rows.length;
    const range = `${mig.name}!A2:${colEnd}${lastRow}`;
    const resp = await updateValues(token, newSid, range, rows);
    const written = resp.updatedRows ?? rows.length;
    console.log(`    ✓ wrote ${written} rows to ${range}`);

    // POST-MIGRATE: 选题登记表 C/D VLOOKUP 公式被空字符串覆盖了，重写
    if (mig.name === '选题登记表') {
      const cFormula = `=IF($A2="","",IFERROR(VLOOKUP($A2,'关键词主表'!$A:$X,3,FALSE),"未找到"))`;
      const dFormula = `=IF($A2="","",IFERROR(VLOOKUP($A2,'关键词主表'!$A:$X,4,FALSE),"未找到"))`;
      const cValues = Array.from({ length: rows.length }, () => [cFormula]);
      const dValues = Array.from({ length: rows.length }, () => [dFormula]);
      await updateValues(token, newSid, `选题登记表!C2:C${lastRow}`, cValues, 'USER_ENTERED');
      await updateValues(token, newSid, `选题登记表!D2:D${lastRow}`, dValues, 'USER_ENTERED');
      console.log(`    ✓ restored C/D VLOOKUP formulas at C2:D${lastRow}`);
    }
    console.log('');
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`✅ Migration complete. Open: https://docs.google.com/spreadsheets/d/${newSid}/edit`);
  console.log('');
  console.log('VERIFY:');
  console.log('  1. 关键词主表 J 列（DR 差值公式）应在所有迁入行自动计算');
  console.log('  2. 选题登记表 C/D 列（VLOOKUP 月搜索量/KD）应回填');
  console.log('  3. 5 视图表（趋势/快速胜利/战略/长尾）应按主表 R 列分桶筛出来');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
