#!/usr/bin/env node
// _merge-new-keywords.mjs — 把「GenGrowth 关键词研究主表」关键词主表的增量并入「gengrowth-flow-mvp」关键词主表。
//
//   增量 = (a) 源有目标无的新词 → append 到目标数据末尾（只写手动列 A:I，公式列 J-U/R/S 留给已有公式自动算）
//          (b) 指定共有词的打分刷新 → 定位目标行后只更新差异单元格
//   不动：主题集群表 / 选题登记表（目标已是超集）；跳过会撤销 drop 标记的 6 个词。
//
//   默认 dry-run（只预览 + 存快照）。加 --write 才真正写。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
loadEnv();

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const TARGET = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc'; // gengrowth-flow-mvp（目标）
const SOURCE = '1uVCq_nTBg59dwpKMZxVu7Z5plG78cIlEcqvtfo1e0Sg'; // GenGrowth 关键词研究主表（源）
const TAB = '关键词主表';
const WRITE = process.argv.includes('--write');

// 6 个 drop 词：目标里已标"跳过"，源里被清空。跳过它们 → 不撤销 drop 决策（FRONT_HALF_FLOW §4.2 C）。
const DROP_WORDS = new Set([
  'highly sensitive person quotes', 'astrologer reading', 'professional astrology reading',
  'professional astrology readings', 'professional birth chart reading', 'professional natal chart reading',
].map((s) => s.toLowerCase()));

const norm = (s) => String(s ?? '').trim().toLowerCase();
const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());

async function gget(url, token) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status}: ${b.error?.message || r.statusText}`);
  return b;
}
async function fetchVals(id, range, token, render) {
  const u = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS${render ? `&valueRenderOption=${render}` : ''}`;
  return (await gget(u, token)).values || [];
}

const sa = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = WRITE ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(sa, [scope]);

// 1) 快照（永远存：当前目标主表 A:Y 的 值 + 公式 两份，作回滚点）
const snapVals = await fetchVals(TARGET, `${TAB}!A:Y`, token);
const snapFormulas = await fetchVals(TARGET, `${TAB}!A:Y`, token, 'FORMULA');
const snapDir = join(REPO, '.gg-cache', 'snapshots');
mkdirSync(snapDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const snapPath = join(snapDir, `flow-mvp-keyword-master-${stamp}.json`);
writeFileSync(snapPath, JSON.stringify({ workbook: TARGET, tab: TAB, takenAt: new Date().toISOString(), rows: snapVals.length, values: snapVals, formulas: snapFormulas }, null, 2));
console.log(`[snapshot] 目标主表 ${snapVals.length} 行已存: ${snapPath}`);

// 2) 计算新词 + 定位 append 起点
const tgt = snapVals;
const src = await fetchVals(SOURCE, `${TAB}!A:X`, token);
const tgtKeys = new Set(tgt.slice(1).map((r) => norm(r?.[0])).filter(Boolean));
let lastNonEmpty = 1;
for (let i = 1; i < tgt.length; i++) if (String(tgt[i]?.[0] ?? '').trim() !== '') lastNonEmpty = i + 1; // 1-indexed sheet row
const appendStart = lastNonEmpty + 1;

const MANUAL = [0, 1, 2, 3, 4, 5, 6, 7, 8]; // A..I 手动列（公式列 J-U/R/S 不写）
// 源表内部可能有同词重复行（如 full moon June 2026 出现两次）→ 按 norm 去重，
// 同词保留月搜索量(idx2)数值更大者（信息更全/更新），并列保留先出现。
const volNum = (r) => { const v = Number(String(r?.[2] ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(v) ? v : -1; };
const newByKey = new Map();
for (let i = 1; i < src.length; i++) {
  const row = src[i] || [];
  const k = norm(row[0]);
  if (!k || isSection(row[0]) || tgtKeys.has(k) || DROP_WORDS.has(k)) continue;
  const prev = newByKey.get(k);
  if (!prev || volNum(row) > volNum(prev)) newByKey.set(k, row);
}
const newRows = [...newByKey.values()].map((row) => MANUAL.map((ci) => (row[ci] == null ? '' : row[ci])));

// 3) 3 个打分刷新词（共有词，源值更新；跳过 drop 词）
const REFRESH = [
  { kw: 'vedic birth chart calculator online free', set: { G: '6', H: '❌强' } },
  { kw: 'sextile astrology', set: { C: '700', D: '9' } },
  { kw: 'best vedic birth chart calculator', set: { G: '6', H: '⚠️中' } },
];
const tgtRowOf = new Map();
for (let i = 1; i < tgt.length; i++) { const k = norm(tgt[i]?.[0]); if (k && !tgtRowOf.has(k)) tgtRowOf.set(k, i + 1); }
const updates = [];
for (const { kw, set } of REFRESH) {
  const rowNum = tgtRowOf.get(norm(kw));
  if (!rowNum) { console.log(`[warn] 刷新词在目标未找到，跳过: ${kw}`); continue; }
  for (const [col, val] of Object.entries(set)) updates.push({ range: `${TAB}!${col}${rowNum}`, values: [[val]], _kw: kw, _col: col });
}

// 4) 预览
console.log(`\n[append] 新词 ${newRows.length} 个 → 写 ${TAB}!A${appendStart}:I${appendStart + newRows.length - 1}（仅手动列 A:I，公式列自动算）`);
for (const r of newRows) console.log('   + ' + r.map((v) => `"${v}"`).join(', '));
console.log(`\n[update] 打分刷新 ${updates.length} 个单元格:`);
for (const u of updates) console.log(`   ~ ${u.range}  ← "${u.values[0][0]}"  (${u._kw} 的 ${u._col} 列)`);

if (!WRITE) { console.log('\n=== DRY-RUN（未写入）。确认无误后加 --write 执行。==='); process.exit(0); }

// 5) 写：append 用 update 到精确范围（避免 append API 落到公式填充区外）+ 刷新 update
const data = [
  { range: `${TAB}!A${appendStart}:I${appendStart + newRows.length - 1}`, values: newRows },
  ...updates.map(({ range, values }) => ({ range, values })),
];
const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${TARGET}/values:batchUpdate`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
});
const body = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(`batchUpdate failed ${res.status}: ${body.error?.message}`);
console.log(`\n[written] 更新单元格总数 = ${body.totalUpdatedCells}；新词行 ${appendStart}-${appendStart + newRows.length - 1}`);
console.log('回滚点:', snapPath);
