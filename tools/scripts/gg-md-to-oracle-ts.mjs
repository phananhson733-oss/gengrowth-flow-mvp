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
    // catch-all for single-segment / malformed TBD-external-link (no pipe triple)
    .replace(/\[\[<\s*TBD-external-link:\s*([^>]+?)\s*>\]\]/g, (_m, inner) => { const p = inner.split('|'); return p[p.length - 1].trim(); })
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLen) {
    // Clean truncation — never emit a trailing "..." (reads as broken to users
    // and Google). Prefer ending on a full sentence at/under maxLen; otherwise
    // keep the first full sentence when it is still within a sane hard cap.
    const sentenceEnd = (s, start = 0) => {
      for (let i = start; i < s.length; i++) {
        const ch = s[i];
        if (ch === '。' || ch === '！' || ch === '？') return i;
        if (ch === '.' || ch === '!' || ch === '?') {
          const next = s[i + 1] || '';
          if (!next || /\s/.test(next)) return i;
        }
      }
      return -1;
    };
    const lastSentenceEndWithin = (s, limit) => {
      let last = -1;
      let i = 0;
      while (i < Math.min(limit, s.length)) {
        const end = sentenceEnd(s, i);
        if (end < 0 || end >= limit) break;
        last = end;
        i = end + 1;
      }
      return last;
    };
    const hasCjk = /[\u3400-\u9fff]/u.test(cleaned);
    const minFullSentence = hasCjk ? 40 : 80;
    const hardMax = Math.max(maxLen + 120, 240);
    const window = cleaned.slice(0, maxLen);
    const sentEnd = lastSentenceEndWithin(cleaned, maxLen);
    const firstSentEnd = sentenceEnd(cleaned);
    if (sentEnd >= minFullSentence) {
      cleaned = cleaned.slice(0, sentEnd + 1).trim();
    } else if (firstSentEnd >= minFullSentence && firstSentEnd + 1 <= hardMax) {
      cleaned = cleaned.slice(0, firstSentEnd + 1).trim();
    } else {
      // No sentence end within the window → prefer the last clause boundary
      // (comma/semicolon ≥ 80), else cut at a word boundary; then strip dangling
      // function-words so the description never ends mid-phrase on a preposition/
      // article/conjunction (e.g. "…the deity of" → "…by Yama").
      const clause = Math.max(window.lastIndexOf('; '), window.lastIndexOf('；'));
      let cut = clause >= 80 ? window.slice(0, clause) : window.replace(/\s+\S*$/, '');
      cut = cut.replace(/[，、；,;:\s]+$/u, '').trim();
      const danglingTail = /\s+(of|the|a|an|and|or|to|by|in|on|for|with|at|as|from|into|over|under|that|this|these|those|its|their|his|her|is|are|was|were|be|been)$/i;
      while (danglingTail.test(cut)) cut = cut.replace(danglingTail, '');
      cleaned = cut.trim();
    }
  }
  return cleaned;
}

