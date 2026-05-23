#!/usr/bin/env node
// gg-backfill-site-dr.mjs — 把"当前自有站 DR"批量回填到 关键词主表 I 列
//
// 背景：
//   I 列定义是"查词当时的站 DR 快照"。590 历史词在挖矿时 I 列填 0（当时无 Ahrefs 站）。
//   2026-05-23 用户告知：astrologywiki.com 当前 DR ≤ 5（新站）。
//   按用户选择"用今天 DR 批量回填历史 590 词"。
//
// 设计：
//   - DR 作为必填 CLI 参数（不允许默认值，强制用户给真实数字 — 防 mock）
//   - --apply-to all|empty|zero  指定回填范围（默认 zero = 只填 I=0 的行）
//   - --dry-run 默认；--write 才落
//   - 写入后立即输出 R 列分桶分布对比（before/after）
//
// 用法：
//   node tools/scripts/gg-backfill-site-dr.mjs --dr 5                          (dry-run, 默认)
//   node tools/scripts/gg-backfill-site-dr.mjs --dr 5 --write
//   node tools/scripts/gg-backfill-site-dr.mjs --dr 3 --write --apply-to all   (覆盖全部)
//   node tools/scripts/gg-backfill-site-dr.mjs --dr 5 --write --workbook legacy
//
// SOP 引用：
//   tools/scripts/lib/_workbook-spec.mjs I1 注释：
//   "自有站DR（查词当时的站DR快照，手动填写）"
//   "获取：Ahrefs → 输入你的域名 → 查看 Domain Rating"

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, def = null) => (has(f) ? argv[argv.indexOf(f) + 1] : def);

if (has('--help') || has('-h')) {
  console.log(`gg-backfill-site-dr.mjs — 回填关键词主表 I 列（自有站 DR 快照）

用法:
  --dr N            必填。真实 Ahrefs 站 DR 数字（整数 0-100）
  --apply-to MODE   zero (默认，只填 I=0 的行) | empty | all
  --write           落到 sheet（默认 dry-run）
  --dry-run         强制 dry-run
  --workbook X      flow-mvp (默认) | legacy | <sheet-id>

示例:
  node tools/scripts/gg-backfill-site-dr.mjs --dr 5 --write
`);
  process.exit(0);
}

const DR_RAW = arg('--dr');
if (!DR_RAW) {
  console.error('ERR: --dr <integer> 必填。请去 Ahrefs 查 astrologywiki.com 当前 Domain Rating 后传入。');
  console.error('  禁止猜值或填 mock — 见 ~/.claude/projects/.../memory/feedback_no_mock_data.md');
  process.exit(2);
}
const DR = parseInt(DR_RAW, 10);
if (!Number.isInteger(DR) || DR < 0 || DR > 100) {
  console.error(`ERR: --dr 必须是 0-100 整数，收到 "${DR_RAW}"`);
  process.exit(2);
}

const APPLY_TO = arg('--apply-to', 'zero');
if (!['zero', 'empty', 'all'].includes(APPLY_TO)) {
  console.error(`ERR: --apply-to 必须是 zero|empty|all`);
  process.exit(2);
}

const WRITE = has('--write') && !has('--dry-run');
const WORKBOOK = arg('--workbook', 'flow-mvp');

async function fetchValues(token, sid, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  return ((await gFetch(url, token)).values) || [];
}

async function updateValues(token, sid, range, values, valueInputOption = 'RAW') {
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

function tallyR(rCol) {
  const tally = {};
  for (const v of rCol) {
    if (v === undefined || v === '') continue;
    tally[v] = (tally[v] || 0) + 1;
  }
  return tally;
}

async function main() {
  loadEnv();
  let sid;
  if (WORKBOOK === 'flow-mvp') sid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  else if (WORKBOOK === 'legacy') sid = process.env.GG_SHEETS_WORKBOOK_ID;
  else sid = WORKBOOK;
  if (!sid) {
    console.error(`ERR: workbook "${WORKBOOK}" — env not set`);
    process.exit(2);
  }
  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(sa)) {
    console.error(`ERR: writer SA not found: ${sa}`);
    process.exit(2);
  }
  const { token } = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Workbook:  ${WORKBOOK} (${sid.slice(0, 12)}…)`);
  console.log(`DR:        ${DR}  (用户告知的真实 Ahrefs 数字)`);
  console.log(`Apply to:  ${APPLY_TO}`);
  console.log(`Mode:      ${WRITE ? 'WRITE' : 'DRY-RUN'}`);
  console.log('');

  // 1. fetch A 列 + I 列 + R 列（before）
  const rows = await fetchValues(token, sid, '关键词主表!A2:R1500');
  const before = tallyR(rows.map((r) => r[17]));
  const eligible = [];
  rows.forEach((r, idx) => {
    if (!r[0]) return;
    const i = r[8]; // I col (idx 8)
    const isZero = i === 0 || i === '0';
    const isEmpty = i === undefined || i === '' || i === null;
    if (APPLY_TO === 'all') eligible.push(idx);
    else if (APPLY_TO === 'zero' && isZero) eligible.push(idx);
    else if (APPLY_TO === 'empty' && isEmpty) eligible.push(idx);
  });
  console.log(`合格回填行数: ${eligible.length}`);
  console.log(`R 列分桶分布（回填前）:`);
  for (const [k, n] of Object.entries(before).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${String(n).padStart(4)}`);
  }

  if (eligible.length === 0) {
    console.log('\n无可回填行，退出。');
    return;
  }

  if (!WRITE) {
    console.log('\nDRY-RUN: 无 sheet 写入。加 --write 落盘。');
    return;
  }

  // 2. 按连续行段批量写（减少 API 调用）
  // I 列地址：I2..I{rows+1}
  const iValues = Array.from({ length: rows.length }, (_, idx) => {
    if (eligible.includes(idx)) return [DR];
    // 保留原值（不动）
    const v = rows[idx][8];
    return [v === undefined ? '' : v];
  });
  const lastRow = 1 + rows.length;
  const range = `关键词主表!I2:I${lastRow}`;
  console.log(`\nWRITE → ${range} (${eligible.length} cells = ${DR}, ${rows.length - eligible.length} cells 不变)`);
  await updateValues(token, sid, range, iValues);
  console.log('✓ 写入完成，等公式重算 (5s)...');
  await new Promise((r) => setTimeout(r, 5000));

  // 3. fetch R 列（after）+ 对比
  const rAfter = await fetchValues(token, sid, '关键词主表!R2:R1500');
  const after = tallyR(rAfter.map((r) => r[0]));
  console.log(`\nR 列分桶分布（回填后）:`);
  for (const [k, n] of Object.entries(after).sort((a, b) => b[1] - a[1])) {
    const delta = (after[k] || 0) - (before[k] || 0);
    const sign = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : '0';
    console.log(`  ${k.padEnd(12)} ${String(n).padStart(4)}   (${sign})`);
  }
  console.log(`\n→ 下一步：node tools/scripts/gg-cluster-init.mjs --write`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
