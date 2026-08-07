#!/usr/bin/env node
// _gengrowth-0807-fill-brief.mjs — 为 2026-08-07 批次的 4 篇补齐 gengrowth workbook 的两处配置：
//   1. CTA Map: append 4 行「免费工具页」CTA（目前表里只有 app/pricing/features/use-cases，
//      没有任何 /tools/* 行，所以主题集群表 cta_primary 指定的「免费工具·内链审计」等根本无法
//      被 cta-selector 选中，只能落到 cta_gengrowth_app 通配兜底）。
//   2. 选题登记表 第 70/71/73/74 行: 只填【空单元格】，绝不覆盖已有值
//      （Tier / page_id / cluster_id / page_role 表里已填对，脚本不碰）。
//
// 数据来源（全部真实，无占位）：
//   · 月搜索量 / KD  ← 主题集群表 keywords_included 列
//   · content_angle ← 主题集群表 content_angle 列（逐字）
//   · Friction / Logic ← 2026-08-07 实拉的 SERP top-N（.gg-cache/serp/<page_id>.json）
//
// 默认 dry-run。加 --write 才真正写。幂等：CTA 行按 cta_id 去重；单元格非空则跳过。
import { getAccessToken, loadEnv } from '../lib/gg-shared.mjs';
import { join } from 'node:path';
import { homedir } from 'node:os';
loadEnv();

const WB = '1RRxsyFmdWgtd6tojjze_8lxwSUTTZKm4TqU4gZTIRA8'; // gengrowth.ai workbook
const TAB_BRIEF = '选题登记表';
const TAB_CTA = 'CTA Map';
const WRITE = process.argv.includes('--write');
const SCOPE = ['https://www.googleapis.com/auth/spreadsheets'];
const SA = join(homedir(), '.config', 'gg', 'gg-writer-sa.json');

// ── CTA Map 新增行（列序 = 表头 12 列） ──────────────────────────────────────
// cta_kind 必须避开 cta-selector 的 DISALLOWED_KINDS(blog/external/navigation)；
// target_url 的 host 必须是 gengrowth.ai（site-profile.siteCtaHost）。
// 三个 /tools/* 路径已于 2026-08-07 线上核验 HTTP 200。
const CTA_ROWS = [
  ['cta_tool_keyword_map', 'Tool', 'Open the Free Keyword Opportunity Map',
    'https://gengrowth.ai/tools/hidden-keywords', 'tool_click', '精修线',
    'Free keyword opportunity map for finding low-competition and zero-volume keywords.',
    'tool', 'low hanging fruit keywords;zero search volume keywords;zero volume keywords;keyword opportunity;low competition keywords',
    'TRUE', '20', 'keyword-research'],
  ['cta_tool_quick_wins', 'Tool', 'Run a Free SEO Quick Wins Check',
    'https://gengrowth.ai/tools/seo-quick-wins', 'tool_click', '精修线',
    'Free SEO quick-wins check that surfaces striking-distance queries from search performance data.',
    'tool', 'striking distance keywords;seo quick wins;average position;search console impressions',
    'TRUE', '20', 'search-diagnosis'],
  ['cta_tool_traffic_drop', 'Tool', 'Diagnose a Traffic Drop for Free',
    'https://gengrowth.ai/tools/traffic-drop-diagnosis', 'tool_click', '精修线',
    'Free traffic-drop diagnosis for core-update and ranking-loss investigations.',
    'tool', 'traffic drop;core update;organic traffic drop;ranking drop',
    'TRUE', '20', 'search-diagnosis'],
  ['cta_tool_link_audit', 'Tool', 'Run a Free Internal Link Audit',
    'https://gengrowth.ai/tools/internal-link-audit', 'tool_click', '精修线',
    'Free internal link audit that maps link equity, orphan pages and crawl depth.',
    'tool', 'pagerank sculpting;internal link;link equity;orphan pages;crawl depth;nofollow',
    'TRUE', '20', 'internal-linking'],
];

