#!/usr/bin/env node
// gg-author-review.mjs — multi-party review for the autopilot authoring loop.
//
// "多方审核撰写": TWO independent critics (Codex GPT-5.5 xhigh + Claude Opus 4.8)
// each critique a draft the author model (Sonnet 4.6 xhigh) produced, then the
// author model revises to address the combined feedback. This adds the qualitative
// review layer (two cross-vendor opinions) that the deterministic phase2 gate cannot do
// (phase2 checks structure + red-line rules; it can't judge whether the article
// is factually sound, well-grounded, genuinely useful, or generic filler).
//
// Pipeline position: runs in gg-seo-autopilot --author on a draft that ALREADY
// passed phase2, then the caller re-runs phase2 on the revised draft and keeps
// the revision only if it still passes (review is a best-effort IMPROVEMENT —
// quality must never regress).
//
// Usage:
//   node gg-author-review.mjs --source <draft.md> --out <revised.md> --page-id <id>
//                             [--entity "<e>"] [--target-keyword "<kw>"]
// Exits 0 with --out written either way: the revised article, or (if the critique
// is LGTM / the reviser misbehaves / a CLI is missing) a verbatim copy of the
// source, plus a one-line summary to stdout: "review: <revised|no-change> …".

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HOME = homedir();
const CODEX = [join(HOME, '.npm-global', 'bin', 'codex')].find(existsSync) || 'codex';
const CLAUDE = ['/opt/homebrew/bin/claude'].find(existsSync) || 'claude';
// "多方审核撰写" (user pref 2026-06-05): TWO independent critics — Codex GPT-5.5
// xhigh AND Claude Opus 4.8 (Opus reviews like GPT does) — then the AUTHOR model
// (Sonnet 4.6 xhigh) revises its own draft addressing the combined feedback. All
// overridable via env. `--effort`: low|medium|high|xhigh|max.
const OPUS_CRITIC_MODEL = process.env.GG_REVIEW_OPUS_MODEL || 'claude-opus-4-8';
// Critics review with xhigh (short output — a bulleted critique — so latency is
// modest, and we want the strongest review, "评审和 gpt 一样").
const OPUS_CRITIC_EFFORT = process.env.GG_REVIEW_OPUS_EFFORT || 'xhigh';
const REVISER_MODEL = process.env.GG_REVISER_MODEL || process.env.GG_CLAUDE_MODEL || 'claude-sonnet-4-6';
// Reviser rewrites the FULL article (long output) → use 'high' for speed, matching
// the generation effort; the re-run phase2 gate guards quality. Override via env.
const REVISER_EFFORT = process.env.GG_REVISER_EFFORT || 'high';
const CODEX_EFFORT = process.env.GG_CODEX_EFFORT || 'xhigh';
const CODEX_TIMEOUT_MS = parseInt(process.env.GG_REVIEW_CODEX_TIMEOUT_MS || '180000', 10);
const OPUS_TIMEOUT_MS = parseInt(process.env.GG_REVIEW_OPUS_TIMEOUT_MS || '480000', 10);
const REVISER_TIMEOUT_MS = parseInt(process.env.GG_REVIEW_REVISER_TIMEOUT_MS || '480000', 10);
const DISABLE_CODEX_REVIEW = process.env.GG_REVIEW_DISABLE_CODEX === '1';
const DISABLE_OPUS_REVIEW = process.env.GG_REVIEW_DISABLE_OPUS === '1';

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') o.source = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--page-id') o.pageId = argv[++i];
    else if (a === '--entity') o.entity = argv[++i];
    else if (a === '--target-keyword') o.targetKeyword = argv[++i];
  }
  return o;
}

function run(bin, args, input, timeout) {
  return execFileSync(bin, args, { input, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024 });
}

