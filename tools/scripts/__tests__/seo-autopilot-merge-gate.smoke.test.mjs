import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
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
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../gg-seo-autopilot.mjs', import.meta.url));
const BRANCH = 'seo/auto/2026-07-16-PG-001';
const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function fixture(t, claim = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-autopilot-merge-gate-'));
  const flow = join(root, 'flow');
  const oracle = join(root, 'oracle');
  const ops = join(root, 'ops');
  const tasks = join(ops, 'inbox', '06-tasks', 'tasks');
  const bin = join(root, 'bin');
  const claimsPath = join(tasks, '.autopilot-claims.json');
  const ghCalls = join(root, 'gh-calls.log');
  const gitCalls = join(root, 'git-calls.log');
  mkdirSync(flow, { recursive: true });
  mkdirSync(oracle, { recursive: true });
  mkdirSync(tasks, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(claimsPath, `${JSON.stringify({
    'PG-001': {
      branch: BRANCH,
      slug: 'sha-pinned-gate',
      status: 'pushed-preview',
      previewUrl: 'https://preview.example.test',
      ...claim,
    },
  }, null, 2)}\n`);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(ghCalls)}, args.join(' ') + '\\n');
if (args.includes('view') && args.includes('headRefOid')) {
  if (process.env.GG_TEST_GH_HEAD_FAIL === '1') process.exit(7);
  process.stdout.write(process.env.GG_TEST_GH_HEAD || ${JSON.stringify(HEAD_A)});
  process.exit(0);
}
if (args.includes('view') && args.includes('mergeable,mergeStateStatus')) {
  process.stdout.write(JSON.stringify({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }));
  process.exit(0);
}
if (args.includes('merge')) process.exit(Number(process.env.GG_TEST_GH_MERGE_EXIT || 7));
process.exit(0);
`);
  chmodSync(gh, 0o755);
  const gitBin = join(bin, 'git');
  writeFileSync(gitBin, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(gitCalls)}, args.join(' ') + '\\n');
const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' });
process.exit(result.status == null ? 1 : result.status);
`);
  chmodSync(gitBin, 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GG_FLOW_REPO: flow,
    GG_ORACLE_DIR: oracle,
    GG_OPS_DIR: ops,
    GG_FLOW_STATE_DIR: join(root, 'state'),
    GG_AUTOPILOT_NO_NOTIFY: '1',
    GG_AUTOPILOT_NO_INDEX_TRACKING: '1',
    GG_AUTOPILOT_LOCK_TIMEOUT_MS: '1000',
  };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
    timeout: 10_000,
  });
  const ghText = () => existsSync(ghCalls) ? readFileSync(ghCalls, 'utf8') : '';
  const gitText = () => existsSync(gitCalls) ? readFileSync(gitCalls, 'utf8') : '';
  const claims = () => JSON.parse(readFileSync(claimsPath, 'utf8'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, run, ghText, gitText, claims };
}

