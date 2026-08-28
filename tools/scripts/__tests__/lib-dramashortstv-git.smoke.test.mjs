#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  commitAndPushDramaDocument,
  preflightDramaOpsRepo,
} from '../lib/dramashortstv-git.mjs';

const ARTICLE = 'inbox-maboyang/05-blog/dramashortstv/2026-08-28-dramashortstv-blog-dramabox-vs-reelshort.md';

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function write(repo, relativePath, content) {
  const path = join(repo, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), 'gg-drama-git-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote]);
  execFileSync('git', ['init', '--initial-branch=main', work]);
  git(work, ['config', 'user.name', 'Drama Test']);
  git(work, ['config', 'user.email', 'drama@example.test']);
  write(work, 'README.md', 'seed\n');
  git(work, ['add', '--', 'README.md']);
  git(work, ['commit', '-m', 'seed']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-u', 'origin', 'main']);
  return { root, remote, work };
}

function cloneCompetitor(root, remote) {
  const competitor = join(root, `competitor-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  execFileSync('git', ['clone', remote, competitor], { stdio: 'ignore' });
  git(competitor, ['config', 'user.name', 'Other Writer']);
  git(competitor, ['config', 'user.email', 'other@example.test']);
  return competitor;
}

test('preflight accepts only clean synchronized main with exact fetch/push remote', () => {
  const env = setupRepo();
  try {
    const result = preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    assert.equal(result.branch, 'main');
    assert.equal(result.remoteUrl, env.remote);
    assert.equal(result.ahead, 0);
    assert.equal(result.behind, 0);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('preflight rejects wrong branch, wrong remote, dirty, and staged-only state', () => {
  const env = setupRepo();
  try {
    git(env.work, ['switch', '-c', 'feature']);
    assert.throws(() => preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote }), /branch.*main/i);
    git(env.work, ['switch', 'main']);
    assert.throws(() => preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: '/wrong/remote.git' }), /remote/i);

    write(env.work, 'unrelated.md', 'dirty\n');
    assert.throws(() => preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote }), /worktree.*clean/i);
    git(env.work, ['add', '--', 'unrelated.md']);
    assert.throws(() => preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote }), /worktree.*clean/i);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('preflight rejects nonzero remote divergence', () => {
  const env = setupRepo();
  try {
    const competitor = cloneCompetitor(env.root, env.remote);
    write(competitor, 'remote.md', 'new remote commit\n');
    git(competitor, ['add', '--', 'remote.md']);
    git(competitor, ['commit', '-m', 'advance remote']);
    git(competitor, ['push', 'origin', 'main']);
    assert.throws(() => preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote }), /ahead=0.*behind=1/i);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('delivery stages, commits, pushes, and verifies only the target document', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    write(env.work, ARTICLE, '# Article\n');
    const result = commitAndPushDramaDocument({
      opsDir: env.work,
      relativePath: ARTICLE,
      topicSlug: 'dramabox-vs-reelshort',
      expectedRemote: env.remote,
    });
    assert.equal(result.status, 'delivered');
    assert.equal(result.commitSha, result.remoteSha);
    assert.match(result.blobSha, /^[0-9a-f]{40}$/);
    assert.equal(git(env.work, ['show', '--format=%s', '-s', 'HEAD']), 'content(dramashortstv): add dramabox-vs-reelshort');
    assert.deepEqual(git(env.work, ['show', '--format=', '--name-only', 'HEAD']).split('\n').filter(Boolean), [ARTICLE]);
    assert.equal(git(env.work, ['status', '--porcelain']), '');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('delivery refuses an unrelated change without creating a commit', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    const before = git(env.work, ['rev-parse', 'HEAD']);
    write(env.work, ARTICLE, '# Article\n');
    write(env.work, 'unrelated.md', 'do not commit\n');
    assert.throws(
      () => commitAndPushDramaDocument({ opsDir: env.work, relativePath: ARTICLE, topicSlug: 'dramabox-vs-reelshort', expectedRemote: env.remote }),
      /exactly one target document/i,
    );
    assert.equal(git(env.work, ['rev-parse', 'HEAD']), before);
    assert.equal(git(env.work, ['diff', '--cached', '--name-only']), '');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('delivery checks staged bytes for whitespace errors before commit', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    const before = git(env.work, ['rev-parse', 'HEAD']);
    write(env.work, ARTICLE, '# Article with trailing spaces  \n');
    assert.throws(
      () => commitAndPushDramaDocument({
        opsDir: env.work,
        relativePath: ARTICLE,
        topicSlug: 'dramabox-vs-reelshort',
        expectedRemote: env.remote,
      }),
      /staged document.*diff check/i,
    );
    assert.equal(git(env.work, ['rev-parse', 'HEAD']), before);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('ordinary push rejection preserves the local document commit', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    write(env.work, ARTICLE, '# Article\n');

    const competitor = cloneCompetitor(env.root, env.remote);
    write(competitor, 'race.md', 'remote won race\n');
    git(competitor, ['add', '--', 'race.md']);
    git(competitor, ['commit', '-m', 'remote race']);
    git(competitor, ['push', 'origin', 'main']);
    const remoteBefore = git(competitor, ['rev-parse', 'HEAD']);

    assert.throws(
      () => commitAndPushDramaDocument({ opsDir: env.work, relativePath: ARTICLE, topicSlug: 'dramabox-vs-reelshort', expectedRemote: env.remote }),
      /push failed/i,
    );
    const localAfter = git(env.work, ['rev-parse', 'HEAD']);
    assert.notEqual(localAfter, remoteBefore);
    assert.equal(git(env.work, ['show', '--format=', '--name-only', 'HEAD']).trim(), ARTICLE);
    assert.equal(git(env.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('identical remotely delivered document returns idempotent no-op', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    write(env.work, ARTICLE, '# Article\n');
    const first = commitAndPushDramaDocument({
      opsDir: env.work,
      relativePath: ARTICLE,
      topicSlug: 'dramabox-vs-reelshort',
      expectedRemote: env.remote,
    });
    const second = commitAndPushDramaDocument({
      opsDir: env.work,
      relativePath: ARTICLE,
      topicSlug: 'dramabox-vs-reelshort',
      expectedRemote: env.remote,
    });
    assert.equal(second.status, 'already-delivered');
    assert.equal(second.commitSha, first.commitSha);
    assert.equal(git(env.work, ['rev-list', '--count', 'HEAD']), '2');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('delivery rechecks branch and remote identity after preflight', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    write(env.work, ARTICLE, '# Article\n');
    git(env.work, ['remote', 'set-url', '--push', 'origin', join(env.root, 'wrong.git')]);
    assert.throws(
      () => commitAndPushDramaDocument({
        opsDir: env.work,
        relativePath: ARTICLE,
        topicSlug: 'dramabox-vs-reelshort',
        expectedRemote: env.remote,
      }),
      /remote mismatch/i,
    );
    assert.equal(git(env.work, ['rev-list', '--count', 'HEAD']), '1');
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});

test('concurrent staged file cannot enter the target commit or get pushed', () => {
  const env = setupRepo();
  try {
    preflightDramaOpsRepo({ opsDir: env.work, expectedRemote: env.remote });
    write(env.work, ARTICLE, '# Article\n');
    const remoteBefore = git(env.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0];
    let injected = false;
    const racingGit = (repo, args) => {
      if (!injected && args[0] === 'commit') {
        injected = true;
        write(repo, 'concurrent.md', 'concurrent writer\n');
        git(repo, ['add', '--', 'concurrent.md']);
      }
      return git(repo, args);
    };
    assert.throws(
      () => commitAndPushDramaDocument({
        opsDir: env.work,
        relativePath: ARTICLE,
        topicSlug: 'dramabox-vs-reelshort',
        expectedRemote: env.remote,
        runGit: racingGit,
      }),
      /unrelated changes appeared after commit/i,
    );
    assert.deepEqual(git(env.work, ['show', '--format=', '--name-only', 'HEAD']).split('\n').filter(Boolean), [ARTICLE]);
    assert.equal(git(env.work, ['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/)[0], remoteBefore);
  } finally {
    rmSync(env.root, { recursive: true, force: true });
  }
});
