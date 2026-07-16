import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-seo-autopilot.mjs', import.meta.url));
const BRANCH = 'seo/auto/2026-07-16-PG-REGATE-001';
const PAGE_ID = 'PG-REGATE-001';
const SLUG = 'regate-article';
const INDEX = 'data/articles/index.ts';
const GENERATOR = 'scripts/generate-seo-pages.mjs';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed:\n${result.stdout || ''}\n${result.stderr || ''}`,
  );
  return String(result.stdout || '').trim();
}

function git(repo, ...args) {
  return run('git', ['-C', repo, ...args]);
}

function frontInsert(repo, file, line) {
  const path = join(repo, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace('[\n', `[\n${line}\n`));
}

function fixture(t, { nonAdditiveConflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-autopilot-regate-'));
  const remote = join(root, 'remote.git');
  const oracle = join(root, 'oracle');
  const flow = join(root, 'flow');
  const ops = join(root, 'ops');
  const state = join(root, 'state');
  const tasks = join(ops, 'inbox', '06-tasks', 'tasks');
  const repairRoot = join(root, 'repair-worktrees');
  const autopilotWorktreeRoot = join(root, 'autopilot-worktrees');
  const bin = join(root, 'bin');
  mkdirSync(remote, { recursive: true });
  run('git', ['init', '--bare', '-q', remote]);
  mkdirSync(oracle, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', oracle]);
  git(oracle, 'config', 'user.name', 'regate-test');
  git(oracle, 'config', 'user.email', 'regate@example.invalid');
  git(oracle, 'remote', 'add', 'origin', remote);
  mkdirSync(join(oracle, 'data', 'articles'), { recursive: true });
  mkdirSync(join(oracle, 'scripts'), { recursive: true });
  writeFileSync(join(oracle, INDEX), 'export const ARTICLES = [\n];\n');
  writeFileSync(join(oracle, GENERATOR), 'const ARTICLE_SLUGS_EN_ONLY = [\n];\n');
  writeFileSync(join(oracle, 'shared.ts'), 'export const SHARED = "base";\n');
  git(oracle, 'add', '-A');
  git(oracle, 'commit', '-qm', 'base');
  git(oracle, 'push', '-q', '-u', 'origin', 'main');

  git(oracle, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(oracle, 'data', 'articles', `${SLUG}.ts`), 'export const article = "reviewed";\n');
  frontInsert(oracle, INDEX, `  '${SLUG}',`);
  frontInsert(oracle, GENERATOR, `  '${SLUG}',`);
  if (nonAdditiveConflict) {
    writeFileSync(join(oracle, 'shared.ts'), 'export const SHARED = "branch";\n');
  }
  git(oracle, 'add', '-A');
  git(oracle, 'commit', '-qm', 'reviewed article');
  const reviewedHead = git(oracle, 'rev-parse', 'HEAD');
  git(oracle, 'push', '-q', '-u', 'origin', BRANCH);

  git(oracle, 'checkout', '-q', 'main');
  frontInsert(oracle, INDEX, "  'newer-main-article',");
  frontInsert(oracle, GENERATOR, "  'newer-main-article',");
  if (nonAdditiveConflict) {
    writeFileSync(join(oracle, 'shared.ts'), 'export const SHARED = "main";\n');
  }
  git(oracle, 'add', '-A');
  git(oracle, 'commit', '-qm', 'main advances');
  git(oracle, 'push', '-q', 'origin', 'main');
  git(oracle, 'fetch', '-q', 'origin');

  mkdirSync(repairRoot, { recursive: true });
  const repairWorktree = join(repairRoot, `${PAGE_ID}-event`);
  git(oracle, 'worktree', 'add', '-q', '--detach', repairWorktree, reviewedHead);

  const draft = join(state, 'seo-repair-drafts', 'astrologywiki', PAGE_ID, 'event.md');
  mkdirSync(join(state, 'seo-repair-drafts', 'astrologywiki', PAGE_ID), { recursive: true });
  const draftText = '# immutable reviewed draft\n';
  writeFileSync(draft, draftText);
  const draftSha256 = createHash('sha256').update(draftText).digest('hex');

  mkdirSync(tasks, { recursive: true });
  const claimsPath = join(tasks, '.autopilot-claims.json');
  writeFileSync(claimsPath, `${JSON.stringify({
    [PAGE_ID]: {
      branch: BRANCH,
      slug: SLUG,
      status: 'verified-preview',
      previewUrl: 'https://preview.example.test',
      headRefOid: reviewedHead,
      worktree: repairWorktree,
      draftFile: draft,
      draftSha256,
    },
  }, null, 2)}\n`);

  mkdirSync(flow, { recursive: true });
  mkdirSync(autopilotWorktreeRoot, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('headRefOid')) {
  process.stdout.write(process.env.GG_TEST_REVIEWED_HEAD);
  process.exit(0);
}
if (args.includes('mergeable,mergeStateStatus')) {
  process.stdout.write(JSON.stringify({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
  process.exit(0);
}
process.exit(0);
`);
  chmodSync(gh, 0o755);
  const npm = join(bin, 'npm');
  writeFileSync(npm, '#!/bin/sh\nexit 0\n');
  chmodSync(npm, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GG_FLOW_REPO: flow,
    GG_ORACLE_DIR: oracle,
    GG_ORACLE_WORKTREE_ROOT: autopilotWorktreeRoot,
    GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT: repairRoot,
    GG_OPS_DIR: ops,
    GG_FLOW_STATE_DIR: state,
    GG_AUTOPILOT_NO_NOTIFY: '1',
    GG_AUTOPILOT_NO_INDEX_TRACKING: '1',
    GG_AUTOPILOT_LOCK_TIMEOUT_MS: '1000',
    GG_TEST_REVIEWED_HEAD: reviewedHead,
  };
  const runAutopilot = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    oracle,
    remote,
    claimsPath,
    reviewedHead,
    repairWorktree,
    draft,
    draftSha256,
    runAutopilot,
  };
}

