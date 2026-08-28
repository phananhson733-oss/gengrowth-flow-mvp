#!/usr/bin/env node
// gg-md-to-gengrowth-blog.mjs — the gengrowth.ai PUBLISH BRIDGE.
//
// Turns a flow-mvp staged gengrowth draft (_staging/PG-XXX-NNN-<llm>-v8.md) into a
// gengrowth.ai blog_posts row. It is the gengrowth analog of gg-md-to-oracle-ts.mjs:
//   oracle:    draft md -> oracle/data/articles/<slug>.ts (WikiArticle) -> PR -> Vercel
//   gengrowth: draft md -> Supabase blog_posts row (SANITIZED HTML) -> SQL seed -> PR
//
// gengrowth.ai renders the blog from a Supabase `blog_posts` table; the article page
// injects `content` via dangerouslySetInnerHTML after sanitize-html. So the bridge
// must emit SANITIZED HTML (not markdown) using the EXACT same sanitize policy as the
// render path (src/.../blog-article-content.tsx), so stored HTML == displayed HTML.
//
// PUBLISH MECHANISM (b): this machine has no Supabase service-role key, so the bridge
// EMITS a reviewable SQL upsert file (--emit sql) that is PR'd to gengrowth-agents-repo
// and applied to prod (supabase CLI / SQL Editor) by an operator. Idempotent on
// (slug, locale) via an enumerated ON CONFLICT DO UPDATE (matches supabase/seed-blog.sql),
// so re-publishing UPDATES in place, never duplicates. (--emit api is a future lane.)
//
// Design + Codex review: docs/2026-06-17-gengrowth-publish-bridge-design.md
//
// USAGE
//   node tools/scripts/gg-md-to-gengrowth-blog.mjs \
//     --source _staging/PG-WLS-001-claude-v8.md --locale en \
//     --out /Users/awayer_mini/gengrowth-agents-repo/supabase/seed-blog-w25.sql
//   add --dry-run to print the row + HTML without writing.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import sanitizeHtmlPkg from 'sanitize-html';
const sanitizeHtml = sanitizeHtmlPkg.default || sanitizeHtmlPkg;

// Reuse the oracle bridge's already-exported, behaviour-tested helpers (its main()
// is guarded by `if (import.meta.url === file://${process.argv[1]})`, so importing
// is side-effect-free).
import {
  parseFrontmatter,
  deriveDescription,
  transformBody,
  atomicWrite,
} from './gg-md-to-oracle-ts.mjs';

// ── site constants ───────────────────────────────────────────────────────────
// The gengrowth blog uses a single fixed byline (no authors table / FK); all
// existing seeded rows use 'GenGrowth Team'.
const AUTHOR_BY_LOCALE = { en: 'GenGrowth Team' };

