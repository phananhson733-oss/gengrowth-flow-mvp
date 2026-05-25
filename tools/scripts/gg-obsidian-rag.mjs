#!/usr/bin/env node
// gg-obsidian-rag.mjs — GenGrowth Phase 0 RAG source #4: Obsidian wiki indexer.
//
// Purpose: replace the web-scraped entity-passport RAG (which returned nav
// boilerplate + wrong-topic Wikipedia search results) with high-quality
// curated content from wzb's personal Obsidian vault committed at
// wzb-obsidian/LLM-Wiki/. The vault contains 30+ deep-reading astrology book
// notes (Liz Greene / Stephen Arroyo / Robert Hand / Steven Forrest) plus
// ~2200 other curated pages — vastly better RAG fuel than scraped web text.
//
// Usage:
//   node tools/scripts/gg-obsidian-rag.mjs \
//     --page-id page_saturn_return \
//     --entity "saturn return" \
//     --target-keyword "saturn return meaning"
//
// Output: .gg-cache/{page_id}/obsidian-rag.json (schema_version "1").
//
// Downstream: gg-content-draft.mjs Phase 1 reads this cache + emits a
// <source name="obsidian-wiki"> XML block in the rendered prompt alongside
// entity-passport / friction-mine / serp-top-10.
//
// Pure Node built-in. No npm. No LLM. No network.

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  sanitize,
  validateWritePath,
  redact,
} from './lib/gg-shared.mjs';
// bilingual-v9-full: share the word-aware ZH tokenizer (Intl.Segmenter +
// ZH_DOMAIN_LEXICON) so RAG matching against ZH notes uses the same
// segmentation as phase2 RL4. Without this, entity "蓝色气场" would tokenize
// to a single 4-char glob and never match note bodies that segment as
// "蓝色 气场".
import { tokenizeKeepStop as tokenizeZhAware } from './lib/red-lines.mjs';

// ============================================================
// constants
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DEFAULT_CACHE = join(REPO_ROOT, '.gg-cache');

// Vault path resolution order (first existing wins; CLI --vault-dir / env
// GG_OBSIDIAN_VAULT override these defaults). Historical layout: vault was
// once a submodule under flow-mvp; in production it lives in the sibling
// gengrowth-wiki repo. Both paths checked so old configs keep working.
export const VAULT_CANDIDATES = [
  join(homedir(), 'gengrowth-wiki', 'wzb-obsidian', 'LLM-Wiki'),
  join(REPO_ROOT, '..', 'gengrowth-wiki', 'wzb-obsidian', 'LLM-Wiki'),
  join(REPO_ROOT, 'wzb-obsidian', 'LLM-Wiki'),
];

export function resolveDefaultVault() {
  if (process.env.GG_OBSIDIAN_VAULT) return process.env.GG_OBSIDIAN_VAULT;
  for (const candidate of VAULT_CANDIDATES) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore stat/permission errors, try next
    }
  }
  // Return last candidate so the existing "vault not found" error path
  // surfaces a sensible message instead of an undefined-path NPE.
  return VAULT_CANDIDATES[VAULT_CANDIDATES.length - 1];
}

const DEFAULT_VAULT = resolveDefaultVault();

const TOOL_NAME = 'gg-obsidian-rag';
const TOOL_VERSION = `${TOOL_NAME} v1.0`;
const SCHEMA_VERSION = '1';

// Spec §11: path-traversal slug whitelist (same regex as sibling tools).
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// Caps (mirror friction-mine / entity-passport conservatism).
const MAX_NOTES = 8;          // top-N notes after ranking
const MAX_SNIPPETS = 12;      // grand-total snippet cap across all notes
const MAX_SNIPPET_CHARS = 600;
const MIN_SECTION_CHARS = 80; // skip structural skeleton sections
const MAX_NOTE_BYTES = 256 * 1024; // 256 KB — skip mega-files (likely indexes)
const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// Final score floor (after path-preference multiplier): notes scoring below
// this are dropped as noise. T3 × Tech multiplier (0.7 * 0.6 = 0.42) is below
// this floor, which correctly filters out project meta-docs that mention an
// entity as an example but aren't actually about it. Books T5 hits with
// multi-token adjacent matches land at 0.31 + 0.2 × 1.4 ≈ 0.7, well above.
const MIN_FINAL_SCORE = 0.5;

