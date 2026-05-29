#!/usr/bin/env node
// gg-queue-build.mjs — 把「桶 × 集群优先级 × 本周产能上限」算成一周的选题队列，
// 写进已有的「选题登记表」(Status=待写)，补上从「研究脑」到「生产后半段」缺的那一刀。
//
// 设计哲学（混合 / 队列驱动，front-half-design 评审胜出方案 C）：
//   - 所有分桶 / 意图 / DR / 集群战略规则继续留在 Google Sheets 公式里（成熟、版本化、可人工改）
//   - 本脚本只做 Sheets 公式做不好的事：跨表 JOIN + 排序 + 产能截断
//   - 它 READS 主表已算好的「分桶」(R 列) 裁决，绝不在代码里重算任何分桶规则
//
// 链路定位：
//   gg-keyword-mine → keyword_candidates （wzb 标 Y）
//     ↓ gg-keyword-promote → 关键词主表 A-I（O/R 列公式当场分桶）
//     ↓ 人在主题集群表设 priority=P0 + week='Week 1'
//   gg-queue-build (本工具) → 选题登记表 Status=待写 的本周队列（A 列 keyword + cluster_id）
//     ↓ 人补 brief 字段（可先 gg-brief-suggest 预填）→ 翻 Status 推进
//   gg-sheet-to-brief → v8 brief override → 后半段（render / LLM / phase2 / publish）
//
// 用法：
//   node tools/scripts/gg-queue-build.mjs --week 'Week 1' --capacity 10            # 默认 dry-run，只打印
//   node tools/scripts/gg-queue-build.mjs --week 'Week 1' --priority P0,P1 --capacity 8
//   node tools/scripts/gg-queue-build.mjs --week 'Week 1' --capacity 10 --write    # 真正写选题登记表
//   node tools/scripts/gg-queue-build.mjs --include-long-tail --capacity 5
//
// 安全保证：
//   1. 默认 dry-run（不写表）；写表必须显式 --write
//   2. 写表只 append 到「选题登记表!A:A」(keyword)，再对新行的 cluster_id / Status 单元格 batchUpdate
//      —— 绝不整行 append（会覆盖 C/D 列 VLOOKUP 公式）
//   3. 去重：已在选题登记表(A 列)出现的 keyword 不再入队
//   4. 只读「分桶」(R 列) 裁决，从不在代码里重算分桶 → 不引入第二套真相
//
// 规范主脑表 = GG_SHEETS_FLOW_MVP_WORKBOOK_ID（1CkjOC，后半段全部读它）。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAccessToken, gFetch, loadEnv, resolveWorkbookId } from './lib/gg-shared.mjs';
import { fetchTab } from './gg-sheet-pull.mjs';
import { buildClusterMap } from './gg-sheet-to-brief.mjs';

export const MASTER_TAB = '关键词主表';
export const CLUSTERS_TAB = '主题集群表';
export const PAGES_TAB = '选题登记表';

// 入队后写进选题登记表 Status 列的值。对齐 .gs v3.1 既有词表
// （待写 / 写作中 / 质检 / 已发布 / 已刷新）——「待写」本身就是队列态，不另造英文状态。
export const QUEUE_STATUS = '待写';

// 桶优先级（数字越小越先出）。趋势词「发现即执行」最高，长尾词兜底最低。
export const BUCKET_RANK = Object.freeze({ 趋势词: 0, 快速胜利: 1, 战略词: 2, 长尾词: 3 });
export const PRIORITY_RANK = Object.freeze({ P0: 0, P1: 1, P2: 2 });

// D1（2026-05-29 决策）：calculator/工具意图词文章页满足不了（用户要"输入生日→输出星盘"的交互工具），
// 默认 park、不入文章队列（留档不丢，等"要不要做计算器页"的产品决策）。
// 高精度标记——宁可漏 park 也不误伤文章词；团队可增删。`--include-tool-intent` 关闭 park。
export const TOOL_INTENT_PATTERNS = Object.freeze([
  /\bcalculator\b/i,
  /\bsynastry report\b/i,
  /\bchart with interpretation\b/i,
  /\bai astrology\b/i,
  /\bastrology ai\b/i,
  /\btest free\b/i,
  /\bquiz\b/i,
]);

