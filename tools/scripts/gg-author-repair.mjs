#!/usr/bin/env node
// gg-author-repair.mjs — deterministic, text-only repair worker.
//
// REPLACES the agentic rescue in gg-seo-autopilot.mjs (the
// `claude -p --allowedTools 'Bash Read Edit Write Grep' --dangerously-skip-permissions`
// surgical-repair escalation). That agentic path let the model run arbitrary
// Bash / Read / Edit / Write / Grep inside the live repo and self-loop on
// phase2 — a wide blast radius for a step whose only job is "rewrite ONE draft
// so it passes QA". This worker collapses that to a single deterministic call:
//
//   read --source draft  →  build a repair prompt (source + keyword + author +
//   the phase2 failure text)  →  one TEXT-ONLY worker call
//   (claude -p --model <m> --effort <e>, prompt on stdin, stdout captured)  →
//   strip any pre-H1 preamble  →  write ONLY --out.
//
// HARD INVARIANTS (the autopilot relies on these):
//   - NEVER edits --source. The source draft is read-only input; the corrected
//     article is written ONLY to --out. The caller re-runs phase2 on --out (the
//     candidate) and decides whether to adopt it — this script never runs phase2.
//   - NO tools. The worker is plain `claude -p` (text in, text out). There is no
//     --allowedTools and no --dangerously-skip-permissions: the model cannot touch
//     the filesystem, run commands, or escape the prompt.
//
// Usage:
//   node gg-author-repair.mjs --source <draft.md> --out <candidate.md> \
//     --page-id <PG-...> --target-keyword "<phrase>" --author <id> \
//     --failures "<phase2 failure text OR a path to a file of failures>" \
//     [--model <claude model>] [--effort <low|medium|high|xhigh|max>] \
//     [--timeout-ms <n>]
//
// Worker contract (matches gg-llm-orchestrator.mjs buildCommand 'claude' case and
// the sibling gg-article-review-worker.mjs): claude -p --model <m> --effort <e>,
// prompt on stdin, corrected article on stdout.
//
// Exit codes:
//   0  → --out written with the (pre-H1-stripped) corrected article.
//   1  → tooling failure: worker missing / crashed / timed out / produced empty
//        output, OR --source unreadable. --out is NOT written on failure, so the
//        caller's existing "does --out exist + pass phase2?" gate sees no candidate
//        and parks exactly as before. A tooling failure must never be a silent pass.
//   2  → CLI/usage error (bad or missing required args).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { stripPreH1 } from './lib/strip-preamble.mjs';
import { WORKER_CWD } from './lib/worker-cwd.mjs';

// FRONTIER-ONLY (wzb 2026-05-23, docs/OPS_OVERVIEW.md "LLM 选择策略"): never Sonnet/Haiku/mini
// for content generation — the cost delta is dwarfed by ranking ROI. This script REWRITES
// ARTICLE PROSE that ships to production, so it is squarely inside that policy, yet it was
// the one generation-path script still defaulting to Sonnet while _call-hermes /
// gg-brief-suggest / gg-phase2-fix / gg-llm-orchestrator all declare FRONTIER-ONLY.
// Caught 2026-08-07 when a repair run on PG-ILA-001 spawned `claude -p --model claude-sonnet-4-6`.
// Override per-call with --model or GG_AUTHOR_REPAIR_MODEL; GG_AGENTIC_MODEL still wins if set,
// so an operator who deliberately configured the agentic tier keeps that choice.
const DEFAULT_MODEL = process.env.GG_AUTHOR_REPAIR_MODEL || process.env.GG_AGENTIC_MODEL || 'claude-opus-4-8';
const DEFAULT_EFFORT = process.env.GG_AUTHOR_REPAIR_EFFORT || process.env.GG_AGENTIC_EFFORT || 'high';
const DEFAULT_FALLBACK_EFFORT = process.env.GG_AUTHOR_REPAIR_FALLBACK_EFFORT || 'high';
// A repair is a surgical rewrite, not a full research/generation pass. Bound
// each provider attempt to four minutes, then allow at most one distinct-model
// fallback. This prevents a dead worker from occupying the single nightly
// executor for the old 30-minute ceiling.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GG_AUTHOR_REPAIR_TIMEOUT_MS || '240000', 10);

