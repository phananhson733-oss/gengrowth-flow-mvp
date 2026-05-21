// Generalized Phase 2 validation + publish script. Reusable per entity.
// Bypasses Sheet integration (Sheet row may not be filled). Runs binary checks
// via lib/red-lines.mjs + structure check. If all pass → writes _staging/{base}.md
// with frontmatter + manifest.json.
//
// Usage:
//   node tools/scripts/_phase2-validate.mjs \
//     --source <path-to-llm-output.md> \
//     --tag <suffix>  \
//     --page-id <page_X> \
//     --entity "Display Name" \
//     --target-keyword "keyword phrase" \
//     [--associated-keywords "k1, k2, k3"] \
//     [--template Definition] [--tier T2] \
//     [--word-min 1500] [--word-max 1800] \
//     [--kw-min 5] [--kw-max 8] \
//     [--expected-h2 7] \
//     [--psych-safety N] \
//     [--llm-source "Claude Opus 4.7"] \
//     [--prompt-version v7]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  checkRL1,
  checkRL2,
  checkRL3,
  checkRL4,
  checkRL5,
  checkRL6,
} from './lib/red-lines.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const STAGING_DIR = join(REPO, '_staging');
const SERP_DIR = join(REPO, '.gg-cache', 'serp');

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

const args = parseArgs(process.argv.slice(2));

function req(name) {
  if (!args[name]) {
    process.stderr.write(`[phase2] missing --${name.replace(/_/g, '-')}\n`);
    process.exit(2);
  }
  return args[name];
}