// Lookup table for resolving TBD wikilink descriptions to real oracle URLs.
// First matching rule wins. Description matching is case-insensitive
// substring/regex. Patterns are intentionally narrow to avoid mis-routing.
// Anything unmatched falls through to an italic placeholder (no fake link).
export const TBD_LINK_RULES = [
  // --- 7/27 执行表 v2 clusters: 实验七 K-pop 星盘 / 实验八 虚构角色 / 实验九 流行音乐,
  // plus the 7/24 celebrity-athlete spokes. Sits at the TOP because every entry is a
  // proper noun — matching a person or character name can never mis-route a generic
  // description, and these MUST precede the broad /(natal|birth) chart/ rule below or
  // "Suga BTS birth chart" resolves to the how-to-read pillar instead of its own spoke.
  // Within the block, member/character spokes precede their group pillar (first-match-
  // wins) so "Jisoo birth chart" never gets swallowed by the BLACKPINK pillar rule.
  // NOTE: `jalen brunson` is matched by FULL name — the live quinta-brunson-birth-chart
  // page would otherwise collide on a bare /brunson/ match.
  { match: /suga(\s+bts)?\s+birth\s+chart|min\s+yoongi|\bsuga['’]?s?\s+(natal\s+)?chart/i, href: '/en/wiki/suga-bts-birth-chart' },
  { match: /\brm(\s+bts)?\s+birth\s+chart|kim\s+namjoon|namjoon/i, href: '/en/wiki/rm-bts-birth-chart' },
  { match: /jisoo/i, href: '/en/wiki/jisoo-birth-chart' },
  { match: /bts\s+(members['’]?\s+)?zodiac\s+signs?|防弹少年团.{0,4}星座/i, href: '/en/wiki/bts-members-zodiac-signs' },
  { match: /blackpink\s+(members['’]?\s+)?zodiac\s+signs?|blackpink\s+成员?.{0,4}星座/i, href: '/en/wiki/blackpink-zodiac-signs' },
  { match: /severus\s+snape|\bsnape\b/i, href: '/en/wiki/severus-snape-zodiac-sign' },
  { match: /dumbledore|邓布利多/i, href: '/en/wiki/dumbledore-zodiac-sign' },
  { match: /harry\s+potter\s+(characters['’]?\s+)?zodiac\s+signs?|哈利.?波特.{0,6}星座/i, href: '/en/wiki/harry-potter-characters-zodiac-signs' },
  { match: /rihanna|robyn\s+fenty|蕾哈娜/i, href: '/en/wiki/rihanna-birth-chart' },
  { match: /selena\s+gomez|赛琳娜.?戈麦斯/i, href: '/en/wiki/selena-gomez-birth-chart' },
  { match: /jalen\s+brunson/i, href: '/en/wiki/jalen-brunson-birth-chart' },
  { match: /robert\s+downey(\s+jr\.?)?|小罗伯特.?唐尼/i, href: '/en/wiki/robert-downey-jr-birth-chart' },
  { match: /shohei\s+ohtani|\bohtani\b|大谷翔平/i, href: '/en/wiki/shohei-ohtani-birth-chart' },
  { match: /victor\s+wembanyama|wembanyama|文班亚马/i, href: '/en/wiki/victor-wembanyama-zodiac-sign' },
  // 实验六 MBTI × 星座. MUST sit above the generic sign rules at the bottom of this array
  // AND above the /\bscorpio\b/ north-node rule, which otherwise swallows "Scorpio MBTI"
  // and points it at /en/wiki/north-node-in-scorpio.
  { match: /scorpio\s+mbti|mbti\s+type\s+for\s+scorpio/i, href: '/en/wiki/scorpio-mbti-type' },
  { match: /(zodiac\s+signs?\s+as\s+mbti|mbti\s+(types?\s+)?for\s+each\s+zodiac|what\s+mbti\s+is\s+each\s+zodiac|most\s+common\s+mbti\s+types?)/i, href: '/en/wiki/the-most-common-mbti-types-for-each-zodiac-sign' },
  // --- 7/29 v2 全速期批次. Type/character spokes precede their pillar, and the
  // ENFP-Gemini crossover precedes the bare ENFP rule so the more specific page wins. ---
  { match: /enfp\s+gemini|gemini\s+enfp/i, href: '/en/wiki/enfp-gemini' },
  { match: /\bintp\b[^.\n]{0,20}\b(zodiac|sun|star)\s*sign|\bintp\s+zodiac\b/i, href: '/en/wiki/intp-zodiac-sign' },
  { match: /\besfp\b[^.\n]{0,20}\b(zodiac|sun|star)\s*sign|\besfp\s+zodiac\b/i, href: '/en/wiki/esfp-zodiac-sign' },
  { match: /bts\s+(zodiac\s+)?compatibilit|compatibilit\w*\s+(between\s+)?bts\s+members/i, href: '/en/wiki/bts-compatibility-zodiac' },
  { match: /\bive\s+(members['’]?\s+)?zodiac\s+signs?|jang\s+wonyoung|아이브/i, href: '/en/wiki/ive-members-zodiac-signs' },
  { match: /seventeen\s+(members['’]?\s+)?zodiac\s+signs?/i, href: '/en/wiki/seventeen-zodiac-signs' },
  { match: /wanda\s+maximoff|scarlet\s+witch/i, href: '/en/wiki/wanda-maximoff-zodiac-sign' },
  { match: /\bthor\b[^.\n]{0,24}\b(zodiac|sun|star)\s*sign|\bthor\s+zodiac\b/i, href: '/en/wiki/thor-zodiac-sign' },
  { match: /marvel\s+(characters['’]?\s+)?zodiac\s+signs?|漫威.{0,4}星座/i, href: '/en/wiki/marvel-characters-zodiac-signs' },
  { match: /billie\s+eilish/i, href: '/en/wiki/billie-eilish-birth-chart' },
  { match: /sabrina\s+carpenter/i, href: '/en/wiki/sabrina-carpenter-zodiac-sign' },
  // --- 6/16 World Cup 2026 astrology cluster (pillar + player / team / national
  // spokes). Specific spokes precede the general pillar rule (first-match-wins),
  // and the whole block sits at the TOP so "germany ... birth chart" routes to its
  // own spoke before the broad /(natal|birth) chart/ rule further down. Target
  // slugs world-cup-2026-astrology-prediction / argentina-* / vinicius-jr-zodiac-
  // sign / saturn-in-aries-2026 are live; germany-* ship in the 6/16 batch. ---
  // --- 6/18 World Cup 2026 player + Cancer-cluster spokes (PG-WC-016~020). These
  // MUST precede the generic /(natal|birth) chart/ rule (~line 343) and the WC-2026
  // pillar rule below (first-match-wins). messi-record precedes messi-zodiac so a
  // "world cup record" description never routes to the zodiac spoke. EN + ZH. ---
  { match: /jude\s+bellingham|bellingham\s+birth\s+chart|裘德.{0,2}贝林厄姆|贝林厄姆/i, href: '/en/wiki/jude-bellingham-birth-chart' },
  { match: /erling\s+haaland|haaland\s+birth\s+chart|哈兰德/i, href: '/en/wiki/erling-haaland-birth-chart' },
  { match: /messi\s+world\s+cup\s+record|messi'?s?\s+world\s+cup\s+astrology|梅西.{0,8}世界杯/i, href: '/en/wiki/messi-world-cup-record-astrology' },
  { match: /lionel\s+messi\s+zodiac\s+sign|messi\s+zodiac\s+sign|梅西.{0,4}星座/i, href: '/en/wiki/lionel-messi-zodiac-sign' },
  { match: /harry\s+kane|kane\s+birth\s+chart|哈里.{0,2}凯恩|凯恩星盘/i, href: '/en/wiki/harry-kane-birth-chart' },
  { match: /cancer\s+zodiac\s+world\s+cup|cancer\s+world\s+cup\s+lens|巨蟹座?.{0,8}世界杯/i, href: '/en/wiki/cancer-zodiac-world-cup-2026' },
  // --- 6/18 batch-2 WC player + England-team spokes (PG-WC-021~025). MUST precede
  // the generic /(natal|birth) chart/ rule (~line 351) and the WC-2026 pillar rule
  // below (first-match-wins) so a player "birth chart" routes to its own spoke. EN+ZH. ---
  { match: /james\s+rodr[ií]guez|rodr[ií]guez\s+birth\s+chart|哈梅斯|J\s*罗\b|罗德里格斯/i, href: '/en/wiki/james-rodriguez-birth-chart' },
  { match: /luis\s+d[ií]az|d[ií]az\s+birth\s+chart|路易斯.{0,2}迪亚斯|迪亚斯星盘?/i, href: '/en/wiki/luis-diaz-birth-chart' },
  { match: /yoane\s+wissa|wissa\s+birth\s+chart|约阿内|维萨星盘?/i, href: '/en/wiki/yoane-wissa-birth-chart' },
  { match: /christian\s+pulisic|pulisic\s+birth\s+chart|普利西奇/i, href: '/en/wiki/christian-pulisic-birth-chart' },
  { match: /england\s+world\s+cup\s+2026\s+astrology|england\s+(team|squad|national)\s+(team\s+)?astrology|英格兰.{0,8}世界杯.{0,6}占星/i, href: '/en/wiki/england-world-cup-2026-astrology' },
  // --- 6/21 batch (PG-WC-026 Spain / 027 Cunha / 028 Scotland-Brazil / TRANS-011 Chiron-in-Taurus / MYTH-006 Toy Story 5).
  // MUST precede the generic /(natal|birth) chart/ rule (~line 351), the WC-2026 pillar rule below, AND the generic
  // /\bchiron\b/ rule (~line 260) — first-match-wins — so chiron-in-taurus routes to its own spoke, not the 12th-house page. EN+ZH. ---
  { match: /spain\s+world\s+cup\s+2026\s+astrology|la\s+roja\s+astrology|spain\s+(national\s+team\s+)?(birth\s+)?chart|西班牙.{0,8}世界杯.{0,6}占星|斗牛士.{0,8}占星/i, href: '/en/wiki/spain-world-cup-2026-astrology' },
  { match: /matheus\s+cunha|cunha\s+birth\s+chart|马特乌斯|库尼亚/i, href: '/en/wiki/matheus-cunha-birth-chart' },
  { match: /scotland\s+(vs\.?\s+|and\s+|[-\s]+)brazil.{0,24}(world\s+cup\s+)?astrology|苏格兰.{0,4}巴西.{0,8}占星/i, href: '/en/wiki/scotland-brazil-world-cup-astrology' },
  { match: /chiron\s+in\s+taurus|chiron\s+taurus(\s+2026)?(\s+transit)?|凯龙.{0,4}金牛/i, href: '/en/wiki/chiron-in-taurus-2026-astrology' },
  { match: /toy\s+story\s+5\s+(characters?\s+)?zodiac|toy\s+story\s+(5\s+)?zodiac\s+signs?|玩具总动员.{0,4}星座/i, href: '/en/wiki/toy-story-5-zodiac-signs' },
  { match: /best\s+soccer\s+players?\s+(by\s+)?zodiac|soccer\s+players?\s+by\s+zodiac\s+sign|顶尖足球.{0,6}星座/i, href: '/en/wiki/best-soccer-players-zodiac-sign' },
  { match: /world\s+cup\s+2026\s+june\s+astrology|june\s+2026.{0,16}(transit|astrology)\s+calendar|june\s+2026\s+(planetary\s+)?transits?|世界杯.{0,6}六月/i, href: '/en/wiki/world-cup-2026-june-astrology' },
  { match: /(2026)?\s*世界杯.{0,4}占星.{0,4}(总览|预测|专题|指南|pillar)|世界杯占星(总览|专题)/, href: '/en/wiki/world-cup-2026-astrology-prediction' },
  { match: /vinicius.{0,6}(jr|junior).{0,16}(zodiac|sun)\s*sign|vinicius.{0,6}(jr|junior).{0,16}sun[-\s]?sign/i, href: '/en/wiki/vinicius-jr-zodiac-sign' },
  { match: /germany\s+world\s+cup.{0,24}(players?|squad).{0,16}chart|germany.{0,16}(players?|squad).{0,12}birth\s*chart/i, href: '/en/wiki/germany-world-cup-players-birth-chart-2026' },
  { match: /germany\s+world\s+cup\s+2026\s+team\s+astrology|germany.{0,16}team\s+astrology/i, href: '/en/wiki/germany-world-cup-2026-astrology-team' },
  { match: /argentina\s+world\s+cup\s+2026\s+astrology/i, href: '/en/wiki/argentina-world-cup-2026-astrology' },
  { match: /transit_events\s+cluster|jupiter\s+in\s+cancer.{0,20}saturn\s+in\s+aries|saturn\s+in\s+aries(\s+2026)?(\s+transit)?/i, href: '/en/wiki/saturn-in-aries-2026' },
  { match: /world\s+cup\s+2026\s+astrology\s+(themes?\s+)?(pillar|prediction|hub|overview|guide)|world\s+cup\s+2026\s+astrology\s+themes|world\s+cup\s+2026\s+astrology\s+prediction/i, href: '/en/wiki/world-cup-2026-astrology-prediction' },
  { match: /how\s+to\s+read\s+a\s+(national|mundane)\s+(or\s+mundane\s+)?chart|(national|mundane)\s+chart\b/i, href: '/en/wiki/how-to-read-birth-chart' },
  // 6/26 synastry cluster (PG-SYNASTRY-001/002) — couple/synastry pieces link here.
  { match: /composite\s+chart\s+(calculator|tool|generator)|synastry\s+calculator|calculator\s+(tool\s+)?for\s+comparing\s+two\s+(birth\s+)?charts|合盘(计算器|工具)/i, href: '/en/wiki/composite-chart-calculator' },
  { match: /synastry\s+(chart\s+)?compatibility|pillar\s+guide\s+to\s+synastry|synastry\s+(pillar|overview|guide|reading)|synastry\s+(and\s+)?compatibility|合盘(相性|分析|指南)/i, href: '/en/wiki/synastry-chart-compatibility' },
  // --- 6/24 Celebrity zodiac cluster (PG-CELEB-001..005): cross-links among the five
  // celeb spokes. Person-name matches are specific, so they sit safely above the generic
  // /(natal|birth) chart/ rule. Same slugs serve EN + ZH. ---
  { match: /emma\s+watson|艾玛.?沃森/i, href: '/en/wiki/emma-watson-zodiac-sign' },
  { match: /greta\s+lee|格蕾塔.?李/i, href: '/en/wiki/greta-lee-zodiac-sign' },
  { match: /kylie\s+jenner|凯莉.?詹娜/i, href: '/en/wiki/kylie-jenner-zodiac-sign' },
  { match: /mariah\s+carey|玛丽亚.?凯莉/i, href: '/en/wiki/mariah-carey-zodiac-sign' },
  { match: /sharon\s+osbourne|莎朗.?奥斯本/i, href: '/en/wiki/sharon-osbourne-zodiac-sign' },
  // 6/26 celebrity-couple synastry spokes (PG-CELEB-007/008).
  { match: /taylor\s+swift\s+(and|&|x)?\s*travis\s+kelce|swift[-\s]+kelce(\s+synastry)?|泰勒.{0,4}凯尔斯/i, href: '/en/wiki/taylor-swift-and-travis-kelce' },
  { match: /harry\s+styles\s+(and|&|x)?\s*zo[eë]?\s+kravitz|styles[-\s]+kravitz(\s+synastry)?|哈里.{0,4}克拉维茨/i, href: '/en/wiki/harry-styles-and-zo-kravitz' },
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
  // --- 6/2 MAHADASHA cluster (mahadasha pillar + rahu/ketu/saturn(shani)/venus
  // spokes). Planet spokes MUST precede the generic mahadasha pillar rule
  // (first-match-wins); vedic-vs-western-astrology is the bridge. Saturn-dasha
  // matches only with "dasha/period" so "saturn in pisces" still routes below. ---
  { match: /\brahu\s+(maha)?dasha\b|\brahu\s+(planetary\s+)?period\b/i, href: '/en/wiki/rahu-mahadasha' },
  { match: /\bketu\s+(maha)?dasha\b|\bketu\s+(planetary\s+)?period\b/i, href: '/en/wiki/ketu-mahadasha' },
  { match: /\b(saturn|shani)\s+(maha)?dasha\b|\bsaturn\s+(planetary\s+)?period\b/i, href: '/en/wiki/saturn-mahadasha' },
  { match: /\b(venus|shukra)\s+(maha)?dasha\b|\bvenus\s+(planetary\s+)?period\b/i, href: '/en/wiki/venus-mahadasha' },
  { match: /vedic\s+(and|vs\.?|versus)\s+western|western\s+astrology|vedic\s+versus\s+western/i, href: '/en/wiki/vedic-vs-western-astrology' },
  { match: /pillar\s+guide\s+to\s+(the\s+)?mahadasha|mahadasha\s+(system|and\s+(the\s+)?vimshottari)|\bmahadasha\b\s+(pillar|overview|guide)|vimshottari\s+dasha\s+system/i, href: '/en/wiki/mahadasha' },
  { match: /计都.{0,3}大运|ketu.{0,4}大运/i, href: '/en/wiki/ketu-mahadasha' },
  { match: /(罗睺|羅睺|拉胡).{0,3}大运|rahu.{0,4}大运/i, href: '/en/wiki/rahu-mahadasha' },
  { match: /(土星|shani|沙尼).{0,3}大运|saturn.{0,4}大运/i, href: '/en/wiki/saturn-mahadasha' },
  { match: /(金星|shukra).{0,3}大运|venus.{0,4}大运/i, href: '/en/wiki/venus-mahadasha' },
  { match: /吠陀占星?.{0,8}西方|吠陀.{0,4}西方占星|吠陀占星核心概念/, href: '/en/wiki/vedic-vs-western-astrology' },
  { match: /大运(周期|体系|系统)?.{0,6}(总览|pillar)|大运.{0,4}mahadasha|mahadasha.{0,4}总览/i, href: '/en/wiki/mahadasha' },
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
  { match: /ascendant\s+meaning|rising\s+sign\s+(profile|meaning|basics|overview)|overview\s+of\s+rising\s+sign/i, href: '/en/wiki/ascendant-meaning' },
  // Celeb-batch recurring anchors ("rising sign personality profiles", "rising sign profiles hub")
  // want the rising/ascendant page, not the generic pillar. Above the narrowed ascendant rule.
  { match: /rising\s+sign\s+(personality\s+)?profiles?|rising\s+sign\s+profiles?\s+(hub|cluster|overview)/i, href: '/en/wiki/ascendant-meaning' },
  // No dedicated stellium page exists; how-to-read-birth-chart covers planet clusters — honest ONLY
  // when the anchor describes clusters (see the per-article reword). Repoint if a stellium page ships.
  { match: /\bstelliums?\b/i, href: '/en/wiki/how-to-read-birth-chart' },
  // Narrowed: a BARE "ascendant" routes to the real ascendant page; a bare "rising sign" with no
  // basics/overview/meaning/profile qualifier now falls through to the italic de-link (avoids the
  // links-seo mismatch that force-linking vague anchors to the generic pillar caused).
  { match: /\bascendant\b/i, href: '/en/wiki/ascendant-meaning' },
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
  { match: /solar\s+return(\s+chart)?|太阳返照/i, href: '/en/wiki/solar-return-chart' },
  { match: /\b(sixth|6th)\s+house\b/i,     href: '/en/wiki/6th-house-astrology' },
  { match: /\b(seventh|7th)\s+house\b/i,   href: '/en/wiki/7th-house-astrology' },
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
  // Intent-gated: only link when the anchor is ABOUT how to read/understand a birth chart, so a
  // vague "companion celebrity birth chart profile in this series" de-links instead of mis-pointing
  // at the generic pillar (the links-seo mismatch park). Legit "guide to reading a full birth chart"
  // still links.
  { match: /\b(how\s+to\s+read|reading|read\s+(a|your|the)|understand\w*|basics?\s+of|guide\s+to|fundamentals?\s+of|full)\s+(a\s+|your\s+|the\s+)?(natal|birth)\s+chart\b/i, href: '/en/wiki/how-to-read-birth-chart' },
  { match: /(出生星盘|本命盘|星盘入门|星图入门)/, href: '/en/wiki/how-to-read-birth-chart' },
  // --- ZH aura cluster ---
  { match: /气场颜色|气场.*总览/, href: '/en/wiki/aura-colors-pillar' },
  { match: /红色?气场/,           href: '/en/wiki/red-aura-meaning' },
  { match: /黄色?气场/,           href: '/en/wiki/yellow-aura-meaning' },
  { match: /(生殖轮|脉轮|能量中心)/, href: '/en/wiki/chakra-system-overview' },
  // --- Planets → domicile-house page (no standalone planet pages yet; classical
  // rulership is the closest existing match). Signs without a page → ruling house. ---
  // Intent-gated (2026-07-01): these sign/planet→domicile-house fallbacks now fire ONLY when the
  // anchor is about the HOUSE or classical rulership (has house/rule(s)/ruler/rulership/domicile —
  // ZH 宫/守护 — near the planet/sign). A bare "Pisces Sun sign" / "Jupiter transit" de-links to
  // italic instead of mis-pointing at a house page (the CELEB-018 links-seo mismatch class). Explicit
  // house-number rules above run first (first-match-wins), so "9th house"/"第十二宫" are unaffected.
  { match: /\bjupiter\b.{0,24}\b(rule|rules|ruler|rulership|domicile|house)\b|\bhouse\b.{0,16}\bjupiter\b.{0,12}\brules?\b|木星.{0,6}(宫|守护)/i,   href: '/en/wiki/9th-house-astrology' },
  { match: /\bpluto\b.{0,24}\b(rule|rules|ruler|rulership|domicile|house)\b|\bhouse\b.{0,16}\bpluto\b.{0,12}\brules?\b|冥王星.{0,6}(宫|守护)/i,   href: '/en/wiki/8th-house-meaning' },
  { match: /\bneptune\b.{0,24}\b(rule|rules|ruler|rulership|domicile|house)\b|\bhouse\b.{0,16}\bneptune\b.{0,12}\brules?\b|海王星.{0,6}(宫|守护)/i,  href: '/en/wiki/12th-house-astrology' },
  { match: /\bsagittarius\b.{0,24}\b(rule|rules|ruler|rulership|domicile|house)\b|\bhouse\b.{0,16}\bsagittarius\b.{0,12}\brules?\b|(射手|人马).{0,6}(宫|守护)/i, href: '/en/wiki/9th-house-astrology' },
  { match: /\bpisces\b.{0,24}\b(rule|rules|ruler|rulership|domicile|house)\b|\bhouse\b.{0,16}\bpisces\b.{0,12}\brules?\b|双鱼.{0,6}(宫|守护)/i,     href: '/en/wiki/12th-house-astrology' },
  // Generic "planets in the chart" overview → birth-chart fundamentals.
  { match: /行星.{0,6}(星盘|本命|含义|意义)|星盘里.{0,4}行星|planets?\s+in\s+the\s+(natal|birth)/i, href: '/en/wiki/how-to-read-birth-chart' },
  // Nodal methodology / generic nodal-sign placement → nodes pillar.
  { match: /\b(true node|mean node|evolutionary astrolog\w*|nodal sign)\b/i, href: '/en/wiki/north-node-vs-south-node' },
  // --- 12 sign pages (/en/wiki/<sign>), all live. Added 2026-07-29: there was NO rule
  // pointing at any of them, so every "what a Capricorn Sun means" / "Aquarius sign
  // meaning" placeholder in a celebrity, K-pop, or fictional-character article de-linked
  // to a dead italic — a standing internal-link leak across the whole content line.
  //
  // Deliberately INTENT-GATED and placed LAST: a bare sign name is far too common to
  // route on (it appears in "Scorpio MBTI", "Cancer season 2026", "Virgo rising",
  // "Cancer North Node", every rulership fallback above). The anchor must be ABOUT the
  // sign itself — "<sign> Sun", "<sign> sign meaning/means", "<sign> archetype" — and
  // must NOT be about a rising sign, a Moon placement, or MBTI, all of which have their
  // own pages. Every more specific rule already ran by the time we get here.
  ...['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'].map((sign) => ({
    match: new RegExp(
      `(?!.*\\b(rising|moon|mbti|north\\s+node|south\\s+node|season)\\b)`
      + `\\b${sign}\\b(?:[^.\\n]{0,24}?\\b(?:sun|sun[-\\s]sign|archetype)\\b`
      + `|\\s+(?:zodiac\\s+)?sign\\s+(?:meaning|means|explained|in\\s+detail))`,
      'i',
    ),
    href: `/en/wiki/${sign}`,
  })),
];

// `selfSlug` suppresses self-links. An article naturally names its own entity in
// Related Reading ("Billie Eilish zodiac sign", "Billie Eilish moon sign"), and a
// person/character rule keyed on that name then resolves every one of them back to
// the page you are already on — 4 self-links on one page in the 7/29 batch. A
// self-link is dead weight for readers and passes no PageRank, so it de-links to
// italic instead. Callers that do not know the target slug simply omit it.
export function resolveTbdLink(description, selfSlug = '') {
  const d = description.trim();
  const selfHref = selfSlug ? `/en/wiki/${selfSlug}` : null;
  // TBD descriptions may be single-segment ("astrology houses overview") or the
  // three-part "anchor | context | reason" form the v8 prompt teaches. Match on
  // the full string (context/reason add recall) but only ever SHOW the anchor —
  // the first `|`-segment — so the internal authoring metadata never leaks into
  // the rendered link text. Single-segment descriptions are unaffected.
  const anchor = d.split('|')[0].trim();
  for (const rule of TBD_LINK_RULES) {
    if (rule.match.test(d)) {
      if (selfHref && rule.href === selfHref) return `*${anchor}*`;
      return `[${anchor}](${rule.href})`;
    }
  }
  return `*${anchor}*`;
}

// Resolve `[[<TBD-external-link: Service | Topic | desc>]]` to a real link.
// Only Wikipedia is recognized (the sole external source the content cites); the
// Topic field becomes the article slug. An unknown service falls through to an
// italic flag (no fabricated URL), mirroring resolveTbdLink's unmatched behavior.
export function resolveExternalTbdLink(service, topic) {
  const t = topic.trim();
  if (!/wikipedia/i.test(service)) return `*${t}*`;
  const url = `https://en.wikipedia.org/wiki/${encodeURI(t.replace(/ /g, '_'))}`;
  return `[${t} (Wikipedia)](${url})`;
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

export function transformBody(body, selfSlug = '') {
  let out = body;
  out = out.replace(
    /\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g,
    (_m, desc) => resolveTbdLink(desc, selfSlug),
  );
  out = out.replace(
    /\[\[<\s*TBD-external-link:\s*([^|>]+?)\s*\|\s*([^|>]+?)\s*\|\s*[^>]*?>\]\]/g,
    (_m, service, topic) => resolveExternalTbdLink(service, topic),
  );
  // Catch-all: any remaining TBD-external-link that ISN'T the canonical
  // `Service | Topic | desc` triple (e.g. a single-segment bare description the
  // model emitted) would otherwise ship as raw `[[...]]` markup. De-link it to
  // plain italic text — take the last `|`-segment as the label — so no raw
  // wikilink syntax ever reaches the published page. (Mirrors the unmatched
  // internal-link → italic behavior.)
  out = out.replace(
    /\[\[<\s*TBD-external-link:\s*([^>]+?)\s*>\]\]/g,
    (_m, inner) => { const p = inner.split('|'); return `*${p[p.length - 1].trim()}*`; },
  );
  out = autoLinkBareUrls(out);
  out = out.trimEnd();
  return out;
}

export function escapeForTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

// Emit just the `export const <var>: WikiArticle = { ... };` block (no header,
// no import). Used by emitTs (full file).
export function emitExportBlock({ slug, title, date, description, keywords, body, varName, authorMeta = null }) {
  const escapedBody = escapeForTemplate(body);
  const keywordsLit = JSON.stringify(keywords, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
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
  lang: "en",
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

function convertOne({ source, slug, out }) {
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
  const transformedBody = transformBody(body, resolvedSlug);
  const description = deriveDescription(transformedBody);
  const varName = slugToCamel(resolvedSlug, 'En');
  // T10: carry author identity into publish metadata. content-draft's
  // buildAuthorFrontmatter writes the persona id under `author_id` (see
  // gg-content-draft.mjs). Fall back to legacy `author` for hand-authored staging
  // files. Reading the wrong key silently drops every byline to the house team.
  const authorMeta = resolveAuthorMeta(fm.author_id || fm.author);
  const ts = emitTs({ slug: resolvedSlug, title, date, description, keywords, body: transformedBody, varName, authorMeta });
  mkdirSync(dirname(out), { recursive: true });
  atomicWrite(out, ts);
  return { slug: resolvedSlug, varName, out, mergeMode: 'standalone' };
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

    // EN-only (2026-07-03): zh conversion was removed with the rest of the zh
    // authoring pipeline. Reject --language zh loudly instead of silently
    // converting a Chinese draft as English.
    const langArg = typeof args.language === 'string' ? args.language.toLowerCase() : null;
    if (langArg && langArg !== 'en') {
      process.stderr.write(`--language ${args.language} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)\n`);
      return 2;
    }

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
      const source = join(stagingDir, `${pid}-${winnerLlm}-${version}.md`);
      if (!existsSync(source)) {
        process.stderr.write(`✗ missing: ${source}\n`);
        results.push({ pid, ok: false, reason: 'source missing', winnerLlm });
        continue;
      }
      // Slug resolution: the md frontmatter `slug:` is the source of truth and the
      // only thing that maps PG-* page_ids — pageIdToSlug only knows the aura
      // page_<color>_aura_meaning rule and returns PG-* ids unchanged. Fall back to
      // the derived slug for staging md that omits frontmatter.
      const fmSlugMatch = readFileSync(source, 'utf8').slice(0, 2000).match(/^slug:\s*["']?([^"'\n]+?)["']?\s*$/m);
      const slug = (fmSlugMatch && fmSlugMatch[1].trim()) || pageIdToSlug(pid);
      const out = join(articlesDir, `${slug}.ts`);
      try {
        const r = convertOne({ source, slug, out });
        process.stdout.write(`✓ ${r.slug}  →  ${r.out}  (var: ${r.varName}, winner: ${winnerLlm})\n`);
        results.push({ pid, ok: true, winnerLlm, ...r });
      } catch (e) {
        process.stderr.write(`✗ ${pid}: ${e.message}\n`);
        results.push({ pid, ok: false, reason: e.message, winnerLlm });
      }
    }
    const ok = results.filter((r) => r.ok);
    process.stderr.write(`\nbatch: ${ok.length}/${results.length} converted\n`);
    process.stdout.write('\n// --- index.ts patch hint ---\n');
    for (const r of ok) {
      process.stdout.write(`// import { ${r.varName} } from "./${r.slug}";\n`);
    }
    process.stdout.write('// ARTICLES_EN.push:\n');
    for (const r of ok) {
      process.stdout.write(`//   ${r.varName},\n`);
    }
    process.stdout.write('// ARTICLE_SLUGS (generate-seo-pages.mjs):\n');
    for (const r of ok) {
      process.stdout.write(`//   '${r.slug}',\n`);
    }
    return ok.length === results.length ? 0 : 1;
  }

  if (!args.source || !args.out) {
    process.stderr.write('missing --source <md> and --out <ts>\n');
    return 2;
  }
  const langArg = typeof args.language === 'string' ? args.language.toLowerCase() : null;
  if (langArg && langArg !== 'en') {
    process.stderr.write(`--language ${args.language} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)\n`);
    return 2;
  }
  const r = convertOne({ source: args.source, slug: args.slug, out: args.out });
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
