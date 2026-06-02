#!/usr/bin/env node
// gg-md-to-oracle-ts.mjs — convert a flow-mvp staging .md (+ optional manifest)
// into an oracle data/articles/<slug>.ts file matching the WikiArticle shape.
//
// Single-file usage:
//   node tools/scripts/gg-md-to-oracle-ts.mjs \
//     --source _staging/page_blue_aura_meaning-claude-v8.md \
//     --slug blue-aura-meaning \
//     --out /Users/wzb/Code/oracle/data/articles/blue-aura-meaning.ts
//
// Batch usage (6 page_ids × default Claude winner):
//   node tools/scripts/gg-md-to-oracle-ts.mjs --batch \
//     --winner-llm claude --version v8 \
//     --oracle-articles-dir /Users/wzb/Code/oracle/data/articles
//
// Mixed-winner batch (some pages claude, others codex):
//   node tools/scripts/gg-md-to-oracle-ts.mjs --batch \
//     --winner-llm claude --version v8 \
//     --pages "page_orange_aura_meaning page_chakra_system_overview" \
//     --winner-map "page_chakra_system_overview:codex"
//
// Body transforms applied (in order):
//   1. Resolve `[[<TBD-internal-link: X>]]` via TBD_LINK_MAP:
//      matched → `[X](/en/wiki/<slug>)` real markdown link
//      unmatched → `*X*` italic placeholder (visually flags TBD without
//                  faking a clickable link to nowhere)
//   2. Auto-link bare http(s) URLs (not already inside `]( ... )`)
//      → `[url](url)` so React-markdown renders an <a>
//   3. Trim trailing whitespace
//   4. Escape backticks + `${` for safe embedding in TS template literal
//
// Description: first ~160 chars of first paragraph after first ## section.
// Keywords: target_keyword as first item, then associated_keywords.
// Lang: 'en' (our articles are EN-only).
// Author: 'AstrologyWiki Team' (matches existing oracle convention).

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidAuthorId, normalizeAuthorId } from './lib/author-routing.mjs';
import { loadPersona } from './lib/author-personas/loader.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_REPO = join(__dirname, '..', '..');

// Resolve author identity for publish metadata (Lane B / T10) via loadPersona —
// the single source of truth for persona cards (replaces a hand-rolled frontmatter
// parser that drifted from the loader). Returns { id, displayName, slug, shortBio }
// or null if the id is absent/invalid or the card fails the loader's validation.
// authorId comes from the staging md frontmatter `author_id` field (written by
// content-draft's buildAuthorFrontmatter / _phase2-validate); legacy `author` is
// accepted at the call site. The value may be JSON-quoted ("marcus-orion") and
// parseFrontmatter does not strip quotes, so normalize them before validating.
export function resolveAuthorMeta(authorId) {
  const raw = typeof authorId === 'string' ? authorId.replace(/^["']|["']$/g, '').trim() : authorId;
  if (!raw || !isValidAuthorId(raw)) return null;
  const id = normalizeAuthorId(raw);
  try {
    const p = loadPersona(id);
    // short bio: prefer the credential capsule field, else primary focus.
    return { id, displayName: p.displayName, slug: id, shortBio: p.capsule.credential || p.primaryFocus || '' };
  } catch {
    return null;
  }
}

export const DEFAULT_PAGES = [
  'page_aura_colors_pillar',
  'page_blue_aura_meaning',
  'page_yellow_aura_meaning',
  'page_purple_aura_meaning',
  'page_white_aura_meaning',
  'page_red_aura_meaning',
];

export function pageIdToSlug(pageId) {
  return pageId.replace(/^page_/, '').replace(/_/g, '-');
}

// Leading ordinal tokens (8th-house-meaning → eighth…) must be spelled out:
// a JS identifier cannot start with a digit, so "8thHouseMeaningEn" is a syntax
// error that breaks the oracle build. Covers the 12 astrological houses.
const ORDINAL_WORDS = Object.freeze({
  '1st': 'first', '2nd': 'second', '3rd': 'third', '4th': 'fourth',
  '5th': 'fifth', '6th': 'sixth', '7th': 'seventh', '8th': 'eighth',
  '9th': 'ninth', '10th': 'tenth', '11th': 'eleventh', '12th': 'twelfth',
});

export function slugToCamel(slug, suffix = 'En') {
  const parts = slug.split('-');
  if (parts.length && ORDINAL_WORDS[parts[0]]) parts[0] = ORDINAL_WORDS[parts[0]];
  let camel = parts
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join('');
  // Fallback: any other leading digit → prefix so the identifier stays valid.
  if (/^[0-9]/.test(camel)) camel = `n${camel}`;
  return camel + suffix;
}

export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error('no YAML frontmatter found');
  const fm = {};
  const lines = m[1].split('\n');
  let currentKey = null;
  for (const line of lines) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2];
      fm[currentKey] = val === '' ? [] : val;
    } else {
      const item = line.match(/^\s+-\s+(.+)$/);
      if (item && Array.isArray(fm[currentKey])) {
        fm[currentKey].push(item[1].trim());
      }
    }
  }
  return { frontmatter: fm, body: m[2] };
}