const ctx = {
  source: req('source'),
  tag: req('tag'),
  page_id: req('page_id'),
  entity: req('entity'),
  target_keyword: req('target_keyword'),
  associated_keywords: (args.associated_keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
  template: args.template || 'Definition',
  tier: args.tier || 'T2',
  track: '量产线',
  page_role: 'Support',
  psych_safety_flag: args.psych_safety || 'N',
  llm_source: args.llm_source || 'unknown',
  prompt_version: args.prompt_version || 'v7',
  word_range_min: Number.parseInt(args.word_min, 10) || 1500,
  word_range_max: Number.parseInt(args.word_max, 10) || 1800,
  kw_min: Number.parseInt(args.kw_min, 10) || 5,
  kw_max: Number.parseInt(args.kw_max, 10) || 8,
  expected_h1: 1,
  expected_h2: Number.parseInt(args.expected_h2, 10) || 7,
};
const outBasename = `${ctx.page_id}-${ctx.tag}`;

function structureCheck(draft) {
  const findings = [];
  const h1Count = (draft.match(/^# /gm) || []).length;
  const h2Count = (draft.match(/^## /gm) || []).length;
  const h3Count = (draft.match(/^### /gm) || []).length;
  const h4Count = (draft.match(/^#### /gm) || []).length;
  if (h1Count !== ctx.expected_h1) findings.push(`H1 count = ${h1Count}, expected ${ctx.expected_h1}`);
  if (h2Count !== ctx.expected_h2) findings.push(`H2 count = ${h2Count}, expected ${ctx.expected_h2}`);
  if (h3Count !== 0) findings.push(`H3 count = ${h3Count}, expected 0`);
  if (h4Count !== 0) findings.push(`H4 count = ${h4Count}, expected 0`);

  const words = draft.trim().split(/\s+/).filter(Boolean).length;
  if (words < ctx.word_range_min) findings.push(`word count ${words} < min ${ctx.word_range_min}`);
  if (words > ctx.word_range_max) findings.push(`word count ${words} > max ${ctx.word_range_max}`);

  const requiredH2s = [
    `## What is ${ctx.entity}?`,
    '## Why It Matters for Self-Awareness',
    `## ${ctx.entity} vs Adjacent Concepts: Mechanism + Trade-offs`,
    '## Quick Reference Table',
    '## Reflection Prompts',
    '## Related Reading',
    '## Take Action',
  ];
  for (const h of requiredH2s) {
    if (!draft.includes(h)) findings.push(`missing required H2: "${h}"`);
  }

  const wikilinks = draft.match(/\[\[[^\]]+\]\]/g) || [];
  const tbdLinks = wikilinks.filter((l) => /^\[\[<TBD-internal-link: /.test(l));
  if (wikilinks.length !== tbdLinks.length) {
    findings.push(`${wikilinks.length - tbdLinks.length} wikilink(s) not in TBD format`);
  }
  if (wikilinks.length < 2) findings.push(`Related Reading has only ${wikilinks.length} wikilink(s), recommend ≥3`);

  // Anti-fluff: no preamble between H1 and first H2.
  const lines = draft.split('\n');
  let inPreambleZone = false;
  for (const line of lines) {
    if (/^# /.test(line)) { inPreambleZone = true; continue; }
    if (inPreambleZone) {
      if (/^## /.test(line)) break;
      if (line.trim() !== '' && !line.startsWith('#')) {
        findings.push(`preamble paragraph found between H1 and H2 #1: "${line.slice(0, 60)}…"`);
        break;
      }
    }
  }

  // Trailing chatbot meta scan.
  const tail = draft.slice(-500);
  if (/(would you like|let me know|i can also|do you want to|happy to help)/i.test(tail)) {
    findings.push('trailing chatbot meta detected in last 500 chars');
  }

  return { ok: findings.length === 0, findings, stats: { h1Count, h2Count, h3Count, h4Count, words, wikilinks: wikilinks.length, tbdLinks: tbdLinks.length } };
}

// ---------- main ----------

console.log('━'.repeat(60));
console.log(`Phase 2 validation: ${ctx.page_id} (${ctx.entity})`);
console.log(`Source: ${ctx.source}`);
console.log(`LLM: ${ctx.llm_source} / prompt: ${ctx.prompt_version}`);
console.log('━'.repeat(60));

const rawSource = readFileSync(ctx.source, 'utf8');
// Strip YAML frontmatter if present. Fresh LLM output has none; re-runs on
// published files carry an auto-added frontmatter listing target_keyword +
// associated_keywords which would otherwise double-count and falsely fail RL5.
const draft = rawSource.startsWith('---\n')
  ? rawSource.replace(/^---\n[\s\S]*?\n---\n+/, '')
  : rawSource;
if (!draft.match(/^#\s+.+$/m)) {
  console.error('ERROR: draft has no H1; aborting');
  process.exit(1);
}

const results = {};
let pass = true;

console.log('\n▸ Structure check');
const struct = structureCheck(draft);
results.structure = struct;
if (struct.ok) {
  console.log(`  ✓ PASS  H1=${struct.stats.h1Count} H2=${struct.stats.h2Count} H3=${struct.stats.h3Count} words=${struct.stats.words} wikilinks=${struct.stats.wikilinks} (all TBD)`);
} else {
  pass = false;
  console.log('  ✗ FAIL');
  struct.findings.forEach((f) => console.log(`    - ${f}`));
}

// SERP cache load
const serpPath = join(SERP_DIR, `${ctx.page_id}.json`);
let serpCtx;
try {
  const raw = JSON.parse(readFileSync(serpPath, 'utf8'));
  const snips = Array.isArray(raw.snippets) ? raw.snippets.filter((s) => typeof s === 'string' && s.length > 0) : [];
  serpCtx = snips.length > 0
    ? { serpState: 'hit', snippets: snips, escapeReason: null }
    : { serpState: 'missing-skipped', snippets: [], escapeReason: 'cache present but empty' };
} catch {
  serpCtx = { serpState: 'missing-skipped', snippets: [], escapeReason: 'no cache' };
}

const rlChecks = [
  ['RL1 (clinical claims)', () => checkRL1(draft)],
  ['RL2 (competitor smear)', () => checkRL2(draft)],
  ['RL3 (SERP plagiarism)', () => checkRL3(draft, serpCtx)],
  ['RL4 (keyword anchored)', () => checkRL4(draft, { targetKeyword: ctx.target_keyword, entity: ctx.entity })],
  ['RL5 (keyword stuffing)', () => checkRL5(draft, { targetKeyword: ctx.target_keyword })],
  ['RL6 (psych safety)', () => checkRL6(draft, { psych_safety_flag: ctx.psych_safety_flag })],
];

const WAIVERS = new Set(); // No waivers — B'.3 SERP cache now live.

for (const [name, fn] of rlChecks) {
  console.log(`\n▸ ${name}`);
  try {
    const r = fn();
    results[name] = r;
    if (r.pass === true) {
      console.log(`  ✓ PASS  ${r.note || ''}`);
    } else {
      const rlKey = name.split(' ')[0];
      if (WAIVERS.has(rlKey)) {
        results[name].waived = true;
        console.log(`  ⚠ WAIVED (${rlKey}) — ${r.note || ''}`);
      } else {
        pass = false;
        console.log(`  ✗ FAIL  ${r.note || JSON.stringify(r)}`);
      }
    }
  } catch (e) {
    pass = false;
    console.log(`  ✗ ERROR: ${e.message}`);
    results[name] = { pass: false, error: e.message };
  }
}

console.log('\n' + '━'.repeat(60));
if (!pass) {
  console.log('OVERALL: FAIL — not writing to _staging');
  process.exit(11);
}
console.log('OVERALL: PASS — writing to _staging');

// ---------- write publish-ready file ----------

const sha = createHash('sha256').update(draft).digest('hex').slice(0, 16);
const generatedAt = new Date().toISOString();

const frontmatter = `---
title: ${ctx.entity} Meaning
slug: ${ctx.target_keyword.replace(/\s+/g, '-')}
date: ${generatedAt.slice(0, 10)}
status: ready-to-review
type: wiki-entry
template: ${ctx.template}
tier: ${ctx.tier}
track: ${ctx.track}
page_id: ${ctx.page_id}
target_keyword: ${ctx.target_keyword}
associated_keywords:
${ctx.associated_keywords.map((k) => `  - ${k}`).join('\n')}
generated_by: ${ctx.llm_source}
prompt_version: ${ctx.prompt_version}
generated_at: ${generatedAt}
content_sha256_short: ${sha}
phase2_checks: all-pass
---

`;

mkdirSync(STAGING_DIR, { recursive: true });
const outMdPath = join(STAGING_DIR, `${outBasename}.md`);
const outManifestPath = join(STAGING_DIR, `${outBasename}.manifest.json`);

writeFileSync(outMdPath, frontmatter + draft);
console.log(`\n  ✓ wrote ${outMdPath} (${(frontmatter + draft).length} bytes)`);

const manifest = {
  schema_version: '1',
  page_id: ctx.page_id,
  entity: ctx.entity,
  target_keyword: ctx.target_keyword,
  template: ctx.template,
  tier: ctx.tier,
  track: ctx.track,
  generated_by: ctx.llm_source,
  prompt_version: ctx.prompt_version,
  generated_at: generatedAt,
  content_sha256_short: sha,
  source_path: ctx.source,
  staging_path: outMdPath,
  phase2_checks: {
    overall: 'pass',
    structure: struct.stats,
    rl1: results['RL1 (clinical claims)']?.pass ?? false,
    rl2: results['RL2 (competitor smear)']?.pass ?? false,
    rl3: results['RL3 (SERP plagiarism)']?.pass ?? false,
    rl4: results['RL4 (keyword anchored)']?.pass ?? false,
    rl5: results['RL5 (keyword stuffing)']?.pass ?? false,
    rl6: results['RL6 (psych safety)']?.pass ?? false,
  },
};
writeFileSync(outManifestPath, JSON.stringify(manifest, null, 2));
console.log(`  ✓ wrote ${outManifestPath}`);
console.log('\n' + '━'.repeat(60));
console.log('DONE');
