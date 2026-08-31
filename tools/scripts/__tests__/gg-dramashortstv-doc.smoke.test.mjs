#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildDramaWorkerCommand,
  parseDramaArgs,
  runDramaShortsDelivery,
} from '../gg-dramashortstv-doc.mjs';
import * as dramaCli from '../gg-dramashortstv-doc.mjs';
import { sha256Text } from '../lib/dramashortstv-evidence.mjs';
import { DRAMA_OUTPUT_SUBDIR, DRAMA_WORKBOOK_ID, resolveDramaOutputPath } from '../lib/dramashortstv-doc.mjs';

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

const EVIDENCE = Object.freeze({
  schemaVersion: '1',
  pageId: NORMALIZED.pageId,
  sha256: 'e'.repeat(64),
});
const EVIDENCE_BLOCK = '<!-- UNTRUSTED EVIDENCE -->\n<DRAMASHORTSTV_EVIDENCE>{"source":"apple:1"}</DRAMASHORTSTV_EVIDENCE>';

function fakeDeps(calls, overrides = {}, captures = {}) {
  return {
    opsDir: '/tmp/gengrowth-ops',
    today: () => '2026-08-28',
    readSheet: async () => { calls.push('sheet'); return { row: {} }; },
    normalize: () => { calls.push('normalize'); return NORMALIZED; },
    planOutputPath: () => '/tmp/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-28-dramashortstv-blog-dramabox-vs-reelshort.md',
    resolveOutputPath: () => '/tmp/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-28-dramashortstv-blog-dramabox-vs-reelshort.md',
    gitPreflight: async () => { calls.push('git-preflight'); return { head: 'a'.repeat(40) }; },
    findExisting: async () => { calls.push('git-existing'); return null; },
    readSop: async () => { calls.push('sop'); return '# SOP\n' + 'rules '.repeat(300); },
    collectEvidence: async () => { calls.push('research'); return EVIDENCE; },
    validateEvidence: () => { calls.push('evidence-qa'); return { ok: true, errors: [] }; },
    buildEvidenceBlock: () => EVIDENCE_BLOCK,
    buildPrompt: (input) => { calls.push('prompt'); captures.prompt = input; return '# Prompt\n' + 'prompt '.repeat(300); },
    generate: async () => { calls.push('generate'); return DRAFT; },
    validate: (input) => { calls.push('qa'); captures.qa = input; return { ok: true, errors: [] }; },
    factualReview: async (input) => {
      calls.push('factual-review');
      captures.factualReview = input;
      return {
        verdict: 'PASS',
        reviewedDraftSha256: sha256Text(DRAFT),
        reviewedEvidenceSha256: sha256Text(EVIDENCE_BLOCK),
      };
    },
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

test('argument parser validates the raw row token before safe-integer conversion', () => {
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4garbage']), /row/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4.9']), /row/i);
  assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '9007199254740992']), /row/i);
});

test('page-id mode invokes the unbounded bridge selector directly without gg-sheet-pull', () => {
  assert.equal(typeof dramaCli.buildDramaSheetBridgeArgs, 'function');
  const args = dramaCli.buildDramaSheetBridgeArgs({ workbook: DRAMA_WORKBOOK_ID, pageId: NORMALIZED.pageId });
  assert.deepEqual(args, [
    '--workbook', DRAMA_WORKBOOK_ID,
    '--page-id', NORMALIZED.pageId,
    '--dry-run',
    '--allow-missing-cta',
  ]);
  const source = readFileSync(join(ROOT, 'tools', 'scripts', 'gg-dramashortstv-doc.mjs'), 'utf8');
  assert.doesNotMatch(source, /gg-sheet-pull|SHEET_PULL/);
});

