#!/usr/bin/env node
// gg-cluster-init.mjs — 主题集群初稿生成器
//
// PRD v0.7 §7.3.2 修法 #4 落地：
//   只从 关键词主表 R 列 = "⚡快速胜利" 或 "📌长尾词" 的行喂入聚类，
//   避免趋势词/战略词污染集群（趋势词应人工精修线、战略词独立做）。
//
// 设计原则（与 SOP v2.5 一致）：
//   - 主题集群表 README 标"人工填" — 本脚本只写自动可推导部分：
//       cluster_id（自动序号 c-001…）
//       cluster_name（核心共词，如 "aura colors"）
//       keywords_included（'\n' 分隔的真实词列表）
//     业务字段（track / jtbd / content_angle / cta / priority / week）留空，人工补
//   - 聚类用 token 共现 + 最长公共词头（jaccard 轻量版），无 mock 无随机
//   - 默认 dry-run，--write 才落 sheet；--rebuild 清空现有数据后重建
//
// 用法：
//   node tools/scripts/gg-cluster-init.mjs --dry-run                     (默认 dry-run)
//   node tools/scripts/gg-cluster-init.mjs --write
//   node tools/scripts/gg-cluster-init.mjs --write --rebuild
//   node tools/scripts/gg-cluster-init.mjs --workbook legacy --dry-run
//   node tools/scripts/gg-cluster-init.mjs --buckets 快速胜利,长尾词 --write
//
// env required:
//   GG_SHEETS_FLOW_MVP_WORKBOOK_ID (default) OR GG_SHEETS_WORKBOOK_ID (legacy)
//   ~/.config/gg/gg-writer-sa.json

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { getAccessToken, gFetch, loadEnv } from './lib/gg-shared.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const arg = (f, def = null) => (has(f) ? argv[argv.indexOf(f) + 1] : def);

const WRITE = has('--write');
const DRY = !WRITE || has('--dry-run');
const REBUILD = has('--rebuild');
const WORKBOOK = arg('--workbook', 'flow-mvp');
const BUCKETS_ARG = arg('--buckets', '快速胜利,长尾词')
  .split(',')
  .map((s) => s.trim());
// Map shorthand → full R 列 value
const BUCKETS = BUCKETS_ARG.map((b) => {
  if (b.includes('快速胜利')) return '⚡快速胜利';
  if (b.includes('长尾')) return '📌长尾词';
  if (b.includes('趋势')) return '🚀趋势词';
  if (b.includes('战略')) return '🎯战略词';
  return b;
});
const MIN_CLUSTER_SIZE = parseInt(arg('--min-size', '2'), 10);
const MAX_CLUSTER_SIZE = parseInt(arg('--max-size', '15'), 10);

if (has('--help') || has('-h')) {
  console.log(`gg-cluster-init.mjs — 主题集群初稿（PRD §7.3.2 修法 #4）

用法:
  --write           落到 sheet（默认 dry-run 只打印）
  --rebuild         清空 主题集群表 现有数据后重建
  --dry-run         强制 dry-run（不写）
  --workbook X      flow-mvp (默认) | legacy | <sheet-id>
  --buckets a,b     喂入桶（默认 "快速胜利,长尾词"，PRD 修法 #4）
  --min-size N      最小集群词数（默认 2）
  --max-size N      最大集群词数（默认 15，超出拆分）
`);
  process.exit(0);
}

// ============================================================
// 1. token + cluster heuristics（无 mock，纯字面分析）
// ============================================================

// 英文 SEO 关键词常见 stopwords（话题无关）
const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'in', 'on', 'to', 'is', 'are',
  'was', 'were', 'be', 'been', 'do', 'does', 'did', 'have', 'has', 'had',
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'that', 'this',
  'these', 'those', 'my', 'your', 'his', 'her', 'its', 'their', 'our',
  'me', 'you', 'him', 'them', 'us', 'i', 'we', 'they', 'it',
  'best', 'top', 'good', 'better', 'free', 'online', 'app', 'apps',
  'guide', 'tutorial', 'tips', 'meaning', 'means', 'mean', 'definition',
  'chart', 'calculator', 'tool', 'list', 'review', 'reviews',
  'vs', 'with', 'without', 'by', 'from', 'about', 'as', 'at',
  'can', 'should', 'will', 'would', 'could',
]);

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length >= 2);
}