export function deriveDescription(body, maxLen = 160) {
  const lines = body.split('\n');
  let started = false;
  let para = '';
  for (const line of lines) {
    const t = line.trim();
    // Begin after the first ## section, then keep scanning across later ##
    // sections until a real prose paragraph is found. A section may be
    // table-only (e.g. a "Key Dates at a Glance" markdown table) — its pipe
    // rows must never leak into the description.
    if (/^##\s+/.test(line)) { started = true; continue; }
    if (!started) continue;
    if (t === '') { if (para) break; else continue; }
    if (/^#{1,6}\s/.test(line)) continue;          // sub-heading: skip
    if (/^\|/.test(t) || /^[-:|\s]+$/.test(t)) {    // markdown table row / separator
      if (para) break;                              // prose already collected → end
      continue;                                     // table before any prose → skip past it
    }
    para += (para ? ' ' : '') + t;
  }
  let cleaned = para
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g, '$1')
    .replace(/\[\[<\s*TBD-external-link:[^|>]*\|\s*([^|>]+?)\s*\|[^>]*>\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLen) {
    // Clean truncation — never emit a trailing "..." (reads as broken to users
    // and Google). Prefer ending on a full sentence at/under maxLen; otherwise
    // cut at a word boundary and strip any dangling CJK/ASCII pause punctuation.
    const window = cleaned.slice(0, maxLen);
    const sentEnd = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
    );
    if (sentEnd >= 80) {
      cleaned = cleaned.slice(0, sentEnd + 1).trim();
    } else {
      cleaned = window.replace(/\s+\S*$/, '').replace(/[，、；,;:\s]+$/u, '').trim();
    }
  }
  return cleaned;
}

// Lookup table for resolving TBD wikilink descriptions to real oracle URLs.
// First matching rule wins. Description matching is case-insensitive
// substring/regex. Patterns are intentionally narrow to avoid mis-routing.
// Anything unmatched falls through to an italic placeholder (no fake link).
export const TBD_LINK_RULES = [
  // --- 6/2 EMPATH/HSP cluster (highly-sensitive-person pillar + signs / vs-autism
  // / famous spokes). Specific spokes MUST precede the general pillar rule
  // (first-match-wins) so "HSP vs autism" / "signs of a HSP" route to their own
  // spoke. 12th-house + inner-wound (EN) bridges resolve via existing rules below;
  // the pillar rule matches ONLY explicit "pillar/trait/overview" phrasing so a
  // bare "highly sensitive person" in the pillar's own body never self-links. ---
  { match: /high(ly)?\s+sensitiv\w*\s+(person|people).{0,24}\bautism\b|high\s+sensitivity\s+(vs\.?|versus|and)\s+autism|\bhsp\b\s+(vs\.?|versus|and)\s+autism/i, href: '/en/wiki/highly-sensitive-person-vs-autism' },
  { match: /signs?\s+of\s+(a\s+)?high(ly)?\s+sensitiv\w*|signs?\s+of\s+high\s+sensitivity|high(ly)?\s+sensitive\s+person\s+(signs|checklist)/i, href: '/en/wiki/signs-of-a-highly-sensitive-person' },
  { match: /famous\s+high(ly)?\s+sensitiv\w*\s+(people|person|figures)|celebrit\w+\s+who\s+are\s+high(ly)?\s+sensitiv/i, href: '/en/wiki/famous-highly-sensitive-people' },
  { match: /pillar\s+guide\s+to\s+the\s+high(ly)?\s+sensitiv\w*|high(ly)?\s+sensitive\s+person\s+(trait|pillar|overview|guide)|guide\s+to\s+the\s+highly\s+sensitive\s+person\b/i, href: '/en/wiki/highly-sensitive-person' },
  { match: /高敏感.{0,8}自闭|敏感.{0,4}自闭症/, href: '/en/wiki/highly-sensitive-person-vs-autism' },
  { match: /高敏感.{0,8}(自查|信号|迹象|清单)|(自查|典型信号).{0,4}清单/, href: '/en/wiki/signs-of-a-highly-sensitive-person' },
  { match: /(名人|公众人物).{0,8}高敏感|高敏感.{0,8}名人(案例)?/, href: '/en/wiki/famous-highly-sensitive-people' },
  { match: /高敏感(人群)?(特质)?(总览|概览|pillar)|高敏感人群特质总览/, href: '/en/wiki/highly-sensitive-person' },
  { match: /(疗愈|安放|理解|安顿).{0,4}内在.{0,3}创伤|内在情绪创伤/, href: '/en/wiki/healing-your-inner-wound' },
  // --- 5/30 cluster (healing_placements pillar+spokes, saturn-in-pisces transit,
  // persephone-goddess myth). Placed FIRST so "Chiron/Mars in the 12th house" and
  // "Saturn in Pisces" win over the broad 12th-house / pisces rules further down
  // (first-match-wins). All target slugs ship in this same batch. ---
  // healing_placements (EN) — chiron/mars-12th must precede the generic 12th-house rule
  { match: /\bchiron\b/i, href: '/en/wiki/chiron-in-12th-house' },
  { match: /\bmars\s+in\s+(the\s+)?(12th|twelfth)\s+house\b/i, href: '/en/wiki/mars-in-12th-house' },
  { match: /\b(healing\s+your\s+inner\s+wound|inner\s+wound)\b/i, href: '/en/wiki/healing-your-inner-wound' },
  // transit + myth (EN) — saturn-in-pisces must precede the broad /\bpisces\b/ rule
  { match: /\bsaturn\s+in\s+pisces\b/i, href: '/en/wiki/saturn-in-pisces' },
  { match: /\bpersephone\b/i, href: '/en/wiki/persephone-goddess' },
  // healing_placements + transit + myth (ZH) — must precede 第十二宫 / 宫 / 双鱼
  { match: /凯龙/, href: '/en/wiki/chiron-in-12th-house' },
  { match: /火星.{0,5}(十二宫|12\s*宫)/, href: '/en/wiki/mars-in-12th-house' },
  { match: /内在伤口/, href: '/en/wiki/healing-your-inner-wound' },
  { match: /土星.{0,5}双鱼/, href: '/en/wiki/saturn-in-pisces' },
  { match: /(珀耳塞福涅|珀尔塞福涅|佩瑟芬)/, href: '/en/wiki/persephone-goddess' },
  // --- 6/1 transit cluster (transits pillar + natal-chart-transits spoke). MUST
  // precede the broad /(natal|birth) chart/ rule (line ~255) so "natal chart
  // transits" routes to its own spoke, not the birth-chart fundamentals page.
  // natal-chart-transits (specific) precedes the pillar rule. Single-planet
  // "<planet> transit" links have NO page yet — deliberately NOT matched here so
  // they fall through to the planet→house fallback (line ~264) or an italic TBD
  // placeholder, rather than self-linking the pillar. Only EXPLICIT pillar
  // references route to /transits. ---
  { match: /\b(natal|birth)\s+chart\s+transits?\b|\btransits?\s+to\s+(your|the|a|one'?s)\s+(natal|birth)\s+chart\b|\btransit[-\s]to[-\s]natal\s+contacts?\b/i, href: '/en/wiki/natal-chart-transits' },
  { match: /\bastrological\s+transits?\b|\bplanetary\s+transits?\b|\b(pillar\s+guide\s+to\s+|guide\s+to\s+)?transits?\s+(pillar|hub|overview|guide|101|explained)\b|\bpillar\s+guide\s+to\s+(astrological\s+)?transits?\b/i, href: '/en/wiki/transits' },
  // transit cluster (ZH) — 本命盘行运 (specific) before pillar; single-planet
  // 「X行运」 deliberately unmatched (no spoke yet → house fallback or italic).
  { match: /本命盘?.{0,3}行运|出生盘.{0,3}行运|行运.{0,3}本命/, href: '/en/wiki/natal-chart-transits' },
  { match: /占星行运(总览|概览|入门|pillar)|行运(总览|概览|入门|pillar)|行运总览/, href: '/en/wiki/transits' },
  // --- 5/29 cluster (chakra spokes + astrology-terms glossary + aspect/angle
  // spokes). Placed FIRST so specific spokes win over the broad /\bchakra/i and
  // ZH /脉轮/ pillar rules below (first-match-wins). All target slugs ship in this
  // same batch. ---
  // chakra spokes (EN) — must precede /\bchakra/i
  { match: /\bheart\s*chakra\b/i,  href: '/en/wiki/heart-chakra-meaning' },
  { match: /\bthroat\s*chakra\b/i, href: '/en/wiki/throat-chakra-meaning' },
  { match: /\b(ajna|third[-\s]*eye|brow)\s*chakra\b/i, href: '/en/wiki/ajna-chakra' },
  { match: /\bcrown\s*chakra\b/i,  href: '/en/wiki/crown-chakra-meaning' },
  { match: /\bsolar\s*plexus\b/i,  href: '/en/wiki/solar-plexus-chakra-affirmations' },
  { match: /\bchakra\s+crystals?\b|\bcrystals?\s+for\s+(each|the|every)\s+chakra\b/i, href: '/en/wiki/crystals-for-each-chakra' },
  // chakra spokes (ZH) — must precede /(生殖轮|脉轮|能量中心)/
  { match: /心轮/,   href: '/en/wiki/heart-chakra-meaning' },
  { match: /喉轮/,   href: '/en/wiki/throat-chakra-meaning' },
  { match: /(眉心轮|眉轮|第三眼)/, href: '/en/wiki/ajna-chakra' },
  { match: /顶轮/,   href: '/en/wiki/crown-chakra-meaning' },
  { match: /(太阳轮|太阳神经丛)/,  href: '/en/wiki/solar-plexus-chakra-affirmations' },
  { match: /脉轮水晶/, href: '/en/wiki/crystals-for-each-chakra' },
  // astrology-terms glossary pillar + aspect/angle spokes (EN)
  { match: /\bsextile\b/i,        href: '/en/wiki/sextile-astrology' },
  { match: /\btrine\b/i,          href: '/en/wiki/trine-in-astrology' },
  { match: /\bsquare\s+aspect\b|\bsquare\b/i, href: '/en/wiki/square-astrology' },
  { match: /\bdescendant\b/i,     href: '/en/wiki/descendant-astrology' },
  { match: /\bimum\s+coeli\b|\bIC\s+angle\b|\bthe\s+IC\b/i, href: '/en/wiki/ic-astrology' },
  { match: /\bastrology\s+terms?\b|\bglossary\b/i, href: '/en/wiki/astrology-terms' },
  { match: /\b(major|minor|chart)\s+aspects?\b|\bfive\s+major\s+aspects\b/i, href: '/en/wiki/astrology-terms' },
  { match: /\bascendant\b|\brising\s+sign\b/i, href: '/en/wiki/how-to-read-birth-chart' },
  { match: /\bmidheaven\b/i,      href: '/en/wiki/how-to-read-birth-chart' },
  // astrology-terms glossary + aspect/angle spokes (ZH)
  { match: /六分相/, href: '/en/wiki/sextile-astrology' },
  { match: /三分相/, href: '/en/wiki/trine-in-astrology' },
  { match: /四分相/, href: '/en/wiki/square-astrology' },
  { match: /下降点/, href: '/en/wiki/descendant-astrology' },
  { match: /(天底|imum\s*coeli)/i, href: '/en/wiki/ic-astrology' },
  { match: /占星术语/, href: '/en/wiki/astrology-terms' },
  { match: /(主要相位|相位总览|次要相位)/, href: '/en/wiki/astrology-terms' },
  { match: /(上升星座|上升点)/, href: '/en/wiki/how-to-read-birth-chart' },
  { match: /(天顶|中天)/, href: '/en/wiki/how-to-read-birth-chart' },
  { match: /(本命星盘|星盘阅读)/, href: '/en/wiki/how-to-read-birth-chart' },
  // --- end 5/29 cluster ---
  { match: /\bred\s*aura\b/i,    href: '/en/wiki/red-aura-meaning' },
  { match: /\borange\s*aura\b/i, href: '/en/wiki/orange-aura-meaning' },
  { match: /\bgreen\s*aura\b/i,  href: '/en/wiki/green-aura-meaning' },
  { match: /\bblue\s*aura\b/i,   href: '/en/wiki/blue-aura-meaning' },
  { match: /\byellow\s*aura\b/i, href: '/en/wiki/yellow-aura-meaning' },
  { match: /\bpurple\s*aura\b/i, href: '/en/wiki/purple-aura-meaning' },
  { match: /\bviolet\s*aura\b/i, href: '/en/wiki/purple-aura-meaning' },
  { match: /\bindigo\s*aura\b/i, href: '/en/wiki/purple-aura-meaning' },
  { match: /\bwhite\s*aura\b/i,  href: '/en/wiki/white-aura-meaning' },
  { match: /\bfour[-\s]*element/i, href: '/en/wiki/four-element-framework' },
  { match: /\bchakra/i,          href: '/en/wiki/chakra-system-overview' },
  { match: /\baura\s*colors?\b/i, href: '/en/wiki/aura-colors-pillar' },
  { match: /\baura\s*reading\b/i, href: '/en/wiki/aura-colors-pillar' },
  // --- Astrological houses (8/9/11/12 + pillar exist; 2/3/4/5/7/10 fall back to
  // the pillar — same cluster, keeps the link clickable instead of orphaned). ---
  { match: /\b(eighth|8th)\s+house\b/i,    href: '/en/wiki/8th-house-meaning' },
  { match: /\b(ninth|9th)\s+house\b/i,     href: '/en/wiki/9th-house-astrology' },
  { match: /\b(eleventh|11th)\s+house\b/i, href: '/en/wiki/11th-house' },
  { match: /\b(twelfth|12th)\s+house\b/i,  href: '/en/wiki/12th-house-astrology' },
  { match: /第八宫/,   href: '/en/wiki/8th-house-meaning' },
  { match: /第九宫/,   href: '/en/wiki/9th-house-astrology' },
  { match: /第十一宫/, href: '/en/wiki/11th-house' },
  { match: /第十二宫/, href: '/en/wiki/12th-house-astrology' },
  { match: /\bhouses?\b/i, href: '/en/wiki/astrology-houses' },
  { match: /宫/,          href: '/en/wiki/astrology-houses' },
  // --- Lunar nodes (scorpio/taurus spokes + pillar). Scorpio/Taurus themes route
  // to the matching nodal-sign spoke; generic node descriptions to the pillar. ---
  { match: /\bscorpio\b/i, href: '/en/wiki/north-node-in-scorpio' },
  { match: /天蝎/,         href: '/en/wiki/north-node-in-scorpio' },
  { match: /\btaurus\b/i,  href: '/en/wiki/north-node-in-taurus' },
  { match: /金牛/,         href: '/en/wiki/north-node-in-taurus' },
  { match: /\b(lunar nodes?|nodal axis|north node|south node|north (and|&) south node)\b/i, href: '/en/wiki/north-node-vs-south-node' },
  { match: /(交点|节点)/,  href: '/en/wiki/north-node-vs-south-node' },
  // --- Birth chart fundamentals ---
  { match: /\b(natal|birth)\s+chart\b/i, href: '/en/wiki/how-to-read-birth-chart' },
  { match: /(出生星盘|本命盘|星盘入门|星图入门)/, href: '/en/wiki/how-to-read-birth-chart' },
  // --- ZH aura cluster ---
  { match: /气场颜色|气场.*总览/, href: '/en/wiki/aura-colors-pillar' },
  { match: /红色?气场/,           href: '/en/wiki/red-aura-meaning' },
  { match: /黄色?气场/,           href: '/en/wiki/yellow-aura-meaning' },
  { match: /(生殖轮|脉轮|能量中心)/, href: '/en/wiki/chakra-system-overview' },
  // --- Planets → domicile-house page (no standalone planet pages yet; classical
  // rulership is the closest existing match). Signs without a page → ruling house. ---
  { match: /\bjupiter\b|木星/i,   href: '/en/wiki/9th-house-astrology' },
  { match: /\bpluto\b|冥王星/i,   href: '/en/wiki/8th-house-meaning' },
  { match: /\bneptune\b|海王星/i,  href: '/en/wiki/12th-house-astrology' },
  { match: /\bsagittarius\b|射手|人马/i, href: '/en/wiki/9th-house-astrology' },
  { match: /\bpisces\b|双鱼/i,     href: '/en/wiki/12th-house-astrology' },
  // Generic "planets in the chart" overview → birth-chart fundamentals.
  { match: /行星.{0,6}(星盘|本命|含义|意义)|星盘里.{0,4}行星|planets?\s+in\s+the\s+(natal|birth)/i, href: '/en/wiki/how-to-read-birth-chart' },
  // Nodal methodology / generic nodal-sign placement → nodes pillar.
  { match: /\b(true node|mean node|evolutionary astrolog\w*|nodal sign)\b/i, href: '/en/wiki/north-node-vs-south-node' },
];

export function resolveTbdLink(description, lang = 'en') {
  const d = description.trim();
  // TBD descriptions may be single-segment ("astrology houses overview") or the
  // three-part "anchor | context | reason" form the v8 prompt teaches. Match on
  // the full string (context/reason add recall) but only ever SHOW the anchor —
  // the first `|`-segment — so the internal authoring metadata never leaks into
  // the rendered link text. Single-segment descriptions are unaffected.
  const anchor = d.split('|')[0].trim();
  // Rules store the EN path; rewrite /en/ → /<lang>/ so a ZH article links the ZH page.
  const langPath = lang === 'zh' ? '/zh/' : '/en/';
  for (const rule of TBD_LINK_RULES) {
    if (rule.match.test(d)) return `[${anchor}](${rule.href.replace('/en/', langPath)})`;
  }
  return `*${anchor}*`;
}

// Resolve `[[<TBD-external-link: Service | Topic | desc>]]` to a real link.
// Only Wikipedia is recognized (the sole external source the content cites); the
// Topic field becomes the article slug and lang picks the en/zh.wikipedia.org
// host. An unknown service falls through to an italic flag (no fabricated URL),
// mirroring resolveTbdLink's unmatched behavior.
export function resolveExternalTbdLink(service, topic, lang = 'en') {
  const t = topic.trim();
  if (!/wikipedia|维基百科/i.test(service)) return `*${t}*`;
  const isZh = lang === 'zh' || /[一-鿿]/.test(t);
  const host = isZh ? 'zh.wikipedia.org' : 'en.wikipedia.org';
  const url = `https://${host}/wiki/${encodeURI(t.replace(/ /g, '_'))}`;
  const label = isZh ? `${t}（维基百科）` : `${t} (Wikipedia)`;
  return `[${label}](${url})`;
}

// Auto-link bare http(s) URLs to markdown link form, but skip ones already
// inside a markdown link target (`](https://...)`) or angle-bracket autolink
// (`<https://...>`). Trailing punctuation `.,;:!?` is excluded from link.
export function autoLinkBareUrls(s) {
  return s.replace(/(?<![(\[<])https?:\/\/[^\s)<>]+/g, (m) => {
    const trimmed = m.replace(/[.,;:!?]+$/, '');
    const punct = m.slice(trimmed.length);
    return `[${trimmed}](${trimmed})${punct}`;
  });
}

export function transformBody(body, lang = 'en') {
  let out = body;
  out = out.replace(
    /\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g,
    (_m, desc) => resolveTbdLink(desc, lang),
  );
  out = out.replace(
    /\[\[<\s*TBD-external-link:\s*([^|>]+?)\s*\|\s*([^|>]+?)\s*\|\s*[^>]*?>\]\]/g,
    (_m, service, topic) => resolveExternalTbdLink(service, topic, lang),
  );
  out = autoLinkBareUrls(out);
  out = out.trimEnd();
  return out;
}

export function escapeForTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

// Emit just the `export const <var>: WikiArticle = { ... };` block (no header,
// no import). Used by both emitTs (full file) and mergeIntoSibling (append-only
// path that preserves existing EN export).
export function emitExportBlock({ slug, title, date, description, keywords, body, varName, language = 'en', authorMeta = null }) {
  const escapedBody = escapeForTemplate(body);
  const keywordsLit = JSON.stringify(keywords, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const lang = language === 'zh' ? 'zh' : 'en';
  // WikiArticle now references the author by id only (authorId → AuthorPersona.id,
  // resolved at render time from the oracle authors registry — replaces the old
  // bare author/authorSlug/authorBio fields, which are no longer in the type and
  // break the build's author-integrity gate). authorMeta.id is the persona id.
  const authorId = authorMeta && (authorMeta.id || authorMeta.slug)
    ? (authorMeta.id || authorMeta.slug)
    : '';
  return `export const ${varName}: WikiArticle = {
  slug: ${JSON.stringify(slug)},
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(description)},
  authorId: ${JSON.stringify(authorId)},
  date: ${JSON.stringify(date)},
  schema: "Article",
  lang: "${lang}",
  keywords: ${keywordsLit},
  content: \`${escapedBody}
\`,
};
`;
}

export function emitTs(opts) {
  const block = emitExportBlock(opts);
  return `// Article: ${opts.title}
// Generated from flow-mvp _staging/ by tools/scripts/gg-md-to-oracle-ts.mjs.
import type { WikiArticle } from "../../types";

${block}`;
}

// Atomic write: tmp file in the same dir + rename, so a mid-write crash never
// leaves a truncated .ts in oracle's articles dir (which would break the
// whole oracle build because of an unterminated template literal).
export function atomicWrite(path, contents) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

// Inject a new export block into an existing oracle <slug>.ts. Behavior:
//   - If file already contains `export const ${varName}:` (the canonical
//     line-starting form) → REPLACE that block in place (idempotent re-runs).
//   - If file mentions `export const ${varName}` ANYWHERE but the strict block
//     regex can't isolate it (formatting drift) → THROW. We never silent-append
//     because that would emit a duplicate `export const ${varName}` and break
//     TypeScript with "Cannot redeclare block-scoped variable".
//   - If file lacks WikiArticle import → THROW. Caller falls back to writing a
//     standalone file via emitTs (which includes the import).
//   - Else → APPEND at file end (preserves all existing exports + comments).
//
// Regex strategy (F1):
//   - Anchored block start: `^export const <varName>:\s*WikiArticle\s*=\s*\{`
//   - Body: lazy `[\s\S]*?`
//   - Terminator: `^};` at column 0, optionally followed by inline comment /
//     whitespace, then end-of-line. The `m` flag enables `^/$` per line.
//   This stops the markdown body's `\n};` inside a code fence from being
//   mistaken for the export's closing brace, because the body lines are
//   indented (inside a template literal, the closing `\`` sits before `};`).
export function mergeIntoSibling(siblingPath, newBlock, varName) {
  // F4: normalize CRLF → LF on read so the regex (which anchors on `\n`)
  // behaves consistently across platforms.
  const raw = readFileSync(siblingPath, 'utf8');
  const existing = raw.replace(/\r\n/g, '\n');

  // F3: sibling must be an oracle article module (or empty) so the injected
  // `export const ...: WikiArticle = ...` resolves to the right type. We
  // tolerate empty/whitespace-only files (caller will fall back to full
  // emitTs). For non-empty files, the WikiArticle TYPE must be in scope —
  // either via an `import ... WikiArticle` statement, or a local declaration
  // (`interface WikiArticle` / `type WikiArticle`). A bare mention in a
  // comment doesn't count.
  const hasImport = /import\s+(?:type\s+)?\{[^}]*\bWikiArticle\b[^}]*\}/.test(existing);
  const hasLocalDecl = /\b(?:interface|type)\s+WikiArticle\b/.test(existing);
  if (existing.trim() !== '' && !hasImport && !hasLocalDecl) {
    throw new Error(
      `sibling ${siblingPath} does not import/declare WikiArticle — refusing to inject typed export. ` +
      `Pass --no-merge to write a standalone .zh.ts instead.`,
    );
  }

  const blockRegex = new RegExp(
    `^export const ${varName}:\\s*WikiArticle\\s*=\\s*\\{[\\s\\S]*?^\\};[^\\n]*\\n?`,
    'm',
  );
  if (blockRegex.test(existing)) {
    return { merged: existing.replace(blockRegex, newBlock), mode: 'replaced' };
  }

  // F1 hard guard: if the symbol exists but our strict block extractor
  // doesn't see it (unusual formatting / hand-edited), refuse rather than
  // silently appending a duplicate.
  const symbolRegex = new RegExp(`\\bexport const ${varName}\\b`);
  if (symbolRegex.test(existing)) {
    throw new Error(
      `sibling ${siblingPath} contains "export const ${varName}" but our block ` +
      `extractor couldn't isolate it (non-canonical formatting?). ` +
      `Refusing to append a duplicate. Reformat the existing block to start with ` +
      `"export const ${varName}: WikiArticle = {" and end with "};" on its own line, ` +
      `or pass --no-merge.`,
    );
  }

  const trimmed = existing.replace(/\s*$/, '');
  return { merged: trimmed + '\n\n' + newBlock, mode: 'appended' };
}

function convertOne({ source, slug, out, language = 'en', mergeSibling = false, articlesDir = null }) {
  const md = readFileSync(source, 'utf8');
  const { frontmatter: fm, body } = parseFrontmatter(md);
  const resolvedSlug = slug || fm.slug;
  if (!resolvedSlug) throw new Error(`no slug for ${source}`);
  // Title source priority: the article's own `# H1` (the magnetic, keyword-woven
  // headline the model wrote) over the frontmatter `title:` (often the bare
  // keyword). The page renders `title` as the <h1> / <title> / og:title and skips
  // the in-body H1 as a duplicate, so the magnetic H1 must land in `title` to be
  // SEO-visible (清单 §1: magnetic title, no bare keyword / colon template).
  const h1Match = body.match(/^#\s+(.+?)\s*$/m);
  const title = (h1Match && h1Match[1].trim()) || fm.title;
  if (!title) throw new Error(`no title for ${source}`);
  const date = fm.date || new Date().toISOString().slice(0, 10);
  const tgtKw = fm.target_keyword || '';
  const assoc = Array.isArray(fm.associated_keywords) ? fm.associated_keywords : [];
  const keywords = [tgtKw, ...assoc].filter(Boolean);
  const transformedBody = transformBody(body, language);
  const description = deriveDescription(transformedBody);
  // bilingual-v9-full: varName suffix follows language. Oracle convention is
  // single-file dual-export (slugEn + slugZh in same .ts), e.g.
  // track-mood-astrology.ts.
  const suffix = language === 'zh' ? 'Zh' : 'En';
  const varName = slugToCamel(resolvedSlug, suffix);
  // T10: carry author identity into publish metadata. content-draft's
  // buildAuthorFrontmatter writes the persona id under `author_id` (see
  // gg-content-draft.mjs). Fall back to legacy `author` for hand-authored staging
  // files. Reading the wrong key silently drops every byline to the house team.
  const authorMeta = resolveAuthorMeta(fm.author_id || fm.author);
  const exportBlock = emitExportBlock({ slug: resolvedSlug, title, date, description, keywords, body: transformedBody, varName, language, authorMeta });

  // F2: sibling path is derived from the resolved (parsed) slug, not from
  // `out`. This makes the merge target stable even if --out is a weird
  // filename (e.g. foo.bar.ts, scratch path). `articlesDir` is the directory
  // where oracle articles live; for the batch path it's args.oracle-articles-
  // dir; for the single-file path it defaults to dirname(out).
  const siblingDir = articlesDir || dirname(out);
  const siblingPath = join(siblingDir, `${resolvedSlug}.ts`);

  if (mergeSibling && siblingPath !== out && existsSync(siblingPath)) {
    try {
      const { merged, mode } = mergeIntoSibling(siblingPath, exportBlock, varName);
      atomicWrite(siblingPath, merged);
      return { slug: resolvedSlug, varName, out: siblingPath, language, mergeMode: mode };
    } catch (e) {
      // F3: WikiArticle type not in scope → fall back to writing a
      // self-contained file (includes the import). All other errors (F1 hard
      // guard etc.) propagate so the operator sees them.
      if (!/does not import\/declare WikiArticle/.test(e.message)) throw e;
      // Continue to standalone path below.
    }
  }

  const ts = emitTs({ slug: resolvedSlug, title, date, description, keywords, body: transformedBody, varName, language, authorMeta });
  mkdirSync(dirname(out), { recursive: true });
  atomicWrite(out, ts);
  return { slug: resolvedSlug, varName, out, language, mergeMode: 'standalone' };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// Reverse of pageIdToSlug — recover page_id from slug. The forward
// transform is `page_<snake_case>` → `<kebab-case>`; reverse is best-effort
// since the prefix is hardcoded. Callers should still verify that the
// returned page_id corresponds to a staging md (caller guards).
export function slugToPageId(slug) {
  return `page_${slug.replace(/-/g, '_')}`;
}

// Returns true if `_staging/<page_id>-<llm>-<version>.manifest.json` exists
// AND its phase2_checks.overall is "pass". phase2-validate only enriches the
// frontmatter + writes the manifest on PASS, so failures are correctly
// invisible to refresh-existing.
function hasPassedPhase2(stagingDir, pageId, llm, version) {
  const manifestPath = join(stagingDir, `${pageId}-${llm}-${version}.manifest.json`);
  if (!existsSync(manifestPath)) return false;
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return m?.phase2_checks?.overall === 'pass';
  } catch {
    return false;
  }
}

// Find every oracle article slug that has at least one PHASE2-PASSED v8
// staging md (claude preferred, codex as fallback). Used by --refresh-existing
// to re-run the converter on previously-published articles so new
// TBD_LINK_RULES entries get picked up in their body. Skips:
//   - legacy articles (no v8 staging md at all — pre-aura cluster)
//   - articles whose v8 staging md exists but FAILED phase2 (no frontmatter,
//     no manifest → would break convertOne's `parseFrontmatter` anyway)
export function findRefreshableArticles({ articlesDir, stagingDir, version = 'v8' }) {
  if (!existsSync(articlesDir)) throw new Error(`articlesDir not found: ${articlesDir}`);
  if (!existsSync(stagingDir)) throw new Error(`stagingDir not found: ${stagingDir}`);
  const out = [];
  for (const fname of readdirSync(articlesDir)) {
    if (!fname.endsWith('.ts')) continue;
    if (fname === 'index.ts' || fname.startsWith('_')) continue;
    const slug = fname.replace(/\.ts$/, '');
    const pageId = slugToPageId(slug);
    // Prefer claude winner if it passed; else fall back to codex if it passed.
    let winner = null;
    if (hasPassedPhase2(stagingDir, pageId, 'claude', version)) winner = 'claude';
    else if (hasPassedPhase2(stagingDir, pageId, 'codex', version)) winner = 'codex';
    if (winner) out.push({ slug, pageId, winner });
  }
  return out;
}

// Audit TBD_LINK_RULES against the oracle articles directory. Reports two
// drift modes:
//   (1) oracle has an article whose slug is NOT a `href` target in any rule
//       → TBD wikilinks for that entity will fall through to italic placeholder
//       even though the article exists. Action: add a TBD_LINK_RULES entry.
//   (2) a TBD_LINK_RULES rule points at a `/en/wiki/<slug>` that has no
//       matching .ts file under oracle/data/articles/. Action: remove the
//       rule or wait until the article ships.
//
// Returns 0 = clean / 1 = drift found. Doesn't modify anything.
export function auditTbdRulesAgainstOracle(articlesDir, rules = TBD_LINK_RULES) {
  if (!existsSync(articlesDir)) {
    throw new Error(`oracle articles dir not found: ${articlesDir}`);
  }
  const slugsOnDisk = new Set();
  // articlesDir is a flat directory of ~20 .ts files; sync readdir is fine.
  for (const fname of readdirSync(articlesDir)) {
    if (!fname.endsWith('.ts')) continue;
    if (fname === 'index.ts' || fname.startsWith('_')) continue;
    slugsOnDisk.add(fname.replace(/\.ts$/, ''));
  }
  const slugsCoveredByRules = new Set(
    rules.map((r) => {
      const m = /^\/en\/wiki\/([a-z0-9-]+)$/.exec(r.href || '');
      return m ? m[1] : null;
    }).filter(Boolean),
  );
  const missingRule = [...slugsOnDisk].filter((s) => !slugsCoveredByRules.has(s));
  const danglingRule = [...slugsCoveredByRules].filter((s) => !slugsOnDisk.has(s));
  return { missingRule, danglingRule, slugsOnDisk: [...slugsOnDisk], slugsCoveredByRules: [...slugsCoveredByRules] };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.h || args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').slice(1, 24).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }

  if (args.audit_links) {
    const articlesDir = args.oracle_articles_dir || '/Users/wzb/Code/oracle/data/articles';
    let report;
    try {
      report = auditTbdRulesAgainstOracle(articlesDir);
    } catch (e) {
      process.stderr.write(`✗ audit failed: ${e.message}\n`);
      return 2;
    }
    process.stdout.write(`TBD_LINK_RULES audit (${articlesDir})\n`);
    process.stdout.write(`  oracle articles on disk: ${report.slugsOnDisk.length}\n`);
    process.stdout.write(`  slugs covered by rules:  ${report.slugsCoveredByRules.length}\n\n`);
    if (report.missingRule.length === 0 && report.danglingRule.length === 0) {
      process.stdout.write(`✓ rules + oracle articles are in sync.\n`);
      return 0;
    }
    if (report.missingRule.length) {
      process.stdout.write(`⚠ ${report.missingRule.length} oracle article(s) NOT routed by any rule — TBD wikilinks fall to italic placeholder:\n`);
      for (const s of report.missingRule) process.stdout.write(`    /en/wiki/${s}\n`);
      process.stdout.write(`  → add a TBD_LINK_RULES entry in tools/scripts/gg-md-to-oracle-ts.mjs\n\n`);
    }
    if (report.danglingRule.length) {
      process.stdout.write(`⚠ ${report.danglingRule.length} rule(s) point at slug(s) with no .ts file on disk:\n`);
      for (const s of report.danglingRule) process.stdout.write(`    /en/wiki/${s}\n`);
      process.stdout.write(`  → remove the stale rule, or ship the article first.\n`);
    }
    return 1;
  }

  if (args.batch) {
    const defaultWinnerLlm = args.winner_llm || 'claude';
    const version = args.version || 'v8';
    const articlesDir = args.oracle_articles_dir || '/Users/wzb/Code/oracle/data/articles';
    const stagingDir = args.staging_dir || join(FLOW_REPO, '_staging');

    // bilingual-v9: --language en|zh (default en). When zh:
    //   - source path defaults to <stagingDir>/zh-demo/<page>-<llm>-<v>.md
    //     (matches gg-render-batch --language both convention)
    //   - output filename gets .zh infix: aura-color-blue.zh.ts
    //   - emitTs writes lang: "zh" + varName ends with Zh
    //   - index.ts hint suggests ARTICLES_ZH.push instead of ARTICLES_EN
    const langArg = typeof args.language === 'string' ? args.language.toLowerCase() : null;
    if (langArg && !['en', 'zh'].includes(langArg)) {
      process.stderr.write(`invalid --language "${args.language}" — expected en|zh\n`);
      return 2;
    }
    const language = langArg || 'en';

    // bilingual-v9-full follow-up: ZH defaults to merging into EN sibling so
    // oracle stays single-file dual-export. --no-merge keeps the legacy
    // `<slug>.zh.ts` standalone output (useful for review / dry-run).
    const mergeSibling = language === 'zh' && !args.no_merge;

    // Page list resolution priority:
    //   1. --refresh-existing → every oracle article with a v8 staging md
    //   2. --pages "..."     → explicit list
    //   3. DEFAULT_PAGES     → the original 6 aura batch
    let pages;
    let autoWinnerMap = {};
    if (args.refresh_existing) {
      let refreshable;
      try {
        refreshable = findRefreshableArticles({ articlesDir, stagingDir, version });
      } catch (e) {
        process.stderr.write(`✗ refresh-existing failed: ${e.message}\n`);
        return 2;
      }
      pages = refreshable.map((r) => r.pageId);
      // Auto-populate winner map from whatever staging md is actually present.
      // User-supplied --winner-map still wins over this auto-map.
      for (const r of refreshable) autoWinnerMap[r.pageId] = r.winner;
      process.stdout.write(`[refresh-existing] found ${refreshable.length} oracle article(s) with v8 staging md\n`);
    } else {
      pages = (args.pages && args.pages !== true) ? args.pages.split(/\s+/) : DEFAULT_PAGES;
    }

    // Per-page winner override map. Lets a mixed-winner batch (some pages
    // claude-PASS, others codex-PASS) convert in one invocation:
    //   --winner-map "page_chakra_system_overview:codex,page_orange_aura_meaning:claude"
    // Resolution order per page: explicit --winner-map > autoWinnerMap
    // (filled by --refresh-existing from existing staging md) > --winner-llm
    // > 'claude'.
    const winnerMap = { ...autoWinnerMap };
    if (args.winner_map && args.winner_map !== true) {
      for (const pair of String(args.winner_map).split(/[,\s]+/).filter(Boolean)) {
        const idx = pair.indexOf(':');
        if (idx <= 0) {
          process.stderr.write(`invalid --winner-map pair "${pair}" — expected page_id:llm\n`);
          return 2;
        }
        winnerMap[pair.slice(0, idx)] = pair.slice(idx + 1);
      }
    }

    const results = [];
    for (const pid of pages) {
      const winnerLlm = winnerMap[pid] || defaultWinnerLlm;
      // ZH source convention: orchestrator --out-dir _staging/zh-demo/ writes
      // <pid>-<llm>-<version>.md there (no .zh in filename — the directory
      // disambiguates). EN stays at <stagingDir>/<pid>-<llm>-<v>.md.
      const source = language === 'zh'
        ? join(stagingDir, 'zh-demo', `${pid}-${winnerLlm}-${version}.md`)
        : join(stagingDir, `${pid}-${winnerLlm}-${version}.md`);
      if (!existsSync(source)) {
        process.stderr.write(`✗ missing: ${source}\n`);
        results.push({ pid, ok: false, reason: 'source missing', winnerLlm, language });
        continue;
      }
      // Slug resolution: the md frontmatter `slug:` is the source of truth and the
      // only thing that maps PG-* page_ids — pageIdToSlug only knows the aura
      // page_<color>_aura_meaning rule and returns PG-* ids unchanged. Fall back to
      // the derived slug for staging md that omits frontmatter.
      const fmSlugMatch = readFileSync(source, 'utf8').slice(0, 2000).match(/^slug:\s*["']?([^"'\n]+?)["']?\s*$/m);
      const slug = (fmSlugMatch && fmSlugMatch[1].trim()) || pageIdToSlug(pid);
      // Output filename gets .zh infix for ZH so EN/ZH .ts files coexist in oracle
      // articles dir without overwriting (ZH merges into the EN sibling unless --no-merge).
      const outName = language === 'zh' ? `${slug}.zh.ts` : `${slug}.ts`;
      const out = join(articlesDir, outName);
      try {
        const r = convertOne({ source, slug, out, language, mergeSibling, articlesDir });
        const tag = r.mergeMode === 'replaced' || r.mergeMode === 'appended'
          ? `merge:${r.mergeMode}` : r.mergeMode;
        process.stdout.write(`✓ [${language}] ${r.slug}  →  ${r.out}  (var: ${r.varName}, winner: ${winnerLlm}, ${tag})\n`);
        results.push({ pid, ok: true, winnerLlm, ...r });
      } catch (e) {
        process.stderr.write(`✗ ${pid}: ${e.message}\n`);
        results.push({ pid, ok: false, reason: e.message, winnerLlm, language });
      }
    }
    const ok = results.filter((r) => r.ok);
    process.stderr.write(`\nbatch [${language}]: ${ok.length}/${results.length} converted\n`);
    // F5: amplified post-batch hint. When ZH is merged into an EN sibling,
    // index.ts MUST still be hand-patched or the ZH content is in the bundle
    // but unreachable (silent /zh/wiki/<slug> 404). Show a ⚠ banner so the
    // operator can't miss it. Also detect legacy `<slug>.zh.ts` co-existing
    // with the merged file — those are stale and must be deleted, otherwise
    // `oracle/data/articles/<slug>.zh.ts` and the merged `<slug>.ts` both
    // claim the same slug.
    process.stdout.write('\n// --- index.ts patch hint ---\n');
    const mergedResults = ok.filter((r) => r.mergeMode === 'replaced' || r.mergeMode === 'appended');
    if (mergedResults.length) {
      process.stdout.write('// ⚠ MANDATORY follow-up: oracle ZH 404 unless you patch index.ts.\n');
      process.stdout.write('// The ZH export lives in <slug>.ts now, but ARTICLES_ZH still misses it.\n');
    }
    for (const r of ok) {
      const merged = r.mergeMode === 'replaced' || r.mergeMode === 'appended';
      const importPath = (language === 'zh' && !merged) ? `./${r.slug}.zh` : `./${r.slug}`;
      const noteSuffix = merged ? '  // add to existing import block' : '';
      process.stdout.write(`// import { ${r.varName} } from "${importPath}";${noteSuffix}\n`);
    }
    const arr = language === 'zh' ? 'ARTICLES_ZH' : 'ARTICLES_EN';
    process.stdout.write(`// ${arr}.push:\n`);
    for (const r of ok) {
      process.stdout.write(`//   ${r.varName},\n`);
    }
    process.stdout.write('// ARTICLE_SLUGS (generate-seo-pages.mjs):\n');
    for (const r of ok) {
      process.stdout.write(`//   '${r.slug}',\n`);
    }
    // F5: legacy .zh.ts coexistence. After merge, `<slug>.ts` is the source
    // of truth; an old `<slug>.zh.ts` is stale and risks index.ts importing
    // from the wrong module.
    const staleZhTs = mergedResults
      .map((r) => join(articlesDir, `${r.slug}.zh.ts`))
      .filter(existsSync);
    if (staleZhTs.length) {
      process.stderr.write('\n⚠ STALE FILES — delete these after patching index.ts:\n');
      for (const p of staleZhTs) process.stderr.write(`    ${p}\n`);
    }
    return ok.length === results.length ? 0 : 1;
  }

  if (!args.source || !args.out) {
    process.stderr.write('missing --source <md> and --out <ts>\n');
    return 2;
  }
  const langArg = typeof args.language === 'string' ? args.language.toLowerCase() : null;
  if (langArg && !['en', 'zh'].includes(langArg)) {
    process.stderr.write(`invalid --language "${args.language}" — expected en|zh\n`);
    return 2;
  }
  const language = langArg || 'en';
  const mergeSibling = language === 'zh' && !args.no_merge;
  // F2: sibling path is derived inside convertOne from the resolved frontmatter
  // slug + dirname(out). No more guessing slug from --out filename.
  const r = convertOne({ source: args.source, slug: args.slug, out: args.out, language, mergeSibling });
  process.stdout.write(`✓ ${r.slug}  →  ${r.out}  (var: ${r.varName}, ${r.mergeMode})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { convertOne, main };
