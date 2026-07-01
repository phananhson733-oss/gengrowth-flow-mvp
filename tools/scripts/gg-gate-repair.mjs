#!/usr/bin/env node
// gg-gate-repair.mjs — SURGICAL gate-side repair worker (text-only, structured patch).
//
// The publish-gate counterpart to gg-author-repair.mjs. Where author-repair rewrites a
// whole markdown DRAFT to fix phase2 failures, this worker fixes a CONVERTED ARTICLE at
// the publish-gate park boundary (a review dimension or the codex factual gate FAILed) by
// returning the SMALLEST possible set of old_string/new_string edits — never a full
// rewrite (which timed out at 300s and returned empty). The caller applies the edits
// deterministically, so the model touches no files and runs no tools.
//
// Contract (stdout, JSON only):
//   { "edits": [ { "old_string": "...", "new_string": "..." }, ... ], "note": "<one line>" }
//   edits: [] with a note starting "cannot-repair" ⇒ the caller parks as before.
// Every old_string is validated here to be a UNIQUE substring of the article; non-unique /
// absent edits are dropped (never applied blindly). Empty-after-validation ⇒ cannot-repair.
//
// Usage:
//   node gg-gate-repair.mjs --article <path.ts> --dimension <links-seo|schema|astrology|codex>
//     --reason "<gate failure reason>" [--draft <path.md>] [--allowed-links "s1,s2,..."]
//     [--model <m>] [--effort <e>] [--timeout-ms <n>]
//
// Exit codes: 0 → validated JSON on stdout (edits may be empty). 1 → tooling failure
// (worker missing/crashed/timeout/unparseable) — caller parks. 2 → CLI/usage error.
//
// SAFETY: text-only claude -p (NO --allowedTools, NO --dangerously-skip-permissions), cwd
// isolated to WORKER_CWD so the repo CLAUDE.md is never inherited (see worker-cwd.mjs).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { WORKER_CWD } from './lib/worker-cwd.mjs';

const DEFAULT_MODEL = process.env.GG_GATE_REPAIR_MODEL || process.env.GG_AGENTIC_MODEL || 'claude-opus-4-8';
const DEFAULT_EFFORT = process.env.GG_GATE_REPAIR_EFFORT || 'high';
// Surgical patch, not a rewrite → much shorter bound than author-repair's 30min.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GG_GATE_REPAIR_TIMEOUT_MS || '420000', 10);
const REPAIRABLE = new Set(['links-seo', 'schema', 'astrology', 'codex']);

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--article') o.article = argv[++i];
    else if (a === '--dimension') o.dimension = argv[++i];
    else if (a === '--reason') o.reason = argv[++i];
    else if (a === '--draft') o.draft = argv[++i];
    else if (a === '--allowed-links') o.allowedLinks = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--timeout-ms') o.timeoutMs = argv[++i];
  }
  return o;
}

function validate(o) {
  const errors = [];
  if (!o.article) errors.push('--article is required');
  else if (!existsSync(o.article)) errors.push(`--article not found: ${o.article}`);
  if (!o.dimension) errors.push('--dimension is required');
  else if (!REPAIRABLE.has(o.dimension)) errors.push(`--dimension must be one of ${[...REPAIRABLE].join('|')}`);
  if (!o.reason || !o.reason.trim()) errors.push('--reason is required');
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (o.timeoutMs !== undefined) {
    timeoutMs = Number.parseInt(o.timeoutMs, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) errors.push('--timeout-ms must be a positive integer');
  }
  return { errors, timeoutMs };
}

// Dimension-specific fix guidance (what a SAFE surgical fix looks like for each gate).
function dimensionGuidance(dimension) {
  switch (dimension) {
    case 'links-seo':
      return [
        'This is an internal-link ANCHOR↔TARGET mismatch. For each flagged link, EITHER:',
        '  (a) change the anchor TEXT so it honestly describes the page the URL points to, keeping the URL; OR',
        '  (b) if the anchor promises a page that does not exist, retarget the URL to a REAL page from the allowed-links list whose topic matches; OR',
        '  (c) if no honest target exists, replace the whole markdown link `[anchor](/url)` with plain italic text `*anchor*` (de-link).',
        'Do NOT invent slugs. Only use /en/wiki/ or /en/blog/ slugs that appear in the allowed-links list (or that the reason names as real).',
      ];
    case 'schema':
      return [
        'This is a schema/keyword integrity failure — usually an off-topic or hallucinated keyword, or a body claim that contradicts the article schema/frontmatter.',
        'Fix by REMOVING or CORRECTING the specific flagged term/claim (e.g. strip a stray off-topic keyword from a sentence or a keyword list). Do not add new claims.',
      ];
    case 'astrology':
      return [
        'This is an astrological accuracy failure. Fix the SPECIFIC flagged placement/date/claim minimally: correct a wrong sign/placement to the accurate one, OR reframe an unverifiable placement as fan-shared/unconfirmed (never assert it). Do not restructure the article.',
      ];
    case 'codex':
      return [
        'This is a factual-review failure. Fix the SPECIFIC flagged fact minimally: correct a wrong fact to the verifiable truth (e.g. a wrong brand/product name, a wrong date), OR remove/generalize an unverifiable specific (a named study, stat, or quote that cannot be confirmed). NEVER invent a replacement specific (no fabricated numbers, sources, or quotes).',
      ];
    default:
      return ['Fix the named failure with the smallest possible edits.'];
  }
}