// ── internal-link catalog (2026-08-07) ───────────────────────────────────────
// WHY THIS EXISTS: transformBody() is imported from the ORACLE bridge, and its default
// TBD_LINK_RULES are all `/en/wiki/<astrology-slug>`. A gengrowth draft's
// `[[<TBD-internal-link: ...>]]` therefore matched nothing and de-linked to italic text —
// so EVERY internal link in EVERY gengrowth article silently vanished, and the Pillar→
// Series→tool topology that 主题集群表 `internal_link_rule` specifies has never shipped.
// Verified on PG-KOD-001 before this catalog existed: 5 of 5 internal links were dropped.
//
// PATH: the site serves `/blog/<slug>` — the `/en/` prefixed form 308-redirects to it
// (checked live 2026-08-07), and an internal link should never burn a redirect hop.
//
// MATCHING: first match wins, so specific spokes MUST precede their broader pillar.
// Patterns are deliberately narrow (multi-word, anchored on the distinguishing noun) —
// a loose pattern mis-routes a link, which is worse than dropping it.
// MAINTENANCE: add a rule when a new gengrowth article goes live, or later articles
// cannot link to it.
const GENGROWTH_TBD_LINK_RULES = [
  // -- 2026-08-07 batch: keyword_opportunity / search_performance_diagnosis / internal_link_architecture
  // The two zero-volume rules precede the generic low-hanging-fruit pillar so a
  // "zero search volume" description resolves to the Series, not the Pillar.
  { match: /zero[\s-]*(search[\s-]*)?volume|no[\s-]*search[\s-]*volume|zero[\s-]*volume/i, href: '/blog/zero-search-volume-keywords' },
  { match: /serp[\s-]*first[\s-]*keyword[\s-]*vetting|validat\w*[^.\n]{0,30}search[\s-]*volume/i, href: '/blog/zero-search-volume-keywords' },
  { match: /low[\s-]*hanging[\s-]*fruit|keyword[\s-]*difficulty|easy[\s-]*keywords?[\s-]*to[\s-]*rank|low[\s-]*competition[\s-]*keywords?|(search|keyword)[\s-]*opportunit(y|ies)|hidden[\s-]*keywords?/i, href: '/blog/how-to-find-low-hanging-fruit-keywords' },
  // "search performance diagnosis" in any order, plus the Search-Console-diagnosis phrasings
  // the writers actually produce ("reading Search Console data for SEO diagnosis").
  // The trailing `search console` alternatives were added 2026-08-17: the previous form
  // required a diagnos/impression/position word NEAR "Search Console", so the anchor the
  // 8/17 brief actually specifies — "the pillar on reading your own Search Console data"
  // — matched nothing and de-linked to italic. Reading your own Search Console data IS
  // what this Pillar covers, so a bare mention is a correct destination, not a guess.
  { match: /striking[\s-]*distance|search[\s-]*performance[\s-]*diagnos|diagnos\w*[^.\n]{0,40}search[\s-]*(performance|console)|search[\s-]*console[^.\n]{0,40}(diagnos|impression|position)|average[\s-]*position|content[\s-]*refresh[\s-]*prioriti|quick[\s-]*wins?|(read|reading|your[\s-]*own)[^.\n]{0,24}search[\s-]*console|search[\s-]*console[\s-]*(data|export)/i, href: '/blog/striking-distance-keywords' },
  // 2026-08-28: PG-ILA-002 — 「加了内链但排名没动」的一手数据篇。MUST precede the
  // pagerank-sculpting rule: an anchor like "internal links that did not move rankings"
  // shares the `internal link` stem, and sculpting is about WHERE equity flows, not about
  // whether adding links changed anything. Gated on a negation so ordinary architecture
  // anchors still land on the sculpting Pillar.
  { match: /internal[\s-]*links?[^.\n]{0,40}(not|no|didn't|failed?)[^.\n]{0,24}(improv|mov|chang|help|rank)|internal[\s-]*link[\s-]*experiment/i, href: '/blog/internal-links-not-improving-rankings' },
  { match: /pagerank[\s-]*sculpt|link[\s-]*equity|orphan[\s-]*pages?|crawl[\s-]*depth|internal[\s-]*link[\s-]*(architecture|structure)/i, href: '/blog/pagerank-sculpting' },
  // 2026-08-17: the August volatility post (Series under search_performance_diagnosis).
  // This MUST precede the two `core update` rules below. A description like "our August 2026
  // core update check" would otherwise be swallowed by the generic /core[\s-]*update/ rule and
  // land on the July page. Gated on August 2026 being NAMED — a bare "core update" still means
  // July, which is correct: August 2026 had no confirmed core update (Search Status Dashboard).
  { match: /august[\s-]*2026|unconfirmed[\s-]*volatilit/i, href: '/blog/google-algorithm-update-august-2026' },
  // 2026-08-24: the cannibalization article now exists (PG-SPD-003). This rule closes the hole
  // the note below describes — descriptions promising a cannibalization how-to finally have a
  // correct destination. Sits BEFORE the traffic-drop/core-update rule so nothing re-swallows it.
  { match: /cannibali[sz]|multiple[\s-]*pages[\s-]*(rank|compet)/i, href: '/blog/multiple-pages-ranking-for-same-keyword' },
  // Cross-cluster: traffic-drop / core-update work lives on the live google-july-2026-update page.
  // NOTE: `cannibali[sz]ation` was deliberately REMOVED from this rule. That page is about the
  // July 2026 core update and says nothing about cannibalization, so the rule was sending readers
  // who were promised a cannibalization how-to to an algorithm-update post. A wrong destination is
  // worse than no link — an unmatched description de-linked to italic, which was the correct outcome
  // until the cannibalization article above existed.
  { match: /traffic[\s-]*drop|core[\s-]*update/i, href: '/blog/google-july-2026-update' },
  { match: /segment\w*[^.\n]{0,40}(country|device)/i, href: '/blog/striking-distance-keywords' },
  // -- live articles most likely to be referenced by the clusters above --
  // `july[\s-]*2026` stands alone (added 2026-08-17). The old form required "update" to
  // follow, so "our earlier walkthrough of the July 2026 change" — the exact anchor the
  // 8/17 brief specifies — de-linked. Naming the month is enough to identify the page.
  { match: /july[\s-]*2026|google[\s-]*2026[\s-]*(core[\s-]*)?update|core[\s-]*update/i, href: '/blog/google-july-2026-update' },
  { match: /website[\s-]*health[\s-]*score/i, href: '/blog/website-health-score' },
  { match: /seo[\s-]*audit[\s-]*checklist/i, href: '/blog/seo-audit-checklist' },
  { match: /technical[\s-]*seo[\s-]*audit|site[\s-]*audit[\s-]*report/i, href: '/blog/seo-audit-checklist' },
  { match: /generative[\s-]*engine[\s-]*optimi[sz]ation|\bgeo\b[^.\n]{0,20}optimi/i, href: '/blog/generative-engine-optimization' },
  // agentic-seo (Series under ai_search_visibility, live 2026-08-21). Sits BEFORE the
  // pillar rule so an anchor naming the agentic piece is not swallowed by a broader
  // visibility phrasing in the same description. Gated on "agentic" being NAMED —
  // a bare "seo agent" is the PRODUCT page (/agents/seo, a full URL, never a TBD link).
  { match: /agentic[\s-]*seo|refusal[\s-]*list[^.\n]{0,30}seo[\s-]*agent/i, href: '/blog/agentic-seo' },
  { match: /ai[\s-]*search[\s-]*visibility|chatgpt[\s-]*citation/i, href: '/blog/ai-search-visibility' },
  { match: /best[\s-]*ai[\s-]*seo[\s-]*tools?/i, href: '/blog/best-ai-seo-tools' },
  // seo_tools_comparison Pillar (added 2026-08-17). Every article on the 8/18–8/30 B-line is a
  // Series under best-cheap-seo-tools and has to link back to it; measured on PG-CMP-007, the
  // anchor de-linked because no rule existed, which would have dropped the Pillar<->Series
  // topology for all twelve. `affordable` is a SEPARATE live page — keep the two rules distinct
  // so "affordable seo tools" does not get pulled onto the cheap-tools Pillar.
  { match: /affordable[\s-]*seo[\s-]*tools?/i, href: '/blog/affordable-seo-tools' },
  { match: /(cheap|budget|low[\s-]*cost|inexpensive)[\s-]*seo[\s-]*tools?|seo[\s-]*tools?[\s-]*on[\s-]*a[\s-]*budget/i, href: '/blog/best-cheap-seo-tools' },
  // B 线各篇 alternatives 页（随每篇上线当天加）。互链是这批 12 篇彼此之间唯一的拓扑：
  // 每上线一篇却不加规则，后面写到它的锚文本就会静默退化成斜体 —— 不报错，链接就是没了。
  // 放在 `seo tools` 系列规则之后、`seo automation` 之前：这些锚文本里带竞品名，
  // 不会被上面的通用规则抢走。
  { match: /outrank[\s-]*(\.so\s*)?(alternatives?|comparison|review)/i, href: '/blog/outrank-alternatives' },
  { match: /autoblogging[\s-]*(\.?ai)?[\s-]*(alternatives?|comparison|review)/i, href: '/blog/autoblogging-ai-alternatives' },
  { match: /babylovegrowth[\s-]*(\.?ai)?[\s-]*(alternatives?|comparison|review)/i, href: '/blog/babylovegrowth-alternatives' },
  { match: /frase[\s-]*(\.?io)?[\s-]*(alternatives?|comparison|review)/i, href: '/blog/frase-alternatives' },
  { match: /byword[\s-]*(\.?ai)?[\s-]*(alternatives?|comparison|review)/i, href: '/blog/byword-ai-alternatives' },
  { match: /rightblogger[\s-]*(alternatives?|comparison|review)/i, href: '/blog/rightblogger-alternatives' },
  { match: /scalenut[\s-]*(alternatives?|comparison|review)/i, href: '/blog/scalenut-alternatives' },
  { match: /arvow[\s-]*(alternatives?|comparison|review)/i, href: '/blog/arvow-alternatives' },
  { match: /seo[\s-]*automation/i, href: '/blog/seo-automation' },
  { match: /seo[\s-]*for[\s-]*saas[\s-]*startups?/i, href: '/blog/seo-for-saas-startups' },
  { match: /b2b[\s-]*saas[\s-]*seo/i, href: '/blog/b2b-saas-seo' },
  { match: /seo[\s-]*for[\s-]*saas|saas[\s-]*seo[\s-]*(strategy|platform)/i, href: '/blog/seo-for-saas' },
  { match: /seo[\s-]*for[\s-]*technology[\s-]*companies|b2b[\s-]*seo/i, href: '/blog/seo-for-technology-companies' },
  { match: /startup[\s-]*seo|diy[\s-]*seo/i, href: '/blog/startup-seo' },
  { match: /white[\s-]*label[\s-]*keyword[\s-]*research/i, href: '/blog/white-label-keyword-research' },
  { match: /agency[\s-]*rank[\s-]*tracking|rank[\s-]*tracking[\s-]*tool/i, href: '/blog/agency-rank-tracking' },
  { match: /local[\s-]*seo[\s-]*audit/i, href: '/blog/local-seo-audit' },
  { match: /backlink[\s-]*monitor/i, href: '/blog/why-use-a-backlink-monitor-tool' },
  // Sits AFTER the pagerank-sculpting rule so "internal link structure/architecture" still
  // resolves there; this catches the audit/crawl-methodology phrasing instead.
  { match: /bounded[\s-]*internal[\s-]*link|internal[\s-]*link[\s-]*(audit|crawl)|link[\s-]*crawl[\s-]*method/i, href: '/blog/bounded-internal-link-crawl' },
  { match: /broken[\s-]*link|4xx|dead[\s-]*link/i, href: '/blog/seo-audit-checklist' },
];

// External sources a B2B SEO article legitimately cites. Wikipedia (the oracle default)
// is not one of them; official documentation is. hrefs are REAL, verified URLs — the
// resolver must never synthesize one from the topic text.
const GENGROWTH_EXTERNAL_TBD_RULES = [
  // NOTE: support.google.com/webmasters = Search Console HELP CENTER; developers.google.com/search
  // = Search CENTRAL. Two different Google properties — labelling one as the other is exactly the
  // "误引 Google 官方文档" failure the W25 retro found, so the labels below name each precisely.
  {
    match: /search[\s-]*console/i,
    href: 'https://support.google.com/webmasters/answer/7042828',
    label: 'Google Search Console Help: impressions, position, and clicks',
  },
  {
    match: /crawlable[\s-]*links?|link[\s-]*best[\s-]*practices?/i,
    href: 'https://developers.google.com/search/docs/crawling-indexing/links-crawlable',
    label: "Google's link best practices (Search Central)",
  },
  {
    match: /nofollow|qualify[\s-]*(your[\s-]*)?outbound[\s-]*links?/i,
    href: 'https://developers.google.com/search/docs/crawling-indexing/qualify-outbound-links',
    label: 'Google: qualify your outbound links (Search Central)',
  },
  {
    match: /search[\s-]*central|google[\s-]*seo[\s-]*(starter[\s-]*guide|documentation)/i,
    href: 'https://developers.google.com/search/docs',
    label: 'Google Search Central documentation',
  },
];

const GENGROWTH_LINK_OPTS = Object.freeze({
  rules: GENGROWTH_TBD_LINK_RULES,
  pathPrefix: '/blog/',
  externalRules: GENGROWTH_EXTERNAL_TBD_RULES,
});

// heroImage/heroImageAlt are REQUIRED by the site schema, but a staged draft carries no
// hero art. Match what the site's own legacy migration already chose for cover-less rows
// (docs/marketing-blog-migration.md: "Missing legacy cover fields use the existing public
// /images/og-default.svg asset") so migrated and newly published posts look consistent.
// Visible tech debt: override per-article with --hero / --hero-alt once real art exists
// under public/images/blog/<slug>/.
const DEFAULT_HERO_IMAGE = '/images/og-default.svg';
const heroAltFor = (title) => `Cover illustration for ${title}`;

// blog_posts.category is a TEXT CHECK limited to 4 content-TYPE values; the W25 SEO
// clusters are TOPICS, none of which match. `category` collapses to a valid enum
// (methodology = how-to/framework guide, the shape every W25 post takes). Zero schema change.
const VALID_CATEGORIES = new Set(['case_study', 'methodology', 'weekly_review', 'experiment_log']);
const DEFAULT_CATEGORY = 'methodology';

// pillar_slug must be one of the blog's canonical PILLARS (the blog index filter tabs,
// src/app/[locale]/blog/page.tsx). It is NOT the fine W25 cluster id. Live W25 SEO posts
// (white-label, agency rank tracking, etc.) all use 'seo_content' — verified in prod
// (qeeocwurjslqppjxlsbk). Map page_id prefix -> pillar; unknown W25 -> seo_content.
const VALID_PILLARS = new Set(['growth_automation', 'experiment_driven', 'attribution', 'seo_content', 'customer_stories']);
const PILLAR_BY_PREFIX = {
  'PG-WLS': 'seo_content', 'PG-ART': 'seo_content', 'PG-SFS': 'seo_content',
  'PG-EOS': 'seo_content', 'PG-AIS': 'seo_content', 'PG-TAS': 'seo_content',
  'PG-SDS': 'seo_content', 'PG-B2B': 'seo_content', 'PG-CMP': 'seo_content',
  'PG-SLB': 'seo_content', 'PG-SMS': 'seo_content',
};
const DEFAULT_PILLAR = 'seo_content';

// Deterministic UUIDv5 (RFC 4122, SHA-1) from `${slug}|${locale}` so the row id is
// stable across re-publish (SQL diffs stay clean) and never collides with another
// post. Fixed namespace below is specific to the gengrowth blog.
const GENGROWTH_BLOG_NS = '7b9e0c4a-5d3f-4e21-9a6b-1c2d3e4f5a6b';
function uuidv5(name, namespaceUuid = GENGROWTH_BLOG_NS) {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  const b = h.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { locale: 'en', emit: 'sql', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === '--source') a.source = next();
    else if (k === '--locale') a.locale = next();
    else if (k === '--emit') a.emit = next();
    else if (k === '--out') a.out = next();
    else if (k === '--page-id') a.pageId = next();
    else if (k === '--category') a.category = next();
    else if (k === '--pillar') a.pillar = next();
    else if (k === '--hero') a.heroImage = next();
    else if (k === '--hero-alt') a.heroImageAlt = next();
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') a.help = true;
  }
  return a;
}

function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// Pull the first in-body `# H1` as the editorial title and STRIP it from the body —
// the blog renders the title separately above the content, so a leading <h1> in
// `content` would duplicate it (existing seed rows start at <h2>).
function extractTitleAndStripH1(body, frontmatter) {
  const lines = body.split('\n');
  let title = null;
  const out = [];
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m && title === null) { title = m[1].trim(); continue; } // drop the H1 line
    out.push(line);
  }
  if (!title) title = (typeof frontmatter.title === 'string' && frontmatter.title) || null;
  return { title, body: out.join('\n').replace(/^\n+/, '') };
}

