#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDramaWorkerCommand,
  parseDramaArgs,
  runDramaShortsDelivery,
} from '../gg-dramashortstv-doc.mjs';
import { DRAMA_WORKBOOK_ID } from '../lib/dramashortstv-doc.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const NORMALIZED = {
  pageId: 'page_dramabox_vs_reelshort',
  contentType: 'comparison',
  targetKeyword: 'dramabox vs reelshort',
  associatedKeywords: ['best short drama apps'],
  entity: 'DramaBox vs ReelShort',
  friction: 'Users worry about cancellation traps.',
  logic: 'Both apps bill through Apple or Google.',
  contentAngle: 'Compare first-party details and real reviews.',
  clusterId: 'clu_app_profiles',
  pageRole: 'Support',
  template: 'Comparison',
  sourceRow: 4,
  notes: [],
};

const DRAFT = `# DramaBox vs ReelShort: Real Reviews Compared

Both apps are legitimate, but viewers should compare their catalogs and live billing terms.

## DramaBox vs ReelShort at a Glance

| Decision | DramaBox | ReelShort |
|---|---|---|
| Catalog | Frequent releases | Curated originals |

## Payment and Cancellation Compared

Both apps bill through Apple or Google accounts.

## Frequently Asked Questions

### Which app has more frequent releases?

DramaBox generally adds titles more frequently.

## Sources and Content Team Notes

- Recheck the official app-store pages before publication.
`;

function fakeDeps(calls, overrides = {}) {
  return {
    opsDir: '/tmp/gengrowth-ops',
    today: () => '2026-08-28',
    readSheet: async () => { calls.push('sheet'); return { row: {} }; },
    normalize: () => { calls.push('normalize'); return NORMALIZED; },
    resolveOutputPath: () => '/tmp/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-28-dramashortstv-blog-dramabox-vs-reelshort.md',
    gitPreflight: async () => { calls.push('git-preflight'); return { head: 'a'.repeat(40) }; },
    findExisting: async () => { calls.push('git-existing'); return null; },
    readSop: async () => { calls.push('sop'); return '# SOP\n' + 'rules '.repeat(300); },
    buildPrompt: () => { calls.push('prompt'); return '# Prompt\n' + 'prompt '.repeat(300); },
    generate: async () => { calls.push('generate'); return DRAFT; },
    validate: () => { calls.push('qa'); return { ok: true, errors: [] }; },
    factualReview: async () => { calls.push('factual-review'); return { verdict: 'PASS' }; },
    format: () => { calls.push('format'); return `---\ntitle: Test\n---\n\n${DRAFT}`; },
    write: async () => { calls.push('write'); return { status: 'created' }; },
    gitDeliver: async () => { calls.push('git-deliver'); return { status: 'delivered', commitSha: 'b'.repeat(40), remoteSha: 'b'.repeat(40) }; },
    ...overrides,
  };
}

