#!/usr/bin/env node
// Hermetic smoke tests for gg-article-review-worker.mjs.
// Fake 'claude' bin on a tmp PATH → no real LLM, no network. Mirrors the
// node:test + spawnSync black-box style of tools/scripts/__tests__/.
//
// Run: node --test /tmp/gg-landing-staging/__tests__/gg-article-review-worker.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-article-review-worker.mjs', import.meta.url));
const TMP = join(tmpdir(), `gg-review-worker-test-${process.pid}`);
mkdirSync(TMP, { recursive: true });

// Seed a tiny article .ts and source draft .md.
const ARTICLE_TS = join(TMP, 'page_chiron_7th.ts');
const DRAFT_MD = join(TMP, 'page_chiron_7th.md');
writeFileSync(
  ARTICLE_TS,
  `export const page = { slug: 'chiron-in-7th-house', title: 'Chiron in 7th House', schema: { '@type': 'Article' }, body: 'Chiron in the 7th house...' };\n`,
);
writeFileSync(DRAFT_MD, `# Chiron in 7th House\n\n## Meaning\nReflective body about [[chiron]] in relationships.\n`);

// Make a fake 'claude' bin (a shell script printing canned output). Returns the
// absolute path to the fake, injected via GG_REVIEW_WORKER_CLAUDE_BIN so it wins
// over the real /opt/homebrew/bin/claude on this machine — NO real LLM is spawned.
// `payload` is the exact stdout the fake emits; `exitCode` its exit status.
function fakeBin(payload, { exitCode = 0 } = {}) {
  const dir = join(TMP, `bin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'claude');
  // Single-quote the printf arg so /bin/sh does NOT interpret backticks,
  // $, or quotes inside the payload (e.g. ```json fences). A single quote in
  // the payload is escaped via the '\'' idiom.
  const quoted = `'${payload.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh\ncat >/dev/null\nprintf '%s' ${quoted}\nexit ${exitCode}\n`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

function run(args, { fake, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ...(fake ? { GG_REVIEW_WORKER_CLAUDE_BIN: fake } : {}),
      ...env,
    },
  });
}

test('PASS verdict: exit 0 and parsed verdict === PASS (--json)', () => {
  const fake = fakeBin('{"verdict":"PASS","blocking_reason":""}');
  const r = run(
    ['--dimension', 'schema', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'PASS');
  assert.equal(out.dimension, 'schema');
  assert.deepEqual(out.notes, []);
});

test('FAIL verdict is a SUCCESSFUL review: exit 0, verdict FAIL', () => {
  const fake = fakeBin('{"verdict":"FAIL","blocking_reason":"wrong rulership","notes":["fix ruler -> Venus"]}');
  const r = run(
    ['--dimension', 'astrology', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.blocking_reason, 'wrong rulership');
  assert.deepEqual(out.notes, ['fix ruler -> Venus']);
});

test('prose-wrapped JSON: first object extracted', () => {
  const fake = fakeBin(
    'Sure! Here is my review:\n```json\n{"verdict":"PASS","blocking_reason":"","notes":[]}\n```\nHope that helps.',
  );
  const r = run(
    ['--dimension', 'links-seo', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).verdict, 'PASS');
});

test('prose brace BEFORE verdict object: real verdict extracted, NOT SKIPPED (regression: anchoring on first { hijacks extraction)', () => {
  // A leading non-verdict brace in the commentary. The OLD extractor anchored on
  // the FIRST '{' ("{curly}"), parsed that fragment, found no PASS/FAIL verdict
  // and fell through to SKIPPED. The fixed extractor must skip the prose brace
  // and lock onto the real verdict object further along.
  const fake = fakeBin(
    'The {curly} block looks fine. Verdict: {"verdict":"PASS","blocking_reason":"","notes":["ok -> ship"]}',
  );
  const r = run(
    ['--dimension', 'astrology', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 0, `expected exit 0 (real verdict), got ${r.status}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'PASS', `expected PASS, got ${out.verdict} (prose brace hijacked extraction?)`);
  assert.notEqual(out.verdict, 'SKIPPED', 'prose brace must not cause a SKIPPED fall-through');
  assert.deepEqual(out.notes, ['ok -> ship']);
});

test('prose brace that IS parseable JSON but lacks a verdict: skipped, real verdict still found', () => {
  // Harder case: the leading brace parses to a real JSON object but carries no
  // PASS/FAIL verdict. Extractor must reject it (normalizeVerdict → null) and
  // keep scanning to the genuine verdict object.
  const fake = fakeBin(
    'Context: {"note":"this is metadata, not a verdict"} and now the result {"verdict":"FAIL","blocking_reason":"bad rulership","notes":[]}',
  );
  const r = run(
    ['--dimension', 'astrology', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'FAIL');
  assert.equal(out.blocking_reason, 'bad rulership');
});

test('--article is a directory: clean structured SKIPPED (exit 1), not a raw EISDIR stack', () => {
  // A directory path passes validate()'s existsSync check but readFileSync throws
  // EISDIR. Must route to a clean SKIPPED tooling failure, never dump a raw stack.
  const dirAsArticle = join(TMP, 'article-is-a-dir');
  mkdirSync(dirAsArticle, { recursive: true });
  const fake = fakeBin('{"verdict":"PASS","blocking_reason":""}');
  const r = run(
    ['--dimension', 'schema', '--article', dirAsArticle, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 1, `expected clean exit 1, got ${r.status}; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'SKIPPED');
  assert.match(out.blocking_reason, /cannot read article/);
  // The failure must be the structured SKIPPED line, NOT a raw node stack trace.
  assert.doesNotMatch(r.stderr || '', /EISDIR|at Object\.readFileSync|at main/, 'raw stack leaked');
});

test('no parseable JSON: SKIPPED + nonzero exit (tooling failure must not pass)', () => {
  const fake = fakeBin('I cannot produce JSON, sorry.');
  const r = run(
    ['--dimension', 'schema', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.verdict, 'SKIPPED');
  assert.match(out.blocking_reason, /no parseable JSON verdict/);
});

test('worker nonzero exit: SKIPPED + nonzero exit', () => {
  const fake = fakeBin('boom', { exitCode: 3 });
  const r = run(
    ['--dimension', 'schema', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout.trim()).verdict, 'SKIPPED');
});

test('invalid --dimension → exit 2 (CLI error)', () => {
  const fake = fakeBin('{"verdict":"PASS","blocking_reason":""}');
  const r = run(
    ['--dimension', 'bogus', '--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /invalid/);
});

test('missing --dimension → exit 2', () => {
  const fake = fakeBin('{"verdict":"PASS","blocking_reason":""}');
  const r = run(['--article', ARTICLE_TS, '--draft', DRAFT_MD, '--json'], { fake });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--dimension is required/);
});

test('missing article file → exit 2', () => {
  const fake = fakeBin('{"verdict":"PASS","blocking_reason":""}');
  const r = run(
    ['--dimension', 'schema', '--article', join(TMP, 'nope.ts'), '--draft', DRAFT_MD, '--json'],
    { fake },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not found/);
});

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true });
});
