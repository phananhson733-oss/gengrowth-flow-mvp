#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-llm-orchestrator.mjs');

test('Claude watchdog failure falls back once to Opus and preserves the canonical draft path', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-llm-orchestrator-fallback-'));
  try {
    const bin = join(root, 'bin');
    const out = join(root, 'out');
    const prompt = join(root, 'prompt.md');
    const calls = join(root, 'calls.log');
    mkdirSync(bin, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(prompt, `# Prompt\n\n${'Write a safe structured article. '.repeat(80)}\n`);

    const fakeClaude = join(bin, 'claude');
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$GG_TEST_CALLS"
case "$*" in
  *claude-sonnet-4-6*)
    printf '%s\\n' 'WATCHDOG: no CPU/output progress for 180s (deadlock); group cpu=4.9s' >&2
    exit 1
    ;;
  *claude-opus-4-8*)
    printf '# Recovered Article\\n\\n'
    i=0
    while [ "$i" -lt 220 ]; do
      printf 'This recovered paragraph is long enough for the frontier output guard. '
      i=$((i + 1))
    done
    printf '\\n'
    exit 0
    ;;
esac
exit 9
`);
    chmodSync(fakeClaude, 0o755);

    const run = spawnSync(process.execPath, [
      SCRIPT,
      '--prompt', prompt,
      '--page-id', 'PG-FALLBACK-001',
      '--models', 'claude',
      '--out-dir', out,
      '--retry', '0',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GG_TEST_CALLS: calls,
        GG_CLAUDE_MODEL: 'claude-sonnet-4-6',
        GG_CLAUDE_FALLBACK_MODEL: 'claude-opus-4-8',
        GG_CLAUDE_EFFORT: 'high',
        GG_CLAUDE_FALLBACK_EFFORT: 'high',
      },
    });

    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const canonicalDraft = join(out, 'PG-FALLBACK-001-claude-v8.md');
    assert.match(readFileSync(canonicalDraft, 'utf8'), /^# Recovered Article/);

    const invoked = readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(invoked.length, 2);
    assert.match(invoked[0], /claude-sonnet-4-6/);
    assert.match(invoked[1], /claude-opus-4-8/);

    const summary = JSON.parse(readFileSync(join(out, 'PG-FALLBACK-001-orchestrator.json'), 'utf8'));
    const result = summary.results.claude;
    assert.equal(result.ok, true);
    assert.equal(result.output_path, canonicalDraft);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[1].transient_failure_fallback_to, 'claude-opus-4-8');
    assert.match(result.attempts[1].fallback_reason, /WATCHDOG.*deadlock/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Opus primary automatically selects Sonnet as the distinct fallback when no fallback model is configured', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-llm-orchestrator-opus-primary-'));
  try {
    const bin = join(root, 'bin');
    const out = join(root, 'out');
    const prompt = join(root, 'prompt.md');
    const calls = join(root, 'calls.log');
    mkdirSync(bin, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(prompt, `# Prompt\n\n${'Write a safe structured article. '.repeat(80)}\n`);

    const fakeClaude = join(bin, 'claude');
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$GG_TEST_CALLS"
case "$*" in
  *claude-opus-4-8*)
    printf '%s\\n' 'WATCHDOG: no CPU/output progress for 180s (deadlock); group cpu=4.9s' >&2
    exit 1
    ;;
  *claude-sonnet-4-6*)
    printf '# Recovered Article\\n\\n'
    i=0
    while [ "$i" -lt 220 ]; do
      printf 'This recovered paragraph is long enough for the frontier output guard. '
      i=$((i + 1))
    done
    printf '\\n'
    exit 0
    ;;
esac
exit 9
`);
    chmodSync(fakeClaude, 0o755);

    const run = spawnSync(process.execPath, [
      SCRIPT,
      '--prompt', prompt,
      '--page-id', 'PG-FALLBACK-OPUS-001',
      '--models', 'claude',
      '--out-dir', out,
      '--retry', '0',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GG_TEST_CALLS: calls,
        GG_CLAUDE_MODEL: 'claude-opus-4-8',
        GG_CLAUDE_FALLBACK_MODEL: '',
        GG_CLAUDE_EFFORT: 'high',
        GG_CLAUDE_FALLBACK_EFFORT: 'high',
      },
    });

    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
    const invoked = readFileSync(calls, 'utf8').trim().split('\n');
    assert.equal(invoked.length, 2);
    assert.match(invoked[0], /claude-opus-4-8/);
    assert.match(invoked[1], /claude-sonnet-4-6/);

    const summary = JSON.parse(readFileSync(join(out, 'PG-FALLBACK-OPUS-001-orchestrator.json'), 'utf8'));
    const result = summary.results.claude;
    assert.equal(result.ok, true);
    assert.equal(result.attempts[1].transient_failure_fallback_to, 'claude-sonnet-4-6');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ordinary Claude failure does not trigger the infrastructure fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-llm-orchestrator-no-fallback-'));
  try {
    const bin = join(root, 'bin');
    const out = join(root, 'out');
    const prompt = join(root, 'prompt.md');
    const calls = join(root, 'calls.log');
    mkdirSync(bin, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(prompt, `# Prompt\n\n${'Write a safe structured article. '.repeat(80)}\n`);

    const fakeClaude = join(bin, 'claude');
    writeFileSync(fakeClaude, `#!/bin/sh
printf '%s\\n' "$*" >> "$GG_TEST_CALLS"
printf '%s\\n' 'provider rejected this prompt permanently' >&2
exit 1
`);
    chmodSync(fakeClaude, 0o755);

    const run = spawnSync(process.execPath, [
      SCRIPT,
      '--prompt', prompt,
      '--page-id', 'PG-NO-FALLBACK-001',
      '--models', 'claude',
      '--out-dir', out,
      '--retry', '0',
    ], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GG_TEST_CALLS: calls,
        GG_CLAUDE_MODEL: 'claude-sonnet-4-6',
        GG_CLAUDE_FALLBACK_MODEL: 'claude-opus-4-8',
      },
    });

    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    const summary = JSON.parse(readFileSync(join(out, 'PG-NO-FALLBACK-001-orchestrator.json'), 'utf8'));
    assert.equal(summary.results.claude.ok, false);
    assert.equal(summary.results.claude.attempts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