// 找最频繁的 unigram + bigram（除停用词），按出现频次倒序
function findClusterSeeds(words) {
  const unigramCount = new Map();
  const bigramCount = new Map();
  for (const w of words) {
    const tokens = tokenize(w);
    for (const t of tokens) unigramCount.set(t, (unigramCount.get(t) || 0) + 1);
    for (let i = 0; i < tokens.length - 1; i++) {
      const bg = `${tokens[i]} ${tokens[i + 1]}`;
      bigramCount.set(bg, (bigramCount.get(bg) || 0) + 1);
    }
  }
  // 优先 bigram（更具体），降序
  const bigramSeeds = [...bigramCount.entries()]
    .filter(([, n]) => n >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1] - a[1])
    .map(([bg]) => bg);
  const unigramSeeds = [...unigramCount.entries()]
    .filter(([, n]) => n >= MIN_CLUSTER_SIZE)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
  return { bigramSeeds, unigramSeeds };
}

// 把每个词分配到第一个匹配的 seed（贪心，优先 bigram）
function assignClusters(words, seeds) {
  const clusters = new Map(); // seed → [words]
  const unassigned = [];

  for (const w of words) {
    const wl = w.toLowerCase();
    let matched = null;
    // 优先 bigram
    for (const seed of seeds.bigramSeeds) {
      if (wl.includes(seed)) { matched = seed; break; }
    }
    // 退而求其次 unigram（用词边界避免 natal→prenatal 误匹）
    if (!matched) {
      for (const seed of seeds.unigramSeeds) {
        const re = new RegExp(`\\b${seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (re.test(wl)) { matched = seed; break; }
      }
    }
    if (matched) {
      if (!clusters.has(matched)) clusters.set(matched, []);
      clusters.get(matched).push(w);
    } else {
      unassigned.push(w);
    }
  }

  return { clusters, unassigned };
}

// 拆分超大集群（>MAX_CLUSTER_SIZE） → 二级 bigram 细分
function splitLargeClusters(clusters) {
  const result = new Map();
  for (const [name, words] of clusters.entries()) {
    if (words.length <= MAX_CLUSTER_SIZE) {
      result.set(name, words);
      continue;
    }
    // 二级 seed
    const sub = findClusterSeeds(words);
    const subSeeds = sub.bigramSeeds.filter((s) => s !== name).slice(0, 6);
    if (!subSeeds.length) {
      // 无法二级分裂，按字母序切块
      for (let i = 0; i < words.length; i += MAX_CLUSTER_SIZE) {
        const chunk = words.slice(i, i + MAX_CLUSTER_SIZE);
        result.set(`${name} (${Math.floor(i / MAX_CLUSTER_SIZE) + 1})`, chunk);
      }
      continue;
    }
    const subAssigned = assignClusters(words, { bigramSeeds: subSeeds, unigramSeeds: [] });
    for (const [subName, subWords] of subAssigned.clusters.entries()) {
      result.set(`${name} / ${subName}`, subWords);
    }
    if (subAssigned.unassigned.length) {
      result.set(`${name} (其它)`, subAssigned.unassigned);
    }
  }
  return result;
}

// ============================================================
// 2. sheet io
// ============================================================

async function fetchValues(token, sid, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  return ((await gFetch(url, token)).values) || [];
}

async function updateValues(token, sid, range, values, valueInputOption = 'RAW') {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

async function clearRange(token, sid, range) {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}:clear`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
  );
}

// ============================================================
// 3. main
// ============================================================

async function main() {
  loadEnv();
  let sid;
  if (WORKBOOK === 'flow-mvp') sid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  else if (WORKBOOK === 'legacy') sid = process.env.GG_SHEETS_WORKBOOK_ID;
  else sid = WORKBOOK;
  if (!sid) {
    console.error(`ERR: workbook "${WORKBOOK}" — set GG_SHEETS_FLOW_MVP_WORKBOOK_ID or pass --workbook <id>`);
    process.exit(2);
  }

  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(sa)) {
    console.error(`ERR: writer SA not found: ${sa}`);
    process.exit(2);
  }
  const { token } = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Workbook: ${WORKBOOK} (${sid.slice(0, 12)}…)`);
  console.log(`Buckets:  ${BUCKETS.join(' / ')}`);
  console.log(`Mode:     ${DRY ? 'DRY-RUN' : 'WRITE'}${REBUILD ? ' + REBUILD' : ''}`);
  console.log('');

  // 1. fetch 关键词主表
  const rows = await fetchValues(token, sid, '关键词主表!A2:R1500');
  console.log(`关键词主表 总行数: ${rows.length}`);
  const eligible = rows.filter((r) => r[0] && BUCKETS.includes(r[17])); // R = col index 17
  console.log(`  ${BUCKETS.join('/')} 桶合格行: ${eligible.length}`);

  if (eligible.length === 0) {
    console.log('\n⚠ 无合格行可聚类。');
    console.log('  这通常意味着关键词主表 I 列（自有站 DR）未填，');
    console.log('  导致 J 列差值=G-I 偏大，N 列 DR 闸门判 ❌跳过，R 列归入 ❌跳过。');
    console.log('  → 按 SOP 在 Ahrefs 查 astrologywiki.com 当前 DR 并填入 I 列，再重跑。');
    console.log('\nDRY-RUN: 无 sheet 写入。');
    process.exit(0);
  }

  // 2. 聚类
  const words = eligible.map((r) => String(r[0]));
  const seeds = findClusterSeeds(words);
  console.log(`\n种子词: bigram=${seeds.bigramSeeds.length} unigram=${seeds.unigramSeeds.length}`);
  const initial = assignClusters(words, seeds);
  const clusters = splitLargeClusters(initial.clusters);
  console.log(`初步集群: ${clusters.size}  未分配: ${initial.unassigned.length}`);

  // 3. 组装主题集群表 row
  const out = [];
  let seq = 1;
  for (const [name, members] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const cluster_id = `c-${String(seq).padStart(3, '0')}`;
    out.push([
      cluster_id,                    // A cluster_id
      name,                          // B cluster_name (auto, 人工可改)
      '',                            // C track (人工)
      '',                            // D content_layer (人工)
      '',                            // E business_role (人工)
      '',                            // F primary_entity (人工)
      '',                            // G jtbd (人工)
      '',                            // H content_angle (人工)
      '',                            // I us_share (人工)
      '',                            // J pillar_page (人工)
      '',                            // K series_pattern (人工)
      members.join('\n'),            // L keywords_included (auto)
      '',                            // M page_assets (人工)
      '',                            // N internal_link_rule (人工)
      '',                            // O cta_primary (人工)
      '',                            // P psych_safety_flag (人工)
      '',                            // Q priority (人工)
      '',                            // R week (人工)
      '',                            // S success_metric (人工)
    ]);
    seq++;
  }
  if (initial.unassigned.length) {
    out.push([
      `c-${String(seq).padStart(3, '0')}`,
      '(未聚类 — 人工分配)',
      '', '', '', '', '', '', '', '', '',
      initial.unassigned.join('\n'),
      '', '', '', '', '', '', '',
    ]);
  }

  // 4. 报告 + 写
  console.log('\n━━━ 集群草稿（按词数倒序前 10）━━━');
  for (const row of out.slice(0, 10)) {
    const memberCount = row[11].split('\n').filter(Boolean).length;
    console.log(`  ${row[0]}  ${String(row[1]).padEnd(28)}  ${String(memberCount).padStart(3)} 词`);
    const preview = row[11].split('\n').slice(0, 3).join(' | ');
    console.log(`         ↳ ${preview}${memberCount > 3 ? ' …' : ''}`);
  }
  if (out.length > 10) console.log(`  ... (+${out.length - 10} more clusters)`);

  if (DRY) {
    console.log('\nDRY-RUN: 无 sheet 写入。加 --write 落盘。');
    return;
  }

  if (REBUILD) {
    console.log('\nREBUILD: 清空 主题集群表!A2:S1500 ...');
    await clearRange(token, sid, '主题集群表!A2:S1500');
  }

  const lastRow = 1 + out.length;
  const range = `主题集群表!A2:S${lastRow}`;
  console.log(`WRITE → ${range} (${out.length} clusters)`);
  await updateValues(token, sid, range, out);
  console.log(`✓ wrote ${out.length} clusters`);
  console.log(`  Open: https://docs.google.com/spreadsheets/d/${sid}/edit`);
}

// 仅在直接 invoke 时跑（保护 import 复用算法函数）
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}

export { tokenize, findClusterSeeds, assignClusters, splitLargeClusters };