// keep only the article body (first H1 → end); drop any model preamble/epilogue meta.
function cleanArticle(text) {
  const h1 = text.search(/^# .+/m);
  return (h1 >= 0 ? text.slice(h1) : text).trim();
}

const CRITIQUE_PROMPT = (entity, kw, draft) => `You are a senior astrology content editor doing an INDEPENDENT quality pass on an SEO article a different AI wrote. Topic: "${entity || kw}". Target keyword: "${kw || entity}".

A rule-checker already verified structure and red-line compliance — do NOT re-check those. Find only what rules can't: judge it as a tough, specific editor.

Look for:
1. Factual / astrological errors or dubious claims.
2. Grounding: generic filler vs. real, specific substance a knowledgeable reader would respect.
3. Usefulness: does the reader get concrete, do-able insight, or padding?
4. Voice & angle: distinctive, or interchangeable with any generic blog?
5. SEO/intent: does it actually answer the searcher's intent for the keyword?

Output ONLY a short bulleted list of CONCRETE, actionable fixes (each "- <issue> → <what to change>"), max 8, most important first. Do NOT rewrite the article. If it is genuinely strong with no material issue, output exactly: LGTM

--- DRAFT ---
${draft}`;

const REVISE_PROMPT = (critique, draft) => `You are revising your own astrology SEO article after an editor's review. Apply every applicable point of the feedback to raise accuracy, grounding, and usefulness.

HARD CONSTRAINTS — an automated gate re-checks the result; breaking ANY of these makes the revision worthless and it will be discarded:
- Keep the EXACT same H1 and the EXACT same H2 headings (verbatim wording, same order). Do not add, remove, rename, or reorder sections.
- TOTAL length MUST stay 1500–1800 words. The feedback asks you to ADD things, so you MUST also CUT or tighten weaker prose to compensate — count the words and trim to land under 1800.
- The FIRST internal wiki-link [[...]] must appear within the first ~150 words of body text (keep it inside the opening of section 1 or 2); do not push it later, and do not add more [[...]] links than the draft already has.
- Keep the CTA section's markdown link and the Sources section; do not invent or add citations.
- No meta commentary, no preamble.

Output the COMPLETE revised article ONLY — from the "# " H1 line through the final Sources entry. Nothing before the H1, nothing after the last source.

--- EDITOR FEEDBACK ---
${critique}

--- CURRENT DRAFT ---
${draft}`;

// Is a critique actionable (real fixes), vs LGTM / empty / unavailable?
function actionableBullets(critique) {
  if (!critique) return 0;
  if (/\bLGTM\b/i.test(critique)) return 0;
  return critique.split('\n').filter((l) => /^\s*([-*]|\d+\.)\s+\S/.test(l)).length;
}

// Critic 1 — Codex GPT-5.5 xhigh. codex exec puts its banner on stderr and nothing
// usable on stdout, so capture the final message via --output-last-message. Returns
// '' on any tooling failure (best-effort — the Opus critic can still carry the pass).
function critiqueViaCodex(o, draft) {
  if (DISABLE_CODEX_REVIEW) return '';
  const critiqueFile = `${o.out}.codex-critique.txt`;
  try {
    // -s read-only: codex exec defaults to workspace-write + approval:never, so it
    // will agentically EDIT FILES. read-only blocks all writes — we only want text.
    run(CODEX, ['exec', '-s', 'read-only', '-c', 'model=gpt-5.5', '-c', `reasoning_effort=${CODEX_EFFORT}`,
      '--output-last-message', critiqueFile, '-'],
      CRITIQUE_PROMPT(o.entity, o.targetKeyword, draft), CODEX_TIMEOUT_MS);
    return existsSync(critiqueFile) ? readFileSync(critiqueFile, 'utf8').trim() : '';
  } catch { return ''; }
}

// Critic 2 — Claude Opus 4.8 (reviews like GPT does). Independent second opinion.
function critiqueViaOpus(o, draft) {
  if (DISABLE_OPUS_REVIEW) return '';
  try {
    return run(CLAUDE, ['-p', '--model', OPUS_CRITIC_MODEL, '--effort', OPUS_CRITIC_EFFORT],
      CRITIQUE_PROMPT(o.entity, o.targetKeyword, draft), OPUS_TIMEOUT_MS).trim();
  } catch { return ''; }
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.source || !o.out) { process.stderr.write('usage: --source <draft.md> --out <revised.md> --page-id <id>\n'); process.exit(2); }
  const draft = readFileSync(o.source, 'utf8');
  const keep = (why) => { writeFileSync(o.out, draft); process.stdout.write(`review: no-change (${why})\n`); process.exit(0); };

  // 1. TWO independent critics in sequence: Codex GPT-5.5 + Claude Opus 4.8.
  const codexCritique = critiqueViaCodex(o, draft);
  const opusCritique = critiqueViaOpus(o, draft);
  const codexN = actionableBullets(codexCritique);
  const opusN = actionableBullets(opusCritique);
  if (codexN === 0 && opusN === 0) return keep('both critics: LGTM / no actionable issues / unavailable');

  // Combine the actionable critiques into one feedback block for the reviser.
  const combined = [
    codexN ? `## Reviewer 1 — Codex GPT-5.5 (xhigh)\n${codexCritique}` : '',
    opusN ? `## Reviewer 2 — Claude Opus 4.8\n${opusCritique}` : '',
  ].filter(Boolean).join('\n\n');

  // 2. The author model (Sonnet 4.6 xhigh) revises its own draft per the combined feedback.
  let revised;
  try {
    revised = run(CLAUDE, ['-p', '--model', REVISER_MODEL, '--effort', REVISER_EFFORT], REVISE_PROMPT(combined, draft), REVISER_TIMEOUT_MS);
  } catch (e) {
    return keep(`reviser failed: ${String(e.message || e).replace(/\s+/g, ' ').slice(-100)}`);
  }
  revised = cleanArticle(revised);
  // Safety: never emit a broken/short revision — fall back to the passing draft.
  if (!/^# .+/m.test(revised) || revised.length < draft.length * 0.6) return keep('revision looked malformed — kept original');

  writeFileSync(o.out, revised);
  const who = [codexN && 'codex', opusN && 'opus'].filter(Boolean).join('+');
  process.stdout.write(`review: revised (${codexN + opusN} issue(s) from ${who})\n`);
}

main();
