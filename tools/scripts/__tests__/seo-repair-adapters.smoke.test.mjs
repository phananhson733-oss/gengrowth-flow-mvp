import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGengrowthRepairAdapter,
  isAllowedGengrowthAction,
} from '../lib/seo-repair-adapter-gengrowth.mjs';

function record(overrides = {}) {
  return {
    fingerprint: 'fp-wls-007',
    event: {
      schemaVersion: 2,
      eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      runId: 'gengrowth-publish-20260715',
      site: 'gengrowth',
      lane: 'publish',
      pageId: 'PG-WLS-007',
      slug: 'chatgpt-seo',
      stage: 'fact_gate',
      errorKind: 'tool_exit',
      summary: 'codex exited 3',
      stderr: 'provider stream reset',
      logFile: '/tmp/gengrowth-publish.log',
      logOffsetStart: 0,
      logOffsetEnd: 100,
      canonicalRetry: ['node', '/repo/tools/scripts/gg-codex-pr-review.mjs', '--source', '/repo/_staging/PG-WLS-007-codex-v8.md'],
      createdAt: '2026-07-15T14:00:00.000Z',
    },
    ...overrides,
  };
}

test('gengrowth adapter retries the exact reviewer, publishes one page, and trusts only terminal verification', async () => {
  const calls = [];
  const adapter = createGengrowthRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveTarget: async () => ({
      mdPath: '/repo/_staging/PG-WLS-007-codex-v8.md',
      manifestPath: '/repo/_staging/PG-WLS-007-codex-v8.manifest.json',
      slug: 'chatgpt-seo',
    }),
    runCommand: async (argv) => {
      calls.push(argv);
      if (argv[1].endsWith('gg-codex-pr-review.mjs')) {
        return { code: 0, stdout: 'VERDICT: PASS\n', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: 'published=1 verified=1\n', stderr: '', timedOut: false };
    },
    verifyTerminal: async () => ({
      ok: true,
      terminal: 'published',
      checks: { supabase_published: true, production_200: true, writeback_clear: true },
    }),
  });

  const result = await adapter.execute({
    record: record(),
    classification: 'transient',
    strategy: 'deterministic_retry',
  });
  assert.equal(result.terminal, 'published');
  assert.deepEqual(calls, [
    ['node', '/repo/tools/scripts/gg-codex-pr-review.mjs', '--source', '/repo/_staging/PG-WLS-007-codex-v8.md'],
    ['node', '/repo/tools/scripts/gg-gengrowth-publish.mjs', '--apply', '--pages', 'PG-WLS-007', '--limit', '1'],
  ]);
});

test('gengrowth adapter does not publish when a targeted reviewer returns a real FAIL', async () => {
  const calls = [];
  const adapter = createGengrowthRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveTarget: async () => ({ mdPath: '/repo/_staging/PG-WLS-007-codex-v8.md', slug: 'chatgpt-seo' }),
    runCommand: async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: 'VERDICT: FAIL\nUnsupported claim', stderr: 'review evidence', timedOut: false };
    },
    verifyTerminal: async () => { throw new Error('must not verify or publish after FAIL'); },
  });
  const result = await adapter.execute({
    record: record(),
    classification: 'transient',
    strategy: 'deterministic_retry',
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.type, 'fact_gate_fail');
  assert.match(result.evidence.stdout, /VERDICT: FAIL/);
  assert.match(result.evidence.stderr, /review evidence/);
  assert.equal(calls.length, 1);
});

test('gengrowth adapter action whitelist rejects top-level wrappers and arbitrary sources', () => {
  const context = {
    scriptsDir: '/repo/tools/scripts',
    pageId: 'PG-WLS-007',
    mdPath: '/repo/_staging/PG-WLS-007-codex-v8.md',
  };
  assert.equal(isAllowedGengrowthAction([
    'node', '/repo/tools/scripts/gg-codex-pr-review.mjs', '--source', context.mdPath,
  ], context), true);
  assert.equal(isAllowedGengrowthAction([
    'node', '/repo/tools/scripts/gg-gengrowth-publish.mjs', '--apply', '--pages', 'PG-WLS-007', '--limit', '1',
  ], context), true);
  assert.equal(isAllowedGengrowthAction(['bash', '/repo/tools/scripts/gg-nightly-seo.sh'], context), false);
  assert.equal(isAllowedGengrowthAction([
    'node', '/repo/tools/scripts/gg-codex-pr-review.mjs', '--source', '/tmp/other.md',
  ], context), false);
});