// ── 选题登记表 逐行补空（key = 表头列名） ───────────────────────────────────
const BRIEF_FILL = {
  70: { // PG-SPD-001 striking distance keywords — T1 Pillar
    'Associated Keywords': 'striking distance keywords seo, striking distance report, position 11-20 keywords, quick win keywords search console',
    '月搜索量': '1300',
    'KD': '12',
    'Intent': 'Informational',
    'Template': 'Guide',
    'Entity': 'Striking Distance Keywords / Average Position',
    'Friction': 'SEO owners treat "striking distance" as one fixed position band and re-optimize whatever the tool lists, because every guide names a different range (5-20, 11-20, page 2) and none explains that Search Console average position is impression-weighted, so a keyword can look stuck at 12 while already ranking 6 for the queries that matter.',
    'Logic': 'SERP returns definition-plus-method posts (Clutch, SEOGets, RankDraft, RicketyRoo, Intrepid Digital) that all converge on the same three steps — pull GSC, filter a position band, refresh the page. None of them warns that the position column they filter on is an impression-weighted average, so the band itself is unreliable before it is segmented by query and country.',
    'CTA': 'cta_tool_quick_wins',
    'content_angle': 'Diagnosis from your own GSC data with the statistical traps named out loud — including the impression-weighted vs simple-average position trap we fell into ourselves',
    'psych_safety_flag': 'N',
    'target_keyword_zh': '临界距离关键词',
    'author': 'Alex Chen',
  },
  71: { // PG-KOD-001 how to find low hanging fruit keywords — T1 Pillar
    'Associated Keywords': 'low hanging fruit keywords, easy keywords to rank for, low competition keywords, low keyword difficulty seo',
    '月搜索量': '1300',
    'KD': '4',
    'Intent': 'Informational',
    'Template': 'Guide',
    'Entity': 'Low Hanging Fruit Keywords / Keyword Difficulty',
    'Friction': 'Site owners equate a low keyword-difficulty score with a winnable SERP, because every guide teaches the same filter-by-KD workflow and none of them tells you the score is a backlink model that never looked at who is actually ranking on page one.',
    'Logic': 'SERP returns six near-identical method posts (SEOptimer, TripleDart, Terra, SmartClick, TalkToTarget, Duo Collective) that all reduce to: open GSC, filter by a difficulty score in Ahrefs or Semrush, pick long-tail. Every one of them stops at the score. None opens the SERP to check whether the ten pages already ranking are forums, aggregators, or DR-80 publishers — which is the only thing that decides whether the score is meaningful.',
    'CTA': 'cta_tool_keyword_map',
    'content_angle': 'Keyword selection judged by who actually ranks on the SERP, not by the difficulty score the tool prints — including the 53 candidate words we picked that all turned out to have zero volume',
    'psych_safety_flag': 'N',
    'target_keyword_zh': '如何找低垂果实关键词',
    'author': 'Alex Chen',
  },
  73: { // PG-KOD-002 zero search volume keywords — T2 Series
    'Associated Keywords': 'zero volume keywords, low search volume keywords, zero search volume keywords seo, keywords with no search volume',
    '月搜索量': '110',
    'KD': '14',
    'Intent': 'Informational',
    'Template': 'Guide',
    'Entity': 'Zero Search Volume Keywords / Search Volume Validation',
    'Friction': 'Writers hear "zero volume keywords still convert" and take it as blanket permission to publish anything the tool reports as 0, because the advice posts argue the upside without ever giving a test that separates a genuinely under-reported query from a phrase nobody searches.',
    'Logic': 'SERP is split between advocacy (Search Engine Journal, LowFruits, First Place SEO — zero-volume is an untapped opportunity) and caution (SUSO asks "hidden gems or dead ends", Niche Site Project asks "when NOT to"), but neither side hands the reader a decision procedure. The unanswered question is not whether to target them, it is how to tell the two kinds apart before writing.',
    'CTA': 'cta_tool_keyword_map',
    'content_angle': 'Keyword selection judged by who actually ranks on the SERP, not by the difficulty score the tool prints — including the 53 candidate words we picked that all turned out to have zero volume',
    'psych_safety_flag': 'N',
    'target_keyword_zh': '零搜索量关键词',
    'author': 'Alex Chen',
  },
  74: { // PG-ILA-001 pagerank sculpting — T2 Support
    'Associated Keywords': 'pagerank sculpting seo, link equity, nofollow internal links, internal link sculpting',
    '月搜索量': '720',
    'KD': '14',
    'Intent': 'Informational',
    'Template': 'Guide',
    'Entity': 'PageRank Sculpting / Link Equity',
    'Friction': 'Site owners still reach for nofollow to steer link equity because the technique is documented everywhere as a named tactic, while the one thing that settles it — Google changed nofollow handling in 2009 so the withheld share evaporates instead of being redistributed — sits in a single 2009 blog post most guides only cite in passing.',
    'Logic': 'SERP mixes a 2009 primary source (Matt Cutts, plus Search Engine Land reporting it) with 2024-2026 guides (ClickRank, Alli AI, linkbuildingbogen) that re-explain the same history and then hedge on what to do now. Only ohgm pushes past the doctrine. Nothing on the SERP converts the settled answer into the audit a site owner can actually run — which pages are orphaned, which are buried past crawl depth 3, which links are wasted.',
    'CTA': 'cta_tool_link_audit',
    'content_angle': 'Whether a 2009-era tactic still works, answered with a real audit of our own site — where 62% of articles turned out to be orphans and 168 had broken CTA links',
    'psych_safety_flag': 'N',
    'target_keyword_zh': 'PageRank 雕刻',
    'author': 'Alex Chen',
  },
};