function buildPrompt({ article, dimension, reason, draft, allowedLinks }) {
  const lines = [
    `You are a surgical copy-editor fixing ONE automated publish-gate failure in an already-written article. Gate dimension: "${dimension}".`,
    '',
    'THE GATE FAILURE (fix exactly this, nothing else):',
    reason,
    '',
    'HOW TO FIX THIS DIMENSION:',
    ...dimensionGuidance(dimension),
    '',
    'RULES:',
    '- Make the SMALLEST possible change. Do NOT rewrite, restructure, or re-tone the article.',
    '- Never fabricate facts, statistics, sources, quotes, dates, or page slugs.',
    '- Preserve the article\'s structure (H1/H2 count), the TypeScript syntax around the content, and every unrelated sentence.',
  ];
  if (allowedLinks) lines.push(`- Allowed internal-link slugs (the ONLY valid link targets): ${allowedLinks}`);
  lines.push(
    '',
    'OUTPUT — return ONLY a single JSON object, no prose, no code fence:',
    '{"edits":[{"old_string":"<exact unique substring of the article to replace>","new_string":"<replacement>"}],"note":"<one short line>"}',
    '- Each old_string MUST be copied VERBATIM from the article below and MUST occur EXACTLY ONCE (include enough surrounding context to be unique).',
    '- Prefer 1-3 tightly-scoped edits. If you genuinely cannot fix it with surgical edits (needs a rewrite or a fact you cannot verify), return {"edits":[],"note":"cannot-repair: <why>"}.',
  );
  if (draft) {
    lines.push('', '--- ORIGINAL DRAFT (context only; DO NOT return this) ---', draft);
  }
  lines.push('', '--- ARTICLE TO EDIT (copy old_string verbatim from here) ---', article);
  return lines.join('\n');
}

function runWorker({ model, effort, prompt, timeoutMs }) {
  const bin = process.env.GG_GATE_REPAIR_BIN
    || ['/opt/homebrew/bin/claude'].find(existsSync)
    || 'claude';
  return spawnSync(bin, ['-p', '--model', model, '--effort', effort], {
    cwd: WORKER_CWD,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// Pull the first balanced top-level JSON object out of the model's stdout.
function extractJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

function fail(reason) {
  process.stderr.write(`[gate-repair] tooling failure: ${reason}\n`);
  process.exit(1);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { errors, timeoutMs } = validate(o);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`[gate-repair] ERROR: ${e}\n`);
    process.stderr.write('usage: --article <path.ts> --dimension <links-seo|schema|astrology|codex> --reason "<text>" [--draft <md>] [--allowed-links "s1,s2"] [--model <m>] [--effort <e>] [--timeout-ms <n>]\n');
    process.exit(2);
  }

  let article;
  try { article = readFileSync(o.article, 'utf8'); }
  catch (e) { return fail(`cannot read --article: ${e.code || e.message}`); }
  let draft = '';
  if (o.draft && existsSync(o.draft)) { try { draft = readFileSync(o.draft, 'utf8'); } catch { /* context only */ } }

  const prompt = buildPrompt({ article, dimension: o.dimension, reason: o.reason, draft, allowedLinks: o.allowedLinks });
  const res = runWorker({ model: o.model || DEFAULT_MODEL, effort: o.effort || DEFAULT_EFFORT, prompt, timeoutMs });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') return fail(`worker timed out after ${timeoutMs}ms`);
    if (res.error.code === 'ENOENT') return fail('claude CLI not found in PATH');
    return fail(`worker spawn failed (${res.error.code || res.error.message})`);
  }
  if (res.status !== 0) {
    return fail(`worker exited ${res.status} (${String(res.stderr || '').slice(-160).replace(/\s+/g, ' ').trim()})`);
  }

  const raw = extractJsonObject(res.stdout);
  if (!raw) return fail('worker output had no JSON object');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return fail(`worker JSON parse failed: ${e.message}`); }

  const inEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
  const valid = [];
  const dropped = [];
  for (const e of inEdits) {
    const oldS = e && typeof e.old_string === 'string' ? e.old_string : null;
    const newS = e && typeof e.new_string === 'string' ? e.new_string : null;
    if (!oldS || newS === null) { dropped.push('malformed'); continue; }
    if (oldS === newS) { dropped.push('no-op'); continue; }
    // UNIQUE substring guard: exactly one occurrence in the article.
    const occurrences = article.split(oldS).length - 1;
    if (occurrences !== 1) { dropped.push(`old_string x${occurrences}`); continue; }
    valid.push({ old_string: oldS, new_string: newS });
  }

  const note = (typeof parsed.note === 'string' && parsed.note.trim())
    ? parsed.note.trim()
    : (valid.length ? 'surgical-edit' : 'cannot-repair: no applicable edits');
  process.stdout.write(JSON.stringify({
    edits: valid,
    note: valid.length ? note : (note.startsWith('cannot-repair') ? note : 'cannot-repair: no applicable edits'),
    dropped: dropped.length ? dropped : undefined,
  }) + '\n');
  process.exit(0);
}

main();
