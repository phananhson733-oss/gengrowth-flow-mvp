import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
  const claims = () => JSON.parse(readFileSync(claimsPath, 'utf8'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { run, ghText, claims };
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
