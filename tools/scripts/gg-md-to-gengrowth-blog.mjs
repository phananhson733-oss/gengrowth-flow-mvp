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
const AUTHOR_BY_LOCALE = { en: 'GenGrowth Team', zh: 'GenGrowth 团队' };

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
  const sourceAbs = resolve(args.source);
  if (!existsSync(sourceAbs)) throw new Error(`source not found: ${sourceAbs}`);
  const raw = readFileSync(sourceAbs, 'utf8');
  const { frontmatter, body: rawBody } = parseFrontmatter(raw);

  const locale = args.locale === 'zh' ? 'zh' : 'en';
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
  const resolvedMd = transformBody(bodyNoH1, locale);
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
  return { row, meta: { pageId, pillar, words, scrubbed, sourceAbs } };
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

// ── main ──────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.source) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n') + '\n');
    process.exit(args.source ? 0 : 1);
  }
  if (args.emit !== 'sql') throw new Error(`--emit ${args.emit} not implemented yet (only 'sql' in v1)`);

  const { row, meta } = buildRow(args);
  const block = rowToSqlBlock(row);

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
  try { main(); } catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1); }
}
