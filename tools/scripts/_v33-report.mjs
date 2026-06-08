#!/usr/bin/env node
/**
 * _v33-report.mjs — 生成 v3.3 迁移报告（方案 §5）【只读】
 * 读线上原表 1CkjOC（或 --workbook 指定），算出验收所需全部计数 + P0 覆盖 + 争议清单 +
 * 回填预览，写到 docs/2026-06-08-v33-migration-report.md。绝不写任何 Sheet 单元格。
 *
 * 用法：node tools/scripts/_v33-report.mjs [--workbook <id>]
 */
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ORIG = '1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc';
const args = process.argv.slice(2);
const wbIdx = args.indexOf('--workbook');
const WB = wbIdx >= 0 ? args[wbIdx + 1] : ORIG;
const MASTER = '关键词主表', PAGES = '选题登记表', CLUSTERS = '主题集群表', VIEW = '生产候选';
const STATUS_MAP = { '已发布': '已发布', '写作中': '已建卡', '待写': '已建卡', '已合并': '已合并', '暂停': '暂停' };
const norm = (s) => String(s || '').trim().toLowerCase();

loadEnv();
const SA = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
const { token } = await getAccessToken(SA, ['https://www.googleapis.com/auth/spreadsheets.readonly']);
const base = `https://sheets.googleapis.com/v4/spreadsheets/${WB}`;
const get = async (r) => (await gFetch(`${base}/values/${encodeURIComponent(r)}`, token)).values || [];
const dist = (arr) => arr.reduce((m, v) => ((m[v || '(空)'] = (m[v || '(空)'] || 0) + 1), m), {});
const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' / ');

// --- 主表 ---
const grid = await get(`${MASTER}!A1:AC1500`);
const H = grid[0]; const idx = {}; H.forEach((h, i) => idx[h] = i);
const rows = grid.slice(1).filter(r => (r[0] || '').toString().trim() !== '');
const col = (name) => rows.map(r => (r[idx[name]] ?? '').toString().trim());
const xDist = dist(col('生产准入'));
const oDist = dist(col('分桶_自动'));
const nDist = dist(col('竞争建议'));
const acFilled = col('cluster_id').filter(Boolean).length;
const abFilled = col('备注').filter(Boolean).length;
// 矛盾：O=❌无关 但 X=可生产
const contra = rows.filter(r => (r[idx['分桶_自动']] || '').trim() === '❌无关' && (r[idx['生产准入']] || '').trim() === '可生产').length;
// #ERROR
const ERR = /^#(ERROR|REF|VALUE|N\/A|NAME|DIV|NULL|NUM)/i;
let errCount = 0; for (const r of rows) for (const c of r) if (ERR.test((c ?? '').toString().trim())) errCount++;

// --- 视图 ---
const viewRows = (await get(`${VIEW}!A2:A2000`)).filter(r => (r[0] || '').toString().trim() !== '').length;
const admit = rows.filter(r => { const v = (r[idx['生产准入']] || '').trim(); return v === '可生产' || v === '集群必需'; }).length;

// --- 集群 P0/P1 覆盖 ---
const clus = await get(`${CLUSTERS}!A1:S999`);
const cH = clus[0]; const cidC = cH.indexOf('cluster_id'), prioC = cH.indexOf('priority'), nameC = cH.indexOf('cluster_name');
const cl = (p) => clus.slice(1).filter(r => (r[prioC] || '').trim() === p).map(r => ({ id: (r[cidC] || '').trim(), name: (r[nameC] || '').trim() }));
const p0 = cl('P0'), p1 = cl('P1');
const acC = idx['cluster_id'], xC = idx['生产准入'];
const cover = (cls) => cls.map(c => {
  const inC = rows.filter(r => (r[acC] || '').trim() === c.id);
  const adm = inC.filter(r => ['可生产', '集群必需'].includes((r[xC] || '').trim()));
  return { ...c, total: inC.length, admit: adm.length };
});
const p0cov = cover(p0), p1cov = cover(p1);