// ── CLI parsing ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') o.source = argv[++i];
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--page-id') o.pageId = argv[++i];
    else if (a === '--target-keyword') o.targetKeyword = argv[++i];
    else if (a === '--author') o.author = argv[++i];
    else if (a === '--failures') o.failures = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--effort') o.effort = argv[++i];
    else if (a === '--word-min') o.wordMin = argv[++i];
    else if (a === '--word-max') o.wordMax = argv[++i];
    else if (a === '--keyword-min') o.keywordMin = argv[++i];
    else if (a === '--keyword-max') o.keywordMax = argv[++i];
    else if (a === '--max-sentences-per-paragraph') o.maxSentencesPerParagraph = argv[++i];
    // EN-only (2026-07-03): the zh repair leg was removed. Reject the legacy
    // flag loudly instead of silently repairing a zh draft with EN instructions.
    else if (a === '--language') {
      const v = argv[++i];
      if (v !== 'en') {
        process.stderr.write(`--language ${v} is no longer supported — the pipeline is EN-only (zh removed 2026-07-03)\n`);
        process.exit(2);
      }
    }
    else if (a === '--timeout-ms') o.timeoutMs = argv[++i];
  }
  return o;
}

function validate(o) {
  const errors = [];
  if (!o.source) errors.push('--source <draft.md> is required');
  else if (!existsSync(o.source)) errors.push(`source file not found: ${o.source}`);
  if (!o.out) errors.push('--out <candidate.md> is required');
  if (!o.pageId) errors.push('--page-id is required');
  if (!o.targetKeyword) errors.push('--target-keyword is required');
  if (!o.author) errors.push('--author is required');
  if (!o.failures) errors.push('--failures <phase2 failure text or file path> is required');
  for (const [field, flag] of [
    ['wordMin', '--word-min'],
    ['wordMax', '--word-max'],
    ['keywordMin', '--keyword-min'],
    ['keywordMax', '--keyword-max'],
    ['maxSentencesPerParagraph', '--max-sentences-per-paragraph'],
  ]) {
    if (o[field] === undefined) continue;
    const value = Number.parseInt(o[field], 10);
    if (!Number.isFinite(value) || value <= 0) errors.push(`${flag} must be a positive integer`);
    else o[field] = value;
  }
  if (o.wordMin && o.wordMax && o.wordMin > o.wordMax) errors.push('--word-min cannot exceed --word-max');
  if (o.keywordMin && o.keywordMax && o.keywordMin > o.keywordMax) errors.push('--keyword-min cannot exceed --keyword-max');

  // --effort intentionally NOT enum-validated (matches gg-author-review.mjs and
  // gg-article-review-worker.mjs) — left to the worker CLI to reject.
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (o.timeoutMs !== undefined) {
    timeoutMs = Number.parseInt(o.timeoutMs, 10);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) errors.push('--timeout-ms must be a positive integer');
  }
  return { errors, timeoutMs };
}

// --failures may be the literal phase2 failure text OR a path to a file holding
// it. Treat it as a file ONLY when it resolves to an existing regular file;
// otherwise it is the failure text verbatim. (A multi-line failure blob can't be
// a path, and a short path-looking string that doesn't exist falls back to text.)
function resolveFailures(failures) {
  try {
    if (existsSync(failures) && statSync(failures).isFile()) {
      return readFileSync(failures, 'utf8');
    }
  } catch {
    // statSync/readFileSync hiccup → treat the arg as literal text.
  }
  return failures;
}

