import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as previewGate from '../gg-preview-gate.mjs';
import * as astrologyAdapter from '../lib/seo-repair-adapter-astrologywiki.mjs';
import { buildRepairAgentPrompt } from '../lib/seo-repair-controller.mjs';

let bindings = {};
try {
  bindings = await import('../lib/seo-repair-bindings.mjs');
} catch {}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function committedRepo(t, parent, name = 'repair') {
  const repo = join(parent, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'binding-test']);
  git(repo, ['config', 'user.email', 'binding-test@example.invalid']);
  writeFileSync(join(repo, 'README.md'), 'clean\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-qm', 'fixture']);
  const head = git(repo, ['rev-parse', 'HEAD']);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { repo, head };
}

test('preview gate parses the complete explicit repair binding tuple', () => {
  const worktree = '/tmp/repair-root/PG-CELEB-057-event';
  const draft = '/tmp/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md';
  const head = 'a'.repeat(40);
  const draftSha256 = 'b'.repeat(64);
  const parsed = previewGate.parseArgs([
    '--branch', 'seo/auto/2026-07-15-PG-CELEB-057',
    '--worktree', worktree,
    '--head-ref-oid', head,
    '--draft', draft,
    '--draft-sha256', draftSha256,
  ]);
  assert.equal(parsed.worktree, worktree);
  assert.equal(parsed.headRefOid, head);
  assert.equal(parsed.draft, draft);
  assert.equal(parsed.draftSha256, draftSha256);
});

test('repair worktree binding accepts only a clean exact-head real directory below the repair root', (t) => {
  assert.equal(typeof bindings.inspectBoundRepairWorktree, 'function');
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-worktree-root-'));
  const { repo, head } = committedRepo(t, root);

  const accepted = bindings.inspectBoundRepairWorktree({
    worktree: repo,
    expectedHead: head,
    remoteHead: head,
    root,
  });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(accepted.realpath, realpathSync(repo));

  writeFileSync(join(repo, 'README.md'), 'dirty\n');
  const dirty = bindings.inspectBoundRepairWorktree({
    worktree: repo,
    expectedHead: head,
    remoteHead: head,
    root,
  });
  assert.equal(dirty.ok, false);
  assert.match(dirty.reason, /dirty|uncommitted/i);
  writeFileSync(join(repo, 'README.md'), 'clean\n');

  const wrongHead = bindings.inspectBoundRepairWorktree({
    worktree: repo,
    expectedHead: 'b'.repeat(40),
    remoteHead: 'b'.repeat(40),
    root,
  });
  assert.equal(wrongHead.ok, false);
  assert.match(wrongHead.reason, /head.*mismatch/i);

  const remoteMismatch = bindings.inspectBoundRepairWorktree({
    worktree: repo,
    expectedHead: head,
    remoteHead: 'c'.repeat(40),
    root,
  });
  assert.equal(remoteMismatch.ok, false);
  assert.match(remoteMismatch.reason, /remote.*head|expected.*remote/i);
});

test('repair worktree binding rejects outside paths and symlink escapes', (t) => {
  assert.equal(typeof bindings.inspectBoundRepairWorktree, 'function');
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-worktree-root-'));
  const outsideParent = mkdtempSync(join(tmpdir(), 'seo-repair-worktree-outside-'));
  const { repo: outside, head } = committedRepo(t, outsideParent, 'outside');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const outsideResult = bindings.inspectBoundRepairWorktree({
    worktree: outside,
    expectedHead: head,
    remoteHead: head,
    root,
  });
  assert.equal(outsideResult.ok, false);
  assert.match(outsideResult.reason, /outside|root/i);

  const link = join(root, 'escaped-link');
  symlinkSync(outside, link);
  const symlinkResult = bindings.inspectBoundRepairWorktree({
    worktree: link,
    expectedHead: head,
    remoteHead: head,
    root,
  });
  assert.equal(symlinkResult.ok, false);
  assert.match(symlinkResult.reason, /symlink|outside|escape/i);

  const missingRoot = bindings.inspectBoundRepairWorktree({
    worktree: outside,
    expectedHead: head,
    remoteHead: head,
    root: join(root, 'missing-root'),
  });
  assert.equal(missingRoot.ok, false);
  assert.match(missingRoot.reason, /root|realpath|no such/i);

  const realControllerRoot = mkdtempSync(join(tmpdir(), 'seo-repair-real-controller-root-'));
  const { repo: realRepair, head: realHead } = committedRepo(t, realControllerRoot, 'repair');
  const aliasParent = mkdtempSync(join(tmpdir(), 'seo-repair-root-alias-'));
  t.after(() => rmSync(aliasParent, { recursive: true, force: true }));
  const aliasedRoot = join(aliasParent, 'controller-root');
  symlinkSync(realControllerRoot, aliasedRoot);
  const rootSymlink = bindings.inspectBoundRepairWorktree({
    worktree: join(aliasedRoot, 'repair'),
    expectedHead: realHead,
    remoteHead: realHead,
    root: aliasedRoot,
  });
  assert.equal(rootSymlink.ok, false);
  assert.match(rootSymlink.reason, /root.*symlink|symlink.*root/i);
});

