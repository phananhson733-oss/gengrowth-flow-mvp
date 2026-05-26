// content-draft-rag.mjs — Phase 0 RAG source-injection block builders for
// gg-content-draft.mjs (entity-passport + friction-mine + serp top-10 +
// obsidian-wiki). Extracted to shrink the orchestrator file; pure (return strings
// / null, no run state).
//
// Each builder validates the cache file is in-jail (.gg-cache/<page_id>/), parses
// JSON, asserts page_id + entity match the current context (fail-fast on mismatch —
// that signals cache corruption, never skip silently), caps snippet count/length,
// and emits a <source name="..."> XML block whose values are routed through
// safeField() so attacker-controlled text inside RAG snippets can't break out of
// the <field> wrapper.
//
// Return contract:
//   - null  → cache file missing (caller decides: fail-fast gate or empty block).
//   - ''    → cache present but content empty/degenerate (treat as hit).
//   - '<source>…</source>'  → normal hit.

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateIngestPath } from './gg-shared.mjs';
import { safeField, assertSafePageId, ensureDir, MAX_INGEST_BYTES } from './content-draft-util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/ is two levels under the script dir; repo root is three up from here.
const REPO_ROOT = join(__dirname, '..', '..', '..');

export function loadSerpSnippets(serpDir, pageId) {
  const path = join(serpDir, `${pageId}.json`);
  if (!existsSync(path)) {
    return { state: 'missing', snippets: [], path };
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const snippets = Array.isArray(raw.snippets)
      ? raw.snippets
          .map((s) => (typeof s === 'string' ? s : s.snippet || s.title || ''))
          .filter((s) => typeof s === 'string' && s.length > 0)
      : [];
    return { state: 'hit', snippets, path };
  } catch (e) {
    return { state: 'error', snippets: [], path, err: e.message };
  }
}

