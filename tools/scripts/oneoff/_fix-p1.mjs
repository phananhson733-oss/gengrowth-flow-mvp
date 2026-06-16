#!/usr/bin/env node
/**
 * _fix-p1.mjs — 仅问题1:选题登记表 1567-1576 补 C/D VLOOKUP 公式 + E=Info。
 * (问题3 已由 Ops 手工回填,作废,不在此脚本。)
 * 默认 dry-run;--apply 才写,且写后重读比对。
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
loadEnv();
const APPLY = process.argv.includes('--apply');
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const SCOPE = APPLY ? ['https://www.googleapis.com/auth/spreadsheets'] : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), SCOPE);
async function get(range, render = 'FORMULA') {
  const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=${render}`, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json(); if (!r.ok) throw new Error(`READ ${range}: ${b.error?.message}`); return b.values || [];
}
const colL = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const norm = (s) => String(s ?? '').trim().toLowerCase();
const die = (m) => { console.error(`\n✖ 断言失败,中止: ${m}`); process.exit(1); };

const REG = await get('选题登记表!A1:Q1576', 'FORMULA');
const KW = await get('关键词主表!A1:AC2000', 'UNFORMATTED_VALUE');

// 断言表头
const REG_HEAD = ['Target Keyword', 'Associated Keywords', '月搜索量', 'KD', 'Intent', 'Tier', 'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'GSC Keywords', 'Status', 'URL', 'Last Audit', 'page_id', 'cluster_id'];
REG_HEAD.forEach((h, i) => { if (String(REG[0][i] ?? '').trim() !== h) die(`选题登记表表头[${colL(i)}] 期望「${h}」实为「${REG[0][i]}」`); });

const EXPECT = ['aura colors meaning', 'light green aura meaning', 'lime green aura meaning', 'aura colors and their meaning', '8th house in astrology', 'rahu in 2nd house and ketu in 8th house', 'dark green aura meaning', 'vedic astrology houses', 'rahu in 11th house and ketu in 5th house', 'light purple aura meaning'];
const kwIntent = new Map(KW.slice(1).map((r) => [norm(r[0]), String(r[12] ?? '').trim()]));

const plan = [];
for (let i = 0; i < 10; i++) {
  const row = 1567 + i;
  const r = REG[row - 1] || [];
  const a = String(r[0] ?? '').trim();
  if (norm(a) !== norm(EXPECT[i])) die(`A${row} 期望「${EXPECT[i]}」实为「${a}」`);
  // 断言 C/D/E 当前为空(不覆盖已有值)
  for (const ci of [2, 3, 4]) if (String(r[ci] ?? '').trim() !== '') die(`${colL(ci)}${row} 非空(「${r[ci]}」),拒绝覆盖`);
  // 断言意图=Informational
  const it = kwIntent.get(norm(a));
  if (it !== 'Informational') die(`关键词主表「${a}」意图期望 Informational 实为「${it}」`);
  plan.push([`选题登记表!C${row}`, `=IF($A${row}="","",IFERROR(VLOOKUP($A${row},'关键词主表'!$A:$X,3,FALSE),"未找到"))`]);
  plan.push([`选题登记表!D${row}`, `=IF($A${row}="","",IFERROR(VLOOKUP($A${row},'关键词主表'!$A:$X,4,FALSE),"未找到"))`]);
  plan.push([`选题登记表!E${row}`, 'Info']);
}

console.log(`=== WRITEPLAN (${plan.length}格) ${APPLY ? '【APPLY】' : '【DRY-RUN】'} ===`);
for (const [ref, v] of plan) console.log(`  ${ref} = ${JSON.stringify(v).slice(0, 90)}`);

if (!APPLY) { console.log('\n(dry-run。确认后加 --apply)'); process.exit(0); }

const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values:batchUpdate`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: plan.map(([range, v]) => ({ range, values: [[v]] })) }),
});
const rb = await res.json();
if (!res.ok) die(`batchUpdate 失败: ${res.status} ${rb.error?.message}`);
console.log(`\n✓ 已写入 ${rb.totalUpdatedCells} 格`);
// 写后重读验证
const back = await get('选题登记表!A1567:E1576', 'UNFORMATTED_VALUE');
console.log('\n写后重读 1567-1576 (A/C/D/E 计算值):');
back.forEach((r, i) => console.log(`  行${1567 + i}: A=${r[0]} C=${r[2]} D=${r[3]} E=${r[4]}`));
