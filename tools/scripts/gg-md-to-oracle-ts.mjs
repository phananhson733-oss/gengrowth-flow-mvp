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
// Body transforms applied (in order):
//   1. Replace `[[<TBD-internal-link: X>]]` → `**X**` (bold placeholder)
//   2. Trim trailing whitespace
//   3. Escape backticks + `${` for safe embedding in TS template literal
//
// Description: first ~160 chars of first paragraph after first ## section.
// Keywords: target_keyword as first item, then associated_keywords.
// Lang: 'en' (our articles are EN-only).
// Author: 'AstrologyWiki Team' (matches existing oracle convention).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_REPO = join(__dirname, '..', '..');

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

export function slugToCamel(slug, suffix = 'En') {
  const camel = slug
    .split('-')
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join('');
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
  let collecting = false;
  let para = '';
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (!collecting) {
        collecting = true;
        continue;
      } else {
        break;
      }
    }
    if (collecting) {
      if (line.trim() === '') {
        if (para) break;
      } else if (/^#{1,6}\s/.test(line)) {
        break;
      } else {
        para += (para ? ' ' : '') + line.trim();
      }
    }
  }
  let cleaned = para
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length > maxLen) {
    cleaned = cleaned.slice(0, maxLen - 3).replace(/\s+\S*$/, '') + '...';
  }
  return cleaned;
}

export function transformBody(body) {
  let out = body;
  out = out.replace(/\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g, '**$1**');
  out = out.trimEnd();
  return out;
}

export function escapeForTemplate(s) {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

export function emitTs({ slug, title, date, description, keywords, body, varName }) {
  const escapedBody = escapeForTemplate(body);
  const keywordsLit = JSON.stringify(keywords, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  return `// Article: ${title}
// Generated from flow-mvp _staging/ by tools/scripts/gg-md-to-oracle-ts.mjs.
import type { WikiArticle } from "../../types";

export const ${varName}: WikiArticle = {
  slug: ${JSON.stringify(slug)},
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(description)},
  author: "AstrologyWiki Team",
  date: ${JSON.stringify(date)},
  schema: "Article",
  lang: "en",
  keywords: ${keywordsLit},
  content: \`${escapedBody}
\`,
};
`;
}

function convertOne({ source, slug, out }) {
  const md = readFileSync(source, 'utf8');
  const { frontmatter: fm, body } = parseFrontmatter(md);
  const resolvedSlug = slug || fm.slug;
  if (!resolvedSlug) throw new Error(`no slug for ${source}`);
  const title = fm.title;
  if (!title) throw new Error(`no title for ${source}`);
  const date = fm.date || new Date().toISOString().slice(0, 10);
  const tgtKw = fm.target_keyword || '';
  const assoc = Array.isArray(fm.associated_keywords) ? fm.associated_keywords : [];
  const keywords = [tgtKw, ...assoc].filter(Boolean);
  const transformedBody = transformBody(body);
  const description = deriveDescription(transformedBody);
  const varName = slugToCamel(resolvedSlug, 'En');
  const ts = emitTs({ slug: resolvedSlug, title, date, description, keywords, body: transformedBody, varName });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, ts);
  return { slug: resolvedSlug, varName, out };
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

async function main(argv) {
  const args = parseArgs(argv);
  if (args.h || args.help) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n').slice(1, 24).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }

  if (args.batch) {
    const winnerLlm = args.winner_llm || 'claude';
    const version = args.version || 'v8';
    const articlesDir = args.oracle_articles_dir || '/Users/wzb/Code/oracle/data/articles';
    const pages = (args.pages && args.pages !== true) ? args.pages.split(/\s+/) : DEFAULT_PAGES;
    const stagingDir = args.staging_dir || join(FLOW_REPO, '_staging');
    const results = [];
    for (const pid of pages) {
      const slug = pageIdToSlug(pid);
      const source = join(stagingDir, `${pid}-${winnerLlm}-${version}.md`);
      const out = join(articlesDir, `${slug}.ts`);
      if (!existsSync(source)) {
        process.stderr.write(`✗ missing: ${source}\n`);
        results.push({ pid, ok: false, reason: 'source missing' });
        continue;
      }
      try {
        const r = convertOne({ source, slug, out });
        process.stdout.write(`✓ ${r.slug}  →  ${r.out}  (var: ${r.varName})\n`);
        results.push({ pid, ok: true, ...r });
      } catch (e) {
        process.stderr.write(`✗ ${pid}: ${e.message}\n`);
        results.push({ pid, ok: false, reason: e.message });
      }
    }
    const ok = results.filter((r) => r.ok);
    process.stderr.write(`\nbatch: ${ok.length}/${results.length} converted\n`);
    // Emit index.ts patch hint (imports + push lines) as machine-readable summary on stdout.
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
  const r = convertOne({ source: args.source, slug: args.slug, out: args.out });
  process.stdout.write(`✓ ${r.slug}  →  ${r.out}  (var: ${r.varName})\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { convertOne, main };