// ── Repair prompt ────────────────────────────────────────────────────────────
// The deterministic counterpart to agenticRescuePrompt(): same intent (surgically
// fix the named phase2 failures without a full rewrite), but the model returns the
// corrected ARTICLE as text — it does not run tools or self-check. The contract
// line is verbatim from the Task 3 spec.
function buildPrompt({ source, targetKeyword, author, failures, constraints = {} }) {
  const lines = [
    'You are repairing a single SEO article draft that failed an automated QA pass.',
    'Apply the smallest changes that fix the listed failures — surgical edits, not a rewrite.',
  ];
  lines.push(
    '',
    `target_keyword (the exact literal phrase): "${targetKeyword}"`,
    `author id: ${author}`,
    '',
    'The automated QA (phase2) flagged the following failures — fix each one:',
    failures,
    '',
    'Hard non-regression budget — satisfy every applicable bound while making the named fixes:',
    constraints.wordMin && constraints.wordMax
      ? `- Keep the body word count within ${constraints.wordMin}-${constraints.wordMax} words.`
      : '- Preserve the current article length unless the failure explicitly requires a word-count change.',
    constraints.keywordMin && constraints.keywordMax
      ? `- Use the exact target_keyword phrase ${constraints.keywordMin}-${constraints.keywordMax} times total, case-insensitive; count before output.`
      : '- Do not add unnecessary exact-keyword repetitions.',
    constraints.maxSentencesPerParagraph
      ? `- No prose paragraph may exceed ${constraints.maxSentencesPerParagraph} sentences.`
      : '- Preserve readable paragraph boundaries.',
    '- Do not regress checks that already pass: preserve valid frontmatter, links, CTA URL, sources, disclaimers, tables, lists, and required headings.',
    '',
    'Output the complete corrected article only. Keep the exact H1/H2 structure unless a failure says a section is missing. Do not add tools, commands, or meta commentary.',
    '',
    '--- CURRENT DRAFT ---',
    source,
  );
  return lines.join('\n');
}

