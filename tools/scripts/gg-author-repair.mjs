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

// Defaults mirror the agentic-rescue knobs in gg-seo-autopilot.mjs
// (GG_AGENTIC_MODEL || 'claude-sonnet-4-6', GG_AGENTIC_EFFORT || 'high') so the
// replacement keeps the same model/effort behavior when the caller omits them.
const DEFAULT_MODEL = process.env.GG_AUTHOR_REPAIR_MODEL || process.env.GG_AGENTIC_MODEL || 'claude-sonnet-4-6';
const DEFAULT_EFFORT = process.env.GG_AUTHOR_REPAIR_EFFORT || process.env.GG_AGENTIC_EFFORT || 'high';
// Bound a single repair call. Mirrors the agentic-rescue timeout default
// (GG_AUTHOR_AGENTIC_TIMEOUT_MS || 1800000) so wall-clock behavior is unchanged.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.GG_AUTHOR_REPAIR_TIMEOUT_MS || '1800000', 10);

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
function buildPrompt({ source, targetKeyword, author, failures }) {
  return [
    'You are repairing a single SEO article draft that failed an automated QA pass.',
    'Apply the smallest changes that fix the listed failures — surgical edits, not a rewrite.',
    '',
    `target_keyword (the exact literal phrase): "${targetKeyword}"`,
    `author id: ${author}`,
    '',
    'The automated QA (phase2) flagged the following failures — fix each one:',
    failures,
    '',
    'Output the complete corrected article only. Keep the exact H1/H2 structure unless a failure says a section is missing. Do not add tools, commands, or meta commentary.',
    '',
    '--- CURRENT DRAFT ---',
    source,
  ].join('\n');
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
    input: prompt,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return res;
}

function fail(reason) {
  process.stderr.write(`[author-repair] tooling failure: ${reason}\n`);
  process.exit(1);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const { errors, timeoutMs } = validate(o);
  if (errors.length) {
    for (const e of errors) process.stderr.write(`[author-repair] ERROR: ${e}\n`);
    process.stderr.write(
      'usage: --source <draft.md> --out <candidate.md> --page-id <id> --target-keyword "<phrase>" '
      + '--author <id> --failures "<text|path>" [--model <m>] [--effort <e>] [--timeout-ms <n>]\n',
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
  const prompt = buildPrompt({ source, targetKeyword: o.targetKeyword, author: o.author, failures });

  const res = runWorker({ model, effort, prompt, timeoutMs });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') return fail(`worker timed out after ${timeoutMs}ms`);
    if (res.error.code === 'ENOENT') return fail('claude CLI not found in PATH');
    return fail(`worker spawn failed (${res.error.code || res.error.message})`);
  }
  if (res.status !== 0) {
    const tail = String(res.stderr || '').slice(-200).replace(/\s+/g, ' ').trim();
    return fail(`worker exited ${res.status}${tail ? ` (${tail})` : ''}`);
  }

  // Strip any chatbot preamble before the first H1 (reuse the orchestrator's
  // lib/strip-preamble.mjs), then require real content. Empty/whitespace-only
  // output is a tooling failure — write nothing so the caller parks as before.
  const fixed = stripPreH1(String(res.stdout || ''));
  if (!fixed || !fixed.trim()) return fail('worker produced empty output');

  // Write ONLY --out. --source is never touched.
  try {
    writeFileSync(o.out, fixed);
  } catch (e) {
    return fail(`cannot write --out: ${e.code || e.message}`);
  }
  process.stdout.write(`[author-repair] wrote ${o.out} (${fixed.length}B, model=${model} effort=${effort})\n`);
  process.exit(0);
}

main();