test('adapter rejects a symlinked controller worktree root before creating or mutating a repair worktree', (t) => {
  assert.equal(typeof astrologyAdapter.prepareRepairWorktree, 'function');
  const originalParent = mkdtempSync(join(tmpdir(), 'seo-repair-original-'));
  const { repo: original } = committedRepo(t, originalParent, 'original');
  const realRoot = mkdtempSync(join(tmpdir(), 'seo-repair-controller-real-'));
  const aliasParent = mkdtempSync(join(tmpdir(), 'seo-repair-controller-alias-'));
  t.after(() => rmSync(realRoot, { recursive: true, force: true }));
  t.after(() => rmSync(aliasParent, { recursive: true, force: true }));
  const aliasRoot = join(aliasParent, 'controller-root');
  symlinkSync(realRoot, aliasRoot);
  const previous = process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT;
  process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT = aliasRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT;
    else process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT = previous;
  });

  assert.throws(() => astrologyAdapter.prepareRepairWorktree({
    eventId: 'event-root-symlink',
    pageId: 'PG-CELEB-057',
    slug: 'caitlin-clark-birth-chart',
  }, {
    slug: 'caitlin-clark-birth-chart',
  }, original), /root.*symlink|symlink.*root/i);
  assert.deepEqual(readFileSync(join(original, 'README.md'), 'utf8'), 'clean\n');
});

test('repair draft binding requires a regular exact-hash real file below the controller draft root', (t) => {
  assert.equal(typeof bindings.inspectBoundRepairDraft, 'function');
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-draft-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const draft = join(root, 'astrologywiki', 'PG-CELEB-057', 'event.md');
  mkdirSync(join(root, 'astrologywiki', 'PG-CELEB-057'), { recursive: true });
  writeFileSync(draft, '# repaired Pisces draft\n');
  const digest = sha256('# repaired Pisces draft\n');

  const accepted = bindings.inspectBoundRepairDraft({
    draftFile: draft,
    expectedSha256: digest,
    root,
  });
  assert.equal(accepted.ok, true, accepted.reason);
  assert.equal(accepted.sha256, digest);

  writeFileSync(draft, '# drifted Aries draft\n');
  const drift = bindings.inspectBoundRepairDraft({
    draftFile: draft,
    expectedSha256: digest,
    root,
  });
  assert.equal(drift.ok, false);
  assert.match(drift.reason, /digest|hash|sha/i);

  const outside = join(tmpdir(), `outside-draft-${process.pid}.md`);
  writeFileSync(outside, '# outside\n');
  t.after(() => rmSync(outside, { force: true }));
  const link = join(root, 'astrologywiki', 'PG-CELEB-057', 'escape.md');
  symlinkSync(outside, link);
  const escaped = bindings.inspectBoundRepairDraft({
    draftFile: link,
    expectedSha256: sha256('# outside\n'),
    root,
  });
  assert.equal(escaped.ok, false);
  assert.match(escaped.reason, /symlink|outside|escape/i);

  const insideTarget = join(root, 'astrologywiki', 'PG-CELEB-057', 'inside-target.md');
  const insideLink = join(root, 'astrologywiki', 'PG-CELEB-057', 'inside-link.md');
  writeFileSync(insideTarget, '# inside regular target\n');
  symlinkSync(insideTarget, insideLink);
  const linkedRegular = bindings.inspectBoundRepairDraft({
    draftFile: insideLink,
    expectedSha256: sha256('# inside regular target\n'),
    root,
  });
  assert.equal(linkedRegular.ok, false);
  assert.match(linkedRegular.reason, /regular file|symlink/i);
});

