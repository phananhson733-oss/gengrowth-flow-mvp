#!/usr/bin/env node
// Hermetic smoke tests for gg-author-repair.mjs.
// Fake 'claude' bin injected via GG_AUTHOR_REPAIR_BIN → no real LLM, no network.
// Mirrors the node:test + spawnSync black-box style of tools/scripts/__tests__/.
//
// Run: node --test /tmp/gg-landing-staging/__tests__/gg-author-repair.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-author-repair.mjs', import.meta.url));
const TMP = join(tmpdir(), `gg-author-repair-test-${process.pid}`);
mkdirSync(TMP, { recursive: true });

const SOURCE_CONTENT = `# Solar Return Meaning\n\n## What It Is\nThe system marks a yearly cycle.\n\n## Sources\n- ref\n`;

// A fake 'claude' bin: a shell script that discards stdin and prints canned
// stdout. Injected via GG_AUTHOR_REPAIR_BIN so it wins over the real CLI — NO
// real LLM is spawned. `payload` is the exact stdout; `exitCode` its status.
function fakeBin(payload, { exitCode = 0 } = {}) {
  const dir = join(TMP, `bin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'claude');
  const quoted = `'${payload.replace(/'/g, `'\\''`)}'`;
  const script = `#!/bin/sh\ncat >/dev/null\nprintf '%s' ${quoted}\nexit ${exitCode}\n`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return p;
}

// A fake bin that records the EXACT argv it was invoked with, so a test can
// assert there is NO --allowedTools / --dangerously-skip-permissions.
function recordingFakeBin(payload) {
  const dir = join(TMP, `recbin-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const argvLog = join(dir, 'argv.txt');
  const p = join(dir, 'claude');
  const quoted = `'${payload.replace(/'/g, `'\\''`)}'`;
  // "$@" written one arg per line so the test can read the full invocation.
  const script = `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${argvLog}'\ncat >/dev/null\nprintf '%s' ${quoted}\nexit 0\n`;
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return { bin: p, argvLog };
}

function seedSource() {
  const src = join(TMP, `src-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(src, SOURCE_CONTENT);
  return src;
}

function run(args, { fake, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      ...(fake ? { GG_AUTHOR_REPAIR_BIN: fake } : {}),
      ...env,
    },
  });
}

test('repairs draft: --source UNCHANGED, --out has fixed content, NO --allowedTools', () => {
  const src = seedSource();
  const out = join(TMP, `out-${Math.random().toString(36).slice(2)}.md`);
  const { bin, argvLog } = recordingFakeBin('# Fixed\n\nBetter');
  const r = run(
    [
      '--source', src, '--out', out, '--page-id', 'PG-SOLAR-001',
      '--target-keyword', 'solar return meaning', '--author', 'lynne-wang',
      '--failures', '- RL4 drift: anchor the keyword in each section',
    ],
    { fake: bin },
  );

  assert.equal(r.status, 0, `expected exit 0; stderr: ${r.stderr}`);

  // --source is UNCHANGED (read-only input, never mutated).
  assert.equal(readFileSync(src, 'utf8'), SOURCE_CONTENT, '--source was modified');

  // --out has the fixed content (worker stdout, pre-H1-stripped).
  assert.ok(existsSync(out), '--out was not written');
  assert.equal(readFileSync(out, 'utf8'), '# Fixed\n\nBetter', '--out content mismatch');

  // The invocation has NO --allowedTools and NO --dangerously-skip-permissions.
  const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
  assert.ok(!argv.includes('--allowedTools'), `--allowedTools leaked into argv: ${argv.join(' ')}`);
  assert.ok(
    !argv.includes('--dangerously-skip-permissions'),
    `--dangerously-skip-permissions leaked into argv: ${argv.join(' ')}`,
  );
  // It IS the text-only worker: claude -p --model <m> --effort <e>.
  assert.ok(argv.includes('-p'), 'expected -p flag');
  assert.ok(argv.includes('--model'), 'expected --model flag');
  assert.ok(argv.includes('--effort'), 'expected --effort flag');
});

test('strips chatbot preamble before the first H1', () => {
  const src = seedSource();
  const out = join(TMP, `out-pre-${Math.random().toString(36).slice(2)}.md`);
  const fake = fakeBin('Here is the corrected article:\n\n# Fixed\n\nBetter body.');
  const r = run(
    [
      '--source', src, '--out', out, '--page-id', 'PG-X', '--target-keyword', 'kw',
      '--author', 'a', '--failures', '- something',
    ],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(readFileSync(out, 'utf8'), '# Fixed\n\nBetter body.', 'preamble not stripped');
});

test('--failures as a FILE PATH is read as the failure text', () => {
  const src = seedSource();
  const out = join(TMP, `out-ffile-${Math.random().toString(36).slice(2)}.md`);
  const failFile = join(TMP, `fails-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(failFile, '- RL6: missing disclaimer\n- RL5: stuffing');
  const fake = fakeBin('# Fixed\n\nBody');
  const r = run(
    [
      '--source', src, '--out', out, '--page-id', 'PG-X', '--target-keyword', 'kw',
      '--author', 'a', '--failures', failFile,
    ],
    { fake },
  );
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.equal(readFileSync(out, 'utf8'), '# Fixed\n\nBody');
});

test('worker empty output: exit 1, --out NOT written, --source unchanged', () => {
  const src = seedSource();
  const out = join(TMP, `out-empty-${Math.random().toString(36).slice(2)}.md`);
  const fake = fakeBin('   \n  ');
  const r = run(
    [
      '--source', src, '--out', out, '--page-id', 'PG-X', '--target-keyword', 'kw',
      '--author', 'a', '--failures', '- x',
    ],
    { fake },
  );
  assert.equal(r.status, 1, `expected exit 1; stderr: ${r.stderr}`);
  assert.ok(!existsSync(out), '--out must NOT be written on empty worker output');
  assert.equal(readFileSync(src, 'utf8'), SOURCE_CONTENT, '--source must be unchanged');
});

test('worker nonzero exit: exit 1, --out NOT written', () => {
  const src = seedSource();
  const out = join(TMP, `out-boom-${Math.random().toString(36).slice(2)}.md`);
  const fake = fakeBin('boom', { exitCode: 3 });
  const r = run(
    [
      '--source', src, '--out', out, '--page-id', 'PG-X', '--target-keyword', 'kw',
      '--author', 'a', '--failures', '- x',
    ],
    { fake },
  );
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(!existsSync(out), '--out must NOT be written on worker failure');
});

test('missing --source → exit 2 (CLI error)', () => {
  const fake = fakeBin('# Fixed');
  const r = run(
    ['--out', join(TMP, 'o.md'), '--page-id', 'PG-X', '--target-keyword', 'kw', '--author', 'a', '--failures', '- x'],
    { fake },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--source/);
});

test('missing --out → exit 2', () => {
  const src = seedSource();
  const fake = fakeBin('# Fixed');
  const r = run(
    ['--source', src, '--page-id', 'PG-X', '--target-keyword', 'kw', '--author', 'a', '--failures', '- x'],
    { fake },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out/);
});

test('nonexistent --source → exit 2', () => {
  const fake = fakeBin('# Fixed');
  const r = run(
    [
      '--source', join(TMP, 'nope.md'), '--out', join(TMP, 'o.md'), '--page-id', 'PG-X',
      '--target-keyword', 'kw', '--author', 'a', '--failures', '- x',
    ],
    { fake },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not found/);
});

test('cleanup', () => {
  rmSync(TMP, { recursive: true, force: true });
});