// ── Worker spawn — claude -p --model <m> --effort <e>, prompt on stdin ────────
// Plain text worker: NO --allowedTools, NO --dangerously-skip-permissions. Mirrors
// gg-article-review-worker.mjs runWorker / gg-llm-orchestrator.mjs buildCommand.
// GG_AUTHOR_REPAIR_BIN lets the hermetic smoke test inject a fake bin (it wins over
// the real /opt/homebrew/bin/claude). Unset in production → resolve as usual.
function runWorker({ model, effort, prompt, timeoutMs }) {
  const bin = process.env.GG_AUTHOR_REPAIR_BIN
    || ['/opt/homebrew/bin/claude'].find(existsSync)
    || 'claude';
  const res = spawnSync(bin, ['-p', '--model', model, '--effort', effort], {
    // cwd outside the repo so the repair worker doesn't inherit the project CLAUDE.md (see worker-cwd.mjs).
    cwd: WORKER_CWD,
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

function distinctFallbackModel(primaryModel) {
  const configured = String(process.env.GG_AUTHOR_REPAIR_FALLBACK_MODEL || '').trim();
  if (configured && configured !== primaryModel) return configured;
  return /opus/i.test(primaryModel) ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
}

function isTransientWorkerFailure(res) {
  if (res?.error?.code === 'ETIMEDOUT') return true;
  const detail = `${res?.stderr || ''} ${res?.error?.message || ''}`;
  return /rate.?limit|\b429\b|overloaded|over capacity|quota|usage limit|too many requests|insufficient_quota|timed?\s*out|timeout|network|ECONN|EAI_AGAIN|socket hang up|connection reset|temporar(?:y|ily) unavailable/i.test(detail);
}

function workerFailureReason(res, timeoutMs) {
  if (res?.error?.code === 'ETIMEDOUT') return `worker timed out after ${timeoutMs}ms`;
  if (res?.error?.code === 'ENOENT') return 'claude CLI not found in PATH';
  if (res?.error) return `worker spawn failed (${res.error.code || res.error.message})`;
  const tail = String(res?.stderr || '').slice(-200).replace(/\s+/g, ' ').trim();
  return `worker exited ${res?.status}${tail ? ` (${tail})` : ''}`;
}

function fail(reason) {
  process.stderr.write(`[author-repair] tooling failure: ${reason}\n`);
  process.exit(1);
}

function writeDebugArtifact(path, content) {
  try {
    if (!path || !content) return;
    writeFileSync(path, String(content));
  } catch {
    // best-effort only: never mask the primary repair failure
  }
}

function writeWorkerDebugSidecars(outPath, res) {
  if (!outPath || !res) return;
  writeDebugArtifact(`${outPath}.repair.stdout.txt`, String(res.stdout || ''));
  writeDebugArtifact(`${outPath}.repair.stderr.txt`, String(res.stderr || ''));
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { errors, timeoutMs } = validate(o);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`[author-repair] ERROR: ${e}\n`);
    process.stderr.write(
      'usage: --source <draft.md> --out <candidate.md> --page-id <id> --target-keyword "<phrase>" '
      + '--author <id> --failures "<text|path>" [--model <m>] [--effort <e>] [--timeout-ms <n>] '
      + '[--word-min <n> --word-max <n> --keyword-min <n> --keyword-max <n> --max-sentences-per-paragraph <n>]\n',
    );
    process.exit(2);
  }

  const model = o.model || DEFAULT_MODEL;
  const effort = o.effort || DEFAULT_EFFORT;

  // Read the source draft (read-only input — NEVER mutated). existsSync passed in
  // validate(), but a directory/unreadable path throws here → clean exit 1.
  let source;
  try {
    source = readFileSync(o.source, 'utf8');
  } catch (e) {
    return fail(`cannot read --source: ${e.code || e.message}`);
  }

  const failures = resolveFailures(o.failures);
  const prompt = buildPrompt({
    source,
    targetKeyword: o.targetKeyword,
    author: o.author,
    failures,
    constraints: {
      wordMin: o.wordMin,
      wordMax: o.wordMax,
      keywordMin: o.keywordMin,
      keywordMax: o.keywordMax,
      maxSentencesPerParagraph: o.maxSentencesPerParagraph,
    },
  });

  let usedModel = model;
  let usedEffort = effort;
  let res = runWorker({ model, effort, prompt, timeoutMs });
  if ((res.error || res.status !== 0) && isTransientWorkerFailure(res)) {
    const fallbackModel = distinctFallbackModel(model);
    process.stderr.write(
      `[author-repair] transient worker failure on ${model}: ${workerFailureReason(res, timeoutMs)}; `
      + `falling back once to ${fallbackModel} ${DEFAULT_FALLBACK_EFFORT}\n`,
    );
    usedModel = fallbackModel;
    usedEffort = DEFAULT_FALLBACK_EFFORT;
    res = runWorker({
      model: fallbackModel,
      effort: DEFAULT_FALLBACK_EFFORT,
      prompt,
      timeoutMs,
    });
  }
  if (res.error) {
    writeWorkerDebugSidecars(o.out, res);
    return fail(workerFailureReason(res, timeoutMs));
  }
  if (res.status !== 0) {
    writeWorkerDebugSidecars(o.out, res);
    return fail(workerFailureReason(res, timeoutMs));
  }

  // Strip any chatbot preamble before the first H1 (reuse the orchestrator's
  // lib/strip-preamble.mjs), then require real content. Empty/whitespace-only
  // output is a tooling failure — write nothing so the caller parks as before.
  const fixed = stripPreH1(String(res.stdout || ''));
  if (!fixed || !fixed.trim()) {
    writeWorkerDebugSidecars(o.out, res);
    return fail('worker produced empty output');
  }

  // Write ONLY --out. --source is never touched.
  try {
    writeFileSync(o.out, fixed);
  } catch (e) {
    return fail(`cannot write --out: ${e.code || e.message}`);
  }
  process.stdout.write(`[author-repair] wrote ${o.out} (${fixed.length}B, model=${usedModel} effort=${usedEffort})\n`);
  process.exit(0);
}

main();