test('controller draft materialization rejects a pre-existing symlink before any Agent can edit it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-draft-preagent-'));
  const outside = mkdtempSync(join(tmpdir(), 'seo-repair-draft-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const source = join(root, 'PG-CELEB-057-en.md');
  const draftRoot = join(root, 'state', 'seo-repair-drafts');
  const directory = join(draftRoot, 'astrologywiki', 'PG-CELEB-057');
  const draftFile = join(directory, 'event-057.md');
  const outsideTarget = join(outside, 'escaped.md');
  mkdirSync(directory, { recursive: true });
  writeFileSync(source, '# source draft\n');
  writeFileSync(outsideTarget, '# outside target\n');
  symlinkSync(outsideTarget, draftFile);

  const result = astrologyAdapter.ensureAstrologyRepairDraft({
    sourceFile: source,
    draftRoot,
    site: 'astrologywiki',
    pageId: 'PG-CELEB-057',
    attemptId: 'event-057',
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /symlink|outside|regular file/i);
  assert.equal(readFileSync(outsideTarget, 'utf8'), '# outside target\n');
});

test('controller draft materialization rejects a symlinked parent without creating anything outside', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-draft-parent-'));
  const outside = mkdtempSync(join(tmpdir(), 'seo-repair-draft-parent-outside-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const source = join(root, 'PG-CELEB-057-en.md');
  const draftRoot = join(root, 'state', 'seo-repair-drafts');
  mkdirSync(draftRoot, { recursive: true });
  writeFileSync(source, '# source draft\n');
  symlinkSync(outside, join(draftRoot, 'astrologywiki'), 'dir');

  const before = readdirSync(outside);
  const result = astrologyAdapter.ensureAstrologyRepairDraft({
    sourceFile: source,
    draftRoot,
    site: 'astrologywiki',
    pageId: 'PG-CELEB-057',
    attemptId: 'event-057',
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /symlink|outside|escape/i);
  assert.deepEqual(readdirSync(outside), before);
});

test('controller draft snapshot is durable per attempt and never overwritten by later live staging drift', (t) => {
  assert.equal(typeof astrologyAdapter.ensureAstrologyRepairDraft, 'function');
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-draft-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'PG-CELEB-057-en.md');
  const draftRoot = join(root, 'state', 'seo-repair-drafts');
  writeFileSync(source, '# live staging says Mars in Aries\n');

  const first = astrologyAdapter.ensureAstrologyRepairDraft({
    sourceFile: source,
    draftRoot,
    site: 'astrologywiki',
    pageId: 'PG-CELEB-057',
    attemptId: 'event-057',
  });
  assert.equal(first.ok, true, first.reason);
  assert.equal(readFileSync(first.draftFile, 'utf8'), '# live staging says Mars in Aries\n');

  writeFileSync(first.draftFile, '# repaired snapshot says Mars in Pisces\n');
  writeFileSync(source, '# newer live staging still says Mars in Aries\n');
  const resumed = astrologyAdapter.ensureAstrologyRepairDraft({
    sourceFile: source,
    draftRoot,
    site: 'astrologywiki',
    pageId: 'PG-CELEB-057',
    attemptId: 'event-057',
  });
  assert.equal(resumed.draftFile, first.draftFile);
  assert.equal(readFileSync(resumed.draftFile, 'utf8'), '# repaired snapshot says Mars in Pisces\n');
  assert.equal(resumed.draftSha256, sha256('# repaired snapshot says Mars in Pisces\n'));
});

test('057-style repair target exposes article, plan, matching assets, and controller draft copy', async () => {
  const target = await astrologyAdapter.buildAstrologyRepairTarget({
    site: 'astrologywiki',
    pageId: 'PG-CELEB-057',
    slug: 'caitlin-clark-birth-chart',
    stage: 'preview_fact_gate',
    summary: 'article and SVG disagree',
  }, {
    branch: 'seo/auto/2026-07-15-PG-CELEB-057',
    worktree: '/repair-root/PG-CELEB-057-event',
    articleFile: 'data/articles/caitlin-clark-birth-chart.ts',
    changedFiles: ['data/articles/caitlin-clark-birth-chart.ts'],
    targetAssetFiles: [
      'public/images/blog/caitlin-clark-birth-chart-i0-en.svg',
      'public/images/blog/caitlin-clark-birth-chart-i2-en.svg',
    ],
    supportFiles: ['scripts/plans/auto-caitlin-clark-birth-chart.json'],
    draftFile: '/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md',
    draftSha256: 'd'.repeat(64),
  });
  assert.equal(target.draftFile, '/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md');
  assert.equal(target.draftSha256, 'd'.repeat(64));
  assert.deepEqual(target.assetFiles, [
    '/repair-root/PG-CELEB-057-event/public/images/blog/caitlin-clark-birth-chart-i0-en.svg',
    '/repair-root/PG-CELEB-057-event/public/images/blog/caitlin-clark-birth-chart-i2-en.svg',
  ]);
  assert.deepEqual(target.supportFiles, [
    '/repair-root/PG-CELEB-057-event/scripts/plans/auto-caitlin-clark-birth-chart.json',
  ]);
});

test('default regate command binds the clean repair worktree, pushed head, and repaired draft digest', () => {
  assert.equal(typeof astrologyAdapter.astrologyRegateCommands, 'function');
  const commands = astrologyAdapter.astrologyRegateCommands({
    branch: 'seo/auto/2026-07-15-PG-CELEB-057',
    worktree: '/repair-root/PG-CELEB-057-event',
    persistedHeadRefOid: 'a'.repeat(40),
    draftFile: '/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md',
    draftSha256: 'b'.repeat(64),
  }, '/repo/tools/scripts');
  assert.deepEqual(commands, [
    [
      'node', '/repo/tools/scripts/gg-seo-autopilot.mjs',
      '--retry-failed', '--branch', 'seo/auto/2026-07-15-PG-CELEB-057',
    ],
    [
      'node', '/repo/tools/scripts/gg-preview-gate.mjs',
      '--branch', 'seo/auto/2026-07-15-PG-CELEB-057',
      '--worktree', '/repair-root/PG-CELEB-057-event',
      '--head-ref-oid', 'a'.repeat(40),
      '--draft', '/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md',
      '--draft-sha256', 'b'.repeat(64),
    ],
  ]);
});

test('adapter default regate executes the complete bound Gate command instead of falling back to claim paths', async () => {
  const calls = [];
  const branch = 'seo/auto/2026-07-15-PG-CELEB-057';
  const worktree = '/repair-root/PG-CELEB-057-event';
  const draft = '/state/seo-repair-drafts/astrologywiki/PG-CELEB-057/event.md';
  const head = 'a'.repeat(40);
  const draftSha256 = 'b'.repeat(64);
  const adapter = astrologyAdapter.createAstrologyWikiRepairAdapter({
    scriptsDir: '/repo/tools/scripts',
    resolveContext: async () => ({
      branch,
      worktree,
      headRefOid: head,
      articleFile: `${worktree}/data/articles/caitlin-clark-birth-chart.ts`,
      changedFiles: ['data/articles/caitlin-clark-birth-chart.ts'],
      draftFile: draft,
      draftSha256,
      linkCandidates: [],
    }),
    runCommand: async (argv) => {
      calls.push(argv);
      if (argv.includes('--retry-failed')) {
        return {
          code: 1,
          stdout: '',
          stderr: `cannot retry ${branch} from status "pushed-preview" — expected needs_human`,
          timedOut: false,
        };
      }
      if (argv[1].endsWith('gg-preview-gate.mjs')) {
        return { code: 0, stdout: '{}', stderr: '', timedOut: false };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          results: [{ ok: true, terminal: 'published' }],
        }),
        stderr: '',
        timedOut: false,
      };
    },
  });
  const result = await adapter.execute({
    record: {
      event: {
        eventId: 'event-057',
        site: 'astrologywiki',
        pageId: 'PG-CELEB-057',
        slug: 'caitlin-clark-birth-chart',
        stage: 'preview_fact_gate',
        errorKind: 'tool_exit',
        summary: 'retry exact gate',
      },
    },
    strategy: 'deterministic_retry',
  });
  assert.equal(result.terminal, 'published');
  assert.deepEqual(calls[1], [
    'node', '/repo/tools/scripts/gg-preview-gate.mjs',
    '--branch', branch,
    '--worktree', worktree,
    '--head-ref-oid', head,
    '--draft', draft,
    '--draft-sha256', draftSha256,
  ]);
});

