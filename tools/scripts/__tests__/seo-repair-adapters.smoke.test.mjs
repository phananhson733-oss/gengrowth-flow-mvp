import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createGengrowthRepairAdapter,
  isAllowedGengrowthAction,
} from '../lib/seo-repair-adapter-gengrowth.mjs';
import {
  buildAstrologyRepairTarget,
  createAstrologyWikiRepairAdapter,
  editableAstrologyFiles,
  isSafeAstrologyMergeIndex,
  isSafeAstrologyTargetPath,
  isAlreadyRegatableRetryFailure,
  isAlreadyPublishedRetryFailure,
  parseGitStatusPaths,
  selectAstrologyChangedFiles,
  verifyInternalLinkCandidate,
} from '../lib/seo-repair-adapter-astrologywiki.mjs';

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

function authoringRecord(pageId = 'PG-SDS-004') {
  return record({
    event: {
      ...record().event,
      pageId,
      slug: '',
      lane: 'gengrowth-author',
      stage: 'authoring',
      errorKind: 'tool_exit',
      summary: 'authoring exited before publish-ready handoff',
    },
  });
}

async function tempArtifact(t, relativePath, content) {
  const root = await mkdtemp(join(tmpdir(), 'seo-repair-artifact-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
  return { root, path };
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
  assert.equal(result.agentMutationInvoked, false);
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

test('gengrowth deterministic failure fingerprints the actual article and does not claim Agent mutation', async (t) => {
  const content = '---\nslug: measured-content\n---\n\n# Measured content\n';
  const artifact = await tempArtifact(t, 'PG-WLS-007-codex-v8.md', content);
  const adapter = createGengrowthRepairAdapter({
    resolveTarget: async () => ({ mdPath: artifact.path, slug: 'measured-content' }),
    runCommand: async () => ({
      code: 0,
      stdout: 'VERDICT: FAIL\nUnsupported claim',
      stderr: 'review evidence',
      timedOut: false,
    }),
  });
  const result = await adapter.execute({
    record: record(),
    classification: 'transient',
    strategy: 'deterministic_retry',
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentMutationInvoked, false);
  assert.equal(
    result.evidence.artifactSha,
    createHash('sha256').update(content).digest('hex'),
  );
});

test('gengrowth target-resolution failure explicitly records that no Agent mutation ran', async () => {
  const adapter = createGengrowthRepairAdapter({
    resolveTarget: async () => { throw new Error('draft vanished'); },
  });
  const result = await adapter.execute({
    record: record(),
    classification: 'agent_fixable',
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentMutationInvoked, false);
  assert.equal(result.evidence.type, 'target_resolution_failed');
});

test('gengrowth Agent failure carries the current article SHA and a true invocation marker', async (t) => {
  const content = '---\nslug: agent-failure\n---\n\n# Agent failure artifact\n';
  const artifact = await tempArtifact(t, 'PG-WLS-007-codex-v8.md', content);
  const adapter = createGengrowthRepairAdapter({
    resolveTarget: async () => ({ mdPath: artifact.path, slug: 'agent-failure' }),
    invokeAgent: async () => ({ ok: false, evidence: { type: 'agent_exit', code: 7 } }),
  });
  const result = await adapter.execute({
    record: record(),
    classification: 'agent_fixable',
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentMutationInvoked, true);
  assert.equal(
    result.evidence.artifactSha,
    createHash('sha256').update(content).digest('hex'),
  );
});

test('gengrowth authoring repair recovers one target before resolving a publish-ready draft', async () => {
  const calls = [];
  const ready = {
    mdPath: '/repo/_staging/PG-SDS-004-claude-v8.md',
    manifestPath: '/repo/_staging/PG-SDS-004-claude-v8.manifest.json',
    slug: 'software-development-services',
  };
  const adapter = createGengrowthRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveTarget: async () => {
      throw new Error('must not resolve before author recovery');
    },
    resolveAuthoredTarget: async () => ready,
    runCommand: async (argv) => {
      calls.push(argv);
      if (argv[1].endsWith('gg-codex-pr-review.mjs')) {
        return { code: 0, stdout: 'VERDICT: PASS\n', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, pageId: 'PG-SDS-004' }), stderr: '', timedOut: false };
    },
    verifyTerminal: async () => ({
      ok: true,
      terminal: 'published',
      checks: { supabase_published: true, production_200: true, writeback_clear: true },
    }),
  });

  const result = await adapter.execute({
    record: authoringRecord(),
    classification: 'transient',
    strategy: 'deterministic_repair',
  });

  assert.deepEqual(calls.slice(0, 3), [
    ['node', '/repo/tools/scripts/gg-seo-autopilot.mjs', '--retry-author', '--task', 'PG-SDS-004'],
    ['node', '/repo/tools/scripts/gg-seo-autopilot.mjs', '--author', '--task', 'PG-SDS-004', '--limit', '1'],
    ['node', '/repo/tools/scripts/gg-gengrowth-author-handoff.mjs', '--page-id', 'PG-SDS-004'],
  ]);
  assert.equal(result.terminal, 'published');
  assert.equal(result.agentMutationInvoked, true);
});

test('gengrowth authoring repair stops at the first failed scoped recovery command', async () => {
  const calls = [];
  const adapter = createGengrowthRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveTarget: async () => { throw new Error('must not resolve authoring target'); },
    resolveAuthoredTarget: async () => { throw new Error('must not resolve after a failed author retry'); },
    runCommand: async (argv) => {
      calls.push(argv);
      return { code: 2, stdout: '', stderr: 'retry failed', timedOut: false };
    },
  });
  const result = await adapter.execute({
    record: authoringRecord(),
    classification: 'transient',
    strategy: 'deterministic_repair',
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.type, 'author_recovery_failed');
  assert.equal(result.agentMutationInvoked, false);
  assert.deepEqual(calls, [
    ['node', '/repo/tools/scripts/gg-seo-autopilot.mjs', '--retry-author', '--task', 'PG-SDS-004'],
  ]);
});

test('gengrowth authoring repair salvages a passing handoff after author timeout', async () => {
  const calls = [];
  const timeouts = [];
  const ready = {
    mdPath: '/repo/_staging/PG-SDS-004-claude-v8.md',
    manifestPath: '/repo/_staging/PG-SDS-004-claude-v8.manifest.json',
    slug: 'software-development-services',
  };
  const adapter = createGengrowthRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveTarget: async () => { throw new Error('must not resolve original author target'); },
    resolveAuthoredTarget: async () => ready,
    runCommand: async (argv, options) => {
      calls.push(argv);
      timeouts.push(options.timeoutMs);
      if (argv.includes('--author')) {
        return { code: 124, stdout: 'phase2 draft already passed', stderr: 'review cut', timedOut: true };
      }
      if (argv[1].endsWith('gg-codex-pr-review.mjs')) {
        return { code: 0, stdout: 'VERDICT: PASS\n', stderr: '', timedOut: false };
      }
      return { code: 0, stdout: JSON.stringify({ ok: true, handedOff: true }), stderr: '', timedOut: false };
    },
    verifyTerminal: async () => ({
      ok: true,
      terminal: 'published',
      checks: { supabase_published: true, production_200: true, writeback_clear: true },
    }),
  });

  const result = await adapter.execute({
    record: authoringRecord(),
    classification: 'transient',
    strategy: 'deterministic_repair',
  });
  assert.deepEqual(calls.slice(0, 3), [
    ['node', '/repo/tools/scripts/gg-seo-autopilot.mjs', '--retry-author', '--task', 'PG-SDS-004'],
    ['node', '/repo/tools/scripts/gg-seo-autopilot.mjs', '--author', '--task', 'PG-SDS-004', '--limit', '1'],
    ['node', '/repo/tools/scripts/gg-gengrowth-author-handoff.mjs', '--page-id', 'PG-SDS-004'],
  ]);
  assert.equal(Math.max(...timeouts.slice(0, 3)) <= 20 * 60 * 1000, true);
  assert.equal(result.terminal, 'published');
  assert.equal(result.agentMutationInvoked, true);
  assert.equal(result.evidence.authorRecovery.authorCut, true);
  assert.equal(result.evidence.authorRecovery.results[1].code, 124);
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

test('astrology target includes the factual SVG and complete changed-file evidence', async () => {
  const target = await buildAstrologyRepairTarget({
    site: 'astrologywiki',
    pageId: 'PG-TRANS-016',
    slug: 'saturn-return-age-29',
    stage: 'preview_fact_gate',
    summary: 'SVG says Saturn Square occurs around age 14',
    stderr: 'codex FAIL on public/images/blog/saturn-return-age-29-i0-en.svg',
  }, {
    branch: 'seo/auto/2026-07-15-PG-TRANS-016',
    worktree: '/oracle-worktrees/pg-trans-016',
    articleFile: '/oracle-worktrees/pg-trans-016/data/articles/saturn-return-age-29.ts',
    changedFiles: [
      'data/articles/saturn-return-age-29.ts',
      'public/images/blog/saturn-return-age-29-i0-en.svg',
      'scripts/plans/auto-saturn-return-age-29.json',
      'data/articles/index.ts',
    ],
    linkCandidates: [],
  });
  assert.equal(target.articleFile.endsWith('saturn-return-age-29.ts'), true);
  assert.deepEqual(target.assetFiles, [
    '/oracle-worktrees/pg-trans-016/public/images/blog/saturn-return-age-29-i0-en.svg',
  ]);
  assert.deepEqual(target.changedFiles, [
    '/oracle-worktrees/pg-trans-016/data/articles/saturn-return-age-29.ts',
    '/oracle-worktrees/pg-trans-016/public/images/blog/saturn-return-age-29-i0-en.svg',
    '/oracle-worktrees/pg-trans-016/scripts/plans/auto-saturn-return-age-29.json',
    '/oracle-worktrees/pg-trans-016/data/articles/index.ts',
  ]);
  assert.deepEqual(target.supportFiles, [
    '/oracle-worktrees/pg-trans-016/scripts/plans/auto-saturn-return-age-29.json',
  ]);
  assert.deepEqual(editableAstrologyFiles(target), [
    'data/articles/saturn-return-age-29.ts',
    'public/images/blog/saturn-return-age-29-i0-en.svg',
    'scripts/plans/auto-saturn-return-age-29.json',
  ]);
  assert.match(target.gateEvidence, /Saturn Square.*age 14/);
});

test('astrology interrupted repair preserves porcelain first path and resumes only exact target files', () => {
  assert.deepEqual(parseGitStatusPaths([
    ' M public/images/blog/saturn-return-age-29-i0-en.svg',
    ' M scripts/plans/auto-saturn-return-age-29.json',
    '',
  ].join('\n')), [
    'public/images/blog/saturn-return-age-29-i0-en.svg',
    'scripts/plans/auto-saturn-return-age-29.json',
  ]);
  assert.equal(isSafeAstrologyTargetPath(
    'public/images/blog/saturn-return-age-29-i0-en.svg',
    'saturn-return-age-29',
  ), true);
  assert.equal(isSafeAstrologyTargetPath(
    'scripts/plans/auto-saturn-return-age-29.json',
    'saturn-return-age-29',
  ), true);
  assert.equal(isSafeAstrologyTargetPath('data/articles/index.ts', 'saturn-return-age-29'), false);
  assert.equal(isSafeAstrologyTargetPath(
    'public/images/blog/saturn-return-in-capricorn-i0-en.svg',
    'saturn-return-age-29',
  ), false);
});

test('astrology merge integration is accepted only for current main and target-only final delta', () => {
  const target = {
    worktree: '/oracle-worktrees/pg-trans-016',
    articleFile: '/oracle-worktrees/pg-trans-016/data/articles/saturn-return-age-29.ts',
    assetFiles: ['/oracle-worktrees/pg-trans-016/public/images/blog/saturn-return-age-29-i0-en.svg'],
    supportFiles: ['/oracle-worktrees/pg-trans-016/scripts/plans/auto-saturn-return-age-29.json'],
  };
  const safe = {
    mergeHead: 'main-commit',
    originMain: 'main-commit',
    unmergedFiles: [],
    unstagedFiles: [],
    diffAgainstMain: [
      'data/articles/saturn-return-age-29.ts',
      'public/images/blog/saturn-return-age-29-i0-en.svg',
      'scripts/plans/auto-saturn-return-age-29.json',
    ],
  };
  assert.equal(isSafeAstrologyMergeIndex(target, safe), true);
  assert.deepEqual(selectAstrologyChangedFiles({
    reviewedFiles: ['data/articles/saturn-return-age-29.ts'],
    dirtyFiles: [
      'data/articles/cody-bellinger-birth-chart.ts',
      'data/articles/saturn-return-in-capricorn.ts',
      ...safe.diffAgainstMain,
    ],
    mergeState: safe,
  }), safe.diffAgainstMain);
  assert.equal(isSafeAstrologyMergeIndex(target, { ...safe, mergeHead: 'stale-main' }), false);
  assert.equal(isSafeAstrologyMergeIndex(target, { ...safe, unmergedFiles: ['data/articles/index.ts'] }), false);
  assert.equal(isSafeAstrologyMergeIndex(target, {
    ...safe,
    diffAgainstMain: [...safe.diffAgainstMain, 'scripts/generate-seo-pages.mjs'],
  }), false);
});

test('astrology regate skips reset only when the exact claim is already pushed-preview', () => {
  assert.equal(isAlreadyRegatableRetryFailure({
    ok: false,
    stderr: '[autopilot] ERROR: cannot retry seo/auto/x from status "pushed-preview" — expected needs_human',
  }), true);
  assert.equal(isAlreadyRegatableRetryFailure({
    ok: false,
    stderr: '[autopilot] ERROR: cannot retry seo/auto/x from status "done" — expected needs_human',
  }), false);
  assert.equal(isAlreadyRegatableRetryFailure({ ok: false, stderr: 'auth failed' }), false);
  assert.equal(isAlreadyPublishedRetryFailure({
    ok: false,
    stderr: '[autopilot] ERROR: cannot retry seo/auto/x from status "done" — expected needs_human',
  }), true);
  assert.equal(isAlreadyPublishedRetryFailure({
    ok: false,
    stderr: '[autopilot] ERROR: cannot retry seo/auto/x from status "pushed-preview" — expected needs_human',
  }), false);
});

test('internal-link candidates require an existing route or sitemap entry plus HTTP 200', async () => {
  const deps = {
    routeExists: async (slug) => slug === 'saturn-return-guide',
    sitemapContains: async (slug) => slug === 'saturn-return-in-scorpio',
    fetchDocument: async (url) => ({ ok: !url.includes('fabricated'), status: url.includes('fabricated') ? 404 : 200 }),
  };
  assert.equal(await verifyInternalLinkCandidate('saturn-return-guide', deps), true);
  assert.equal(await verifyInternalLinkCandidate('saturn-return-in-scorpio', deps), true);
  assert.equal(await verifyInternalLinkCandidate('fabricated-saturn-page', deps), false);
  assert.equal(await verifyInternalLinkCandidate('../unsafe', deps), false);
});

test('astrology adapter repairs one target, reruns the complete gate, and accepts only deterministic terminal proof', async () => {
  const calls = [];
  const adapter = createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch: 'seo/auto/2026-07-15-PG-TRANS-018',
      worktree: '/oracle-worktrees/pg-trans-018',
      articleFile: '/oracle-worktrees/pg-trans-018/data/articles/saturn-return-in-capricorn.ts',
      changedFiles: ['data/articles/saturn-return-in-capricorn.ts'],
      linkCandidates: [
        { slug: 'saturn-return-guide', anchorIntent: 'Saturn return guide' },
        { slug: 'fabricated-saturn-page', anchorIntent: 'bad' },
      ],
    }),
    verifyLinkCandidate: async (slug) => slug === 'saturn-return-guide',
    invokeAgent: async (target) => {
      calls.push(['agent', target]);
      assert.deepEqual(target.verifiedLinkCandidates.map((candidate) => candidate.slug), ['saturn-return-guide']);
      return { ok: true, evidence: { filesChanged: [target.articleFile] } };
    },
    persistRepair: async (target) => {
      calls.push(['persist', target.branch]);
      return { ok: true, commit: 'abc123' };
    },
    regate: async (target) => { calls.push(['regate', target.branch]); return { ok: true }; },
    publish: async (target) => { calls.push(['publish', target.branch]); return { ok: true }; },
    verifyTerminal: async () => ({
      ok: true,
      terminal: 'published',
      checks: { reviewed_head: true, production_200: true, writeback_clear: true },
    }),
  });
  const result = await adapter.execute({
    record: {
      fingerprint: 'fp-trans-018',
      event: {
        site: 'astrologywiki',
        pageId: 'PG-TRANS-018',
        slug: 'saturn-return-in-capricorn',
        stage: 'links_seo_review',
        errorKind: 'link_fail',
        summary: 'intended internal links render as italic text',
        stderr: 'review[links-seo] FAIL',
      },
    },
    classification: 'agent_fixable',
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.terminal, 'published');
  assert.equal(result.agentMutationInvoked, true);
  assert.deepEqual(calls.map(([name]) => name), ['agent', 'persist', 'regate', 'publish']);
});