async function withTemporaryEnv(keys, callback) {
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) delete process.env[key];
    return await callback();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('research environment restores the complete process.env after success', async () => {
  const keys = ['GG_TEST_EXISTING_ENV', 'GG_TEST_LOADER_ENV', 'GG_TEST_CALLBACK_ENV'];
  await withTemporaryEnv(keys, async () => {
    process.env.GG_TEST_EXISTING_ENV = 'before';
    await dramaCli.withDramaResearchEnvironment(async () => {
      assert.equal(process.env.GG_TEST_EXISTING_ENV, 'loader-change');
      assert.equal(process.env.GG_TEST_LOADER_ENV, 'loaded');
      process.env.GG_TEST_CALLBACK_ENV = 'callback-change';
    }, {
      loadEnvImpl: () => {
        process.env.GG_TEST_EXISTING_ENV = 'loader-change';
        process.env.GG_TEST_LOADER_ENV = 'loaded';
      },
    });
    assert.equal(process.env.GG_TEST_EXISTING_ENV, 'before');
    assert.equal(process.env.GG_TEST_LOADER_ENV, undefined);
    assert.equal(process.env.GG_TEST_CALLBACK_ENV, undefined);
  });
});

test('research environment restores the complete process.env when callback throws', async () => {
  const keys = ['GG_TEST_THROW_EXISTING', 'GG_TEST_THROW_LOADER', 'GG_TEST_THROW_CALLBACK'];
  await withTemporaryEnv(keys, async () => {
    process.env.GG_TEST_THROW_EXISTING = 'before';
    await assert.rejects(
      () => dramaCli.withDramaResearchEnvironment(async () => {
        process.env.GG_TEST_THROW_CALLBACK = 'callback-change';
        throw new Error('research callback failed');
      }, {
        loadEnvImpl: () => {
          process.env.GG_TEST_THROW_EXISTING = 'loader-change';
          process.env.GG_TEST_THROW_LOADER = 'loaded';
        },
      }),
      /research callback failed/,
    );
    assert.equal(process.env.GG_TEST_THROW_EXISTING, 'before');
    assert.equal(process.env.GG_TEST_THROW_LOADER, undefined);
    assert.equal(process.env.GG_TEST_THROW_CALLBACK, undefined);
  });
});

