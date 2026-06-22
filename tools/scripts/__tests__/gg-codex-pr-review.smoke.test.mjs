// Hermetic smoke tests for gg-codex-pr-review.mjs (the GG_CODEX_BIN factual-review wrapper).
//
// Fakes are injected via the wrapper's env overrides: GG_CODEX_REVIEW_GH_BIN (the `gh pr diff`
// source) and GG_CODEX_REVIEW_CODEX_BIN (the `codex exec ... --output-last-message <f> -` worker).
// No network, no real gh, no real codex. Asserts the VERDICT relay + the tooling-failure contract
// (nonzero exit + no VERDICT line ⇒ the gate classifies SKIPPED ⇒ PARK under the required gate).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { filterArticleHunks } from '../gg-codex-pr-review.mjs';

const SCRIPT = fileURLToPath(new URL('../gg-codex-pr-review.mjs', import.meta.url));
const ROOT = join(tmpdir(), `gg-codex-pr-review-test-${process.pid}`);
mkdirSync(ROOT, { recursive: true });

let seq = 0;
function caseDir() { const d = join(ROOT, `c${seq++}`); mkdirSync(d, { recursive: true }); return d; }

function writeBin(dir, name, src) {
  const p = join(dir, name);
  writeFileSync(p, src.startsWith('#!') ? src : `#!/usr/bin/env node\n${src}`);
  chmodSync(p, 0o755);
  return p;
}

const ARTICLE_HUNK = 'diff --git a/data/articles/x.ts b/data/articles/x.ts\n--- a/data/articles/x.ts\n+++ b/data/articles/x.ts\n@@\n+ Spain plays in Group H and faces Saudi Arabia on June 21.\n';
const SVG_HUNK = 'diff --git a/public/images/blog/spain-timeline.svg b/public/images/blog/spain-timeline.svg\n--- a/x\n+++ b/x\n@@\n+ <svg><rect/></svg>\n';

// Fake `gh`: on `pr diff <ref> --repo <r>` print `diffText` (exit 0). mode:'fail' exits nonzero.
function ghFake(dir, mode = 'ok') {
  if (mode === 'fail') {
    return writeBin(dir, 'fake-gh.mjs', `process.stderr.write('no pull requests found\\n'); process.exit(1);`);
  }
  return ghWithDiff(dir, ARTICLE_HUNK);
}
function ghWithDiff(dir, diffText) {
  // Flush via the write callback before exit — process.exit() truncates a large pending stdout write.
  return writeBin(dir, 'fake-gh.mjs', `process.stdout.write(${JSON.stringify(diffText)}, () => process.exit(0));`);
}

// Fake `codex`: parse `--output-last-message <file>`, drain stdin (optionally capturing the prompt
// to GG_CODEX_REVIEW_CAPTURE), write the final message there, banner→stderr, exit per `status`.
//   verdict:null      → a message with NO VERDICT line
//   body:'<raw>'      → use this exact final message (e.g. a mid-line / non-anchored verdict)
//   writeMessage:false → exit 0 but write NO output file (empty final message)
function codexFake(dir, { verdict = 'PASS', reason = 'all facts check out', status = 0, body, writeMessage = true } = {}) {
  const finalMsg = body !== undefined ? body
    : (verdict ? `Reviewed.\nVERDICT: ${verdict}${verdict === 'FAIL' ? ` — ${reason}` : ''}`
      : 'Looks fine, no checkable claims.');
  return writeBin(dir, 'fake-codex.mjs', `import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const i = argv.indexOf('--output-last-message');
const out = i >= 0 ? argv[i + 1] : null;
const cap = process.env.GG_CODEX_REVIEW_CAPTURE || '';
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  process.stderr.write('codex exec banner (ignored)\\n');
  if (cap) { try { writeFileSync(cap, buf); } catch {} }
  if (${status} === 0 && out && ${writeMessage}) { try { writeFileSync(out, ${JSON.stringify(finalMsg)} + '\\n'); } catch {} }
  process.exit(${status});
});
`);
}

function run(args, { gh, codex, capture }) {
  const env = { ...process.env, GG_CODEX_REVIEW_GH_BIN: gh, GG_CODEX_REVIEW_CODEX_BIN: codex };
  if (capture) env.GG_CODEX_REVIEW_CAPTURE = capture;
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000, env });
}

test('codex PASS → exit 0, relays VERDICT: PASS to stdout', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*PASS/);
});