test('astrology deterministic failure fingerprints worktree content and never claims Agent mutation', async (t) => {
  const artifact = await tempArtifact(
    t,
    'data/articles/saturn-return-age-29.ts',
    'export const article = { title: "first artifact" };\n',
  );
  const assetPath = join(artifact.root, 'public/images/blog/saturn-return-age-29-i0-en.svg');
  await mkdir(dirname(assetPath), { recursive: true });
  await writeFile(assetPath, '<svg><text>age 14</text></svg>\n', 'utf8');
  const adapter = createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch: 'seo/auto/PG-TRANS-016',
      worktree: artifact.root,
      articleFile: artifact.path,
      changedFiles: [
        'data/articles/saturn-return-age-29.ts',
        'public/images/blog/saturn-return-age-29-i0-en.svg',
      ],
      linkCandidates: [],
    }),
    regate: async () => ({ ok: false, reason: 'same factual failure' }),
  });
  const input = {
    record: {
      fingerprint: 'fp-trans-016',
      event: {
        site: 'astrologywiki', pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29',
        stage: 'preview_fact_gate', errorKind: 'asset_fail', summary: 'SVG age 14', stderr: 'FAIL',
      },
    },
    strategy: 'deterministic_retry',
  };
  const first = await adapter.execute(input);
  assert.equal(first.ok, false);
  assert.equal(first.agentMutationInvoked, false);
  assert.match(first.evidence.artifactSha, /^[a-f0-9]{64}$/);

  await writeFile(assetPath, '<svg><text>age 29</text></svg>\n', 'utf8');
  const changed = await adapter.execute(input);
  assert.match(changed.evidence.artifactSha, /^[a-f0-9]{64}$/);
  assert.notEqual(changed.evidence.artifactSha, first.evidence.artifactSha);
});