test('research environment never leaks an arbitrary non-whitelist fake secret', async () => {
  const key = 'GG_TEST_NON_WHITELIST_FAKE_SECRET';
  await withTemporaryEnv([key], async () => {
    await dramaCli.withDramaResearchEnvironment(async () => {
      assert.equal(process.env[key], 'fake-secret');
    }, { loadEnvImpl: () => { process.env[key] = 'fake-secret'; } });
    assert.equal(process.env[key], undefined);
  });
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

test('dry-run plans its target path without touching a nonexistent Ops root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-drama-dry-plan-'));
  const missingOps = join(root, 'missing-ops');
  const calls = [];
  const deps = fakeDeps(calls, {
    opsDir: missingOps,
    resolveOutputPath: resolveDramaOutputPath,
    planOutputPath: ({ opsDir, date, topicSlug }) => join(
      opsDir,
      DRAMA_OUTPUT_SUBDIR,
      `${date}-dramashortstv-blog-${topicSlug}.md`,
    ),
  });
  try {
    const result = await runDramaShortsDelivery(
      parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4']),
      deps,
    );
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.targetPath, join(
      missingOps,
      DRAMA_OUTPUT_SUBDIR,
      '2026-08-28-dramashortstv-blog-dramabox-vs-reelshort.md',
    ));
    assert.deepEqual(calls, ['sheet', 'normalize']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    'research',
    'evidence-qa',
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

test('prompt and factual review are bound to the exact same evidence-block SHA', async () => {
  const calls = [];
  const captures = {};
  await runDramaShortsDelivery(
    parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']),
    fakeDeps(calls, {}, captures),
  );
  const evidenceSha256 = sha256Text(EVIDENCE_BLOCK);
  assert.equal(captures.prompt.evidence, EVIDENCE_BLOCK);
  assert.equal(captures.prompt.evidenceSha256, evidenceSha256);
  assert.equal(captures.qa.evidence, EVIDENCE);
  assert.equal(captures.factualReview.evidence, EVIDENCE_BLOCK);
  assert.equal(captures.factualReview.evidenceSha256, evidenceSha256);
});

test('evidence QA failure prevents prompt, generation, Ops writes, and Git delivery', async () => {
  const calls = [];
  const deps = fakeDeps(calls, {
    validateEvidence: () => { calls.push('evidence-qa'); return { ok: false, errors: ['app-store evidence unavailable'] }; },
  });
  await assert.rejects(
    () => runDramaShortsDelivery(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']), deps),
    /evidence.*app-store evidence unavailable/i,
  );
  assert.deepEqual(calls, ['sheet', 'normalize', 'git-preflight', 'git-existing', 'sop', 'research', 'evidence-qa']);
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
  assert.deepEqual(calls, [
    'sheet', 'normalize', 'git-preflight', 'git-existing', 'sop', 'research', 'evidence-qa', 'prompt', 'generate', 'qa',
  ]);
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
    'sheet', 'normalize', 'git-preflight', 'git-existing', 'sop', 'research', 'evidence-qa', 'prompt', 'generate', 'qa', 'factual-review',
  ]);
});

test('PASS with mismatched reviewed draft or evidence SHA is rejected before formatting', async () => {
  for (const mismatch of ['draft', 'evidence']) {
    const calls = [];
    const deps = fakeDeps(calls, {
      factualReview: async () => {
        calls.push('factual-review');
        return {
          verdict: 'PASS',
          reviewedDraftSha256: mismatch === 'draft' ? '0'.repeat(64) : sha256Text(DRAFT),
          reviewedEvidenceSha256: mismatch === 'evidence' ? '0'.repeat(64) : sha256Text(EVIDENCE_BLOCK),
        };
      },
    });
    await assert.rejects(
      () => runDramaShortsDelivery(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--apply']), deps),
      /reviewed.*sha256|hash mismatch/i,
    );
    assert.equal(calls.includes('format'), false, mismatch);
  }
});

test('factual review inputs are immutable and addressed by both draft and evidence hashes', () => {
  assert.equal(typeof dramaCli.prepareDramaFactualReviewInput, 'function');
  const cacheDir = mkdtempSync(join(tmpdir(), 'gg-drama-review-'));
  try {
    const first = dramaCli.prepareDramaFactualReviewInput({
      cacheDir,
      pageId: NORMALIZED.pageId,
      draft: DRAFT,
      evidence: EVIDENCE_BLOCK,
    });
    assert.match(first.path, new RegExp(`${first.draftSha256}\\.${first.evidenceSha256}\\.md$`));
    const bytes = readFileSync(first.path, 'utf8');
    assert.match(bytes, new RegExp(EVIDENCE_BLOCK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(bytes, new RegExp(DRAFT.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.deepEqual(
      dramaCli.prepareDramaFactualReviewInput({ cacheDir, pageId: NORMALIZED.pageId, draft: DRAFT, evidence: EVIDENCE_BLOCK }),
      first,
    );
    const concurrent = dramaCli.prepareDramaFactualReviewInput({
      cacheDir,
      pageId: NORMALIZED.pageId,
      draft: `${DRAFT}\nConcurrent run.`,
      evidence: EVIDENCE_BLOCK,
    });
    assert.notEqual(concurrent.path, first.path);
    writeFileSync(first.path, 'corrupt');
    assert.throws(
      () => dramaCli.prepareDramaFactualReviewInput({ cacheDir, pageId: NORMALIZED.pageId, draft: DRAFT, evidence: EVIDENCE_BLOCK }),
      /immutable|bytes|hash/i,
    );
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('Drama factual review accepts exactly one matching reviewer-emitted input digest', () => {
  assert.equal(typeof dramaCli.parseReviewerInputDigest, 'function');
  const expected = 'a'.repeat(64);
  assert.equal(
    dramaCli.parseReviewerInputDigest(`Reviewed.\nREVIEWED_INPUT_SHA256: ${expected}\nVERDICT: PASS\n`, expected),
    expected,
  );
  assert.throws(() => dramaCli.parseReviewerInputDigest('VERDICT: PASS\n', expected), /digest|sha256/i);
  assert.throws(
    () => dramaCli.parseReviewerInputDigest(`REVIEWED_INPUT_SHA256: ${'b'.repeat(64)}\nVERDICT: PASS\n`, expected),
    /mismatch/i,
  );
  assert.throws(
    () => dramaCli.parseReviewerInputDigest(`REVIEWED_INPUT_SHA256: ${expected}\nREVIEWED_INPUT_SHA256: ${expected}\nVERDICT: PASS\n`, expected),
    /exactly one|duplicate/i,
  );
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
