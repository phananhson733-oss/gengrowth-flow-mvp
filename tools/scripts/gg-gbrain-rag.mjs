#!/usr/bin/env node
// gg-gbrain-rag.mjs — local-knowledge RAG for the v8 renderer, backed by gbrain.
//
// Drop-in replacement for gg-obsidian-rag.mjs's OUTPUT: it writes the same
// .gg-cache/<page_id>/obsidian-rag.json that gg-render-batch consumes (the
// renderer only reads snippets[].text/.title/.section). The difference is the
// SOURCE: gg-obsidian-rag walks the vault and requires a note to contain ALL
// entity tokens (AND match), so a multi-word entity like "full moon ritual"
// matches 0 notes even though the vault is full of lunar-cycle book notes.
// gbrain is the embedded PGLite brain (3k+ pages, hybrid vector+keyword search),
// so it returns the semantically-relevant chunks the AND-matcher misses.
//
// gbrain is self-contained (PGLite at ~/.gbrain), so this works headless under
// launchd as long as ~/.local/bin is on PATH (the binary is resolved below).
//
// Usage:
//   node gg-gbrain-rag.mjs --page-id <id> --entity "<text>" [--target-keyword "<t>"]
//                          [--limit <pages>] [--cache-dir <dir>]
// Always exits 0 with a valid obsidian-rag.json (empty snippets + gap_note if
// gbrain is unavailable) so the render gate never hard-blocks on RAG.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const REPO = process.env.GG_FLOW_REPO || join(HOME, 'gengrowth-flow-mvp');
const GBRAIN = [join(HOME, '.local', 'bin', 'gbrain')].find(existsSync) || 'gbrain';

const MAX_PAGES = 6;          // distinct gbrain pages to pull full text from
const MAX_SNIPPETS = 10;      // total snippets written
const SNIPPET_CHARS = 600;    // per-snippet excerpt cap
const STOP = new Set('a an the and or of to in on for with is are was what how why when which that this your you it its as at by from be can do does on do'.split(/\s+/));

function parseArgs(argv) {
  const o = { limit: MAX_PAGES, cacheDir: join(REPO, '.gg-cache') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--page-id') o.pageId = argv[++i];
    else if (a === '--entity') o.entity = argv[++i];
    else if (a === '--target-keyword') o.targetKeyword = argv[++i];
    else if (a === '--limit') o.limit = parseInt(argv[++i], 10) || MAX_PAGES;
    else if (a === '--cache-dir') o.cacheDir = argv[++i];
  }
  return o;
}

function gbrain(args, timeout = 60000) {
  return execFileSync(GBRAIN, args, { encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

function tokens(text) {
  return [...new Set((text || '').toLowerCase().match(/[a-z0-9]+/g) || [])]
    .filter((t) => t.length >= 3 && !STOP.has(t));
}

// `gbrain query` prints one ranked line per chunk: "[score] slug -- preview…".
function parseQuery(out) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\[([\d.]+)\]\s+(\S+)\s+--\s+(.*)$/);
    if (m) rows.push({ score: parseFloat(m[1]), slug: m[2], preview: m[3] });
  }
  return rows;
}

function stripFrontmatter(md) {
  return md.startsWith('---') ? md.replace(/^---\n[\s\S]*?\n---\n?/, '') : md;
}
function frontmatterTitle(md, slug) {
  const fm = md.startsWith('---') ? md.slice(3, md.indexOf('\n---', 3)) : '';
  const t = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  if (t) return t[1].trim();
  const h1 = md.match(/^#\s+(.+)$/m);
  if (h1) return h1[1].trim();
  return slug.split('/').pop().replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Split body into {heading, text} blocks at markdown headings.
function blocks(body) {
  const out = [];
  let heading = '';
  let buf = [];
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ heading, text: t }); buf = []; };
  for (const line of body.split('\n')) {
    const h = line.match(/^#{1,4}\s+(.+)$/);
    if (h) { flush(); heading = h[1].trim(); } else buf.push(line);
  }
  flush();
  return out;
}

function clean(text) {
  return text
    .replace(/^>\s?/gm, '')                       // blockquote markers
    .replace(/[*_`#]+/g, '')                       // md emphasis/heading marks
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links → label
    .replace(/\s+/g, ' ')
    .trim();
}
function excerpt(text) {
  const c = clean(text);
  if (c.length <= SNIPPET_CHARS) return c;
  const cut = c.slice(0, SNIPPET_CHARS);
  const sp = cut.lastIndexOf(' ');
  return (sp > SNIPPET_CHARS * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

function buildSnippets(pages, entTokens) {
  const snippets = [];
  for (const { slug, title, score, body } of pages) {
    const bs = blocks(body)
      .map((b) => ({ ...b, hits: entTokens.reduce((n, t) => n + (b.text.toLowerCase().includes(t) ? 1 : 0), 0) }))
      .sort((a, b) => b.hits - a.hits || b.text.length - a.text.length);
    const picked = (bs[0]?.hits ? bs.filter((b) => b.hits > 0).slice(0, 2) : bs.slice(0, 1));
    for (const b of picked) {
      if (snippets.length >= MAX_SNIPPETS) break;
      const text = excerpt(b.text);
      if (text.length < 40) continue;
      snippets.push({
        source_id: `gbrain#${snippets.length + 1}`,
        slug,
        title,
        section: b.heading || '',
        text,
        match_score: Number(score.toFixed(4)),
      });
    }
  }
  return snippets;
}

function main(argv) {
  const o = parseArgs(argv);
  if (!o.pageId || !o.entity) {
    process.stderr.write('usage: --page-id <id> --entity "<text>" [--target-keyword <t>] [--limit N]\n');
    process.exit(2);
  }
  const dir = join(o.cacheDir, o.pageId);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, 'obsidian-rag.json');
  const entTokens = tokens(`${o.entity} ${o.targetKeyword || ''}`);

  let snippets = [];
  let gapNote = '';
  try {
    const rows = parseQuery(gbrain(['query', o.entity, '--limit', '24']));
    // dedupe by slug (query is already RRF-ranked), keep the top distinct pages
    const seen = new Set();
    const topSlugs = [];
    for (const r of rows) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      topSlugs.push(r);
      if (topSlugs.length >= o.limit) break;
    }
    const pages = [];
    for (const r of topSlugs) {
      let md;
      try { md = gbrain(['get', r.slug]); } catch { continue; }
      pages.push({ slug: r.slug, score: r.score, title: frontmatterTitle(md, r.slug), body: stripFrontmatter(md) });
    }
    snippets = buildSnippets(pages, entTokens);
    if (!snippets.length) gapNote = `gbrain returned ${rows.length} hits for "${o.entity}" but no usable excerpts`;
  } catch (e) {
    gapNote = `gbrain query failed: ${String(e.message || e).slice(0, 160)}`;
    process.stderr.write(`[gbrain-rag] WARN ${gapNote}\n`);
  }

  const payload = {
    schema_version: '1',
    page_id: o.pageId,
    entity: o.entity,
    source: 'gbrain',
    generated_at: new Date().toISOString(),
    snippets,
    stats: { pages_queried: o.limit, snippets_kept: snippets.length },
  };
  if (gapNote) payload.gap_note = gapNote;
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  process.stdout.write(`gbrain-rag → ${outPath} (${snippets.length} snippets)${gapNote ? ` [${gapNote}]` : ''}\n`);
}

main(process.argv.slice(2));