test('astrology context failure explicitly records that no Agent mutation ran', async () => {
  const adapter = createAstrologyWikiRepairAdapter({
    resolveContext: async () => { throw new Error('worktree missing'); },
  });
  const result = await adapter.execute({
    record: {
      fingerprint: 'fp-trans-016',
      event: {
        site: 'astrologywiki', pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29',
        stage: 'preview_fact_gate', errorKind: 'asset_fail', summary: 'SVG age 14', stderr: 'FAIL',
      },
    },
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.ok, false);
  assert.equal(result.agentMutationInvoked, false);
  assert.equal(result.evidence.type, 'target_resolution_failed');
});

test('astrology Agent failure fingerprints a newly created dirty target asset', async (t) => {
  const artifact = await tempArtifact(
    t,
    'data/articles/saturn-return-age-29.ts',
    'export const article = { title: "stable article" };\n',
  );
  execFileSync('git', ['init', '-q'], { cwd: artifact.root });
  execFileSync('git', ['config', 'user.name', 'seo-repair-test'], { cwd: artifact.root });
  execFileSync('git', ['config', 'user.email', 'seo-repair-test@example.invalid'], { cwd: artifact.root });
  execFileSync('git', ['add', '.'], { cwd: artifact.root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: artifact.root });
  const assetPath = join(artifact.root, 'public/images/blog/saturn-return-age-29-i0-en.svg');
  await mkdir(dirname(assetPath), { recursive: true });
  let invocation = 0;
  const adapter = createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch: 'seo/auto/PG-TRANS-016',
      worktree: artifact.root,
      articleFile: artifact.path,
      changedFiles: ['data/articles/saturn-return-age-29.ts'],
      linkCandidates: [],
    }),
    invokeAgent: async () => {
      invocation += 1;
      await writeFile(assetPath, `<svg><text>attempt ${invocation}</text></svg>\n`, 'utf8');
      return { ok: false, evidence: { type: 'agent_exit', code: 7 } };
    },
  });
  const input = {
    record: {
      fingerprint: 'fp-trans-016',
      event: {
        site: 'astrologywiki', pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29',
        stage: 'preview_fact_gate', errorKind: 'asset_fail', summary: 'SVG age 14', stderr: 'FAIL',
      },
    },
    strategy: 'agent_content_asset_link',
  };
  const first = await adapter.execute(input);
  const second = await adapter.execute(input);
  assert.equal(first.agentMutationInvoked, true);
  assert.equal(second.agentMutationInvoked, true);
  assert.match(first.evidence.artifactSha, /^[a-f0-9]{64}$/);
  assert.notEqual(second.evidence.artifactSha, first.evidence.artifactSha);
});