// Exit codes.
const EXIT = Object.freeze({
  OK: 0,
  FATAL: 1,
  CLI: 2,
});

// ============================================================
// CLI
// ============================================================

function parseArgs(argv) {
  const out = {
    pageId: null,
    entity: null,
    entityZh: null,
    targetKeyword: '',
    targetKeywordZh: '',
    language: 'en',
    vaultDir: DEFAULT_VAULT,
    cacheDir: DEFAULT_CACHE,
    help: false,
    rebuildIndex: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--page-id') out.pageId = argv[++i];
    else if (a === '--entity') out.entity = argv[++i];
    else if (a === '--entity-zh') out.entityZh = argv[++i];
    else if (a === '--target-keyword') out.targetKeyword = argv[++i] || '';
    else if (a === '--target-keyword-zh') out.targetKeywordZh = argv[++i] || '';
    else if (a === '--language') out.language = argv[++i];
    else if (a === '--vault-dir') out.vaultDir = argv[++i];
    else if (a === '--cache-dir') out.cacheDir = argv[++i];
    else if (a === '--rebuild-index') out.rebuildIndex = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`${TOOL_VERSION} — Phase 0 RAG indexer for Obsidian vault

usage:
  node tools/scripts/gg-obsidian-rag.mjs \\
    --page-id <slug> --entity "<entity>" [--target-keyword "<kw>"]

flags:
  --page-id <slug>            required (matches [A-Za-z0-9_-]{1,64})
  --entity "<text>"           required (used for matching, EN side)
  --entity-zh "<text>"        optional ZH entity (e.g. "蓝色气场") — when set,
                              notes are scored against BOTH EN and ZH tokens
                              so the same cache serves EN+ZH renders
  --target-keyword "<text>"   optional (echoed into output for traceability)
  --target-keyword-zh "<text>" optional (echoed into output as target_keyword_zh)
  --language en|zh            optional (default en); echoed into output
  --vault-dir <path>          default ${DEFAULT_VAULT}
                              (override via env GG_OBSIDIAN_VAULT)
  --cache-dir <path>          default .gg-cache/
  --rebuild-index             force walk vault again (ignores cached index)
`);
}

// ============================================================
// utility helpers
// ============================================================

export function validatePageId(pageId) {
  if (typeof pageId !== 'string' || !pageId) {
    throw new Error('--page-id required (slug, [A-Za-z0-9_-]{1,64})');
  }
  if (!PAGE_ID_REGEX.test(pageId)) {
    throw new Error(`--page-id must match ${PAGE_ID_REGEX} (got: ${pageId.slice(0, 40)})`);
  }
  return pageId;
}

// Tokens used for matching: lowercase ASCII alnum, drop stopwords + single chars.
const STOPWORDS = new Set([
  'a', 'an', 'and', 'the', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are',
  'was', 'were', 'be', 'or', 'as', 'by', 'it', 'its', 'this', 'that', 'with',
]);

export function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  // bilingual-v9-full: route ZH content through the word-aware tokenizer
  // (Intl.Segmenter + ZH_DOMAIN_LEXICON shared with phase2 RL4) so entity
  // tokens for ZH inputs come out as words ("蓝色", "气场") rather than a
  // single contiguous glob ("蓝色气场代表什么"). EN behavior unchanged.
  if (/[一-鿿]/.test(text)) {
    return tokenizeZhAware(text).filter((t) => t.length >= 1 && !STOPWORDS.has(t));
  }
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9一-鿿\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

