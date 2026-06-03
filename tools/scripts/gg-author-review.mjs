#!/usr/bin/env node
// gg-author-review.mjs — multi-party review for the autopilot authoring loop.
//
// "多方审核撰写": an INDEPENDENT model (Codex / gpt-5.5) critiques a draft the
// writer model (Opus) produced, then Opus revises to address the critique. This
// adds the qualitative review layer that the deterministic phase2 gate cannot do
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

const REVISE_PROMPT = (critique, draft) => `You are revising your own astrology SEO article after an editor's review. Apply every applicable point of the feedback, but PRESERVE the structure exactly: the same H1, the same set of H2 sections with their exact heading wording, the CTA section + its link, the Sources section, and the 1500–1800 word range. Improve substance and specificity; do not pad, do not regress structure, do not add meta commentary.

Output the COMPLETE revised article ONLY — from the "# " H1 line through the final Sources entry. Nothing before the H1, nothing after the last source.

--- EDITOR FEEDBACK ---
${critique}

--- CURRENT DRAFT ---
${draft}`;

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.source || !o.out) { process.stderr.write('usage: --source <draft.md> --out <revised.md> --page-id <id>\n'); process.exit(2); }
  const draft = readFileSync(o.source, 'utf8');
  const keep = (why) => { writeFileSync(o.out, draft); process.stdout.write(`review: no-change (${why})\n`); process.exit(0); };

  // 1. Codex critique (independent reviewer)
  let critique;
  try {
    critique = run(CODEX, ['exec', '-c', 'model=gpt-5.5', '-c', 'reasoning_effort=high', '-'],
      CRITIQUE_PROMPT(o.entity, o.targetKeyword, draft), 420000).trim();
  } catch (e) {
    return keep(`codex review unavailable: ${String(e.message || e).replace(/\s+/g, ' ').slice(-100)}`);
  }
  const bullets = critique.split('\n').filter((l) => /^\s*([-*]|\d+\.)\s+\S/.test(l));
  if (/\bLGTM\b/i.test(critique) || bullets.length === 0) return keep('codex: LGTM / no actionable issues');

  // 2. Opus revises to address the critique
  let revised;
  try {
    revised = run(CLAUDE, ['-p', '--model', 'claude-opus-4-7'], REVISE_PROMPT(critique, draft), 600000);
  } catch (e) {
    return keep(`reviser failed: ${String(e.message || e).replace(/\s+/g, ' ').slice(-100)}`);
  }
  revised = cleanArticle(revised);
  // Safety: never emit a broken/short revision — fall back to the passing draft.
  if (!/^# .+/m.test(revised) || revised.length < draft.length * 0.6) return keep('revision looked malformed — kept original');

  writeFileSync(o.out, revised);
  process.stdout.write(`review: revised (${bullets.length} issue(s) from codex)\n`);
}

main();