test('astrology adapter never regates an Agent edit that was not committed and pushed', async () => {
  const calls = [];
  const adapter = createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch: 'seo/auto/2026-07-15-PG-TRANS-016',
      worktree: '/oracle-worktrees/seo-repair/pg-trans-016',
      originalWorktree: '/oracle-worktrees/seo-autopilot/pg-trans-016',
      articleFile: '/oracle-worktrees/seo-repair/pg-trans-016/data/articles/saturn-return-age-29.ts',
      changedFiles: [
        'data/articles/saturn-return-age-29.ts',
        'public/images/blog/saturn-return-age-29-i0-en.svg',
      ],
      linkCandidates: [],
    }),
    invokeAgent: async () => ({ ok: true, evidence: { filesChanged: ['asset.svg'] } }),
    persistRepair: async () => ({ ok: false, stderr: 'push rejected' }),
    regate: async () => { calls.push('regate'); return { ok: true }; },
    publish: async () => { calls.push('publish'); return { ok: true }; },
  });
  const result = await adapter.execute({
    record: {
      fingerprint: 'fp-trans-016',
      event: {
        site: 'astrologywiki', pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29',
        stage: 'preview_fact_gate', errorKind: 'asset_fail', summary: 'SVG age 14', stderr: 'FAIL',
      },
    },
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.ok, false);
  assert.equal(result.evidence.type, 'persist_repair_failed');
  assert.deepEqual(calls, []);
});

