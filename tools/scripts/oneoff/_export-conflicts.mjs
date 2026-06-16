#!/usr/bin/env node
// _export-conflicts.mjs — 只读：列出正式表(1CkjOC)与副本(1UaTxBQ)共有 key 行的逐单元格差异，供人工审。
// 输出 markdown 到 .gg-cache/，控制台打印摘要。不写任何 sheet。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
loadEnv();

const FLOW = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const MIG = '1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { token } = await getAccessToken(join(homedir(), '.config', 'gg', 'gg-writer-sa.json'), ['https://www.googleapis.com/auth/spreadsheets.readonly']);

async function get(id, range) { const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS`, { headers: { authorization: `Bearer ${token}` } }); return (await r.json()).values || []; }
const norm = (s) => String(s ?? '').trim().toLowerCase();
const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());
const colL = (i) => i < 26 ? String.fromCharCode(65 + i) : 'A' + String.fromCharCode(65 + i - 26);

// 关键词主表公式列(差异多为输入衍生，标注降噪)
const MASTER_FORMULA = new Set([9, 10, 12, 13, 14, 17, 18, 20, 21, 23]); // J K M N O R S U V X
const TOPIC_FORMULA = new Set([2, 3]); // 选题登记表 C/D VLOOKUP

async function diffTab({ tab, keyCol = 0, formulaCols = new Set() }) {
  const flow = await get(FLOW, `${tab}!A:AC`);
  const mig = await get(MIG, `${tab}!A:AC`);
  const head = flow[0] || [];
  const fMap = new Map(), mMap = new Map();
  for (let i = 1; i < flow.length; i++) { const k = norm(flow[i]?.[keyCol]); if (k && !isSection(flow[i]?.[keyCol])) fMap.set(k, { row: i + 1, cells: flow[i] }); }
  for (let i = 1; i < mig.length; i++) { const k = norm(mig[i]?.[keyCol]); if (k && !isSection(mig[i]?.[keyCol])) mMap.set(k, { row: i + 1, cells: mig[i] }); }
  const commonCols = Math.min((flow[0] || []).length, (mig[0] || []).length);
  const rows = [];
  for (const [k, f] of fMap) {
    const m = mMap.get(k); if (!m) continue;
    const diffs = [];
    for (let c = 0; c < commonCols; c++) {
      const a = String(f.cells[c] ?? '').trim(), b = String(m.cells[c] ?? '').trim();
      if (a !== b) diffs.push({ c, name: head[c] || '', a, b, formula: formulaCols.has(c) });
    }
    if (diffs.length) rows.push({ key: f.cells[keyCol], flowRow: f.row, migRow: m.row, diffs });
  }
  return { tab, rows, total: rows.length };
}

const results = [];
results.push(await diffTab({ tab: '关键词主表', formulaCols: MASTER_FORMULA }));
results.push(await diffTab({ tab: '主题集群表' }));
results.push(await diffTab({ tab: '选题登记表', formulaCols: TOPIC_FORMULA }));

// markdown
let md = `# 正式表(1CkjOC) vs 迁移副本(1UaTxBQ) 共有行单元格差异清单\n\n`;
md += `> 只读导出。"正式→副本" 表示正式表当前值 → 副本里的值。[公式] 列差异多由输入列衍生。\n> 决定哪些以副本为准覆盖正式表后告诉我。\n\n`;
for (const r of results) {
  md += `## ${r.tab} — ${r.total} 行有差异\n\n`;
  for (const row of r.rows) {
    md += `- **${row.key}** (正式行${row.flowRow} / 副本行${row.migRow})\n`;
    for (const d of row.diffs) {
      md += `  - ${colL(d.c)} ${d.name}${d.formula ? ' [公式]' : ''}: 正式=\`${d.a || '(空)'}\` → 副本=\`${d.b || '(空)'}\`\n`;
    }
  }
  md += `\n`;
}
const outDir = join(__dirname, '..', '..', '..', '.gg-cache');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'flow-vs-migration-conflicts-2026-06-16.md');
writeFileSync(outPath, md);

// 控制台摘要：按列名统计差异频次
console.log('=== 共有行差异摘要 ===');
for (const r of results) {
  const byCol = {};
  for (const row of r.rows) for (const d of row.diffs) { const key = `${colL(d.c)} ${d.name}${d.formula ? '[公式]' : ''}`; byCol[key] = (byCol[key] || 0) + 1; }
  console.log(`\n[${r.tab}] ${r.total} 行有差异，按列：`);
  Object.entries(byCol).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n} 处`));
}
console.log(`\n完整清单 → ${outPath}`);
