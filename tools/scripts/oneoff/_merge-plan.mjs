#!/usr/bin/env node
/**
 * _merge-plan.mjs — 把正式表(1CkjOC)与副本(1UaTxBQ)合成「合集」(union)。
 * 逐格取「最新/非空」：一方空取有值方；状态列取推进后的值；其余双向冲突 → 人工裁决。
 * 只把「合集结果来自副本、需写回正式表」的格子列为写入项；正式已较新的不动。
 *
 *   node tools/scripts/oneoff/_merge-plan.mjs           # dry-run（计划 + 人工冲突清单）
 *   node tools/scripts/oneoff/_merge-plan.mjs --apply   # 把自动决议的写回项写入正式表
 */
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
loadEnv();

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const MIG = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const APPLY = process.argv.includes('--apply');
const __dirname = dirname(fileURLToPath(import.meta.url));
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), [scope]);

async function get(id, range) { const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${token}` } }); return (await r.json()).values || []; }
const norm = (s) => String(s ?? '').trim().toLowerCase();
const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());
const colL = (i) => i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26);

// 公式列：跳过写回（随输入自动算）
const FORMULA = {
  关键词主表: new Set([9, 10, 12, 13, 14, 17, 18, 20, 21, 23]), // J K M N O R S U V X
  选题登记表: new Set([2, 3]), // C D VLOOKUP
  主题集群表: new Set([]),
};
// 状态序：合集取推进后的值
const ORDER = {
  '选题登记表::12': ['待写', '写作中', '质检', '已发布', '已刷新'], // M Status
  '关键词主表::24': ['未开始', '已建卡', '已发布', '已合并'],         // Y 生产状态（暂停不入序→冲突）
};

async function planTab(tab, keyCol = 0) {
  const flow = await get(FLOW, `${tab}!A:AC`);
  const mig = await get(MIG, `${tab}!A:AC`);
  const head = flow[0] || [];
  const fMap = new Map(), mMap = new Map();
  for (let i = 1; i < flow.length; i++) { const k = norm(flow[i]?.[keyCol]); if (k && !isSection(flow[i]?.[keyCol])) fMap.set(k, { row: i + 1, cells: flow[i] }); }
  for (let i = 1; i < mig.length; i++) { const k = norm(mig[i]?.[keyCol]); if (k && !isSection(mig[i]?.[keyCol])) mMap.set(k, { row: i + 1, cells: mig[i] }); }
  const commonCols = Math.min((flow[0] || []).length, (mig[0] || []).length);
  const writes = [], conflicts = [];
  for (const [k, f] of fMap) {
    const m = mMap.get(k); if (!m) continue;
    for (let c = 0; c < commonCols; c++) {
      const a = String(f.cells[c] ?? '').trim(), b = String(m.cells[c] ?? '').trim();
      if (a === b) continue;
      if (FORMULA[tab]?.has(c)) continue; // 公式列不写回
      const meta = { tab, key: f.cells[keyCol], flowRow: f.row, col: c, colName: head[c] || '', a, b };
      if (a === '' && b !== '') { writes.push({ ...meta, to: b, why: '正式空←副本补' }); continue; }
      if (b === '' && a !== '') continue; // 正式有值副本空 → 保留正式，不动
      // 双方都有值且不同
      const ord = ORDER[`${tab}::${c}`];
      if (ord && ord.includes(a) && ord.includes(b)) {
        if (ord.indexOf(b) > ord.indexOf(a)) writes.push({ ...meta, to: b, why: `状态推进 ${a}→${b}` });
        // b 更旧或相等 → 保留正式，不动
      } else {
        conflicts.push(meta); // 语义冲突，人工裁决
      }
    }
  }
  return { tab, writes, conflicts };
}

const plans = [await planTab('关键词主表'), await planTab('主题集群表'), await planTab('选题登记表')];

// markdown
let md = `# 合集(union)合并计划 — 正式表 1CkjOC ← 副本 1UaTxBQ\n\n> 自动写回项 = 合集结果来自副本(更新/补空)、需写入正式表。人工冲突 = 双向都有值且语义不同。\n\n`;
for (const p of plans) {
  md += `## ${p.tab}\n\n### 自动写回正式表 (${p.writes.length})\n`;
  for (const w of p.writes) md += `- ${w.key} 行${w.flowRow} · ${colL(w.col)} ${w.colName}: \`${w.a || '(空)'}\` → \`${w.to}\`  (${w.why})\n`;
  md += `\n### 人工裁决 (${p.conflicts.length})\n`;
  for (const c of p.conflicts) md += `- ${c.key} 行${c.flowRow} · ${colL(c.col)} ${c.colName}: 正式=\`${c.a}\` | 副本=\`${c.b}\`\n`;
  md += `\n`;
}
const outDir = join(__dirname, '..', '..', '..', '.gg-cache');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'flow-merge-plan-2026-06-16.md');
writeFileSync(outPath, md);

console.log('=== 合集合并计划摘要 ===');
for (const p of plans) console.log(`[${p.tab}] 自动写回=${p.writes.length}  人工裁决=${p.conflicts.length}`);
console.log(`\n完整计划 → ${outPath}`);

if (!APPLY) { console.log('\nDRY-RUN。自动写回项确认后加 --apply（人工裁决项不会自动写）。'); process.exit(0); }

// APPLY：写回自动决议项
const data = [];
for (const p of plans) for (const w of p.writes) data.push({ range: `${p.tab}!${colL(w.col)}${w.flowRow}`, values: [[w.to]] });
if (!data.length) { console.log('无写回项。'); process.exit(0); }
const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${FLOW}/values:batchUpdate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }) });
const body = await res.json().catch(() => ({}));
if (!res.ok) throw new Error(`${res.status}: ${body.error?.message}`);
console.log(`\n✅ 写回 ${data.length} 个单元格到正式表。`);