async function greq(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${b.error?.message || res.statusText}`);
  return b;
}
async function readTab(wb, token, tab) {
  const r = encodeURIComponent(`${tab}!A1:AZ2000`);
  return (await greq(`https://sheets.googleapis.com/v4/spreadsheets/${wb}/values/${r}?majorDimension=ROWS`, token)).values || [];
}
function colLetter(idx) { // 0 → A
  let s = '', n = idx;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

const { token } = await getAccessToken(SA, SCOPE);

// ── 1. CTA Map ──────────────────────────────────────────────────────────────
const cta = await readTab(WB, token, TAB_CTA);
const ctaHeader = cta[0] || [];
const ctaIdCol = ctaHeader.findIndex((h) => /^cta_id$/i.test(String(h).trim()));
if (ctaIdCol < 0) { console.error('CTA Map 无 cta_id 列，abort'); process.exit(1); }
if (ctaHeader.length !== CTA_ROWS[0].length) {
  console.error(`CTA Map 表头 ${ctaHeader.length} 列，脚本准备了 ${CTA_ROWS[0].length} 列 — 列数不符，abort`);
  console.error(`表头: ${ctaHeader.join(' | ')}`);
  process.exit(1);
}
const existingIds = new Set(cta.slice(1).map((r) => String(r[ctaIdCol] || '').trim()).filter(Boolean));
const ctaToAdd = CTA_ROWS.filter((r) => !existingIds.has(r[0]));
console.log(`\n=== CTA Map ===`);
console.log(`表头 ${ctaHeader.length} 列，现有 ${existingIds.size} 个 cta_id`);
for (const r of CTA_ROWS) {
  console.log(`  ${existingIds.has(r[0]) ? '跳过(已存在)' : '待 append '} ${r[0]}  →  ${r[3]}`);
}

// ── 2. 选题登记表 ────────────────────────────────────────────────────────────
const brief = await readTab(WB, token, TAB_BRIEF);
const bHeader = brief[0] || [];
const colOf = {};
bHeader.forEach((h, i) => { colOf[String(h).trim()] = i; });

const updates = [];
console.log(`\n=== 选题登记表 ===`);
for (const [rowNumStr, fills] of Object.entries(BRIEF_FILL)) {
  const rowNum = Number(rowNumStr);
  const row = brief[rowNum - 1] || [];
  const kw = String(row[colOf['Target Keyword']] ?? '').trim();
  const pid = String(row[colOf['page_id']] ?? '').trim();
  console.log(`\n  行 ${rowNum}: ${pid} "${kw}"`);
  for (const [field, value] of Object.entries(fills)) {
    const c = colOf[field];
    if (c === undefined) { console.log(`    ⚠️  表头无 "${field}" 列 — 跳过`); continue; }
    const cur = String(row[c] ?? '').trim();
    if (cur) { console.log(`    跳过 ${field}（已有值: ${cur.slice(0, 40)}）`); continue; }
    const a1 = `${TAB_BRIEF}!${colLetter(c)}${rowNum}`;
    updates.push({ range: a1, values: [[value]] });
    console.log(`    填 ${field} @ ${colLetter(c)}${rowNum} = ${String(value).slice(0, 60)}${String(value).length > 60 ? '…' : ''}`);
  }
}

console.log(`\n──────────────────────────────────────`);
console.log(`CTA Map append: ${ctaToAdd.length} 行`);
console.log(`选题登记表 填空: ${updates.length} 个单元格`);

if (!WRITE) { console.log(`\n[DRY-RUN] 加 --write 才真正写入。`); process.exit(0); }

if (ctaToAdd.length) {
  const res = await greq(
    `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values/${encodeURIComponent(TAB_CTA + '!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    token,
    { method: 'POST', body: JSON.stringify({ values: ctaToAdd }) },
  );
  console.log(`✅ CTA Map appended: ${res.updates?.updatedRange} (${res.updates?.updatedRows} 行)`);
}
if (updates.length) {
  const res = await greq(
    `https://sheets.googleapis.com/v4/spreadsheets/${WB}/values:batchUpdate`,
    token,
    { method: 'POST', body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates }) },
  );
  console.log(`✅ 选题登记表 updated: ${res.totalUpdatedCells} 个单元格`);
}