// keyword 是否 tool/calculator 意图（文章页满足不了）。
export function isToolIntent(keyword, patterns = TOOL_INTENT_PATTERNS) {
  const s = String(keyword || '').toLowerCase();
  if (!s) return false;
  return patterns.some((re) => re.test(s));
}

// ---------- 纯函数（导出供测试）----------

// 把主表 R 列（分桶，可能带 ★ / emoji / ❌）归一成桶名。
// "快速胜利★" → "快速胜利"；"❌跳过" → "跳过"；"" → ""。
export function normalizeBucket(rCell) {
  const s = String(rCell || '').replace(/[★🚀⚡🎯📌❌\s]/g, '').trim();
  for (const b of ['趋势词', '快速胜利', '战略词', '长尾词', '跳过']) {
    if (s.includes(b)) return b;
  }
  return '';
}

// 该桶是否可生产。跳过 / 未分桶 永远不入队；长尾词默认不入队（量大，需显式 --include-long-tail）。
export function isProducible(bucket, { includeLongTail = false } = {}) {
  if (!bucket || bucket === '跳过') return false;
  if (bucket === '长尾词') return includeLongTail;
  return true; // 趋势词 / 快速胜利 / 战略词
}

// 从主题集群表的 keywords_included 列建 keyword(小写) → cluster_id 精确索引（首个命中胜出）。
// 关键词主表本身没有 cluster_id 列，集群归属唯一的事实源就是集群表这一列。
export function buildKeywordClusterIndex(clusterMap) {
  const idx = new Map();
  for (const [cid, c] of clusterMap) {
    const kws = String(c.keywords_included || '')
      .split(/[,，、\n]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const kw of kws) {
      const k = kw.toLowerCase();
      if (!idx.has(k)) idx.set(k, cid);
    }
  }
  return idx;
}

// keywords_included 实测太稀疏，且常对不上主表实际词串（集群写 "8th house"，主表是
// "8th house astrology"）。所以把 keywords_included + primary_entity 当作集群「种子词」，
// 用子串匹配大幅提覆盖：keyword 含某种子词即归该集群。
// 种子词长度 < 4 跳过（避免 "ic"/"ai" 之类误伤）；多集群命中时按 priority 优先、再取最长（最具体）种子。
export const MIN_SEED_LEN = 4;

export function buildClusterSeeds(clusterMap) {
  const seeds = [];
  for (const [cid, c] of clusterMap) {
    const pr = PRIORITY_RANK[String(c.priority || '').trim()] ?? 9;
    const toks = String(c.keywords_included || '')
      .split(/[,，、\n]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const ent = String(c.primary_entity || '').trim().toLowerCase();
    if (ent) toks.push(ent);
    for (const t of toks) {
      if (t.length < MIN_SEED_LEN) continue;
      seeds.push({ cluster_id: cid, token: t, pr, len: t.length });
    }
  }
  return seeds;
}

// 返回 (keywordLc) => cluster_id | null。子串匹配，priority 优先、种子最长者胜。
export function buildClusterMatcher(clusterMap) {
  const seeds = buildClusterSeeds(clusterMap);
  return (keywordLc) => {
    let best = null;
    for (const s of seeds) {
      if (keywordLc === s.token || keywordLc.includes(s.token)) {
        if (!best || s.pr < best.pr || (s.pr === best.pr && s.len > best.len)) best = s;
      }
    }
    return best ? best.cluster_id : null;
  };
}

// header 名 → 列 index（关键词主表用名字找列，抗列位漂移）。
export function indexMasterHeader(header) {
  const want = {
    关键词: 'keyword',
    月搜索量: 'volume',
    KD: 'kd',
    DR过滤: 'dr_filter',
    分桶: 'bucket',
    弱度意图分: 'u_score',
    内容状态: 'content_status',
    cluster_id: 'cluster_id', // §4.1c：主表 cluster_id 列（人确认的归属），优先于 matcher
  };
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').trim();
    if (want[h] != null && idx[want[h]] == null) idx[want[h]] = i;
  }
  return idx;
}