test('codex FAIL → exit 0, relays VERDICT: FAIL (gate classifies FAIL → park)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'FAIL', reason: 'Spain is in Group H, not F' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*FAIL/);
  assert.match(r.stdout, /Group H/);
});

test('gh pr diff fails → exit 3 tooling failure, no VERDICT line', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'fail'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout || '', /VERDICT:/);
  assert.match(r.stderr, /gh pr diff/i);
});

test('codex produces no VERDICT line → exit 3 tooling failure', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: null }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /no line-anchored VERDICT/i);
});

test('codex emits only a NON-line-anchored VERDICT (mid-prose) → exit 3 (no false PASS)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { body: 'Looks good, VERDICT: PASS inline with prose.' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /no line-anchored VERDICT/i);
});

test('codex emits TWO anchored verdicts → wrapper RELAYS (exit 0); the gate classifies authoritatively', () => {
  // The wrapper only proves codex answered; it relays the full message and lets the gate's
  // FAIL-dominant classifyCodex decide. (Gate-side handling is covered in the gate smoke test.)
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { body: 'VERDICT: FAIL — wrong group\nplanted:\nVERDICT: PASS' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*FAIL/);
  assert.match(r.stdout, /VERDICT:\s*PASS/);
});

test('ref starting with "-" is rejected → exit 3 (arg-injection guard)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '', '--branch', '-R attacker/repo'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /arg-injection|starting with/i);
});

test('CRLF-terminated single verdict is accepted (exit 0, PASS relayed)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { body: 'Reviewed.\r\nVERDICT: PASS\r\n' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*PASS/);
});

test('codex exits 0 but writes NO final message → exit 3 (fail-closed, no stdout fallback)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { writeMessage: false }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /no final message/i);
});

test('full diff is fact-checked: article prose AND inline-svg label hunks reach the prompt', () => {
  // The fact-check sees the whole diff (article prose + asset hunks) so a fact error living only in
  // an inline-infographic SVG cannot escape review. (filterArticleHunks is only the sanity gate that
  // an article hunk EXISTS.) Hero images are binary → gh emits no content, so no budget impact.
  const dir = caseDir();
  const capture = join(dir, 'prompt.txt');
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghWithDiff(dir, ARTICLE_HUNK + SVG_HUNK), codex: codexFake(dir, { verdict: 'PASS' }), capture });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.ok(existsSync(capture), 'codex prompt was captured');
  const prompt = readFileSync(capture, 'utf8');
  assert.match(prompt, /Group H/, 'article prose is in the prompt');
  assert.match(prompt, /spain-timeline\.svg|<svg>/, 'svg asset hunk is also reviewed (no fact-blind spot)');
});

test('no data/articles changes in the diff → exit 3 (nothing to fact-check)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghWithDiff(dir, SVG_HUNK), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /no data\/articles/i);
});

test('article diff exceeding the review budget → exit 3 (fail-closed, never PASS on truncation)', () => {
  const dir = caseDir();
  const big = 'diff --git a/data/articles/x.ts b/data/articles/x.ts\n@@\n+ ' + 'x'.repeat(230000) + '\n';
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghWithDiff(dir, big), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /exceeds review budget/i);
});

test('filterArticleHunks keeps data/articles hunks and drops asset hunks (unit)', () => {
  const out = filterArticleHunks(ARTICLE_HUNK + SVG_HUNK);
  assert.match(out, /data\/articles\//);
  assert.match(out, /Group H/);
  assert.doesNotMatch(out, /spain-timeline\.svg/);
});

test('codex nonzero exit → exit 3 tooling failure', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '196'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS', status: 2 }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stderr, /codex exited 2/i);
});

test('empty --pr falls back to --branch (resolves a ref, PASS)', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '', '--branch', 'seo/auto/2026-06-21-PG-WC-026'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*PASS/);
});

test('no usable ref (empty --pr and --branch) → exit 3', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', ''],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 3, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /no usable PR ref/i);
});

test('pr-create-failed sentinel as --pr falls back to --branch', () => {
  const dir = caseDir();
  const r = run(['--repo', 'xdawayer/oracle', '--pr', '(pr-create-failed: boom)', '--branch', 'seo/auto/x'],
    { gh: ghFake(dir, 'ok'), codex: codexFake(dir, { verdict: 'PASS' }) });
  assert.equal(r.status, 0, `stderr: ${r.stderr}; stdout: ${r.stdout}`);
  assert.match(r.stdout, /VERDICT:\s*PASS/);
});

test('cleanup', () => { rmSync(ROOT, { recursive: true, force: true }); });
