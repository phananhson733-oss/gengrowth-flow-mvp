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

const __dirname = dirname(fileURLToPath(import.meta.url));
const FLOW_REPO = join(__dirname, '..', '..');

// Persona cards live here (Lane A owns the .md content; we only READ frontmatter).
const PERSONA_DIR = join(__dirname, 'lib', 'author-personas');

// Resolve author identity for publish metadata (Lane B / T10). Priority:
//   1. Lane A loadPersona(id) loader if/when it lands (lib/author-personas/loader.mjs
//      exporting loadPersona) — preferred single source of truth.
//   2. Fallback: read lib/author-personas/<id>.md frontmatter directly
//      (display_name / primary_focus / credential) — robust until the loader exists.
// Returns { id, displayName, slug, shortBio } or null if author id is absent/invalid.
// authorId comes from the staging md frontmatter `author_id` field (written by
// content-draft's buildAuthorFrontmatter); legacy `author` is accepted at the call site.
export function resolveAuthorMeta(authorId, { personaDir = PERSONA_DIR } = {}) {
  // content-draft writes the byline value JSON-quoted (author_id: "marcus-orion")
  // and parseFrontmatter does not strip quotes, so normalize surrounding quotes
  // before validating — otherwise a valid id reads as invalid → silent house byline.
  const raw = typeof authorId === 'string' ? authorId.replace(/^["']|["']$/g, '').trim() : authorId;
  if (!raw || !isValidAuthorId(raw)) return null;
  const id = normalizeAuthorId(raw);
  const fm = readPersonaFrontmatter(id, personaDir);
  if (!fm) return null;
  const displayName = fm.display_name || id;
  // short bio: prefer explicit credential line, else primary_focus.
  const shortBio = fm.credential || fm.primary_focus || '';
  return { id, displayName, slug: id, shortBio };
}

// Minimal frontmatter reader for persona cards. Only pulls the flat scalar keys
// we need (display_name / primary_focus / credential); ignores list blocks.
// Returns {} on parse trouble, null if the card file is missing.
function readPersonaFrontmatter(id, personaDir) {
  const path = join(personaDir, `${id}.md`);
  if (!existsSync(path)) return null;
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv && kv[2] !== '') {
      // strip surrounding quotes from scalar values like version: "1.0"
      fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    }
  }
  return fm;
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

// Lookup table for resolving TBD wikilink descriptions to real oracle URLs.
// First matching rule wins. Description matching is case-insensitive
// substring/regex. Patterns are intentionally narrow to avoid mis-routing.
// Anything unmatched falls through to an italic placeholder (no fake link).
export const TBD_LINK_RULES = [
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
];

export function resolveTbdLink(description) {
  const d = description.trim();
  for (const rule of TBD_LINK_RULES) {
    if (rule.match.test(d)) return `[${d}](${rule.href})`;
  }
  return `*${d}*`;
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

export function transformBody(body) {
  let out = body;
  out = out.replace(
    /\[\[<TBD-internal-link:\s*([^>]+)>\]\]/g,
    (_m, desc) => resolveTbdLink(desc),
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
  // author display name: persona display name if resolved (Lane B / T10),
  // else fall back to the house byline. authorSlug + authorBio are emitted only
  // when a persona is resolved (oracle author bio page is a later plan).
  const houseAuthor = language === 'zh' ? 'AstrologyWiki 团队' : 'AstrologyWiki Team';
  const author = authorMeta && authorMeta.displayName ? authorMeta.displayName : houseAuthor;
  const authorMetaLines = authorMeta
    ? `  authorSlug: ${JSON.stringify(authorMeta.slug)},\n  authorBio: ${JSON.stringify(authorMeta.shortBio)},\n`
    : '';
  return `export const ${varName}: WikiArticle = {
  slug: ${JSON.stringify(slug)},
  title: ${JSON.stringify(title)},
  description: ${JSON.stringify(description)},
  author: ${JSON.stringify(author)},
${authorMetaLines}  date: ${JSON.stringify(date)},
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
  const title = fm.title;
  if (!title) throw new Error(`no title for ${source}`);
  const date = fm.date || new Date().toISOString().slice(0, 10);
  const tgtKw = fm.target_keyword || '';
  const assoc = Array.isArray(fm.associated_keywords) ? fm.associated_keywords : [];
  const keywords = [tgtKw, ...assoc].filter(Boolean);
  const transformedBody = transformBody(body);
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
      const slug = pageIdToSlug(pid);
      const winnerLlm = winnerMap[pid] || defaultWinnerLlm;
      // ZH source convention: orchestrator --out-dir _staging/zh-demo/ writes
      // <pid>-<llm>-<version>.md there (no .zh in filename — the directory
      // disambiguates). EN stays at <stagingDir>/<pid>-<llm>-<v>.md.
      const source = language === 'zh'
        ? join(stagingDir, 'zh-demo', `${pid}-${winnerLlm}-${version}.md`)
        : join(stagingDir, `${pid}-${winnerLlm}-${version}.md`);
      // Output filename gets .zh infix for ZH so EN/ZH .ts files coexist in
      // oracle articles dir without overwriting. Oracle team then merges into
      // single-file dual-export by hand (follow-up: auto-merge into existing
      // <slug>.ts when present).
      const outName = language === 'zh' ? `${slug}.zh.ts` : `${slug}.ts`;
      const out = join(articlesDir, outName);
      if (!existsSync(source)) {
        process.stderr.write(`✗ missing: ${source}\n`);
        results.push({ pid, ok: false, reason: 'source missing', winnerLlm, language });
        continue;
      }
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