// 主表行数组 → keyword 对象（只取需要的列）。跳过空 A 列与 section header(## ...)。
export function parseMasterRows(rows) {
  if (!rows || rows.length < 2) return [];
  const idx = indexMasterHeader(rows[0]);
  if (idx.keyword == null || idx.bucket == null) {
    throw new Error(`关键词主表 header 缺列：需要「关键词」+「分桶」，实得 ${rows[0].join(' | ')}`);
  }
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const keyword = String(r[idx.keyword] || '').trim();
    if (!keyword) continue;
    if (/^#{1,6}\s+/.test(keyword)) continue; // section header 行
    out.push({
      keyword,
      volume: idx.volume != null ? Number(String(r[idx.volume] || '').replace(/[^\d.-]/g, '')) || 0 : 0,
      kd: idx.kd != null ? String(r[idx.kd] || '').trim() : '',
      dr_filter: idx.dr_filter != null ? String(r[idx.dr_filter] || '').trim() : '',
      bucket: normalizeBucket(idx.bucket != null ? r[idx.bucket] : ''),
      u_score: idx.u_score != null ? Number(r[idx.u_score]) || 0 : 0,
      content_status: idx.content_status != null ? String(r[idx.content_status] || '').trim() : '',
      cluster_id: idx.cluster_id != null ? String(r[idx.cluster_id] || '').trim() : '',
    });
  }
  return out;
}

// 从选题登记表行收集已存在的 keyword(小写)，用于去重。跳过 section header / 空行。
export function collectExistingKeywords(pageRows) {
  const set = new Set();
  if (!pageRows || pageRows.length < 2) return set;
  for (let i = 1; i < pageRows.length; i++) {
    const a = String((pageRows[i] || [])[0] || '').trim();
    if (!a || /^#{1,6}\s+/.test(a)) continue;
    set.add(a.toLowerCase());
  }
  return set;
}

// 核心：选 + 排 + 截。纯函数，无 I/O。
// master: parseMasterRows 输出；clusterMap: buildClusterMap；
// kwToCluster: 可传 Map（精确）或 (keywordLc)=>cluster_id 函数（子串匹配，main 用后者）。
export function selectQueue({
  master,
  clusterMap,
  kwToCluster,
  existingKeywords = new Set(),
  week = '',
  priorities = ['P0'],
  capacity = 0,
  includeLongTail = false,
  parkToolIntent = true,
}) {
  const clusterOf = typeof kwToCluster === 'function' ? kwToCluster : (lc) => kwToCluster.get(lc);
  const wantPr = new Set(priorities);
  const cand = [];
  const unclustered = [];
  const parked = []; // D1：tool/calculator 意图词留档，不入文章队列
  for (const m of master) {
    if (!isProducible(m.bucket, { includeLongTail })) continue;
    const lc = m.keyword.toLowerCase();
    if (existingKeywords.has(lc)) continue;
    if (parkToolIntent && isToolIntent(m.keyword)) {
      parked.push(m);
      continue;
    }
    // §4.1c 棘轮：主表 cluster_id 列（人确认值）优先，matcher 仅对空白行兜底。
    const cid = m.cluster_id || clusterOf(lc);
    const cluster = cid ? clusterMap.get(cid) : null;
    if (!cid || !cluster) {
      unclustered.push(m);
      continue;
    }
    if (week && String(cluster.week || '').trim() !== week) continue;
    if (!wantPr.has(String(cluster.priority || '').trim())) continue;
    cand.push({ ...m, cluster_id: cid, cluster });
  }
  cand.sort(
    (a, b) =>
      (PRIORITY_RANK[a.cluster.priority] ?? 9) - (PRIORITY_RANK[b.cluster.priority] ?? 9) ||
      (BUCKET_RANK[a.bucket] ?? 9) - (BUCKET_RANK[b.bucket] ?? 9) ||
      (b.volume || 0) - (a.volume || 0) ||
      (b.u_score || 0) - (a.u_score || 0),
  );
  const selected = capacity > 0 ? cand.slice(0, capacity) : cand;
  return { selected, capped: capacity > 0 ? Math.max(0, cand.length - capacity) : 0, unclustered, parked };
}

// 0-indexed 列号 → A1 列字母（0→A, 26→AA）。
export function colLetter(n) {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// header 名 → 0-indexed 列号（选题登记表写入定位）。
export function indexPagesHeader(header) {
  const idx = {};
  for (let i = 0; i < header.length; i++) {
    const h = String(header[i] || '').trim();
    if (idx[h] == null) idx[h] = i;
  }
  return idx;
}

// 从 :append 返回的 updatedRange（如 "选题登记表!A47:A56"）解析起始行号。
export function parseStartRow(updatedRange) {
  const m = /![A-Z]+(\d+)/.exec(String(updatedRange || ''));
  return m ? Number(m[1]) : null;
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// ---------- Sheets I/O ----------
async function appendColumnA(workbookId, rows, token) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(
      `${PAGES_TAB}!A:A`,
    )}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows.map((r) => [r]) }),
    },
  );
}