// Defense-in-depth: this is the B2B blog, not the astrology site. Unwrap any leaked
// astrologywiki.com / oracle-wiki links to plain text so no cross-site link ships.
// Returns { md, scrubbed }.
function scrubCrossSiteLinks(md) {
  let scrubbed = 0;
  const count = (re) => { const n = (md.match(re) || []).length; scrubbed += n; return n; };
  const reAbs = /\[([^\]]+)\]\((?:https?:\/\/)?(?:www\.)?astrologywiki\.com[^)]*\)/gi;
  const reWiki = /\[([^\]]+)\]\(\/(?:en|zh)\/wiki\/[^)]*\)/gi;
  count(reAbs); count(reWiki);
  md = md.replace(reAbs, '$1').replace(reWiki, '$1');
  return { md, scrubbed };
}

function wordCount(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/[#>*_~|\-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim().split(/\s+/).filter(Boolean).length;
}

function toIso(dateVal) {
  if (typeof dateVal === 'string' && dateVal.trim()) {
    const d = dateVal.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d}T08:00:00Z`; // date-only -> morning
    const parsed = new Date(d);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

const sqlStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const sqlBool = (v) => (v ? 'TRUE' : 'FALSE');
const sqlInt = (v) => String(Math.trunc(v));

// ── core: build one blog_posts row from a staged draft ────────────────────────
function buildRow(args) {
  // EN-only (2026-07-03): reject a zh locale loudly BEFORE any IO — the policy
  // error must win over "source not found" so a bad caller sees the real problem.
  if (args.locale && args.locale !== 'en') {
    throw new Error(`--locale ${args.locale} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)`);
  }
  const locale = 'en';
  const sourceAbs = resolve(args.source);
  if (!existsSync(sourceAbs)) throw new Error(`source not found: ${sourceAbs}`);
  const raw = readFileSync(sourceAbs, 'utf8');
  const { frontmatter, body: rawBody } = parseFrontmatter(raw);

  const pageId = args.pageId || (typeof frontmatter.page_id === 'string' ? frontmatter.page_id : '')
    || basename(sourceAbs).match(/(PG-[A-Z0-9]+-\d+)/)?.[1] || '';
  const prefix = pageId.match(/^(PG-[A-Z]+)/)?.[1] || '';
  const pillar = args.pillar || PILLAR_BY_PREFIX[prefix] || DEFAULT_PILLAR;
  if (!VALID_PILLARS.has(pillar)) throw new Error(`invalid pillar '${pillar}' (must be one of ${[...VALID_PILLARS].join(', ')})`);
  let category = args.category || DEFAULT_CATEGORY;
  if (!VALID_CATEGORIES.has(category)) throw new Error(`invalid category '${category}' (must be one of ${[...VALID_CATEGORIES].join(', ')})`);

  const slug = (typeof frontmatter.slug === 'string' && frontmatter.slug)
    ? frontmatter.slug.trim()
    : slugify(frontmatter.target_keyword || pageId);
  if (!slug) throw new Error('could not determine slug (no frontmatter.slug / target_keyword)');

  const { title, body: bodyNoH1 } = extractTitleAndStripH1(rawBody, frontmatter);
  if (!title) throw new Error('no title (no in-body # H1 and no frontmatter.title)');

  const excerpt = deriveDescription(rawBody, 160);

  // markdown -> resolve TBD/links -> scrub cross-site -> HTML -> sanitize (render-path policy).
  // selfSlug suppresses self-links (an article naming its own topic in Related Reading
  // would otherwise resolve back to itself — dead weight that passes no PageRank).
  const resolvedMd = transformBody(bodyNoH1, slug, GENGROWTH_LINK_OPTS);
  const { md: scrubbedMd, scrubbed } = scrubCrossSiteLinks(resolvedMd);
  const rawHtml = marked.parse(scrubbedMd, { gfm: true, async: false });
  const content = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      img: ['src', 'alt', 'width', 'height', 'loading'],
    },
  });

  const words = wordCount(scrubbedMd);
  const readingTime = Math.max(1, Math.round(words / 200));
  const publishedAt = toIso(frontmatter.date);
  const row = {
    id: uuidv5(`${slug}|${locale}`),
    slug,
    title,
    content,
    excerpt,
    category,
    pillar_slug: pillar,
    locale,
    locale_exclusive: true, // EN-only phase; flip to false once a sibling-locale row exists
    author: AUTHOR_BY_LOCALE[locale],
    published_at: publishedAt,
    updated_at: publishedAt, // == published_at initially (must stay >= published_at)
    reading_time: readingTime,
    status: 'published', // the ONLY go-live gate (read path filters status='published')
    created_at: publishedAt,
  };
  // `markdown` is the resolved+scrubbed Markdown that `content` was rendered FROM.
  // --emit md ships this instead of the HTML: the site's canonical source is now a
  // Markdown file, and re-deriving Markdown from sanitized HTML would be lossy.
  return { row, meta: { pageId, pillar, words, scrubbed, sourceAbs, markdown: scrubbedMd } };
}

// ── emit: canonical Markdown file for nevermore's content/blog/<locale>/<slug>.md ──
//
// WHY THIS EXISTS: gengrowth.ai used to render from Supabase `blog_posts`, so this
// bridge emitted sanitized HTML. The site moved its canonical source to versioned
// Markdown in the app repo (apps/marketing/content/blog/README.md), keeping Supabase
// only as a removable, opt-in read bridge. Publishing through Supabase therefore no
// longer puts an article on the site — it just writes a row nothing reads.
//
// The site parses frontmatter with a deliberately small scalar-only reader
// (src/lib/blog-content.ts) and validates it with a `.strict()` zod schema, so:
//   - keys are camelCase and an unknown key FAILS THE BUILD (no extra fields),
//   - `localeExclusive` is the STRING "true"/"false", not a boolean,
//   - `publishedAt`/`updatedAt` are calendar dates (YYYY-MM-DD), not ISO datetimes.
const SITE_FRONTMATTER_KEYS = [
  'title', 'excerpt', 'author', 'category', 'pillar', 'status',
  'publishedAt', 'updatedAt', 'heroImage', 'heroImageAlt', 'localeExclusive',
];

// The site's reader does NOT understand escape sequences — unquoteFrontmatterValue only
// strips a matching leading/trailing quote pair. So a value must never rely on `\"`.
// Its key regex `^([A-Za-z][A-Za-z0-9]*):\s*(.*)$` keeps everything after the FIRST
// colon, which makes colons inside a value safe. That leaves two real hazards:
// embedded newlines (the reader is line-based) and a value that itself begins and ends
// with the same quote (it would be silently unwrapped).
export function siteFrontmatterScalar(value) {
  const flat = String(value ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!flat) return '';
  const quoted = (q) => flat.length >= 2 && flat.startsWith(q) && flat.endsWith(q);
  if (quoted('"')) return `'${flat}'`;   // wrap in the other quote so one pair survives
  if (quoted("'")) return `"${flat}"`;
  return flat;                            // bare is safest: no escaping is ever applied
}

const dateOnly = (iso) => String(iso).slice(0, 10);

export function buildSiteMarkdown(row, meta, opts = {}) {
  const fm = {
    title: row.title,
    excerpt: row.excerpt,
    author: row.author,
    category: row.category,
    pillar: row.pillar_slug,
    status: row.status,
    publishedAt: dateOnly(row.published_at),
    updatedAt: dateOnly(row.updated_at),
    heroImage: opts.heroImage || DEFAULT_HERO_IMAGE,
    heroImageAlt: opts.heroImageAlt || heroAltFor(row.title),
    localeExclusive: row.locale_exclusive ? 'true' : 'false',
  };
  const lines = SITE_FRONTMATTER_KEYS
    .filter((k) => fm[k] !== undefined && fm[k] !== '')
    .map((k) => `${k}: ${siteFrontmatterScalar(fm[k])}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(meta.markdown).trim()}\n`;
}

// ── emit: idempotent SQL upsert, merged-by-(slug,locale) within --out file ────
const COLS = ['id', 'slug', 'title', 'content', 'excerpt', 'category', 'pillar_slug', 'locale',
  'locale_exclusive', 'author', 'published_at', 'updated_at', 'reading_time', 'status', 'created_at'];
// ON CONFLICT updates every column EXCEPT id/slug/locale/created_at (matches seed-blog.sql:826).
const ON_CONFLICT_COLS = ['title', 'content', 'excerpt', 'category', 'pillar_slug', 'locale_exclusive',
  'author', 'published_at', 'updated_at', 'reading_time', 'status'];

function rowToSqlBlock(row) {
  const v = {
    id: sqlStr(row.id), slug: sqlStr(row.slug), title: sqlStr(row.title), content: sqlStr(row.content),
    excerpt: sqlStr(row.excerpt), category: sqlStr(row.category), pillar_slug: sqlStr(row.pillar_slug),
    locale: sqlStr(row.locale), locale_exclusive: sqlBool(row.locale_exclusive), author: sqlStr(row.author),
    published_at: sqlStr(row.published_at), updated_at: sqlStr(row.updated_at),
    reading_time: sqlInt(row.reading_time), status: sqlStr(row.status), created_at: sqlStr(row.created_at),
  };
  const values = COLS.map((c) => v[c]).join(',\n  ');
  const setClause = ON_CONFLICT_COLS.map((c) => `  ${c} = EXCLUDED.${c}`).join(',\n');
  const start = `-- ===== POST ${row.slug} [${row.locale}] =====`;
  const end = `-- ===== END ${row.slug} [${row.locale}] =====`;
  return `${start}
INSERT INTO blog_posts (${COLS.join(', ')})
VALUES (
  ${values}
)
ON CONFLICT (slug, locale) DO UPDATE SET
${setClause};
${end}`;
}

const FILE_HEADER = `-- seed-blog-w25.sql — gengrowth.ai W25+ SEO blog posts.
-- GENERATED by tools/scripts/gg-md-to-gengrowth-blog.mjs (flow-mvp). Do not hand-edit blocks.
-- Apply in prod via supabase CLI or the Supabase SQL Editor (CI does NOT auto-apply).
-- Idempotent: ON CONFLICT (slug, locale) DO UPDATE — safe to re-run.
-- REQUIRES migration 20260327000000_blog_posts_slug_locale_unique.sql applied in prod first.
`;

function mergeIntoSqlFile(outPath, block, slug, locale) {
  const startMark = `-- ===== POST ${slug} [${locale}] =====`;
  const endMark = `-- ===== END ${slug} [${locale}] =====`;
  let existing = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
  if (!existing.trim()) existing = FILE_HEADER;
  const startIdx = existing.indexOf(startMark);
  if (startIdx !== -1) {
    const endIdx = existing.indexOf(endMark, startIdx);
    if (endIdx === -1) throw new Error(`found start marker for ${slug} [${locale}] but no end marker in ${outPath}`);
    const before = existing.slice(0, startIdx).replace(/\n+$/, '\n');
    const after = existing.slice(endIdx + endMark.length).replace(/^\n+/, '');
    return `${before}\n${block}\n${after}`.replace(/\n{3,}/g, '\n\n');
  }
  return `${existing.replace(/\n+$/, '\n')}\n${block}\n`;
}

// ── emit: REST upsert via the CLI-fetched service_role key (the proven CLI flow) ──
// Mirrors wzb's live path: `supabase projects api-keys -o json` -> service_role ->
// POST /rest/v1/blog_posts. Upsert on the (slug,locale) unique constraint via PostgREST
// on_conflict + merge-duplicates. Omits id + created_at so the DB fills them on insert
// and PRESERVES them on conflict (matches the seed ON CONFLICT, which excludes both).
function rowToRestPayload(row) {
  const { id, created_at, ...rest } = row; // eslint-disable-line no-unused-vars
  return rest;
}
async function emitRest(row, { dryRun }) {
  const SB_URL = process.env.SB_URL;
  const SB_KEY = process.env.SB_KEY;
  const payload = rowToRestPayload(row);
  if (dryRun) {
    process.stdout.write(`\n[DRY-RUN --emit rest] POST ${SB_URL || '$SB_URL'}/rest/v1/blog_posts?on_conflict=slug,locale  (SB_KEY ${SB_KEY ? 'set,len ' + SB_KEY.length : 'NOT set'})\n--- payload (omits id/created_at) ---\n${JSON.stringify(payload, null, 2)}\n`);
    return null;
  }
  if (!SB_URL || !SB_KEY) throw new Error('--emit rest needs SB_URL + SB_KEY env. Fetch: SB_KEY=$(supabase projects api-keys --project-ref <ref> -o json | node tools/scripts/oneoff/_emit-sb-key.mjs); SB_URL=https://<ref>.supabase.co');
  const res = await fetch(`${SB_URL}/rest/v1/blog_posts?on_conflict=slug,locale`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`REST upsert failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  try { return JSON.parse(body)[0] || null; } catch { return null; }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n') + '\n');
    process.exit(args.source ? 0 : 1);
  }
  if (!['sql', 'rest', 'md'].includes(args.emit)) throw new Error(`--emit must be 'sql', 'rest' or 'md' (got '${args.emit}')`);

  const { row, meta } = buildRow(args);

  const summary = [
    `page_id:       ${meta.pageId}`,
    `slug:          ${row.slug}`,
    `locale:        ${row.locale}`,
    `title:         ${row.title}`,
    `category:      ${row.category}`,
    `pillar_slug:   ${row.pillar_slug}`,
    `author:        ${row.author}`,
    `status:        ${row.status}`,
    `words:         ${meta.words}  (reading_time=${row.reading_time})`,
    `published_at:  ${row.published_at}`,
    `id (uuidv5):   ${row.id}`,
    `cross-site links scrubbed: ${meta.scrubbed}`,
    `content bytes: ${row.content.length}`,
    `excerpt:       ${row.excerpt}`,
  ].join('\n');

  if (args.emit === 'md') {
    const doc = buildSiteMarkdown(row, meta, { heroImage: args.heroImage, heroImageAlt: args.heroImageAlt });
    if (args.dryRun) { process.stdout.write(`\n[DRY-RUN --emit md] ${meta.sourceAbs}\n${summary}\n\n--- content/blog/${row.locale}/${row.slug}.md ---\n${doc}`); return; }
    if (!args.out) throw new Error("--out <content/blog/<locale>/<slug>.md> required when not --dry-run");
    const outAbs = resolve(args.out);
    atomicWrite(outAbs, doc);
    process.stdout.write(`\n✓ wrote ${outAbs}\n${summary}\n`);
    return;
  }

  if (args.emit === 'rest') {
    const returned = await emitRest(row, args);
    if (args.dryRun) process.stdout.write(`\n${summary}\n`);
    else process.stdout.write(`\n✓ upserted ${row.slug} [${row.locale}] -> ${process.env.SB_URL}/rest/v1/blog_posts\n${summary}\n${returned ? `db id: ${returned.id}\n` : ''}`);
    return;
  }

  // emit === 'sql'
  const block = rowToSqlBlock(row);
  if (args.dryRun) {
    process.stdout.write(`\n[DRY-RUN] ${meta.sourceAbs}\n${summary}\n\n--- SANITIZED HTML (content) ---\n${row.content}\n\n--- SQL BLOCK ---\n${block}\n`);
    return;
  }
  if (!args.out) throw new Error('--out <file.sql> required when not --dry-run');
  const outAbs = resolve(args.out);
  const merged = mergeIntoSqlFile(outAbs, block, row.slug, row.locale);
  atomicWrite(outAbs, merged);
  process.stdout.write(`\n✓ wrote ${row.slug} [${row.locale}] -> ${outAbs}\n${summary}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
}