function repairBindingFixture(t, h, {
  pageId = 'PG-001',
  draftText = '# repaired draft\n',
} = {}) {
  const repairRoot = join(h.root, 'repair-root');
  const worktree = join(repairRoot, `${pageId}-event`);
  mkdirSync(worktree, { recursive: true });
  for (const args of [
    ['init', '-q'],
    ['config', 'user.name', 'binding-test'],
    ['config', 'user.email', 'binding-test@example.invalid'],
  ]) {
    const result = spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  writeFileSync(join(worktree, 'README.md'), 'clean\n');
  spawnSync('git', ['-C', worktree, 'add', 'README.md']);
  spawnSync('git', ['-C', worktree, 'commit', '-qm', 'binding fixture']);
  const head = spawnSync('git', ['-C', worktree, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).stdout.trim();
  const draftRoot = join(h.root, 'state', 'seo-repair-drafts');
  const draft = join(draftRoot, 'astrologywiki', pageId, 'event.md');
  mkdirSync(join(draftRoot, 'astrologywiki', pageId), { recursive: true });
  writeFileSync(draft, draftText);
  return {
    repairRoot,
    worktree,
    head,
    draft,
    draftSha256: createHash('sha256').update(draftText).digest('hex'),
  };
}

test('--mark-verified requires a well-formed reviewed head SHA before calling gh', (t) => {
  for (const args of [
    ['--mark-verified', '--branch', BRANCH, '--preview-url', 'https://preview.example.test'],
    ['--mark-verified', '--branch', BRANCH, '--preview-url', 'https://preview.example.test', '--head-ref-oid', 'bad'],
  ]) {
    const h = fixture(t);
    const result = h.run(args);
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /head-ref-oid|40-hex/i);
    assert.equal(h.ghText(), '');
  }
});

test('--mark-verified blocks head fetch failure or mismatch and persists exact matching head evidence', (t) => {
  {
    const h = fixture(t);
    const failed = h.run([
      '--mark-verified', '--branch', BRANCH, '--preview-url', 'https://preview.example.test',
      '--head-ref-oid', HEAD_A,
    ], { GG_TEST_GH_HEAD_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.equal(h.claims()['PG-001'].status, 'pushed-preview');
  }
  {
    const h = fixture(t);
    const mismatch = h.run([
      '--mark-verified', '--branch', BRANCH, '--preview-url', 'https://preview.example.test',
      '--head-ref-oid', HEAD_A,
    ], { GG_TEST_GH_HEAD: HEAD_B });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /current.*reviewed|head.*does not match/i);
    assert.equal(h.claims()['PG-001'].status, 'pushed-preview');
  }
  {
    const h = fixture(t);
    const matched = h.run([
      '--mark-verified', '--branch', BRANCH, '--preview-url', 'https://preview.example.test',
      '--evidence', 'full pinned round passed', '--head-ref-oid', HEAD_A,
    ], { GG_TEST_GH_HEAD: HEAD_A });
    assert.equal(matched.status, 0, `${matched.stdout}\n${matched.stderr}`);
    const claim = h.claims()['PG-001'];
    assert.equal(claim.status, 'verified-preview');
    assert.equal(claim.headRefOid, HEAD_A);
    assert.equal(claim.verificationEvidence, 'full pinned round passed');
    assert.match(claim.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
  }
});

test('--mark-verified persists only a clean controller worktree and exact repaired draft evidence', (t) => {
  const h = fixture(t, { worktree: join(tmpdir(), 'original-dirty-worktree') });
  const binding = repairBindingFixture(t, h);
  const result = h.run([
    '--mark-verified',
    '--branch', BRANCH,
    '--preview-url', 'https://preview.example.test',
    '--head-ref-oid', binding.head,
    '--worktree', binding.worktree,
    '--draft', binding.draft,
    '--draft-sha256', binding.draftSha256,
  ], {
    GG_TEST_GH_HEAD: binding.head,
    GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT: binding.repairRoot,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const claim = h.claims()['PG-001'];
  assert.equal(claim.status, 'verified-preview');
  assert.equal(claim.headRefOid, binding.head);
  assert.equal(claim.worktree, realpathSync(binding.worktree));
  assert.equal(claim.draftFile, realpathSync(binding.draft));
  assert.equal(claim.draftSha256, binding.draftSha256);
});

test('--mark-verified repair override fails closed for outside, symlink, dirty, head, or draft drift', (t) => {
  const cases = [
    {
      name: 'outside repair root',
      mutate(binding, h) {
        const outside = join(h.root, 'outside-worktree');
        spawnSync('cp', ['-R', binding.worktree, outside]);
        return { ...binding, worktree: outside };
      },
      pattern: /outside|root/i,
    },
    {
      name: 'symlink escape',
      mutate(binding, h) {
        const outside = join(h.root, 'outside-symlink-target');
        spawnSync('cp', ['-R', binding.worktree, outside]);
        const link = join(binding.repairRoot, 'escaped-link');
        symlinkSync(outside, link);
        return { ...binding, worktree: link };
      },
      pattern: /outside|escape|root|symlink/i,
    },
    {
      name: 'missing controller root',
      mutate(binding, h) {
        return { ...binding, repairRoot: join(h.root, 'missing-controller-root') };
      },
      pattern: /root|realpath|no such/i,
    },
    {
      name: 'controller root is a symlink',
      mutate(binding, h) {
        const alias = join(h.root, 'controller-root-alias');
        symlinkSync(binding.repairRoot, alias);
        return {
          ...binding,
          repairRoot: alias,
          worktree: join(alias, 'PG-001-event'),
        };
      },
      pattern: /root.*symlink|symlink.*root/i,
    },
    {
      name: 'dirty repair worktree',
      mutate(binding) {
        writeFileSync(join(binding.worktree, 'DIRTY.md'), 'dirty\n');
        return binding;
      },
      pattern: /dirty|uncommitted/i,
    },
    {
      name: 'repair HEAD mismatch',
      mutate(binding) {
        return { ...binding, head: 'e'.repeat(40) };
      },
      pattern: /head.*mismatch/i,
    },
    {
      name: 'draft digest drift',
      mutate(binding) {
        return { ...binding, draftSha256: 'f'.repeat(64) };
      },
      pattern: /draft.*digest|digest.*mismatch|sha/i,
    },
  ];
  for (const entry of cases) {
    const h = fixture(t);
    const original = repairBindingFixture(t, h);
    const binding = entry.mutate(original, h);
    const result = h.run([
      '--mark-verified',
      '--branch', BRANCH,
      '--preview-url', 'https://preview.example.test',
      '--head-ref-oid', binding.head,
      '--worktree', binding.worktree,
      '--draft', binding.draft,
      '--draft-sha256', binding.draftSha256,
    ], {
      GG_TEST_GH_HEAD: binding.head,
      GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT: binding.repairRoot,
    });
    assert.notEqual(result.status, 0, `${entry.name} unexpectedly verified`);
    assert.match(result.stderr, entry.pattern, `${entry.name}: ${result.stderr}`);
    assert.equal(h.claims()['PG-001'].status, 'pushed-preview');
  }
});

test('--merge cleanup targets only the verified controller worktree and never the original dirty claim path', (t) => {
  const original = join(tmpdir(), `original-dirty-claim-${process.pid}`);
  mkdirSync(original, { recursive: true });
  writeFileSync(join(original, 'KEEP-ME.txt'), 'must survive merge cleanup\n');
  t.after(() => rmSync(original, { recursive: true, force: true }));
  const h = fixture(t, { worktree: original });
  const binding = repairBindingFixture(t, h);
  const marked = h.run([
    '--mark-verified',
    '--branch', BRANCH,
    '--preview-url', 'https://preview.example.test',
    '--head-ref-oid', binding.head,
    '--worktree', binding.worktree,
    '--draft', binding.draft,
    '--draft-sha256', binding.draftSha256,
  ], {
    GG_TEST_GH_HEAD: binding.head,
    GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT: binding.repairRoot,
  });
  assert.equal(marked.status, 0, marked.stderr);
  const claim = h.claims()['PG-001'];
  assert.equal(claim.worktree, realpathSync(binding.worktree));
  assert.equal(claim.originalWorktree, original);

  h.run(['--merge', '--branch', BRANCH], {
    GG_TEST_GH_HEAD: binding.head,
    GG_TEST_GH_MERGE_EXIT: '0',
    GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT: binding.repairRoot,
  });
  const cleanupCalls = h.gitText().split('\n').filter((line) => line.includes('worktree remove'));
  assert.ok(
    cleanupCalls.some((line) => line.includes(realpathSync(binding.worktree))),
    `verified repair cleanup missing:\n${h.gitText()}`,
  );
  assert.ok(
    cleanupCalls.every((line) => !line.includes(original)),
    `original dirty worktree was selected for cleanup:\n${h.gitText()}`,
  );
  assert.equal(readFileSync(join(original, 'KEEP-ME.txt'), 'utf8'), 'must survive merge cleanup\n');
});

test('--merge rejects missing or malformed reviewed SHA before gh pr merge', (t) => {
  for (const headRefOid of [undefined, 'bad']) {
    const h = fixture(t, {
      status: 'verified-preview',
      ...(headRefOid === undefined ? {} : { headRefOid }),
    });
    const result = h.run(['--merge', '--branch', BRANCH]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /headRefOid|40-hex|reviewed head/i);
    assert.doesNotMatch(h.ghText(), /pr merge/);
  }
});

test('--merge blocks current PR head drift before gh pr merge', (t) => {
  const h = fixture(t, { status: 'verified-preview', headRefOid: HEAD_A });
  const result = h.run(
    ['--merge', '--branch', BRANCH],
    { GG_TEST_GH_HEAD: HEAD_B },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /current PR head .* does not match reviewed head/i);
  assert.doesNotMatch(h.ghText(), /pr merge/);
});

test('--merge always pins gh pr merge to the reviewed SHA', (t) => {
  const h = fixture(t, { status: 'verified-preview', headRefOid: HEAD_A });
  const result = h.run(['--merge', '--branch', BRANCH]);
  assert.notEqual(result.status, 0, 'fake gh stops immediately after recording merge argv');
  assert.match(h.ghText(), new RegExp(`pr merge .*--match-head-commit ${HEAD_A}`));
});
