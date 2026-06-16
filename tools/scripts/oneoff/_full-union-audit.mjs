#!/usr/bin/env node
/**
 * _full-union-audit.mjs — 只读:全 tab union 审计。正式表(1CkjOC) vs 副本(1UaTxBQ)。
 * 目标:回答"副本能否作废"——逐 tab 找 only-in-migration 的真正待迁数据 + 双向冲突。
 *
 * 吸取 codex 评审:
 *  - get() 检查 res.ok,读失败抛错(不静默变空表)
 *  - key 列按表头名解析(抗列漂移),选题登记表用 page_id
 *  - 日志表用复合键(append-only 行并集)
 *  - 视图表比 A1 公式;文档表比行数+内容
 *  - 重复 key 报警
 */
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

async function get(id, range, opt = '') {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?majorDimension=ROWS${opt}`;
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`READ FAIL ${id} ${range}: ${r.status} ${b.error?.message || ''}`); // codex: no silent empty
  return b.values || [];
}
const norm = (s) => String(s ?? '').trim().toLowerCase();
const isSection = (a) => /^#{1,6}\s+/.test(String(a ?? '').trim());

// 每 tab 的 key 列(按表头名,抗漂移);复合键给多个。type: data/view/doc
const TABS = [
  { name: '配置', type: 'data', keys: ['配置项'] },
  { name: '关键词主表', type: 'data', keys: ['关键词'] },
  { name: '主题集群表', type: 'data', keys: ['cluster_id'] },
  { name: '选题登记表', type: 'data', keys: ['page_id'] }, // codex: page_id 主键
  { name: 'CTA Map', type: 'data', keys: ['cta_id'] },
  { name: '结果复盘表', type: 'data', keys: ['outcome_id'] },
  { name: '内容追踪', type: 'data', keys: ['关键词'] },
  { name: '来源分析', type: 'data', keys: ['来源'] },
  { name: 'keyword_candidates', type: 'data', keys: ['run_id', 'query'] },
  { name: 'pipeline-status', type: 'data', keys: ['page_id'] },
  { name: 'publish-log', type: 'data', keys: ['timestamp', 'page_id'] },
  { name: 'quality-metrics', type: 'data', keys: ['timestamp', 'page_id'] },
  { name: 'cost-tracking', type: 'data', keys: ['timestamp', 'operation'] },
  { name: 'config', type: 'data', keys: ['key'] },
  { name: 'monitor-auto', type: 'data', keys: ['report_date', 'url'] },
  { name: 'failure-log', type: 'data', keys: ['timestamp', 'page_id'] },
  { name: '生产候选', type: 'view' },
  { name: '趋势词', type: 'view' }, { name: '快速胜利', type: 'view' },
  { name: '战略词', type: 'view' }, { name: '长尾词', type: 'view' },
  { name: '分桶规则', type: 'doc' }, { name: 'README', type: 'doc' },
];

function keyIdx(head, keys) {
  return keys.map((k) => head.findIndex((h) => String(h).trim() === k));
}
function buildMap(rows, idxs) {
  const m = new Map(); const dups = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (idxs.some((ix) => ix < 0)) return { m, dups, bad: true };
    const k = idxs.map((ix) => norm(r[ix])).join('');
    if (k.replace(//g, '') === '' || isSection(r[idxs[0]])) continue;
    if (m.has(k)) dups.push(k);
    m.set(k, { row: i + 1, cells: r });
  }
  return { m, dups, bad: false };
}

const report = [];
const summary = [];
for (const t of TABS) {
  try {
    if (t.type === 'view') {
      const f = (await get(FLOW, `${t.name}!A1`, '&valueRenderOption=FORMULA'))[0]?.[0] || '';
      const g = (await get(MIG, `${t.name}!A1`, '&valueRenderOption=FORMULA'))[0]?.[0] || '';
      const same = f === g;
      summary.push(`[视图] ${t.name}: A1 公式 ${same ? '一致' : '⚠️不同'}`);
      if (!same) report.push(`## ${t.name} (视图)\n- 正式 A1: \`${f}\`\n- 副本 A1: \`${g}\`\n`);
      continue;
    }
    if (t.type === 'doc') {
      const f = await get(FLOW, `${t.name}!A:Z`); const g = await get(MIG, `${t.name}!A:Z`);
      const fj = JSON.stringify(f), gj = JSON.stringify(g);
      summary.push(`[文档] ${t.name}: ${fj === gj ? '完全一致' : `⚠️不同 (正式${f.length}行/副本${g.length}行)`}`);
      continue;
    }
    const flow = await get(FLOW, `${t.name}!A:AZ`);
    const mig = await get(MIG, `${t.name}!A:AZ`);
    const fHead = flow[0] || [], mHead = mig[0] || [];
    const fIdx = keyIdx(fHead, t.keys), mIdx = keyIdx(mHead, t.keys);
    const fb = buildMap(flow, fIdx), mb = buildMap(mig, mIdx);
    if (fb.bad || mb.bad) { summary.push(`[数据] ${t.name}: ⚠️ key 列 ${t.keys.join('+')} 未找到 (正式idx=${fIdx}/副本idx=${mIdx})`); continue; }
    const onlyMig = [...mb.m.keys()].filter((k) => !fb.m.has(k));
    const onlyFlow = [...fb.m.keys()].filter((k) => !mb.m.has(k));
    const both = [...mb.m.keys()].filter((k) => fb.m.has(k));
    const commonCols = Math.min(fHead.length, mHead.length);
    let conflictRows = 0;
    for (const k of both) {
      const fr = fb.m.get(k).cells, mr = mb.m.get(k).cells;
      for (let c = 0; c < commonCols; c++) { if (String(fr[c] ?? '').trim() !== String(mr[c] ?? '').trim()) { conflictRows++; break; } }
    }
    const dupNote = (fb.dups.length || mb.dups.length) ? ` ⚠️重复key(正式${fb.dups.length}/副本${mb.dups.length})` : '';
    summary.push(`[数据] ${t.name} (key=${t.keys.join('+')}): 仅副本(待迁)=${onlyMig.length} 仅正式=${onlyFlow.length} 共有冲突=${conflictRows}${dupNote}`);
    if (onlyMig.length || onlyFlow.length || conflictRows) {
      let s = `## ${t.name} (key=${t.keys.join('+')})\n`;
      s += `- 仅副本(真正待迁 ${onlyMig.length}): ${onlyMig.slice(0, 30).map((k) => k.replace(//g, '|')).join(' , ') || '无'}\n`;
      s += `- 仅正式(${onlyFlow.length}): ${onlyFlow.slice(0, 30).map((k) => k.replace(//g, '|')).join(' , ') || '无'}\n`;
      s += `- 共有行有冲突: ${conflictRows}\n`;
      report.push(s);
    }
  } catch (e) {
    summary.push(`[ERROR] ${t.name}: ${e.message}`);
  }
}

const md = `# 全 tab union 审计 — 正式表 1CkjOC vs 副本 1UaTxBQ\n\n> 只读。"仅副本"=副本独有、正式没有的数据=作废副本前必须迁回的。\n\n## 摘要\n${summary.map((s) => '- ' + s).join('\n')}\n\n## 明细\n${report.join('\n')}\n`;
const outDir = join(__dirname, '..', '..', '..', '.gg-cache');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'full-union-audit-2026-06-16.md'), md);
console.log(summary.join('\n'));
console.log(`\n完整报告 → .gg-cache/full-union-audit-2026-06-16.md`);
