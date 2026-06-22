// gg-archive-to-vault.mjs — archive a published article into the gengrowth-wiki
// Obsidian vault as an enriched OFM note (RAG / gbrain source).
//
// Flow step (post-deploy): COPIES (never moves) each final EN article from
// _staging/<pid>-en.md into 内容资产/<site>/<Official Title>.md with:
//   - filename = the article's OFFICIAL on-site title (NOT the slug code-name)
//   - enriched OFM frontmatter (tags from keywords, aliases, live url, hero, author)
//   - [[wikilinks]] (互链): in-batch cross-links by title; TBD descriptions resolved
//   - hero + inline infographic embeds (images copied into <site>/, slug-named)
//   - a publish-metadata callout + full article body (for RAG retrieval)
//
// Usage:
//   node tools/scripts/gg-archive-to-vault.mjs --pages "PG-WC-011:vozinha-birth-chart ..." \
//     [--site astrologywiki] [--vault ~/gengrowth-wiki] [--oracle ~/Code/oracle] [--dry-run]

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_REPO = join(__dirname, '..', '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n === undefined || n.startsWith('--')) out[k] = true;
    else { out[k] = n; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const SITE = args.site || 'astrologywiki';
const VAULT = args.vault || join(process.env.HOME, 'gengrowth-wiki');
const ORACLE = args.oracle || '/Users/wzb/Code/oracle';
const DRY = !!args['dry-run'];
const SITE_HOST = args['site-host'] || 'https://www.astrologywiki.com';
const URL_PATH = args['url-path'] || '/en/wiki/'; // leading+trailing slash

const LINK_RULES = [
  [/vinicius.{0,6}(jr|junior).{0,16}(zodiac|sun)\s*sign/i, 'vinicius-jr-zodiac-sign'],
  [/germany\s+world\s+cup.{0,24}(players?|squad).{0,16}chart/i, 'germany-world-cup-players-birth-chart-2026'],
  [/germany\s+world\s+cup\s+2026\s+team\s+astrology|germany.{0,16}team\s+astrology/i, 'germany-world-cup-2026-astrology-team'],
  [/argentina\s+world\s+cup\s+2026\s+astrology/i, 'argentina-world-cup-2026-astrology'],
  [/transit_events\s+cluster|jupiter\s+in\s+cancer.{0,20}saturn\s+in\s+aries|saturn\s+in\s+aries(\s+2026)?(\s+transit)?/i, 'saturn-in-aries-2026'],
  // 6/18 WC player + Cancer-cluster spokes (PG-WC-016~020); before the pillar rule
  [/jude\s+bellingham|bellingham\s+birth\s+chart/i, 'jude-bellingham-birth-chart'],
  [/erling\s+haaland|haaland\s+birth\s+chart/i, 'erling-haaland-birth-chart'],
  [/messi\s+world\s+cup\s+record|messi'?s?\s+world\s+cup\s+astrology/i, 'messi-world-cup-record-astrology'],
  [/lionel\s+messi\s+zodiac\s+sign|messi\s+zodiac\s+sign/i, 'lionel-messi-zodiac-sign'],
  [/harry\s+kane|kane\s+birth\s+chart/i, 'harry-kane-birth-chart'],
  [/cancer\s+zodiac\s+world\s+cup|cancer\s+world\s+cup\s+lens/i, 'cancer-zodiac-world-cup-2026'],
  // 6/18 batch-2 WC player + England-team spokes (PG-WC-021~025); before the pillar rule
  [/james\s+rodr[ií]guez|rodr[ií]guez\s+birth\s+chart/i, 'james-rodriguez-birth-chart'],
  [/luis\s+d[ií]az|d[ií]az\s+birth\s+chart/i, 'luis-diaz-birth-chart'],
  [/yoane\s+wissa|wissa\s+birth\s+chart/i, 'yoane-wissa-birth-chart'],
  [/christian\s+pulisic|pulisic\s+birth\s+chart/i, 'christian-pulisic-birth-chart'],
  [/england\s+world\s+cup\s+2026\s+astrology|england\s+(team|squad|national)\s+(team\s+)?astrology/i, 'england-world-cup-2026-astrology'],
  // 6/21 batch (PG-WC-026/027/028, TRANS-011, MYTH-006); chiron-in-taurus before generic chiron rule
  [/spain\s+world\s+cup\s+2026\s+astrology|la\s+roja\s+astrology|spain\s+(national\s+team\s+)?(birth\s+)?chart/i, 'spain-world-cup-2026-astrology'],
  [/matheus\s+cunha|cunha\s+birth\s+chart/i, 'matheus-cunha-birth-chart'],
  [/scotland\s+(vs\.?\s+|and\s+|[-\s]+)brazil.{0,24}(world\s+cup\s+)?astrology/i, 'scotland-brazil-world-cup-astrology'],
  [/chiron\s+in\s+taurus|chiron\s+taurus(\s+2026)?(\s+transit)?/i, 'chiron-in-taurus-2026-astrology'],
  [/toy\s+story\s+5\s+(characters?\s+)?zodiac|toy\s+story\s+(5\s+)?zodiac\s+signs?/i, 'toy-story-5-zodiac-signs'],
  [/best\s+soccer\s+players?\s+(by\s+)?zodiac|soccer\s+players?\s+by\s+zodiac/i, 'best-soccer-players-zodiac-sign'],
  [/world\s+cup\s+2026\s+june\s+astrology|june\s+2026.{0,16}(transit|astrology)\s+calendar/i, 'world-cup-2026-june-astrology'],
  [/world\s+cup\s+2026\s+astrology\s+(themes?\s+)?(pillar|prediction|hub|overview|guide)|world\s+cup\s+2026\s+astrology\s+themes/i, 'world-cup-2026-astrology-prediction'],
  [/how\s+to\s+read\s+a\s+(national|mundane)/i, 'how-to-read-birth-chart'],
  [/how\s+to\s+read\s+a\s+birth\s+chart/i, 'how-to-read-birth-chart'],
];
function resolveTbd(desc) {
  for (const [re, slug] of LINK_RULES) if (re.test(desc)) return slug;
  return null;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { fm: {}, body: md };
  const fm = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) { key = kv[1]; const v = kv[2].replace(/^["']|["']$/g, '').trim(); fm[key] = v || []; }
    else { const li = line.match(/^\s+-\s+(.*)$/); if (li && key && Array.isArray(fm[key])) fm[key].push(li[1].trim()); }
  }
  return { fm, body: m[2] };
}

function safeTitle(t) {
  return String(t).replace(/[:\\/|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

const TOPIC_TAGS = ['content-asset', SITE, 'seo', 'worldcup2026', 'astrology', 'football-astrology'];

function buildNote({ fm, body, slug, related }) {
  const url = `${SITE_HOST}/en/wiki/${slug}`;
  const title = safeTitle(fm.title || slug);
  const kw = fm.target_keyword || '';
  const assoc = Array.isArray(fm.associated_keywords) ? fm.associated_keywords : [];
  const author = (fm.author_display_name || '').replace(/"/g, '') || fm.author_id || 'AstrologyWiki';
  const tags = [...new Set([...TOPIC_TAGS, ...assoc.map((k) => k.replace(/[^a-z0-9]+/gi, '-').toLowerCase()).filter(Boolean)])];
  const aliases = [...new Set([kw, slug, ...assoc].filter(Boolean))];
  const inBatchBySlug = Object.fromEntries(related.map((r) => [r.slug, r.title]));

  let out = body.replace(/\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g, (_, descRaw) => {
    const desc = descRaw.trim();
    const s = resolveTbd(desc);
    if (!s) return `*${desc}*`;
    const target = inBatchBySlug[s] ? safeTitle(inBatchBySlug[s]) : s;
    return `[[${target}|${desc}]]`;
  });

  const fmBlock = [
    '---',
    `title: "${title.replace(/"/g, "'")}"`,
    `slug: ${slug}`,
    `page_id: ${fm.page_id || ''}`,
    `site: ${SITE}`,
    `url: ${url}`,
    `date: ${fm.date || ''}`,
    `type: content-asset`,
    `status: published`,
    `template: ${fm.template || 'Definition'}`,
    `tier: ${fm.tier || ''}`,
    `author: ${author}`,
    `author_id: ${fm.author_id || ''}`,
    `hero: ${slug}.jpg`,
    `target_keyword: ${kw}`,
    'tags:',
    ...tags.map((t) => `  - ${t}`),
    'aliases:',
    ...aliases.map((a) => `  - ${a}`),
    '---',
    '',
  ].join('\n');

  const callout = [
    `> [!info] 发布信息`,
    `> 已发布于 [${SITE}.com](${url}) · 作者 **${author}** · ${fm.date || ''}`,
    `> hero \`${slug}.jpg\` (1200x675) + 2 内联信息图`,
    '',
    `![[${slug}.jpg]]`,
    '',
  ];

  const relatedBlock = related.length
    ? ['## 相关阅读（互链）', '', ...related.map((r) => `- [[${safeTitle(r.title)}]]`), '', '---', '']
    : ['---', ''];

  return fmBlock + callout.join('\n') + relatedBlock.join('\n') + '\n' + out.trimStart();
}

// ---- backfill mode: source from a JSON dump of oracle WikiArticle objects -----
function linkify(content, slugToTitle) {
  return content.replace(/\[([^\]]+)\]\(\/(?:en|zh)\/(?:wiki|blog)\/([a-z0-9-]+)\)/g, (_, text, slug) => {
    const t = slugToTitle[slug];
    return t ? `[[${safeTitle(t)}|${text}]]` : `[[${slug}|${text}]]`;
  });
}
function buildNoteFromArticle(art, slugToTitle) {
  const url = `${SITE_HOST}${URL_PATH}${art.slug}`;
  const title = safeTitle(art.title || art.slug);
  const heroBase = (art.image || '').split('/').pop() || `${art.slug}.jpg`;
  const kws = Array.isArray(art.keywords) ? art.keywords : [];
  const tags = [...new Set(['content-asset', SITE, 'seo', 'astrology', ...kws.map((k) => k.replace(/[^a-z0-9]+/gi, '-').toLowerCase()).filter(Boolean)])];
  const aliases = [...new Set([art.slug, ...kws].filter(Boolean))];
  const fm = [
    '---', `title: "${title.replace(/"/g, "'")}"`, `slug: ${art.slug}`, `site: ${SITE}`,
    `url: ${url}`, `date: ${art.date || ''}`, `type: content-asset`, `status: published`,
    `author_id: ${art.authorId || ''}`, `hero: ${heroBase}`,
    'tags:', ...tags.map((t) => `  - ${t}`), 'aliases:', ...aliases.map((a) => `  - ${a}`), '---', '',
  ].join('\n');
  const callout = [`> [!info] 发布信息`, `> 已发布于 [${SITE}.com](${url}) · ${art.date || ''}${art.description ? ` · ${art.description}` : ''}`, '', `![[${heroBase}]]`, '', '---', ''];
  return fm + callout.join('\n') + '\n' + linkify(art.content || '', slugToTitle).trimStart();
}
function mainJson() {
  const all = JSON.parse(readFileSync(args['from-json'], 'utf8'));
  const en = all.filter((a) => (a.lang || 'en') === 'en');
  const slugToTitle = Object.fromEntries(all.map((a) => [a.slug, a.title]));
  const attachDir = join(VAULT, '内容资产', SITE, 'attachments');
  if (!DRY) mkdirSync(attachDir, { recursive: true });
  let n = 0, imgs = 0;
  for (const art of en) {
    const dateFolder = art.date || 'undated';
    const notesDir = join(VAULT, '内容资产', SITE, dateFolder);
    if (!DRY) mkdirSync(notesDir, { recursive: true });
    const heroBase = (art.image || '').split('/').pop();
    for (const im of [heroBase, `${art.slug}-i0-en.svg`, `${art.slug}-i1-en.svg`]) {
      if (!im) continue;
      const from = join(ORACLE, 'public', 'images', 'blog', im);
      if (existsSync(from)) { if (!DRY) copyFileSync(from, join(attachDir, im)); imgs++; }
    }
    if (!DRY) writeFileSync(join(notesDir, `${safeTitle(art.title || art.slug)}.md`), buildNoteFromArticle(art, slugToTitle));
    n++;
  }
  console.log(`${DRY ? '[dry] ' : ''}backfilled ${n} EN articles, ${imgs} images -> ${SITE} vault`);
}

function main() {
  if (args['from-json'] && args['from-json'] !== true) return mainJson();
  const pagesArg = args.pages;
  if (!pagesArg || pagesArg === true) { console.error('missing --pages "PID:slug ..." (or --from-json <dump.json>)'); process.exit(2); }
  const pairs = String(pagesArg).trim().split(/\s+/).map((p) => { const [pid, slug] = p.split(':'); return { pid, slug }; });

  const loaded = [];
  for (const { pid, slug } of pairs) {
    const src = join(FLOW_REPO, '_staging', `${pid}-en.md`);
    if (!existsSync(src)) { console.error(`SKIP ${pid}: no ${src}`); continue; }
    const { fm, body } = parseFrontmatter(readFileSync(src, 'utf8'));
    loaded.push({ pid, slug, fm, body, title: fm.title || slug });
  }

  // structure: 内容资产/<site>/<publish-date>/<Official Title>.md
  //            + images in a shared 内容资产/<site>/attachments/ folder
  const attachDir = join(VAULT, '内容资产', SITE, 'attachments');
  if (!DRY) mkdirSync(attachDir, { recursive: true });

  for (const item of loaded) {
    const dateFolder = (args.date && args.date !== true) ? String(args.date) : (item.fm.date || 'undated');
    const notesDir = join(VAULT, '内容资产', SITE, dateFolder);
    if (!DRY) mkdirSync(notesDir, { recursive: true });
    const related = loaded.filter((x) => x.slug !== item.slug).map((x) => ({ slug: x.slug, title: x.title }));
    const note = buildNote({ fm: item.fm, body: item.body, slug: item.slug, related });
    const fname = `${safeTitle(item.title)}.md`;
    const outPath = join(notesDir, fname);
    const imgs = [`${item.slug}.jpg`, `${item.slug}-i0-en.svg`, `${item.slug}-i1-en.svg`];
    let copied = 0;
    for (const im of imgs) {
      const from = join(ORACLE, 'public', 'images', 'blog', im);
      if (existsSync(from)) { if (!DRY) copyFileSync(from, join(attachDir, im)); copied++; }
    }
    if (DRY) console.log(`[dry] ${dateFolder}/${fname}  (${note.length}b, ${related.length} wikilinks, ${copied} imgs)`);
    else { writeFileSync(outPath, note); console.log(`OK ${dateFolder}/${fname}  (${related.length} wikilinks, ${copied} imgs->attachments)`); }
  }
}
main();
