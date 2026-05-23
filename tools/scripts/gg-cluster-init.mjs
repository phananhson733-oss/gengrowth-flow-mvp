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

// 修补#3：cluster_name 美化用的次级 stopword（参与 tokenize 但命名时跳过）
const NAMING_NOISE = new Set([
  'calculator', 'chart', 'meaning', 'mean', 'definition', 'sign',
  'free', 'online', 'best', 'top', 'guide', 'tool', 'app',
]);

// 修补#3：brand token 识别（用作命名前缀，便于人工识别）
const BRAND_PATTERNS = [
  { pattern: /astro[\s-]?seek/i, brand: 'astro-seek' },
  { pattern: /\bcafe astrology\b/i, brand: 'cafe-astrology' },
  { pattern: /\bco[\s-]?star\b/i, brand: 'co-star' },
  { pattern: /\bchani\b/i, brand: 'chani' },
  { pattern: /\bthe pattern\b/i, brand: 'the-pattern' },
  { pattern: /\bastro\.com\b/i, brand: 'astro.com' },
  { pattern: /\bastrosage\b/i, brand: 'astrosage' },
];

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t) && t.length >= 2);
}

// 修补#3：cluster name 美化
//   1. 若任一成员命中 brand pattern，加 [brand:X] 前缀
//   2. 在 cluster 内重新跑 trigram，若有 trigram 覆盖 ≥40% 成员，用 trigram 替代 raw seed
//   3. 剥离命名层 noise（calculator/chart/meaning…）
function prettifyClusterName(rawSeed, members) {
  if (!members || !members.length) return rawSeed;

  // brand 检测
  let brand = null;
  for (const { pattern, brand: b } of BRAND_PATTERNS) {
    if (members.some((m) => pattern.test(m))) { brand = b; break; }
  }

  // trigram 优选
  const trigramCount = new Map();
  for (const w of members) {
    const tokens = tokenize(w);
    for (let i = 0; i < tokens.length - 2; i++) {
      const tg = `${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`;
      trigramCount.set(tg, (trigramCount.get(tg) || 0) + 1);
    }
  }
  const minCoverage = Math.max(2, Math.ceil(members.length * 0.4));
  const topTrigram = [...trigramCount.entries()]
    .filter(([, n]) => n >= minCoverage)
    .sort((a, b) => b[1] - a[1])[0];

  let name = topTrigram ? topTrigram[0] : rawSeed;

  // 剥离 NAMING_NOISE token（仅当剥离后仍 ≥1 实义 token）
  const stripped = name
    .split(/\s+/)
    .filter((t) => !NAMING_NOISE.has(t.toLowerCase()))
    .join(' ');
  if (stripped && stripped.split(/\s+/).length >= 1) name = stripped;

  return brand ? `[${brand}] ${name}` : name;
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

// 修补#2：扫所有 bigram seed 找匹配，选最长（最具体）的。
// 全无 bigram 匹配才 fallback unigram（词边界匹配，避免 natal→prenatal 误判）。
// 防止母词虹吸：避免 astrology 这种高频短词把 north node / square / house 等子主题词全吃掉。
function assignClusters(words, seeds) {
  const clusters = new Map();
  const unassigned = [];

  for (const w of words) {
    const wl = w.toLowerCase();
    // bigram 最长匹配
    let bestBigram = null;
    for (const seed of seeds.bigramSeeds) {
      if (wl.includes(seed)) {
        if (!bestBigram || seed.length > bestBigram.length) bestBigram = seed;
      }
    }
    if (bestBigram) {
      if (!clusters.has(bestBigram)) clusters.set(bestBigram, []);
      clusters.get(bestBigram).push(w);
      continue;
    }
    // fallback: unigram 词边界匹配（first-match-wins，按 freq 倒序即可）
    let matched = null;
    for (const seed of seeds.unigramSeeds) {
      const re = new RegExp(`\\b${seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (re.test(wl)) { matched = seed; break; }
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
    // 修补#1：子桶 size < MIN_CLUSTER_SIZE 全部回流到 "(其它)" 兜底桶，不独立成集群。
    // 防止二级分裂时 freq=1 的 bigram 配贪心匹配产生 1 词桶（c-064~c-088 的根因）。
    const overflow = [...subAssigned.unassigned];
    for (const [subName, subWords] of subAssigned.clusters.entries()) {
      if (subWords.length >= MIN_CLUSTER_SIZE) {
        result.set(`${name} / ${subName}`, subWords);
      } else {
        overflow.push(...subWords);
      }
    }
    if (overflow.length) {
      result.set(`${name} (其它)`, overflow);
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

  // 修补#1（一级补强）：一级集群 size < MIN_CLUSTER_SIZE 也回流到 unassigned 兜底，
  // 不让 "find"/"ic"/"white" 这种 freq=2 的 unigram fallback 产生 1-2 词僵尸集群。
  const oneLevelOverflow = [];
  for (const [name, mem] of [...initial.clusters.entries()]) {
    if (mem.length < MIN_CLUSTER_SIZE) {
      oneLevelOverflow.push(...mem);
      initial.clusters.delete(name);
    }
  }
  if (oneLevelOverflow.length) initial.unassigned.push(...oneLevelOverflow);

  const clusters = splitLargeClusters(initial.clusters);
  console.log(`初步集群: ${clusters.size}  未分配: ${initial.unassigned.length}`);

  // 3. 组装主题集群表 row
  const out = [];
  let seq = 1;
  for (const [name, members] of [...clusters.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const cluster_id = `c-${String(seq).padStart(3, '0')}`;
    // 修补#3：用 prettifyClusterName 美化 raw seed → brand 前缀 / trigram 替代 / 剥 noise
    const prettyName = prettifyClusterName(name, members);
    out.push([
      cluster_id,                    // A cluster_id
      prettyName,                    // B cluster_name (auto-prettified, 人工可改)
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

export { tokenize, findClusterSeeds, assignClusters, splitLargeClusters, prettifyClusterName };