// bilingual-v9-full: combine EN + ZH entity tokens for matching when both
// are available. Used by main() when --language zh or --entity-zh is passed.
// Concept: a single Obsidian RAG cache can serve both EN and ZH renders so
// long as the matching step considers tokens from both languages.
export function combineEntityTokens(entityEn, entityZh) {
  const en = entityEn ? tokenize(entityEn) : [];
  const zh = entityZh ? tokenize(entityZh) : [];
  // Dedup while preserving order: EN first (existing ranking behavior), ZH
  // appended for additional reach into ZH notes.
  const seen = new Set();
  const out = [];
  for (const t of [...en, ...zh]) {
    if (!seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// ============================================================
// indexer
// ============================================================

// Directory names to skip (anywhere in the tree). These are project artifacts
// that would create a feedback loop if indexed (the tool indexing its own
// previous outputs). Tech/dry-run-samples/ contains previous draft outputs
// from gg-content-draft; _staging/ is the active draft directory; etc.
const SKIP_DIR_NAMES = new Set([
  'dry-run-samples',
  '_staging',
  '_outputs',
  'v5-outputs',
  'v6-outputs',
  'v7-outputs',
]);

// Recursively walk a directory and yield .md file paths.
// Skip hidden dirs (.git, .obsidian) + node_modules + SKIP_DIR_NAMES.
export function walkMarkdown(root, options = {}) {
  const skipNames = options.skipNames || SKIP_DIR_NAMES;
  const out = [];
  const visited = new Set();
  function visit(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const name = ent.name;
      if (name.startsWith('.')) continue;
      if (name === 'node_modules') continue;
      if (skipNames.has(name)) continue;
      const full = join(dir, name);
      if (ent.isSymbolicLink()) continue; // skip symlinks for safety
      if (ent.isDirectory()) {
        if (visited.has(full)) continue;
        visited.add(full);
        visit(full);
      } else if (ent.isFile() && name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  visit(root);
  return out;
}

// Parse YAML frontmatter (only top-of-file --- ... --- block).
// Best-effort: handles `key: value`, `key:` followed by `- item` lists, and
// quoted strings. Does NOT support nested objects or multi-line scalars.
export function parseFrontmatter(text) {
  const out = { _present: false };
  if (typeof text !== 'string') return out;
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  const body = text.slice(3, end).split('\n').filter((l) => l.length > 0);
  out._present = true;
  let currentKey = null;
  let currentArr = null;
  for (const rawLine of body) {
    // strip trailing comment
    const line = rawLine.replace(/\s+#.*$/, '');
    // array item: "  - foo"
    const arrMatch = line.match(/^\s*-\s+(.*)$/);
    if (arrMatch && currentArr) {
      currentArr.push(stripQuotes(arrMatch[1].trim()));
      continue;
    }
    // key: value (or "key:" for upcoming list)
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) {
      currentKey = null;
      currentArr = null;
      continue;
    }
    currentKey = kv[1];
    const rawVal = kv[2].trim();
    if (rawVal === '') {
      currentArr = [];
      out[currentKey] = currentArr;
    } else {
      // inline array? `tags: [a, b]`
      const inlineArr = rawVal.match(/^\[(.*)\]$/);
      if (inlineArr) {
        out[currentKey] = inlineArr[1]
          .split(',').map((s) => stripQuotes(s.trim())).filter(Boolean);
        currentArr = null;
      } else {
        out[currentKey] = stripQuotes(rawVal);
        currentArr = null;
      }
    }
  }
  return out;
}

function stripQuotes(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/^["']|["']$/g, '');
}

// Strip frontmatter and return body text.
function stripFrontmatter(text) {
  if (typeof text !== 'string' || !text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  // skip past the closing --- line
  const after = text.indexOf('\n', end + 4);
  return after < 0 ? '' : text.slice(after + 1);
}

// Extract sections by H1/H2/H3 headings. Returns [{ level, heading, body }].
// body is text from the heading line until the next equal-or-higher heading.
export function extractSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { level: m[1].length, heading: m[2].trim(), bodyLines: [] };
    } else if (cur) {
      cur.bodyLines.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections.map((s) => ({
    level: s.level,
    heading: s.heading,
    body: s.bodyLines.join('\n').trim(),
  }));
}

// Extract [[wikilinks]] from body text. Returns [targetNoteTitle, ...].
// Handles `[[Note Title]]` and `[[Note Title|Display Text]]` (returns title).
export function extractWikilinks(text) {
  if (!text) return [];
  const out = new Set();
  const re = /\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const target = m[1].trim();
    if (target) out.add(target);
  }
  return [...out];
}

// Build the in-memory note index.
// noteByPath:  abs path -> { title, frontmatter, sections, wikilinks, titleTokens, allTokens, size }
export function buildIndex(vaultRoot) {
  const noteByPath = {};
  let scanned = 0;
  let skipped = 0;
  const files = walkMarkdown(vaultRoot);
  for (const file of files) {
    scanned++;
    let st;
    try { st = statSync(file); } catch { skipped++; continue; }
    if (!st.isFile()) { skipped++; continue; }
    if (st.size > MAX_NOTE_BYTES) { skipped++; continue; }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { skipped++; continue; }

    const fm = parseFrontmatter(text);
    const body = stripFrontmatter(text);
    const sections = extractSections(body);

    // Title: prefer frontmatter, fall back to first H1, fall back to filename.
    let title = (fm && typeof fm.title === 'string') ? fm.title : '';
    if (!title) {
      const h1 = sections.find((s) => s.level === 1);
      if (h1) title = h1.heading;
    }
    if (!title) {
      title = file.split(sep).pop().replace(/\.md$/i, '');
    }

    // Collect alias tokens (frontmatter aliases / tags).
    const aliasTexts = [];
    if (Array.isArray(fm.aliases)) for (const a of fm.aliases) aliasTexts.push(String(a));
    if (Array.isArray(fm.alias)) for (const a of fm.alias) aliasTexts.push(String(a));
    if (Array.isArray(fm.tags)) for (const a of fm.tags) aliasTexts.push(String(a));

    const headingsText = sections.map((s) => s.heading).join(' ');
    const titleTokens = new Set(tokenize(title).concat(tokenize(aliasTexts.join(' '))));
    const headingTokens = new Set(tokenize(headingsText));
    const wikilinks = extractWikilinks(body);

    noteByPath[file] = {
      title,
      frontmatter: fm,
      aliasTexts,
      sections,
      wikilinks,
      titleTokens: [...titleTokens],
      headingTokens: [...headingTokens],
      size: st.size,
    };
  }
  return { noteByPath, scanned, skipped };
}

// ============================================================
// entity matcher
// ============================================================

// Score a single note against entity tokens. Returns { score, tier, matched }.
// Tiers (highest tier wins; score reflects strength within tier):
//   T1 (1.0): note title contains ALL entity tokens
//   T2 (0.9): frontmatter alias/tag contains ALL entity tokens
//   T3 (0.7): any heading contains ALL entity tokens
//   T4 (0.5): wikilink graph proximity (handled in rankNotes, not here)
//   T5 (0.3+): body content match by token frequency (last resort)
export function scoreNote(note, entityTokens, body) {
  if (entityTokens.length === 0) return { score: 0, tier: null, matched: [] };
  const titleHas = entityTokens.every((t) => note.titleTokens.includes(t));
  if (titleHas) return { score: 1.0, tier: 'T1', matched: entityTokens };

  // T2: aliases / tags
  const aliasBlob = note.aliasTexts.join(' ').toLowerCase();
  const aliasHas = entityTokens.every((t) => aliasBlob.includes(t));
  if (aliasHas && note.aliasTexts.length > 0) {
    return { score: 0.9, tier: 'T2', matched: entityTokens };
  }

  // T3: headings
  const headingHas = entityTokens.every((t) => note.headingTokens.includes(t));
  if (headingHas) return { score: 0.7, tier: 'T3', matched: entityTokens };

  // T5: body match — for multi-token entities, require phrase-level adjacency
  // (within 60 chars) of all tokens, not just disjoint mentions anywhere.
  // Single-token entities just need substring presence.
  // Density formula: each adjacent-hit contributes ~0.07 (capped at 0.5).
  // This gives a 1-hit doc score 0.37, a 3-hit doc 0.51, and a 5+-hit doc 0.6,
  // so Books × 1.4 multiplier puts even single-hit book notes above the 0.5
  // floor (0.37 × 1.4 = 0.52). Spec/Tech docs without phrase-adjacent hits
  // never get T5; with hits, the 0.6 path multiplier keeps them at 0.22-0.36,
  // safely below the floor.
  if (body && body.length > 0) {
    const lower = body.toLowerCase();
    const adjacencyHits = countAdjacentHits(lower, entityTokens, 60);
    if (adjacencyHits > 0) {
      const density = Math.min(0.5, 0.07 * adjacencyHits);
      return { score: 0.3 + density, tier: 'T5', matched: entityTokens, hits: adjacencyHits };
    }
  }
  return { score: 0, tier: null, matched: [] };
}

// Count windows (≤ winChars) in text that contain ALL entityTokens as whole
// words. For 1-token entities, just count word occurrences. For 2+ tokens,
// slide a window: for each occurrence of token[0], check if all other tokens
// appear within winChars after it.
export function countAdjacentHits(textLower, entityTokens, winChars = 60) {
  if (!textLower || entityTokens.length === 0) return 0;
  if (entityTokens.length === 1) {
    const re = new RegExp(`\\b${escapeRegex(entityTokens[0])}\\b`, 'g');
    const m = textLower.match(re);
    return m ? m.length : 0;
  }
  const first = entityTokens[0];
  const rest = entityTokens.slice(1);
  const firstRe = new RegExp(`\\b${escapeRegex(first)}\\b`, 'g');
  let count = 0;
  let m;
  while ((m = firstRe.exec(textLower)) !== null) {
    const start = m.index;
    const end = Math.min(textLower.length, start + first.length + winChars);
    const window = textLower.slice(start, end);
    const allPresent = rest.every((t) => new RegExp(`\\b${escapeRegex(t)}\\b`).test(window));
    if (allPresent) count++;
  }
  return count;
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Path-based preference. Returns a multiplier applied to the base tier score.
// Notes/Books/ is the deep-reading book notes corpus (Liz Greene / Arroyo / etc.)
// — wzb's hand-curated long-form content, ideal RAG fuel.
// Tech/ is project specs / SOPs that often use entities as examples but aren't
// authoritative on the entity itself; demote so we don't bury book content.
export function pathPreferenceMultiplier(path) {
  if (!path || typeof path !== 'string') return 1.0;
  const lower = path.toLowerCase();
  if (lower.includes(`${sep}notes${sep}books${sep}`)) return 1.4;
  if (lower.includes(`${sep}books${sep}`)) return 1.3;
  if (lower.includes(`${sep}knowledge${sep}`)) return 1.1;
  if (lower.includes(`${sep}tech${sep}`)) return 0.6;
  if (lower.includes(`${sep}writing${sep}`)) return 0.8;
  return 1.0;
}

// Rank notes against entity. Returns top-N candidates.
//
// Path-based preference: curated long-form content under Notes/Books/ is
// preferred over project spec docs under Tech/ when both match the same
// entity tokens. This is a 1.4x multiplier applied to the base tier score,
// reflecting wzb's curation: the book reading notes are deep-reading 100+
// line essays distilled from authoritative astrology authors, whereas Tech/
// docs are tool specs that just happen to use the entity as an example.
export function rankNotes(index, entity, options = {}) {
  const max = options.max || MAX_NOTES;
  const entityTokens = tokenize(entity);
  // bilingual-v9-full: caller may pass options.entityTokensZh (ZH tokens) to
  // ALSO score each note against the ZH entity. Notes are scored under EACH
  // language separately, and the higher of the two scores wins. This lets a
  // single RAG cache cover both EN and ZH renders — EN renders prefer EN-
  // matched notes, ZH renders prefer ZH-matched notes.
  const entityTokensZh = options.entityTokensZh || null;
  if (entityTokens.length === 0 && (!entityTokensZh || entityTokensZh.length === 0)) return [];

  const scoreOne = (note, body) => {
    const candidates = [];
    if (entityTokens.length) candidates.push(scoreNote(note, entityTokens, body));
    if (entityTokensZh && entityTokensZh.length) candidates.push(scoreNote(note, entityTokensZh, body));
    return candidates.reduce((a, b) => (b.score > a.score ? b : a), { score: 0, tier: null, matched: [] });
  };

  // First pass: tier 1-3 + tier 5 (cheap; uses precomputed token sets).
  // We avoid loading body for T1/T2/T3 hits; only fall back to body for T5.
  const ranked = [];
  for (const [path, note] of Object.entries(index.noteByPath)) {
    // Cheap path: title/alias/heading match without body.
    let res = scoreOne(note, '');
    if (res.score === 0) {
      // Read body lazily for T5 check (only first 16 KB to keep cost bounded).
      let body = '';
      try {
        const raw = readFileSync(path, 'utf8');
        body = stripFrontmatter(raw).slice(0, 16 * 1024);
      } catch { /* skip */ }
      res = scoreOne(note, body);
    }
    if (res.score > 0) {
      const multiplier = pathPreferenceMultiplier(path);
      const adjusted = res.score * multiplier;
      ranked.push({
        path, note, score: adjusted, tier: res.tier, matched: res.matched,
        pref_mult: multiplier,
      });
    }
  }

  // Tier 4: wikilink graph proximity — a note that links to a T1/T2 match
  // gets at least 0.5 score (if not already higher).
  const strongHits = new Set(
    ranked.filter((r) => r.tier === 'T1' || r.tier === 'T2').map((r) => r.note.title),
  );
  if (strongHits.size > 0) {
    for (const [path, note] of Object.entries(index.noteByPath)) {
      if (ranked.find((r) => r.path === path)) continue;
      const hasLink = (note.wikilinks || []).some((w) => strongHits.has(w));
      if (hasLink) {
        ranked.push({
          path, note, score: 0.5, tier: 'T4', matched: entityTokens, via: 'wikilink',
        });
      }
    }
  }

  // If tiers 1-4 produced < 3 matches, keep T5 results in the pool (they're
  // already in `ranked`). Otherwise drop T5 to keep signal-to-noise high.
  const upperTier = ranked.filter((r) => r.tier !== 'T5');
  const pool = upperTier.length >= 3 ? upperTier : ranked;

  // Apply final score floor — see MIN_FINAL_SCORE comment.
  const filtered = pool.filter((r) => r.score >= MIN_FINAL_SCORE);

  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, max);
}

// ============================================================
// section extractor
// ============================================================

// Within a candidate note, pick the section (H2 or H3) that best matches the
// entity. Returns [{ heading, text, score }] (1-3 best sections per note).
export function extractRelevantSections(note, entityTokens, maxPerNote = 2) {
  const sections = note.sections || [];
  if (sections.length === 0) return [];

  // Score each section: heading-token match + body keyword density.
  const scored = [];
  for (const sec of sections) {
    if (sec.level > 3) continue; // skip H4+
    const body = sec.body || '';
    if (body.length < MIN_SECTION_CHARS) continue;

    const headingTokens = tokenize(sec.heading);
    const bodyLower = body.toLowerCase();
    let headingScore = 0;
    let bodyScore = 0;
    for (const t of entityTokens) {
      if (headingTokens.includes(t)) headingScore += 2;
      const re = new RegExp(`\\b${escapeRegex(t)}\\b`, 'g');
      const m = bodyLower.match(re);
      if (m) bodyScore += m.length;
    }
    const total = headingScore + Math.min(bodyScore, 10);
    if (total === 0) continue;

    scored.push({
      heading: sec.heading,
      level: sec.level,
      body,
      score: total,
    });
  }

  // Fallback: if no section scored, take the first 1-2 substantial H2 sections
  // (covers the case where the entity appears only in the note's title — common
  // for a Liz Greene "Saturn" book where every section is about Saturn).
  if (scored.length === 0) {
    for (const sec of sections) {
      if (sec.level === 2 && (sec.body || '').length >= MIN_SECTION_CHARS) {
        scored.push({
          heading: sec.heading,
          level: sec.level,
          body: sec.body,
          score: 0.1, // sentinel — low but non-zero
        });
        if (scored.length >= maxPerNote) break;
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPerNote);
}

// Truncate at sentence boundary near the cap. Returns text ≤ cap chars.
export function truncateAtSentence(text, cap = MAX_SNIPPET_CHARS) {
  if (typeof text !== 'string') return '';
  if (text.length <= cap) return text;
  const slice = text.slice(0, cap);
  // Look for last sentence-end (. ! ? followed by space or end) in the last
  // min(200, slice.length) chars so we don't run off the front for small caps.
  const lookbackLen = Math.min(200, slice.length);
  const tailStart = slice.length - lookbackLen;
  const tail = slice.slice(tailStart);
  const lastEnd = Math.max(
    tail.lastIndexOf('. '),
    tail.lastIndexOf('! '),
    tail.lastIndexOf('? '),
    tail.lastIndexOf('。'),
  );
  if (lastEnd >= 0) {
    const endIdx = tailStart + lastEnd + 1;
    return slice.slice(0, endIdx).trim();
  }
  // Fall back to last whole-word break.
  const lastSpace = slice.lastIndexOf(' ');
  if (lastSpace > cap * 0.7) return slice.slice(0, lastSpace).trim() + '...';
  return slice.trim() + '...';
}

// ============================================================
// snippet builder + dedup
// ============================================================

// Build full snippet list from ranked notes. Caps at MAX_SNIPPETS total.
// Each snippet body goes through sanitize() + truncateAtSentence().
export function buildSnippets(ranked, entityTokens, vaultRoot) {
  const snippets = [];
  let sectionsExtracted = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (snippets.length >= MAX_SNIPPETS) break;
    const r = ranked[i];
    const note = r.note;
    const picks = extractRelevantSections(note, entityTokens, 2);
    sectionsExtracted += picks.length;
    for (const pick of picks) {
      if (snippets.length >= MAX_SNIPPETS) break;
      const cleaned = sanitize(pick.body);
      const truncated = truncateAtSentence(cleaned, MAX_SNIPPET_CHARS);
      if (!truncated || truncated.length < MIN_SECTION_CHARS) continue;
      snippets.push({
        source_path: relative(REPO_ROOT, r.path),
        source_id: `obsidian#${snippets.length + 1}`,
        note_title: note.title,
        section_heading: pick.heading,
        text: truncated,
        match_score: Number(r.score.toFixed(3)),
        matched_terms: r.matched,
        tier: r.tier,
      });
    }
  }
  // Dedup by Jaccard similarity > 0.7 (keep first; drop later duplicates).
  return dedupSnippets(snippets);
}

export function jaccard(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const uni = sa.size + sb.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

export function dedupSnippets(snippets) {
  const keep = [];
  for (const s of snippets) {
    let dup = false;
    for (const k of keep) {
      if (jaccard(s.text, k.text) > 0.7) { dup = true; break; }
    }
    if (!dup) keep.push(s);
  }
  // Re-index source_id after dedup so they stay sequential 1..N.
  return keep.map((s, i) => ({ ...s, source_id: `obsidian#${i + 1}` }));
}

// ============================================================
// main runner
// ============================================================

export function buildOutput({ pageId, entity, entityZh, targetKeyword, targetKeywordZh, language, vaultRoot }) {
  const idx = buildIndex(vaultRoot);
  const entityTokens = tokenize(entity);
  const entityTokensZh = entityZh ? tokenize(entityZh) : null;
  const ranked = rankNotes(idx, entity, { entityTokensZh });
  // For snippet extraction, use the union of tokens so snippets containing
  // either EN or ZH entity hits get extracted. buildSnippets matches tokens
  // verbatim against note body lines, so mixing is safe (no token-set-
  // intersection logic that would zero out).
  const snippetTokens = entityTokensZh
    ? [...new Set([...entityTokens, ...entityTokensZh])]
    : entityTokens;
  const snippets = buildSnippets(ranked, snippetTokens, vaultRoot);

  const notesMatched = ranked.length;
  const stats = {
    notes_scanned: idx.scanned,
    notes_skipped: idx.skipped,
    notes_matched: notesMatched,
    sections_extracted: snippets.length, // pre-dedup tracked via buildSnippets caller
    snippets_kept_after_dedup: snippets.length,
  };

  // Note about vault gap when matcher returns 0.
  let gap_note = null;
  if (notesMatched === 0) {
    gap_note = `vault contains 0 notes matching entity tokens [${entityTokens.join(', ')}] — expected gap for this topic`;
  }

  return {
    schema_version: SCHEMA_VERSION,
    page_id: pageId,
    entity,
    // bilingual-v9-full: optional ZH fields for traceability + downstream
    // identification. ZH render reads the same cache as EN render.
    ...(entityZh ? { entity_zh: entityZh } : {}),
    target_keyword: targetKeyword || '',
    ...(targetKeywordZh ? { target_keyword_zh: targetKeywordZh } : {}),
    ...(language && language !== 'en' ? { language } : {}),
    generated_at: new Date().toISOString(),
    snippets,
    stats,
    ...(gap_note ? { gap_note } : {}),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); return EXIT.OK; }
  if (!args.pageId || !args.entity) {
    console.error(`${TOOL_NAME}: --page-id and --entity are required (see --help)`);
    return EXIT.CLI;
  }
  let pageId;
  try {
    pageId = validatePageId(args.pageId);
  } catch (e) {
    console.error(`${TOOL_NAME}: ${redact(e.message)}`);
    return EXIT.CLI;
  }
  const entity = String(args.entity).trim();
  if (!entity) {
    console.error(`${TOOL_NAME}: --entity must be non-empty`);
    return EXIT.CLI;
  }
  const targetKeyword = String(args.targetKeyword || '').trim();
  // bilingual-v9-full: ZH inputs are optional; when present they augment the
  // matching pass so notes containing only ZH content can be ranked into the
  // RAG output. ZH render then reads the same cache and gets relevant
  // ZH-content snippets.
  const entityZh = args.entityZh ? String(args.entityZh).trim() : null;
  const targetKeywordZh = String(args.targetKeywordZh || '').trim();
  const language = args.language === 'zh' ? 'zh' : 'en';

  const vaultRoot = args.vaultDir;
  if (!existsSync(vaultRoot)) {
    console.error(`${TOOL_NAME}: vault not found: ${vaultRoot}`);
    return EXIT.FATAL;
  }
  const cacheRoot = args.cacheDir;

  const zhTag = entityZh ? ` entity_zh="${entityZh}"` : '';
  console.log(`${TOOL_VERSION} — page_id="${pageId}" entity="${entity}"${zhTag} language="${language}"`);
  const t0 = Date.now();
  const out = buildOutput({ pageId, entity, entityZh, targetKeyword, targetKeywordZh, language, vaultRoot });
  const ms = Date.now() - t0;

  // Write to .gg-cache/{page_id}/obsidian-rag.json
  const outPath = join(cacheRoot, pageId, 'obsidian-rag.json');
  let abs;
  try {
    const v = validateWritePath(outPath, {
      allowedDirs: [cacheRoot],
      allowedExtensions: ['.json'],
    });
    abs = v.abs;
  } catch (e) {
    console.error(`${TOOL_NAME}: write path validation failed — ${redact(e.message)}`);
    return EXIT.FATAL;
  }
  writeFileSync(abs, JSON.stringify(out, null, 2));

  console.log(`  scanned ${out.stats.notes_scanned} notes (skipped ${out.stats.notes_skipped}) in ${ms}ms`);
  console.log(`  matched ${out.stats.notes_matched} notes → ${out.snippets.length} snippets`);
  if (out.gap_note) console.log(`  gap_note: ${out.gap_note}`);
  console.log(`  wrote ${relative(REPO_ROOT, abs)} (${JSON.stringify(out).length} bytes)`);

  return EXIT.OK;
}

const isDirect = (() => {
  try { return fileURLToPath(import.meta.url) === process.argv[1]; }
  catch { return false; }
})();

if (isDirect) {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error(`${TOOL_NAME}: fatal — ${redact(e && e.message || e)}`);
    process.exit(EXIT.FATAL);
  });
}