test('argument parser requires explicit workbook and exactly one selector', () => {
  assert.throws(() => parseDramaArgs([]), /--workbook/);
  assert.throws(
    () => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--page-id', 'page_x']),
    /exactly one/i,
  );
  assert.throws(
    () => parseDramaArgs(['--workbook', 'wrong', '--row', '4']),
    /workbook/i,
  );
  assert.equal(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4']).apply, false);
  assert.equal(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--page-id', 'page_x', '--apply']).apply, true);
});

test('generation worker is Claude-only with all tools and integrations disabled', () => {
  const command = buildDramaWorkerCommand({
    model: 'claude-sonnet-4-6',
    effort: 'high',
  });
  assert.equal(command.bin, 'claude');
  assert.deepEqual(command.args, [
    '-p',
    '--model', 'claude-sonnet-4-6',
    '--effort', 'high',
    '--tools', '',
    '--safe-mode',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--max-budget-usd', '5',
  ]);
});

test('dry-run reads and normalizes Sheet data without LLM, file, or Git calls', async () => {
  const calls = [];
  const deps = fakeDeps(calls);
  const result = await runDramaShortsDelivery(
    parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4']),
    deps,
  );
  assert.deepEqual(calls, ['sheet', 'normalize']);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.pageId, 'page_dramabox_vs_reelshort');
  assert.equal(result.contentType, 'comparison');
  assert.match(result.targetPath, /gengrowth-ops.*dramabox-vs-reelshort\.md/);
});

test('apply follows the fail-closed generation and delivery order', async () => {
  const calls = [];
  const result = await runDramaShortsDelivery(
    parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']),
    fakeDeps(calls),
  );
  assert.deepEqual(calls, [
    'sheet',
    'normalize',
    'git-preflight',
    'git-existing',
    'sop',
    'prompt',
    'generate',
    'qa',
    'factual-review',
    'format',
    'write',
    'git-deliver',
  ]);
  assert.equal(result.mode, 'apply');
  assert.equal(result.git.status, 'delivered');
});

test('QA failure prevents factual review, Ops write, and Git delivery', async () => {
  const calls = [];
  const deps = fakeDeps(calls, {
    validate: () => { calls.push('qa'); return { ok: false, errors: ['piracy-related term'] }; },
  });
  await assert.rejects(
    () => runDramaShortsDelivery(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']), deps),
    /QA failed.*piracy-related term/i,
  );
  assert.deepEqual(calls, ['sheet', 'normalize', 'git-preflight', 'git-existing', 'sop', 'prompt', 'generate', 'qa']);
});

test('non-PASS factual review prevents document formatting and Git delivery', async () => {
  const calls = [];
  const deps = fakeDeps(calls, {
    factualReview: async () => { calls.push('factual-review'); return { verdict: 'FAIL', reason: 'unsupported ownership claim' }; },
  });
  await assert.rejects(
    () => runDramaShortsDelivery(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']), deps),
    /factual review failed.*unsupported ownership claim/i,
  );
  assert.deepEqual(calls, [
    'sheet', 'normalize', 'git-preflight', 'git-existing', 'sop', 'prompt', 'generate', 'qa', 'factual-review',
  ]);
});

test('apply returns already-delivered before SOP or LLM generation', async () => {
  const calls = [];
  const existing = {
    status: 'already-delivered',
    commitSha: 'c'.repeat(40),
    remoteSha: 'c'.repeat(40),
    relativePath: 'inbox-maboyang/05-blog/dramashortstv/2026-08-25-dramashortstv-blog-dramabox-vs-reelshort.md',
    blobSha: 'd'.repeat(40),
  };
  const deps = fakeDeps(calls, {
    findExisting: async () => { calls.push('git-existing'); return existing; },
  });
  const result = await runDramaShortsDelivery(
    parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']),
    deps,
  );
  assert.deepEqual(calls, ['sheet', 'normalize', 'git-preflight', 'git-existing']);
  assert.equal(result.git.status, 'already-delivered');
  assert.match(result.targetPath, /2026-08-25-/);
});

test('parser rejects unsafe rows, page ids, models, and unknown flags', () => {
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '1']), /row/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--page-id', '../escape']), /page-id/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--model', 'other']), /model/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--model', 'codex']), /model/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--surprise']), /unknown flag/i);
});

test('tools README documents DramaShortsTV hard boundaries', () => {
  const readme = readFileSync(join(ROOT, 'tools', 'README.md'), 'utf8');
  assert.match(readme, /gg-dramashortstv-doc\.mjs/);
  assert.match(readme, /Google Sheet.*只读|Google Sheet.*read-only/iu);
  assert.match(readme, /不生成.*图片|no hero/iu);
  assert.match(readme, /phananhson733-oss\/gengrowth-ops/);
  assert.match(readme, /Claude.*(?:无工具|tools disabled)|--tools.*空/iu);
});
