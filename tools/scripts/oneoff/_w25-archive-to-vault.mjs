// One-off: archive the W25 gengrowth.ai cluster into the gengrowth-wiki vault
// (runbook stage 7 — knowledge-base / RAG source). The shared gg-archive-to-vault
// is astrologywiki-tuned (/en/wiki/ path, oracle image copy, -en.md source); this
// generates gengrowth notes directly from the validated _staging/<pid>-claude-v8.md
// with correct /en/blog/ URLs, full markdown body for RAG, and intra-batch
// [[Title]] wikilinks. Idempotent: rewrites the note file each run.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const REPO = '/Users/wzb/gengrowth-flow-mvp';
const VAULT = join(homedir(), 'gengrowth-wiki', '内容资产', 'gengrowth');
const SITE_HOST = 'https://www.gengrowth.ai';

// slug -> official title (for filename + intra-batch wikilink resolution)
const TITLES = {
  'white-label-keyword-research': 'How White-Label Keyword Research Reaches Clients Under Your Own Brand',
  'best-white-label-seo-tool': 'How to Pick the Best White Label SEO Tool by Resale Tier, Not Feature Count',
  'whitelabel-seo-tool': 'How to Tell Which Whitelabel SEO Tool Tier Your Agency Actually Needs',
  'free-white-label-seo': 'Why a Free White Label SEO Report Without Vendor Footers Changes the Math',
  'agency-rank-tracking': 'How Agency Rank Tracking Quietly Decides Your Reporting Margin',
  'seo-reporting-tool-for-seo-companies': 'How an SEO Reporting Tool for SEO Companies Earns Client Trust',
  'local-seo-audit': 'Why a Local SEO Audit Has to Separate Local Pack Signals From Organic Ones',
};

const BATCH = [
  { pid: 'PG-WLS-001', slug: 'white-label-keyword-research', date: '2026-06-16' },
  { pid: 'PG-WLS-002', slug: 'best-white-label-seo-tool', date: '2026-06-17' },
  { pid: 'PG-WLS-003', slug: 'whitelabel-seo-tool', date: '2026-06-17' },
  { pid: 'PG-WLS-004', slug: 'free-white-label-seo', date: '2026-06-17' },
  { pid: 'PG-ART-001', slug: 'agency-rank-tracking', date: '2026-06-17' },
  { pid: 'PG-ART-002', slug: 'seo-reporting-tool-for-seo-companies', date: '2026-06-17' },
  { pid: 'PG-ART-003', slug: 'local-seo-audit', date: '2026-06-17' },
];

function splitFm(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n+([\s\S]*)$/);
  if (!m) throw new Error('no frontmatter');
  return { fmRaw: m[1], body: m[2] };
}

function stripH1(body) {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => /^#\s+/.test(l));
  if (i === -1) return body;
  return [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n').replace(/^\s+/, '');
}

// /en/blog/<slug> markdown links -> [[Official Title|anchor]] Obsidian wikilinks.
function toWikilinks(body) {
  return body.replace(/\[([^\]]+)\]\(\/en\/blog\/([a-z0-9-]+)\)/g, (_m, anchor, slug) => {
    const title = TITLES[slug];
    return title ? `[[${title}|${anchor}]]` : anchor;
  });
}

function firstParagraph(body) {
  for (const blk of body.split(/\n\s*\n/)) {
    const t = blk.trim();
    if (!t || /^[#>\-*|\d]/.test(t) || t.startsWith('<')) continue;
    const plain = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[[^|\]]*\|?([^\]]*)\]\]/g, '$1').replace(/\s+/g, ' ').trim();
    if (plain.length >= 40) return plain.length > 260 ? plain.slice(0, 257) + '…' : plain;
  }
  return '';
}

let done = 0;
for (const a of BATCH) {
  const src = join(REPO, '_staging', `${a.pid}-claude-v8.md`);
  const { body: rawBody } = splitFm(readFileSync(src, 'utf8'));
  const title = TITLES[a.slug];
  const body = toWikilinks(stripH1(rawBody));
  const url = `${SITE_HOST}/en/blog/${a.slug}`;
  const excerpt = firstParagraph(body);

  const note = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `slug: ${a.slug}`,
    'site: gengrowth',
    `url: ${url}`,
    `date: ${a.date}`,
    'type: content-asset',
    'status: published',
    'author_id: GenGrowth Team',
    'tags:',
    '  - content-asset',
    '  - gengrowth',
    '  - seo',
    '  - b2b',
    '  - methodology',
    '  - seo-content',
    'aliases:',
    `  - ${a.slug}`,
    '---',
    '> [!info] 发布信息',
    `> 已发布于 [gengrowth.ai](${url}) · ${a.date}${excerpt ? ` · ${excerpt}` : ''}`,
    '',
    '---',
    '',
    body.trim(),
    '',
  ].join('\n');

  const dir = join(VAULT, a.date);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${title}.md`);
  writeFileSync(out, note);
  const wikilinks = (body.match(/\[\[/g) || []).length;
  console.log(`✓ ${a.pid} -> 内容资产/gengrowth/${a.date}/${title}.md  (${body.length}c, ${wikilinks} wikilinks, excerpt=${excerpt ? 'y' : 'n'})`);
  done++;
}
console.log(`\narchived ${done}/${BATCH.length} into ${VAULT}`);
