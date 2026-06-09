#!/usr/bin/env node
/**
 * gg-cluster-sync.mjs — 把主题集群表 keywords_included 的归属同步到关键词主表 cluster_id(AC)。
 *
 * 设计（见 D4 决策 2026-06-09）：同步是 additive/幂等/不覆盖，安全到可定时自动跑。
 *   - 自动写(精确)：master 关键词精确命中【唯一】集群的 keywords_included 且 AC 当前为空 → 写 AC。
 *   - 不自动写：AC 已有值(跳过不覆盖)；一词命中多集群(冲突，报告留人工)；仅模糊命中(建议，报告留人工)。
 *   - 漏检报告(每次都出)：① 疑似漏配(模糊命中但精确没中) ② 集群表里对不上主表的孤儿词(措辞/拼写漂移)
 *     ③ 仍未归集群计数。这样"措辞对不上"那种隐性漏会被报出来，而非默默丢。
 *
 * 复用 buildClusterMap(gg-sheet-to-brief) + buildClusterMatcher(gg-queue-build)。
 *
 * 用法：
 *   node tools/scripts/gg-cluster-sync.mjs                 # dry-run（默认原表，只读，出报告）
 *   node tools/scripts/gg-cluster-sync.mjs --apply         # 写 AC 空格（精确唯一命中）+ 出报告
 *   node tools/scripts/gg-cluster-sync.mjs --workbook <id> [--apply]
 *   （autopilot tick 以 --apply 定时调用）
 */
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { buildClusterMap } from './gg-sheet-to-brief.mjs';
import { buildClusterMatcher } from './gg-queue-build.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const norm = (s) => String(s || '').trim().toLowerCase();

// ---- 纯函数（可测） ----

// 主表 grid(含表头) → [{row, kw, ac}]；跳过空 A 列与 section header(## ...)。
// 与 gg-queue-build.parseMasterRows 同源过滤，但这里必须保留 sheet 行号(row) 以便回写 AC，故单列。
export function buildMasterRows(grid) {
  return grid.slice(1)
    .map((r, i) => ({ row: i + 2, kw: r[0], ac: r[28] }))
    .filter(({ kw }) => {
      const k = String(kw || '').trim();
      return k && !/^#{1,6}\s+/.test(k); // section header(## …) 不是关键词，不进任何桶
    });
}

// clusterMap(Map<cid,obj>) → Map<kw_norm, Set<cid>>（精确成员，含多归属以便报冲突）
export function buildExactClusterIndex(clusterMap) {
  const idx = new Map();
  for (const [cid, c] of clusterMap) {
    for (const k of String(c.keywords_included || '').split(/[,，、\n]+/)) {
      const kk = norm(k);
      if (!kk) continue;
      if (!idx.has(kk)) idx.set(kk, new Set());
      idx.get(kk).add(cid);
    }
  }
  return idx;
}

// masterRows: [{row, kw, ac}]；exactIndex: Map<kw,Set<cid>>；fuzzy: (kwLc)=>cid|null
// → { syncs:[{row,kw,cid}], conflicts:[{row,kw,cids}], fuzzy:[{row,kw,cid}], unclustered:[{row,kw}] }
export function classifyMasterRows({ masterRows, exactIndex, fuzzy }) {
  const syncs = [], conflicts = [], fuzzyHits = [], unclustered = [];
  for (const { row, kw, ac } of masterRows) {
    const k = norm(kw);
    if (!k) continue;
    if (String(ac || '').trim()) continue; // AC 已有值 → 不动
    const cids = exactIndex.get(k);
    if (cids && cids.size === 1) { syncs.push({ row, kw, cid: [...cids][0] }); continue; }
    if (cids && cids.size > 1) { conflicts.push({ row, kw, cids: [...cids] }); continue; }
    const f = fuzzy ? fuzzy(k) : null;
    if (f) fuzzyHits.push({ row, kw, cid: f });
    else unclustered.push({ row, kw });
  }
  return { syncs, conflicts, fuzzy: fuzzyHits, unclustered };
}