test('successful local push remains persisted when the dirty original worktree cannot fast-forward', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-persist-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldState = process.env.GG_FLOW_STATE_DIR;
  process.env.GG_FLOW_STATE_DIR = join(root, 'state');
  t.after(() => {
    if (oldState === undefined) delete process.env.GG_FLOW_STATE_DIR;
    else process.env.GG_FLOW_STATE_DIR = oldState;
  });
  const origin = join(root, 'origin.git');
  const repairRoot = join(root, 'repair-root');
  const repair = join(repairRoot, 'PG-CELEB-057-event');
  const original = join(root, 'original');
  mkdirSync(repairRoot, { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', origin]);
  execFileSync('git', ['clone', '-q', origin, repair]);
  for (const repo of [repair]) {
    git(repo, ['config', 'user.name', 'persist-test']);
    git(repo, ['config', 'user.email', 'persist-test@example.invalid']);
  }
  const slug = 'caitlin-clark-birth-chart';
  const article = join(repair, 'data', 'articles', `${slug}.ts`);
  mkdirSync(join(repair, 'data', 'articles'), { recursive: true });
  writeFileSync(article, 'export const article = { mars: "Aries" };\n');
  git(repair, ['add', '.']);
  git(repair, ['commit', '-qm', 'seed article']);
  const branch = 'seo/auto/2026-07-15-PG-CELEB-057';
  git(repair, ['push', '-q', 'origin', `HEAD:refs/heads/${branch}`]);
  execFileSync('git', ['clone', '-q', '--branch', branch, origin, original]);
  git(original, ['config', 'user.name', 'persist-test']);
  git(original, ['config', 'user.email', 'persist-test@example.invalid']);
  writeFileSync(join(original, 'ORIGINAL-DIRTY.md'), 'unrelated original worktree change\n');
  git(original, ['add', 'ORIGINAL-DIRTY.md']);
  git(original, ['commit', '-qm', 'diverge original worktree']);

  const draftRoot = join(root, 'state', 'seo-repair-drafts');
  const draft = join(draftRoot, 'astrologywiki', 'PG-CELEB-057', 'event.md');
  mkdirSync(join(draftRoot, 'astrologywiki', 'PG-CELEB-057'), { recursive: true });
  writeFileSync(draft, '# Mars in Aries\n');
  const initialDraftSha = sha256('# Mars in Aries\n');
  let regatedTarget = null;
  const adapter = astrologyAdapter.createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch,
      worktree: repair,
      originalWorktree: original,
      articleFile: article,
      changedFiles: ['data/articles/caitlin-clark-birth-chart.ts'],
      draftFile: draft,
      draftSha256: initialDraftSha,
      linkCandidates: [],
    }),
    invokeAgent: async (target) => {
      assert.equal(target.draftFile, draft);
      writeFileSync(target.articleFile, 'export const article = { mars: "Pisces" };\n');
      writeFileSync(target.draftFile, '# Mars in Pisces\n');
      return { ok: true, evidence: { changedFiles: [target.articleFile, target.draftFile] } };
    },
    regate: async (target) => {
      regatedTarget = { ...target };
      return { ok: true };
    },
    publish: async () => ({ ok: true }),
    verifyTerminal: async () => ({
      ok: true,
      terminal: 'published',
      checks: { reviewed_head: true, production_200: true, writeback_clear: true },
    }),
  });

  const result = await adapter.execute({
    record: {
      event: {
        eventId: 'event-057',
        site: 'astrologywiki',
        pageId: 'PG-CELEB-057',
        slug,
        stage: 'preview_fact_gate',
        errorKind: 'asset_fail',
        summary: 'Mars fact mismatch',
        stderr: 'review FAIL',
      },
    },
    strategy: 'agent_content_asset_link',
  });

  assert.equal(result.terminal, 'published', JSON.stringify(result.evidence));
  const pushedHead = git(repair, ['rev-parse', 'HEAD']);
  assert.equal(git(repair, ['rev-parse', `refs/remotes/origin/${branch}`]), pushedHead);
  assert.equal(git(original, ['rev-parse', 'HEAD']) === pushedHead, false);
  assert.equal(regatedTarget.persistedHeadRefOid, pushedHead);
  assert.equal(regatedTarget.draftSha256, sha256('# Mars in Pisces\n'));
});

