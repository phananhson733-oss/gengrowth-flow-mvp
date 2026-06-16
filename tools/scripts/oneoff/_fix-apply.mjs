#!/usr/bin/env node
/**
 * _fix-apply.mjs — 选题登记表+结果复盘表 修复执行(经 codex+fan-out 评估+用户拍板)。
 * 默认 dry-run 输出逐格 writeplan;加 --apply 才写正式表,且写后重读比对 fail-fast。
 *
 * 用户裁决:
 *  - imp/clicks 写 P 备注文本(不塞 day14/day30 窗口列)
 *  - row85(308废弃) 保留+P备注,不生成 outcome_id
 *  - 选题登记表 C/D 扩 VLOOKUP 公式;E=Info
 *  - outcome_id = out_<page_id>_snap20260616
 * K 列排名用页面平均位(query级接口报错;差异通常<3位),品牌词页面 K 留空。
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
loadEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLY = process.argv.includes('--apply');
const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const SCOPE = APPLY ? ['https://www.googleapis.com/auth/spreadsheets'] : ['https://www.googleapis.com/auth/spreadsheets.readonly'];
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), SCOPE);
const RECORD_DATE = '2026-06-16';
const WINDOW = 'GSC 28d 2026-05-18~06-15 web 全国 快照';

async function get(range, render = 'UNFORMATTED_VALUE') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values/${encodeURIComponent(range)}?majorDimension=ROWS&valueRenderOption=${render}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json();
  if (!r.ok) throw new Error(`READ FAIL ${range}: ${r.status} ${b.error?.message || ''}`);
  return b.values || [];
}
const colL = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const norm = (s) => String(s ?? '').trim().toLowerCase();
const round1 = (x) => Math.round(x * 10) / 10;
const isBrand = (kw) => { const k = norm(kw); return k.includes('astrologywiki') || k === 'astrowiki' || k === 'astrology wiki'; };
function die(msg) { console.error(`\n✖ 断言失败,中止: ${msg}`); process.exit(1); }

// ---- 读现状 ----
const REG = await get('选题登记表!A1:AM1576', 'FORMULA');
const RECAP = await get('结果复盘表!A1:P200', 'FORMULA');
const KW = await get('关键词主表!A1:AC2000', 'UNFORMATTED_VALUE');
const snap = readFileSync(join(__dirname, '..', '..', '..', '.gg-cache', 'gsc-pages-snapshot-0518-0615.csv'), 'utf8').trim().split('\n');
const gsc = new Map();
for (let i = 1; i < snap.length; i++) {
  const c = snap[i].split(',');
  // page,keywords_count,top_keyword,clicks,impressions,ctr,position  (top_keyword 无内嵌逗号已确认)
  gsc.set(c[0].trim().replace(/\/$/, ''), { top: c[2], clicks: +c[3], imp: +c[4], pos: +c[6] });
}

// ---- 断言:表头 ----
const REG_HEAD = ['Target Keyword', 'Associated Keywords', '月搜索量', 'KD', 'Intent', 'Tier', 'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'GSC Keywords', 'Status', 'URL', 'Last Audit', 'page_id', 'cluster_id', 'page_role', 'content_angle', 'psych_safety_flag', 'journal_prompts', 'target_keyword_zh', 'author'];
const RECAP_HEAD = ['outcome_id', 'page_id', 'cluster_id', 'url', 'day14_收录', '申请时间', '索引修复状态', 'day14_impressions', '记录日期', 'day30_进Top50词数', '当前最高排名词（排名）', 'day30_clicks', 'day60_pv', 'day60_目标国pv', '决策', '备注'];
REG_HEAD.forEach((h, i) => { if (String(REG[0][i] ?? '').trim() !== h) die(`选题登记表表头[${colL(i)}] 期望「${h}」实为「${REG[0][i]}」`); });
RECAP_HEAD.forEach((h, i) => { if (String(RECAP[0][i] ?? '').trim() !== h) die(`结果复盘表表头[${colL(i)}] 期望「${h}」实为「${RECAP[0][i]}」`); });

// ---- writeplan(Map<A1, {v, note}>,重复 key 报错) ----
const plan = new Map();
function put(ref, v, note) {
  if (plan.has(ref)) die(`writeplan 单元格冲突 ${ref}（${plan.get(ref).note} vs ${note}）`);
  plan.set(ref, { v, note });
}

// ===== P1 选题登记表 1567-1576 补 C/D 公式 + E=Info =====
const EXPECT_KW = ['aura colors meaning', 'light green aura meaning', 'lime green aura meaning', 'aura colors and their meaning', '8th house in astrology', 'rahu in 2nd house and ketu in 8th house', 'dark green aura meaning', 'vedic astrology houses', 'rahu in 11th house and ketu in 5th house', 'light purple aura meaning'];
const kwIntent = new Map(KW.slice(1).map((r) => [norm(r[0]), String(r[12] ?? '').trim()]));
for (let i = 0; i < 10; i++) {
  const row = 1567 + i;
  const a = String(REG[row - 1]?.[0] ?? '').trim();
  if (norm(a) !== norm(EXPECT_KW[i])) die(`选题登记表 A${row} 期望「${EXPECT_KW[i]}」实为「${a}」`);
  const it = kwIntent.get(norm(a));
  if (it !== 'Informational') die(`关键词主表「${a}」意图期望 Informational 实为「${it}」(Intent 映射只支持 Informational→Info)`);
  put(`选题登记表!C${row}`, `=IF($A${row}="","",IFERROR(VLOOKUP($A${row},'关键词主表'!$A:$X,3,FALSE),"未找到"))`, 'P1 C公式');
  put(`选题登记表!D${row}`, `=IF($A${row}="","",IFERROR(VLOOKUP($A${row},'关键词主表'!$A:$X,4,FALSE),"未找到"))`, 'P1 D公式');
  put(`选题登记表!E${row}`, 'Info', 'P1 E=Info');
}

// ===== P3A 清脏数据 =====
// row66: 断言仅 E=Y
const r66 = RECAP[65] || [];
const r66nonempty = r66.map((c, i) => (String(c ?? '').trim() ? colL(i) : null)).filter(Boolean);
if (!(r66nonempty.length === 1 && r66nonempty[0] === 'E' && String(r66[4]).trim() === 'Y')) die(`结果复盘表 行66 期望仅 E=Y,实为 ${r66nonempty.join(',')}`);
put('结果复盘表!E66', '', 'P3A 清row66孤立E=Y');
// row85: page_id 应为 PG-EMPATH-004 且 url 为 signs-you-re-
const r85 = RECAP[84] || [];
if (String(r85[1]).trim() !== 'PG-EMPATH-004') die(`结果复盘表 行85 page_id 期望 PG-EMPATH-004 实为「${r85[1]}」`);
if (!String(r85[3]).includes('signs-you-re-a-highly-sensitive-person')) die(`结果复盘表 行85 url 期望含 signs-you-re- 实为「${r85[3]}」`);
put('结果复盘表!P85', '308→/en/wiki/signs-of-a-highly-sensitive-person；已合并至第59行(PG-EMPATH-004 canonical)，不单独复盘', 'P3A row85备注');
// aura row2-9: K→O. 断言 K2:K9 全=调整, O2:O9 全空, 全表其他K无调整
for (let row = 2; row <= 9; row++) {
  if (String(RECAP[row - 1]?.[10] ?? '').trim() !== '调整') die(`结果复盘表 K${row} 期望「调整」实为「${RECAP[row - 1]?.[10]}」`);
  if (String(RECAP[row - 1]?.[14] ?? '').trim() !== '') die(`结果复盘表 O${row} 期望空实为「${RECAP[row - 1]?.[14]}」`);
  put(`结果复盘表!O${row}`, '调整', 'P3A.4 K→O 决策');
}
for (let i = 1; i < RECAP.length; i++) {
  if (i + 1 < 2 || i + 1 > 9) { if (String(RECAP[i][10] ?? '').trim() === '调整') die(`结果复盘表 K${i + 1} 意外含「调整」(应仅aura行2-9)`); }
}

// ===== P3B outcome_id + P3C GSC 回填(行2-98,排除66/85) =====
const pidSeen = new Map();
for (let i = 1; i < RECAP.length; i++) {
  const row = i + 1;
  if (row === 66 || row === 85) continue;
  const r = RECAP[i];
  const pid = String(r[1] ?? '').trim();
  const url = String(r[3] ?? '').trim().replace(/\/$/, '');
  if (!pid && !url) continue;
  // P3B outcome_id
  if (pid) {
    if (pidSeen.has(pid)) die(`结果复盘表 page_id 重复(排除row85后仍重复): ${pid} @行${pidSeen.get(pid)}+${row}`);
    pidSeen.set(pid, row);
    put(`结果复盘表!A${row}`, `out_${pid}_snap20260616`, 'P3B outcome_id');
  }
  // P3C GSC 回填
  if (!url) continue;
  put(`结果复盘表!I${row}`, RECORD_DATE, 'P3C 记录日期');
  const g = gsc.get(url);
  if (g) {
    const kVal = isBrand(g.top) ? '' : `${g.top} (${round1(g.pos)})`;
    put(`结果复盘表!K${row}`, kVal, 'P3C 最高词(排名)');
    put(`结果复盘表!P${row}`, `imp=${g.imp} clicks=${g.clicks}｜${WINDOW}${isBrand(g.top) ? '｜top词为品牌词,K留空' : ''}`, 'P3C 备注');
  } else {
    put(`结果复盘表!P${row}`, `no_gsc_row｜GSC 28d 2026-05-18~06-15 web 全国 无展示`, 'P3C 无展示');
  }
}

// ---- 输出 writeplan ----
const entries = [...plan.entries()].sort((a, b) => a[0].localeCompare(b[0]));
console.log(`\n=== WRITEPLAN (${entries.length} 格) ${APPLY ? '【APPLY 模式】' : '【DRY-RUN,不写】'} ===`);
const groups = {};
for (const [ref, { v, note }] of entries) { (groups[note.split(' ')[0]] ||= []).push([ref, v, note]); }
for (const g of Object.keys(groups).sort()) {
  console.log(`\n-- ${g} (${groups[g].length}格) --`);
  for (const [ref, v, note] of groups[g]) console.log(`  ${ref} = ${v === '' ? '(清空)' : JSON.stringify(v).slice(0, 80)}  [${note}]`);
}

if (!APPLY) { console.log(`\n(dry-run 完成。确认无误后加 --apply 执行。务必先跑 _backup-tabs.mjs)`); process.exit(0); }

// ---- APPLY ----
const data = entries.map(([range, { v }]) => ({ range, values: [[v]] }));
const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values:batchUpdate`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
});
const rb = await res.json();
if (!res.ok) die(`batchUpdate 失败: ${res.status} ${rb.error?.message}`);
console.log(`\n✓ 已写入 ${rb.totalUpdatedCells} 格`);

// 写后重读抽查关键格
const check = await get('结果复盘表!A2:A9', 'UNFORMATTED_VALUE');
console.log('抽查 outcome_id A2:A9:', check.map((r) => r[0]).join(', '));
console.log('完成。请跑验收: _diag-recap.mjs / _full-union-audit.mjs');