// 集群表 keywords_included 里、主表没有对应关键词的词（措辞/拼写漂移或主表缺词）
export function findOrphanClusterKeywords(clusterMap, masterKwSet) {
  const orphans = [];
  for (const [cid, c] of clusterMap) {
    for (const k of String(c.keywords_included || '').split(/[,，、\n]+/)) {
      const kk = norm(k);
      if (!kk) continue;
      if (!masterKwSet.has(kk)) orphans.push({ cid, kw: k.trim() });
    }
  }
  return orphans;
}

// ---- I/O main ----
async function main() {
  const args = process.argv.slice(2);
  const ORIG = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
  const wbIdx = args.indexOf('--workbook');
  const WB = wbIdx >= 0 ? args[wbIdx + 1] : ORIG;
  const APPLY = args.includes('--apply');
  const MASTER = '关键词主表', CLUSTERS = '主题集群表';

  loadEnv();
  const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  const scope = APPLY ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly';
  const { token } = await getAccessToken(SA, [scope]);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${WB}`;
  const get = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];

  const grid = await get(`${MASTER}!A1:AC1500`);
  const mh = grid[0] || [];
  if (mh[28] !== 'cluster_id') throw new Error(`前置校验失败：${MASTER} AC(28)=${mh[28]}，期望 cluster_id（需 v3.3）。`);
  const masterRows = buildMasterRows(grid);
  const masterKwSet = new Set(masterRows.map((x) => norm(x.kw)));

  const clusterMap = buildClusterMap(await get(`${CLUSTERS}!A1:S999`));
  const exactIndex = buildExactClusterIndex(clusterMap);
  const fuzzy = buildClusterMatcher(clusterMap);

  const { syncs, conflicts, fuzzy: fuzzyHits, unclustered } = classifyMasterRows({ masterRows, exactIndex, fuzzy });
  const orphans = findOrphanClusterKeywords(clusterMap, masterKwSet);

  const ts = new Date().toISOString();
  console.log(`[cluster-sync] ${ts} ${APPLY ? 'APPLY' : 'DRY-RUN'} wb=${WB.slice(0, 6)} | synced=${syncs.length} conflicts=${conflicts.length} fuzzy=${fuzzyHits.length} unclustered=${unclustered.length} orphans=${orphans.length}`);
  if (syncs.length) { console.log('  自动写(精确唯一命中):'); for (const s of syncs.slice(0, 30)) console.log(`    行${s.row} ${s.kw} → ${s.cid}`); if (syncs.length > 30) console.log(`    …另 ${syncs.length - 30}`); }
  if (conflicts.length) { console.log('  ⚠️ 冲突(一词多集群，留人工):'); for (const c of conflicts.slice(0, 15)) console.log(`    行${c.row} ${c.kw}: [${c.cids.join(', ')}]`); }
  if (fuzzyHits.length) { console.log('  💡 疑似漏配(仅模糊命中，请确认是否补进 keywords_included 或留空):'); for (const f of fuzzyHits.slice(0, 20)) console.log(`    行${f.row} ${f.kw} ~ ${f.cid}`); if (fuzzyHits.length > 20) console.log(`    …另 ${fuzzyHits.length - 20}`); }
  if (orphans.length) { console.log('  🔎 集群表对不上主表的词(措辞/拼写漂移或主表缺词):'); for (const o of orphans.slice(0, 100)) console.log(`    ${o.cid}: "${o.kw}"`); if (orphans.length > 100) console.log(`    …另 ${orphans.length - 100}`); }
  console.log(`  仍未归集群(主表 AC 空且无任何命中): ${unclustered.length}`);

  if (!APPLY) { console.log('  DRY-RUN（未写入）。'); return 0; }

  if (syncs.length) {
    const data = syncs.map((s) => ({ range: `${MASTER}!AC${s.row}`, values: [[s.cid]] }));
    await gFetch(`${base}/values:batchUpdate`, token, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    });
    console.log(`  ✅ 写入 ${data.length} 行 AC（cluster_id）。`);
  } else {
    console.log('  无新精确命中，无写入(幂等)。');
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((c) => process.exit(c || 0)).catch((e) => { console.error('cluster-sync 失败:', e.message); process.exit(1); });
}