test('controller no-progress artifact SHA includes repaired draft bytes as well as committed article assets', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-artifact-draft-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldState = process.env.GG_FLOW_STATE_DIR;
  process.env.GG_FLOW_STATE_DIR = join(root, 'state');
  t.after(() => {
    if (oldState === undefined) delete process.env.GG_FLOW_STATE_DIR;
    else process.env.GG_FLOW_STATE_DIR = oldState;
  });
  const article = join(root, 'worktree', 'data', 'articles', 'brad-pitt-birth-chart.ts');
  const draft = join(
    root,
    'state',
    'seo-repair-drafts',
    'astrologywiki',
    'PG-CELEB-058',
    'event.md',
  );
  mkdirSync(join(root, 'worktree', 'data', 'articles'), { recursive: true });
  mkdirSync(join(root, 'state', 'seo-repair-drafts', 'astrologywiki', 'PG-CELEB-058'), {
    recursive: true,
  });
  writeFileSync(article, 'export const article = { time: "unknown" };\n');
  writeFileSync(draft, '# Birth time is contested\n');
  const adapter = astrologyAdapter.createAstrologyWikiRepairAdapter({
    resolveContext: async () => ({
      branch: 'seo/auto/2026-07-15-PG-CELEB-058',
      worktree: join(root, 'worktree'),
      articleFile: article,
      changedFiles: ['data/articles/brad-pitt-birth-chart.ts'],
      draftFile: draft,
      draftSha256: sha256(readFileSync(draft)),
      linkCandidates: [],
    }),
    regate: async () => ({ ok: false, reason: 'same gate failure' }),
  });
  const input = {
    record: {
      event: {
        eventId: 'event-058',
        site: 'astrologywiki',
        pageId: 'PG-CELEB-058',
        slug: 'brad-pitt-birth-chart',
        stage: 'preview_fact_gate',
        errorKind: 'gate_fail',
        summary: 'birth time conflict',
      },
    },
    strategy: 'deterministic_retry',
  };
  const first = await adapter.execute(input);
  writeFileSync(draft, '# Exact birth time omitted pending authoritative source\n');
  const second = await adapter.execute(input);
  assert.match(first.evidence.artifactSha, /^[0-9a-f]{64}$/);
  assert.match(second.evidence.artifactSha, /^[0-9a-f]{64}$/);
  assert.notEqual(second.evidence.artifactSha, first.evidence.artifactSha);
});