test('astrology adapter default terminal verifier is scoped to one page and site', async () => {
  const verifierCalls = [];
  const adapter = createAstrologyWikiRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveContext: async () => ({
      branch: 'seo/auto/PG-TRANS-016',
      worktree: '/oracle-worktrees/pg-trans-016',
      articleFile: '/oracle-worktrees/pg-trans-016/data/articles/saturn-return-age-29.ts',
      changedFiles: ['data/articles/saturn-return-age-29.ts'],
      linkCandidates: [],
    }),
    invokeAgent: async () => ({ ok: true }),
    persistRepair: async () => ({ ok: true, commit: 'abc123' }),
    regate: async () => ({ ok: true }),
    publish: async () => ({ ok: true }),
    runCommand: async (argv) => {
      verifierCalls.push(argv);
      return {
        code: 0,
        stdout: JSON.stringify({
          ok: true,
          results: [{ pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29', ok: true, terminal: 'published', checks: { live: true } }],
        }),
        stderr: '',
      };
    },
  });
  const result = await adapter.execute({
    record: {
      event: {
        site: 'astrologywiki', pageId: 'PG-TRANS-016', slug: 'saturn-return-age-29',
        stage: 'preview_fact_gate', errorKind: 'asset_fail', summary: 'SVG age 14', stderr: 'FAIL',
      },
    },
    strategy: 'agent_content_asset_link',
  });
  assert.equal(result.terminal, 'published');
  assert.deepEqual(verifierCalls[0], [
    'node', '/repo/tools/scripts/gg-seo-repair-verify.mjs',
    '--site', 'astrologywiki',
    '--page-id', 'PG-TRANS-016',
    '--slug', 'saturn-return-age-29',
    '--json',
  ]);
});
