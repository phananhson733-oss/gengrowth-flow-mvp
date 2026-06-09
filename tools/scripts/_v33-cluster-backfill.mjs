#!/usr/bin/env node
/**
 * _v33-cluster-backfill.mjs — 给主表 AC(cluster_id) 空行回标集群归属【additive，绝不删/不覆盖已有值】
 *
 * 事实源：主题集群表.keywords_included（每个集群人工维护的成员词）。
 * 匹配：master.关键词(归一) == 某集群 keywords_included 里的某词（精确匹配，归一小写）。
 *   - 仅处理 AC 当前为空的 master 行（已有 cluster_id 一律不动）。
 *   - 一个 keyword 精确命中多个集群 → 报冲突、跳过（留人工）。
 * 写：master AC（cluster_id），逐格 RAW，仅命中且 AC 空的行。
 * 幂等：重跑只对仍空的行写；已写的成为「已有值」被跳过。
 *
 * 用法：
 *   node tools/scripts/_v33-cluster-backfill.mjs                  # dry-run（默认原表，只读）
 *   node tools/scripts/_v33-cluster-backfill.mjs --apply          # 对原表写 AC 空格
 *   node tools/scripts/_v33-cluster-backfill.mjs --workbook <id> [--apply]
 */
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ORIG = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WB = wbIdx >= 0 ? args[wbIdx + 1] : ORIG;
const APPLY = args.includes('--apply');
const MASTER = '关键词主表', CLUSTERS = '主题集群表';
const norm = (s) => String(s || '').trim().toLowerCase();

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
const { token } = await getAccessToken(SA, [scope]);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WB}`;
const get = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];

// 前置校验：主表 v3.3 且 AC=cluster_id
const mh = (await get(`${MASTER}!A1:AC1`))[0] || [];
if (mh[28] !== 'cluster_id') throw new Error(`前置校验失败：${MASTER} AC(28)=${mh[28]}，期望 cluster_id（需 v3.3）。`);

// 建 keyword(norm) → Set(cluster_id) （来自 keywords_included；记多归属以便报冲突）
const clus = await get(`${CLUSTERS}!A1:S999`);
const cH = clus[0]; const cidC = cH.indexOf('cluster_id'), kwC = cH.indexOf('keywords_included'), prioC = cH.indexOf('priority');
const cidPrio = {};
const kw2cids = new Map();
for (const r of clus.slice(1)) {
  const cid = String(r[cidC] || '').trim(); if (!cid) continue;
  cidPrio[cid] = String(r[prioC] || '').trim();
  for (const k of String(r[kwC] || '').split(/[,，、\n]+/)) {
    const kk = norm(k); if (!kk) continue;
    if (!kw2cids.has(kk)) kw2cids.set(kk, new Set());
    kw2cids.get(kk).add(cid);
  }
}

// 读主表 A + AC
const grid = await get(`${MASTER}!A2:AC2000`);
const proposals = [];       // {row, kw, cid}
const conflicts = [];       // {row, kw, cids}
let acEmpty = 0, acFilled = 0;
for (let i = 0; i < grid.length; i++) {
  const row = grid[i] || [];
  const kw = norm(row[0]); if (!kw) continue;
  const curAC = String(row[28] || '').trim();
  if (curAC) { acFilled++; continue; }
  acEmpty++;
  const cids = kw2cids.get(kw);
  if (!cids || cids.size === 0) continue;
  if (cids.size > 1) { conflicts.push({ row: i + 2, kw: row[0], cids: [...cids] }); continue; }
  proposals.push({ row: i + 2, kw: row[0], cid: [...cids][0] });
}

const byCluster = proposals.reduce((m, p) => ((m[p.cid] = (m[p.cid] || 0) + 1), m), {});
console.log(`MODE: ${APPLY ? 'APPLY ⚠️' : 'DRY-RUN'}  WORKBOOK: ${WB}`);
console.log(`主表 AC 现状: 已填 ${acFilled} / 空 ${acEmpty}`);
console.log(`精确命中可回标(AC空): ${proposals.length} | 多集群冲突跳过: ${conflicts.length}`);
console.log(`按集群(含优先级):`);
for (const [cid, n] of Object.entries(byCluster).sort((a, b) => b[1] - a[1])) console.log(`  ${cid} [${cidPrio[cid] || '?'}]: ${n}`);
if (conflicts.length) {
  console.log(`冲突样本(前15):`);
  for (const c of conflicts.slice(0, 15)) console.log(`  行${c.row} ${c.kw}: [${c.cids.join(', ')}]`);
}
console.log(`提议样本(前20):`);
for (const p of proposals.slice(0, 20)) console.log(`  行${p.row} ${p.kw} → ${p.cid} [${cidPrio[p.cid] || '?'}]`);
if (args.includes('--json')) console.log('PROPOSALS_JSON=' + JSON.stringify(proposals.map(p => ({ kw: p.kw, cid: p.cid, prio: cidPrio[p.cid] || '' }))));

if (!APPLY) { console.log('\nDRY-RUN 完成（未写入）。'); process.exit(0); }

const data = proposals.map(p => ({ range: `${MASTER}!AC${p.row}`, values: [[p.cid]] }));
if (data.length) {
  await gFetch(`${base}/values:batchUpdate`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data }),
  });
}
console.log(`\n✅ APPLY 完成：回标 ${data.length} 行 AC（cluster_id）。冲突 ${conflicts.length} 行留人工。`);
