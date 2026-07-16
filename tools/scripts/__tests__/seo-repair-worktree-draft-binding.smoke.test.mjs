import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