test('--prepare-regate unions only additive registries, pushes a new head, and persists a clean binding', (t) => {
  const h = fixture(t);
  const result = h.runAutopilot(['--prepare-regate', '--branch', BRANCH]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const prepared = JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.equal(prepared.ok, true);
  assert.equal(prepared.oldHeadRefOid, h.reviewedHead);
  assert.match(prepared.newHeadRefOid, /^[0-9a-f]{40}$/);
  assert.notEqual(prepared.newHeadRefOid, h.reviewedHead);
  assert.equal(prepared.draftFile, realpathSync(h.draft));
  assert.equal(prepared.draftSha256, h.draftSha256);
  assert.ok(prepared.worktree.startsWith(`${realpathSync(h.repairWorktree.slice(0, h.repairWorktree.lastIndexOf('/')))}/`));
  assert.equal(git(prepared.worktree, 'status', '--porcelain'), '');
  assert.equal(git(prepared.worktree, 'rev-parse', 'HEAD'), prepared.newHeadRefOid);
  assert.equal(git(h.oracle, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s+/)[0], prepared.newHeadRefOid);
  assert.equal(
    readFileSync(join(prepared.worktree, 'data', 'articles', `${SLUG}.ts`), 'utf8'),
    'export const article = "reviewed";\n',
  );
  for (const file of [INDEX, GENERATOR]) {
    const text = readFileSync(join(prepared.worktree, file), 'utf8');
    assert.match(text, /regate-article/);
    assert.match(text, /newer-main-article/);
  }
  const claim = JSON.parse(readFileSync(h.claimsPath, 'utf8'))[PAGE_ID];
  assert.equal(claim.status, 'pushed-preview');
  assert.equal(claim.headRefOid, prepared.newHeadRefOid);
  assert.equal(claim.worktree, prepared.worktree);
  assert.equal(claim.previewUrl, undefined);
  assert.equal(claim.verifiedAt, undefined);
  assert.equal(claim.reviewedAt, undefined);
});

test('--prepare-regate rejects a non-additive conflict without moving the reviewed branch or claim', (t) => {
  const h = fixture(t, { nonAdditiveConflict: true });
  const result = h.runAutopilot(['--prepare-regate', '--branch', BRANCH]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-additive conflict.*shared\.ts/i);
  const claim = JSON.parse(readFileSync(h.claimsPath, 'utf8'))[PAGE_ID];
  assert.equal(claim.status, 'verified-preview');
  assert.equal(claim.headRefOid, h.reviewedHead);
  assert.equal(claim.worktree, h.repairWorktree);
  assert.equal(git(h.oracle, 'ls-remote', 'origin', `refs/heads/${BRANCH}`).split(/\s+/)[0], h.reviewedHead);
  assert.equal(existsSync(join(h.repairWorktree, 'shared.ts')), true);
});