function readRagCache(pageId, filename, expectedEntity) {
  assertSafePageId(pageId, `readRagCache(${filename})`);
  const cacheRoot = join(REPO_ROOT, '.gg-cache');
  ensureDir(cacheRoot);
  ensureDir(join(cacheRoot, pageId));
  const cachePath = join(cacheRoot, pageId, filename);
  if (!existsSync(cachePath)) return { state: 'missing', cachePath };
  // validateIngestPath gives us realpath + symlink rejection + ext check.
  const real = validateIngestPath(cachePath, {
    maxBytes: MAX_INGEST_BYTES,
    allowedDirs: [cacheRoot],
    allowedExtensions: ['.json'],
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch (e) {
    throw new Error(`${filename}: invalid JSON — ${e.message}`);
  }
  // Corruption guard: cache page_id MUST match current page_id.
  if (parsed.page_id !== pageId) {
    throw new Error(
      `${filename}: page_id mismatch — cache="${parsed.page_id}" vs current="${pageId}". ` +
      `Cache may belong to a different page; delete .gg-cache/${pageId}/${filename} and re-run upstream.`
    );
  }
  // Corruption guard: cache entity MUST match (case-insensitive).
  if (typeof parsed.entity !== 'string' ||
      parsed.entity.trim().toLowerCase() !== String(expectedEntity || '').toLowerCase()) {
    throw new Error(
      `${filename}: entity mismatch — cache="${parsed.entity}" vs current="${expectedEntity}". ` +
      `Refusing to use stale RAG cache (would inject wrong-entity snippets).`
    );
  }
  // Schema version pin: only '1' is supported for now.
  if (String(parsed.schema_version || '') !== '1') {
    throw new Error(
      `${filename}: schema_version="${parsed.schema_version}" not supported (expected "1")`
    );
  }
  return { state: 'hit', cachePath, parsed };
}

export function entityPassportBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'entity-passport.rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const snippets = Array.isArray(res.parsed.snippets) ? res.parsed.snippets.slice(0, 12) : [];
  if (snippets.length === 0) {
    return '<source name="entity-passport">\n  <!-- cache hit but no snippets -->\n</source>';
  }
  const lines = ['<source name="entity-passport">'];
  for (const s of snippets) {
    const field = s && typeof s === 'object' ? (s.field || s.angle || 'snippet') : 'snippet';
    const text = s && typeof s === 'object' ? (s.text || s.snippet || '') : String(s);
    lines.push(`  <field name="${safeField(field, { cap: 64 })}">${safeField(text, { cap: 500 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

export function frictionMineBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'friction-mine.rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const themes = Array.isArray(res.parsed.themes) ? res.parsed.themes.slice(0, 8) : [];
  if (themes.length === 0) {
    return '<source name="friction-mine">\n  <!-- cache hit but no themes -->\n</source>';
  }
  const lines = ['<source name="friction-mine">'];
  for (const t of themes) {
    const label = t && typeof t === 'object' ? (t.label || t.theme || 'theme') : 'theme';
    const quote = t && typeof t === 'object' ? (t.scrubbed_quote || t.quote || t.text || '') : String(t);
    lines.push(`  <field name="${safeField(label, { cap: 64 })}">${safeField(quote, { cap: 300 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

// SERP block uses existing .gg-cache/serp/{pageId}.json — same loadSerpSnippets()
// shape. Top-10 snippets, title + meta-snippet clipped to 500ch each. This is the
// "what head-ranking pages frame as the answer" block — prompt instruction must
// direct the LLM to design a CONTRA-position, not copy.
export function serpSnippetsBlock(pageId, _expectedEntity) {
  assertSafePageId(pageId, 'serpSnippetsBlock');
  const serpPath = join(REPO_ROOT, '.gg-cache', 'serp', `${pageId}.json`);
  if (!existsSync(serpPath)) return null;
  // validateIngestPath as defense-in-depth.
  const real = validateIngestPath(serpPath, {
    maxBytes: MAX_INGEST_BYTES,
    allowedDirs: [join(REPO_ROOT, '.gg-cache')],
    allowedExtensions: ['.json'],
  });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch {
    return '<source name="serp-top-10">\n  <!-- cache present but unparseable -->\n</source>';
  }
  const rawSnippets = Array.isArray(parsed.snippets) ? parsed.snippets.slice(0, 10) : [];
  if (rawSnippets.length === 0) {
    return '<source name="serp-top-10">\n  <!-- cache hit but no snippets -->\n</source>';
  }
  const lines = [
    '<source name="serp-top-10" note="head-ranking pages — design your CONTRA-position; do NOT copy">',
  ];
  for (const s of rawSnippets) {
    let title = '';
    let meta = '';
    if (typeof s === 'string') {
      meta = s;
    } else if (s && typeof s === 'object') {
      title = s.title || '';
      meta = s.snippet || s.meta || s.description || '';
    }
    const combined = [title, meta].filter(Boolean).join(' — ');
    lines.push(`  <field name="result">${safeField(combined, { cap: 500 })}</field>`);
  }
  lines.push('</source>');
  return lines.join('\n');
}

// Obsidian-wiki RAG block — Phase 0 source #4. Reads
// .gg-cache/{pageId}/obsidian-rag.json produced by gg-obsidian-rag.mjs. Highest-
// quality RAG source for astrology topics — curated long-form book notes.
// Shape: top-level .snippets is an array of { source_id, note_title,
// section_heading, text, ... }. Emits each as a <field ...>text</field>.
export function obsidianRagBlock(pageId, expectedEntity) {
  const res = readRagCache(pageId, 'obsidian-rag.json', expectedEntity);
  if (res.state === 'missing') return null;
  const snippets = Array.isArray(res.parsed.snippets) ? res.parsed.snippets.slice(0, 12) : [];
  const gapNote = res.parsed.gap_note;
  if (snippets.length === 0) {
    const tail = gapNote ? `\n  <!-- ${safeField(gapNote, { cap: 200 })} -->` : '';
    return `<source name="obsidian-wiki" note="curated book notes from personal vault">${tail}\n  <!-- cache hit but no snippets (vault gap for this entity) -->\n</source>`;
  }
  const lines = [
    '<source name="obsidian-wiki" note="curated deep-reading book notes from wzb personal vault — high-quality paraphrase source">',
  ];
  for (const s of snippets) {
    const sourceId = (s && typeof s === 'object' && s.source_id) ? s.source_id : 'snippet';
    const noteTitle = (s && typeof s === 'object' && s.note_title) ? s.note_title : '';
    const section = (s && typeof s === 'object' && s.section_heading) ? s.section_heading : '';
    const text = (s && typeof s === 'object' && s.text) ? s.text : String(s);
    lines.push(
      `  <field name="${safeField(sourceId, { cap: 32 })}" title="${safeField(noteTitle, { cap: 120 })}" section="${safeField(section, { cap: 96 })}">${safeField(text, { cap: 600 })}</field>`
    );
  }
  lines.push('</source>');
  return lines.join('\n');
}