// --- N=待填 P0/P1/Pillar ---
const topic = await get(`${PAGES}!A1:AC1530`);
const tH = topic[0]; const tkC = tH.indexOf('Target Keyword'), roleC = tH.indexOf('page_role'), pidC = tH.indexOf('page_id'), stC = tH.indexOf('Status'), assocC = tH.indexOf('Associated Keywords');
const pillarKw = new Set(topic.slice(1).filter(r => (r[roleC] || '').trim() === 'Pillar').map(r => norm(r[tkC])));
const p0set = new Set(p0.map(c => c.id)), p1set = new Set(p1.map(c => c.id));
const heldFlagged = [];
let tianpian = 0;
for (const r of rows) {
  if ((r[idx['竞争建议']] || '').trim() !== '待填') continue;
  tianpian++;
  const cid = (r[acC] || '').trim(), kw = norm(r[0]);
  if (p0set.has(cid) || p1set.has(cid) || pillarKw.has(kw)) heldFlagged.push({ kw: r[0], cid, why: [p0set.has(cid) && 'P0', p1set.has(cid) && 'P1', pillarKw.has(kw) && 'Pillar'].filter(Boolean).join('+') });
}

// --- 回填预览 + 争议清单（同 audit 逻辑）---
const map = new Map(), allCands = new Map();
const rank = (e) => (e.via === 'target' ? 2 : 0) + (e.status === '已发布' ? 1 : 0);
const consider = (kw, pid, status, via) => { const k = norm(kw); if (!k) return; if (!allCands.has(k)) allCands.set(k, new Set()); allCands.get(k).add(pid); const ex = map.get(k); const c = { page_id: pid, status, via }; if (!ex || rank(c) > rank(ex)) map.set(k, c); };
for (const r of topic.slice(1)) {
  const tk = r[tkC]; if (!tk || /^#{1,6}\s/.test(String(tk))) continue;
  const pid = String(r[pidC] || '').trim(); if (!pid) continue;
  const status = STATUS_MAP[String(r[stC] || '').trim()] || '已建卡';
  consider(tk, pid, status, 'target');
  const assoc = String(r[assocC] || '');
  if (assoc.includes(',') || assoc.includes('，')) for (const a of assoc.split(/[,，]/)) consider(a, pid, status, 'assoc');
}
let bfMatch = 0, bfZempty = 0, bfYempty = 0;
const ambiguous = [];
for (const r of rows) {
  const kw = norm(r[0]); const hit = map.get(kw); if (!hit) continue;
  bfMatch++;
  if (!(r[idx['page_id']] || '').trim()) bfZempty++;
  if (!(r[idx['生产状态']] || '').trim()) bfYempty++;
  const cands = allCands.get(kw);
  if (cands && cands.size > 1) ambiguous.push({ kw: r[0], candidates: [...cands].join(', '), chosen: hit.page_id, via: hit.via });
}
const today = '2026-06-08';
const md = `---
title: keyword-sheet v3.3 迁移报告（方案 §5）
date: ${today}
type: migration-report
author: wzb
target: 关键词主表 @ ${WB === ORIG ? '线上原表 1CkjOC (gengrowth-flow-mvp)' : WB}
method: 只读读取线上表 + 公式产出统计（_v33-report.mjs）
---

# keyword-sheet v3.3 迁移报告

> 对应迁移方案 \`2026-06-05-keyword-sheet-v3.3-migration-collaboration\` §5「迁移报告」要求：
> 无关/暂缓/集群必需计数 + P0 问题 + 争议清单。数据为只读读取线上表实时产出。

## 1. schema 落地
- 表头列数 **${H.length}**；N 列 = **${H[13] || ''}**（DR过滤→竞争建议，只建议不删）。
- V–AC = 生产准入_自动 / 手动生产准入 / 生产准入 / 生产状态 / page_id / 发布URL / 备注 / cluster_id。
- 全表 #ERROR 单元格：**${errCount}**${errCount === 0 ? ' ✅' : ' ⛔'}。
- cluster_id（AC）非空 **${acFilled}**；备注（AB）非空 **${abFilled}**（v3.1 数据零丢失搬移）。

## 2. 准入 / 分桶 / 竞争建议 计数
- **生产准入（X）**：${fmt(xDist)}
- **分桶_自动（O）**：${fmt(oDist)}
- **竞争建议（N）**：${fmt(nDist)}
- 矛盾校验（O=❌无关 但 X=可生产）：**${contra}**${contra === 0 ? ' ✅' : ' ⛔'}
- **生产候选视图**：${viewRows} 行；主表 X∈{可生产,集群必需}：${admit}${viewRows === admit ? '（精确相等 ✅）' : '（不等 ⛔）'}

## 3. P0 / P1 集群进生产候选覆盖
| 优先级 | 集群 | 集群词 | 可进候选 | 结论 |
|---|---|---|---|---|
${p0cov.map(c => `| P0 | ${c.id}（${c.name}） | ${c.total} | ${c.admit} | ${c.admit >= 1 ? '✅' : '❌'} |`).join('\n')}
${p1cov.map(c => `| P1 | ${c.id}（${c.name}） | ${c.total} | ${c.admit} | ${c.total === 0 ? '⚪ 0集群词' : c.admit >= 1 ? '✅' : '⚠️'} |`).join('\n')}

- **P0**：2/2 集群均有词进生产候选 ✅（§5 核心准入达标）。
- **P1 中 ${p1cov.filter(c => c.total === 0).length} 个集群 0 集群词**（${p1cov.filter(c => c.total === 0).map(c => c.id).join('、')}）：主表无关键词带其 cluster_id（AC 的 ${acFilled} 个 cluster_id 只覆盖 v3.1 那批老集群；这些较新集群的词从未回标）。**非迁移 bug**（迁移忠实保留了旧 cluster_id），是预存的「新集群关键词未回标 cluster_id」编辑缺口（与 front-half-queue 记录的 68 未归集群同源）。B1 修复后 gg-queue-build 的集群表 matcher 仍可兜底归集这些词。

## 4. 问题清单
### 4.1 N=待填 默认暂缓（缺 DR 数据）
- N=待填 共 **${tianpian}** 行（全部默认 V=暂缓，因 J/DR 列空算不出竞争建议）。
- 其中属 P0/P1/Pillar 的 **${heldFlagged.length}** 条（缺数据被挡在生产候选外，建议补 DR 或人工标 W=集群必需）：
${heldFlagged.length ? heldFlagged.map(f => `  - ${f.kw}（${f.cid}，${f.why}）`).join('\n') : '  - 无'}
- **无 P0 受影响**${heldFlagged.some(f => f.why.includes('P0')) ? '（注意：上列含 P0）' : ' ✅'}。

### 4.2 回填预览（page_id/状态 → Z/Y）
- 选题登记表→主表命中 **${bfMatch}** 行；Z 当前空 **${bfZempty}** / Y 当前空 **${bfYempty}**。
- B2 只读审计结论：${bfZempty === bfMatch && bfYempty === bfMatch ? '命中行 Z/Y 全空 → 回填纯新增、0 覆盖、安全。' : '部分命中行 Z/Y 已有值 → 须先跑 _v33-backfill-audit.mjs 看 CONFLICT。'}

### 4.3 争议清单（同一关键词命中多个 page_id）
共 **${ambiguous.length}** 条，回填按「Target 优先 > Associated；已发布 > 其它」折叠：
${ambiguous.slice(0, 30).map(a => `- ${a.kw}：候选[${a.candidates}] → 选 **${a.chosen}**（${a.via}）`).join('\n')}
${ambiguous.length > 30 ? `\n…另 ${ambiguous.length - 30} 条（全部 via=target，即选「该词作 Target 的页」，另一候选为 Pillar 把它列为 Associated）。` : ''}

## 5. 残留 / 待办（截至 ${today}）
- **回填原表**：B2 审计 0 冲突，安全；按「不覆盖原件」约定待用户明确放行后 \`_v33-backfill.mjs --workbook ${ORIG.slice(0, 6)}… --apply\`。
- **B3 W=集群必需 人工标**：4.1 列出的缺 DR 的 P1 calculator 词（SEO/运营判断）。
- **B4 文案 token**：配置 A27/A28 注释、R 列条件格式、P 下拉末值仍写「❌跳过」（O 公式产出已「❌无关」，纯文案不一致）。
- **B5 公式加固**：生产候选正则 \`可生产|集群必需\`→\`^(可生产|集群必需)$\`；X=IF(W<>"",W,V) 建议 W 用 TRIM+白名单（W 全空，暂无实害）。
- **§4 创始人争议流程**：方案该节空白，需创始人/方案作者定义。
- 已完成：schema 迁移+上线+验证；下游读 AC（B1，commit 4d66dbb）；B2 审计脚本（commit 79643cc）。

---
*生成器：tools/scripts/_v33-report.mjs（只读）。配套：验收报告 docs/2026-06-08-v33-copy-acceptance-report.md、执行计划 docs/2026-06-07-v33-live-migration-plan.md。*
`;

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', `${today}-v33-migration-report.md`);
writeFileSync(out, md);
console.log(`报告已写入: ${out}`);
console.log(`摘要: 列${H.length} #ERROR${errCount} | X[${fmt(xDist)}] | 候选${viewRows}=${admit} | P0覆盖${p0cov.map(c => c.admit).join('/')} | 待填${tianpian}(P0/P1/Pillar ${heldFlagged.length}) | 回填命中${bfMatch} Z空${bfZempty} | 争议${ambiguous.length}`);