async function batchUpdateCells(workbookId, data, token) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'RAW', data }),
    },
  );
}

function fmtTable(selected) {
  const lines = [
    '| # | keyword | bucket | vol | cluster_id | priority | week |',
    '|---|---|---|---|---|---|---|',
  ];
  selected.forEach((s, i) => {
    lines.push(
      `| ${i + 1} | ${s.keyword} | ${s.bucket} | ${s.volume} | ${s.cluster_id} | ${s.cluster.priority || ''} | ${s.cluster.week || ''} |`,
    );
  });
  return lines.join('\n');
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`gg-queue-build — 桶 × 集群优先级 × 产能 → 选题登记表本周队列

usage:
  node tools/scripts/gg-queue-build.mjs --week 'Week 1' --capacity 10           # dry-run
  node tools/scripts/gg-queue-build.mjs --week 'Week 1' --priority P0,P1 --capacity 8
  node tools/scripts/gg-queue-build.mjs --week 'Week 1' --capacity 10 --write    # 实际写表

flags:
  --week <str>          只选 cluster.week == 此值的集群（留空=不按周筛）
  --priority <list>     逗号分隔，默认 P0（如 "P0,P1"）
  --capacity <n>        本周最多入队 N 个（0=不截断）
  --include-long-tail   把长尾词也纳入（默认排除）
  --include-tool-intent 把 calculator/工具意图词也入文章队列（默认 park 不入，D1 决策）
  --write               真正写选题登记表（默认 dry-run 只打印）

env: GG_SHEETS_FLOW_MVP_WORKBOOK_ID（规范主脑表）+ writer SA
safety: 默认 dry-run；写表只 append A 列 keyword + batchUpdate cluster_id/Status，不碰公式列
`);
    return 0;
  }

  loadEnv();
  const workbookId = resolveWorkbookId();
  if (!workbookId) {
    console.error('GG_SHEETS_FLOW_MVP_WORKBOOK_ID (或 GG_SHEETS_WORKBOOK_ID) missing in env');
    return 2;
  }
  const doWrite = !!args.write;
  const week = args.week && args.week !== true ? String(args.week).trim() : '';
  const priorities = (args.priority && args.priority !== true ? String(args.priority) : 'P0')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const capacity = Number(args.capacity) || 0;
  const includeLongTail = !!args.include_long_tail;
  const parkToolIntent = !args.include_tool_intent; // D1：默认 park 工具词；显式 --include-tool-intent 关闭

  const writerSa =
    process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (doWrite && !existsSync(writerSa)) {
    console.error(`writer SA not found: ${writerSa}（写表需要 SA）`);
    return 2;
  }

  let token;
  if (existsSync(writerSa)) {
    ({ token } = await getAccessToken(writerSa, ['https://www.googleapis.com/auth/spreadsheets']));
  } else {
    // dry-run 无 SA：退回 OAuth 读 token
    const { getAccessToken: getOauth } = await import('./lib/_oauth-token.mjs');
    token = await getOauth();
  }

  const [masterRaw, clusterRaw, pagesRaw] = await Promise.all([
    fetchTab(workbookId, MASTER_TAB, token),
    fetchTab(workbookId, CLUSTERS_TAB, token),
    fetchTab(workbookId, PAGES_TAB, token),
  ]);

  const master = parseMasterRows(masterRaw);
  const clusterMap = buildClusterMap(clusterRaw);
  const kwToCluster = buildClusterMatcher(clusterMap); // 子串匹配（种子词），比精确索引覆盖高
  const existingKeywords = collectExistingKeywords(pagesRaw);

  const { selected, capped, unclustered, parked } = selectQueue({
    master,
    clusterMap,
    kwToCluster,
    existingKeywords,
    week,
    priorities,
    capacity,
    includeLongTail,
    parkToolIntent,
  });

  process.stderr.write(
    `主表 ${master.length} 词 | 集群 ${clusterMap.size} 个 | 选题登记表已有 ${existingKeywords.size} 词\n` +
      `筛选：week=${week || '(全部)'} priority=${priorities.join(',')} capacity=${capacity || '∞'} long-tail=${includeLongTail} park-tool=${parkToolIntent}\n` +
      `命中 ${selected.length} 词入队${capped ? `（另有 ${capped} 词因产能上限未入）` : ''}${parked.length ? `；park 工具词 ${parked.length} 个` : ''}\n`,
  );

  if (selected.length) {
    process.stdout.write(`\n本周拟入队（${selected.length}）：\n${fmtTable(selected)}\n`);
  } else {
    process.stdout.write('\n本周无可入队的词。检查：集群 priority/week 是否设了？主表是否有该桶的词？\n');
  }

  if (unclustered.length) {
    process.stderr.write(
      `\n⚠️ ${unclustered.length} 个可生产但「未归集群」的词（集群表 keywords_included 里没列到，无法入队）：\n` +
        unclustered.slice(0, 20).map((m) => `   - ${m.keyword} [${m.bucket}]`).join('\n') +
        (unclustered.length > 20 ? `\n   …还有 ${unclustered.length - 20} 个` : '') +
        '\n   → 在主题集群表对应 cluster 的 keywords_included 列补上这些词，下次即可入队。\n',
    );
  }

  if (parked.length) {
    process.stderr.write(
      `\n🅿️ ${parked.length} 个 calculator/工具意图词已 park（D1 决策：文章页满足不了，留档不入队）：\n` +
        parked.slice(0, 20).map((m) => `   - ${m.keyword} [${m.bucket}]`).join('\n') +
        (parked.length > 20 ? `\n   …还有 ${parked.length - 20} 个` : '') +
        '\n   → 这些是"要不要做计算器页"的产品决策素材；要把它们也入文章队列加 --include-tool-intent。\n',
    );
  }

  if (!doWrite) {
    process.stderr.write('\n[dry-run] 未写表。确认无误后加 --write 真正入队。\n');
    return 0;
  }

  if (!selected.length) return 0;

  // 写：先 append A 列 keyword，再对新行 batchUpdate cluster_id / Status。
  const pagesHeader = pagesRaw[0] || [];
  const pIdx = indexPagesHeader(pagesHeader);
  const clusterCol = pIdx.cluster_id;
  const statusCol = pIdx.Status != null ? pIdx.Status : pIdx['内容状态'];

  const appendResp = await appendColumnA(workbookId, selected.map((s) => s.keyword), token);
  const updatedRange = appendResp.updates?.updatedRange;
  const startRow = parseStartRow(updatedRange);
  process.stderr.write(`appended ${selected.length} keyword(s) → ${updatedRange}\n`);

  if (startRow == null) {
    console.error('无法解析 append 返回的起始行，cluster_id/Status 未写。请手动检查选题登记表。');
    return 1;
  }

  const data = [];
  selected.forEach((s, i) => {
    const row = startRow + i;
    if (clusterCol != null) {
      data.push({ range: `${PAGES_TAB}!${colLetter(clusterCol)}${row}`, values: [[s.cluster_id]] });
    }
    if (statusCol != null) {
      data.push({ range: `${PAGES_TAB}!${colLetter(statusCol)}${row}`, values: [[QUEUE_STATUS]] });
    }
  });
  if (data.length) {
    await batchUpdateCells(workbookId, data, token);
    process.stderr.write(`set cluster_id + Status(=${QUEUE_STATUS}) on ${selected.length} new row(s)\n`);
  }

  process.stderr.write(
    '\n✅ 已入队。下一步：在选题登记表补 Tier/Template/Entity/Friction/Logic/page_role（可先 gg-brief-suggest 预填），逐行翻 Status 推进。\n',
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      console.error('fatal:', e.message);
      process.exit(1);
    });
}

export { main };