test('058-style repair prompt forbids invented protected facts and allows neutralizing a contested claim', () => {
  const prompt = buildRepairAgentPrompt({
    template: 'repair one target',
    strategy: 'agent_content_asset_link',
    record: {
      fingerprint: 'fp-058',
      event: {
        schemaVersion: 2,
        eventId: 'event-058',
        site: 'astrologywiki',
        pageId: 'PG-CELEB-058',
        slug: 'brad-pitt-birth-chart',
        errorKind: 'gate_fail',
        summary: 'birth time source conflict',
      },
    },
    target: {
      articleFile: '/repair/data/articles/brad-pitt-birth-chart.ts',
      draftFile: '/state/seo-repair-drafts/astrologywiki/PG-CELEB-058/event.md',
    },
  });
  assert.match(prompt, /do not invent|never invent/i);
  assert.match(prompt, /neutral|remove.*contested|omit.*contested/i);
  assert.match(prompt, /missing authoritative source|human_only/i);
});

test('058 missing authoritative source terminates human_only without repair, regate, or publish', async () => {
  const calls = [];
  const adapter = astrologyAdapter.createAstrologyWikiRepairAdapter({
    resolveContext: async () => {
      calls.push('resolve');
      throw new Error('must not resolve a publish target without authoritative source');
    },
    invokeAgent: async () => {
      calls.push('agent');
      return { ok: true };
    },
    regate: async () => {
      calls.push('regate');
      return { ok: true };
    },
    publish: async () => {
      calls.push('publish');
      return { ok: true };
    },
  });
  const result = await adapter.execute({
    record: {
      event: {
        eventId: 'event-058',
        site: 'astrologywiki',
        pageId: 'PG-CELEB-058',
        slug: 'brad-pitt-birth-chart',
        stage: 'preview_fact_gate',
        errorKind: 'missing_authoritative_source',
        summary: 'birth time has no authoritative source evidence',
      },
    },
    strategy: 'safe_authorization_path',
  });
  assert.equal(result.terminal, 'human_only');
  assert.equal(result.agentMutationInvoked, false);
  assert.deepEqual(calls, []);
});
