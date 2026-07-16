import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const reconcileUrl = pathToFileURL(resolve(flow, 'tools/scripts/gg-ledger-reconcile.mjs')).href;

function runStrictFixture(verification, {
  applyResult = {},
  strict = true,
  apply = true,
} = {}) {
  const source = `
    import { runLedgerReconcile } from ${JSON.stringify(reconcileUrl)};
    const verification = JSON.parse(process.env.GG_TEST_VERIFICATION);
    const applyResult = JSON.parse(process.env.GG_TEST_APPLY_RESULT);
    const phases = [];
    const result = await runLedgerReconcile({
      apply: ${apply ? 'true' : 'false'},
      strict: ${strict ? 'true' : 'false'},
      deps: {
        apply: async () => { phases.push('apply'); return applyResult; },
        verify: async () => { phases.push('verify'); return verification; },
        notify: async () => { phases.push('notify'); },
        log: () => {},
      },
    });
    process.stdout.write(JSON.stringify({ result, phases }));
    if (${strict ? 'true' : 'false'} && result.ok !== true) process.exitCode = 2;
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', source], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_TEST_VERIFICATION: JSON.stringify(verification),
      GG_TEST_APPLY_RESULT: JSON.stringify(applyResult),
    },
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

function zero(overrides = {}) {
  return {
    pendingWritebackAfter: 0,
    sheetFlipsAfter: 0,
    planUncheckedAfter: 0,
    activeRepairAfter: 0,
    expiredLeasesAfter: 0,
    eligibleNeedsHumanAfter: 0,
    errors: [],
    ...overrides,
  };
}

function defaultCliFixture({
  claims = {},
  queue = [],
  sheetPlan = false,
  missingClaims = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-reconcile-default-'));
  const fakeFlow = join(root, 'flow');
  const scripts = join(fakeFlow, 'tools/scripts');
  const opsTasks = join(root, 'ops/inbox/06-tasks/tasks');
  const state = join(root, 'state');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(opsTasks, { recursive: true });
  const status = join(scripts, 'gg-reconcile-status.mjs');
  writeFileSync(status, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(status, 0o755);
  if (!missingClaims) {
    writeFileSync(join(opsTasks, '.autopilot-claims.json'), `${JSON.stringify(claims)}\n`);
  }
  if (sheetPlan) {
    writeFileSync(
      join(opsTasks, '2026-07-16-blog-output-plan-test.md'),
      '- [ ] `PG-A-001` alpha\n',
    );
  }
  if (queue.length > 0) {
    mkdirSync(join(state, 'seo-repair-queue'), { recursive: true });
    queue.forEach((record, index) => {
      writeFileSync(
        join(state, 'seo-repair-queue', `record-${index}.json`),
        `${JSON.stringify(record)}\n`,
      );
    });
  }
  const run = ({ createState = true } = {}) => {
    if (createState) mkdirSync(state, { recursive: true });
    return spawnSync('node', [
      resolve(flow, 'tools/scripts/gg-ledger-reconcile.mjs'),
      '--dry',
      '--strict',
      '--json',
    ], {
      cwd: flow,
      encoding: 'utf8',
      env: {
        ...process.env,
        GG_FLOW_REPO: fakeFlow,
        GG_OPS_DIR: join(root, 'ops'),
        GG_FLOW_STATE_DIR: state,
        GG_SEO_REPAIR_QUEUE_DIR: join(state, 'seo-repair-queue'),
        GG_WRITER_SA_JSON: join(root, 'missing-service-account.json'),
        GG_LARK_NOTIFY_SILENCE: '1',
      },
    });
  };
  return { root, state, run };
}

test('strict mode applies then verifies and returns exactly the required counters', () => {
  const out = runStrictFixture(zero());
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(out.json.phases, ['apply', 'verify']);
  assert.deepEqual(Object.keys(out.json.result).sort(), [
    'activeRepairAfter',
    'eligibleNeedsHumanAfter',
    'errors',
    'expiredLeasesAfter',
    'ok',
    'pendingWritebackAfter',
    'planUncheckedAfter',
    'sheetFlipsAfter',
  ]);
  assert.equal(out.json.result.ok, true);
});

test('pending writeback remains => strict exit 2 and pendingWritebackAfter=1', () => {
  const out = runStrictFixture(zero({ pendingWritebackAfter: 1 }));
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.result.ok, false);
  assert.equal(out.json.result.pendingWritebackAfter, 1);
});

test('verification sheet flips after an earlier apply zero cannot be masked', () => {
  const out = runStrictFixture(zero({ sheetFlipsAfter: 2 }), {
    applyResult: zero({ sheetFlipsAfter: 0 }),
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.result.ok, false);
  assert.equal(out.json.result.sheetFlipsAfter, 2);
  assert.deepEqual(out.json.phases, ['apply', 'verify']);
});

for (const [field, value] of [
  ['planUncheckedAfter', 1],
  ['activeRepairAfter', 1],
  ['expiredLeasesAfter', 1],
  ['eligibleNeedsHumanAfter', 1],
]) {
  test(`${field} independently blocks strict convergence`, () => {
    const out = runStrictFixture(zero({ [field]: value }));
    assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
    assert.equal(out.json.result[field], value);
    assert.equal(out.json.result.ok, false);
  });
}

test('strict path never sends an intermediate notification', () => {
  const out = runStrictFixture(zero({ pendingWritebackAfter: 1 }));
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(out.json.phases, ['apply', 'verify']);
});

test('legacy dry invocation preserves the best-effort apply pass before verification', () => {
  const out = runStrictFixture(zero(), { strict: false, apply: false });
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(out.json.phases, ['apply', 'verify']);
});

test('strict dry verification fails closed without creating a missing state root', () => {
  const fixture = defaultCliFixture();
  const out = fixture.run({ createState: false });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(existsSync(fixture.state), false);
  const json = JSON.parse(out.stdout);
  assert.match(json.errors.join('\n'), /flow-state/i);
});

test('parseable claims with an array entry fail closed instead of becoming zero', () => {
  const fixture = defaultCliFixture({ claims: { 'PG-A-001': [] } });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.match(json.errors.join('\n'), /claim PG-A-001/i);
});

test('active repair with an invalid lease timestamp fails closed', () => {
  const fixture = defaultCliFixture({
    queue: [{
      status: 'repairing',
      event: { site: 'astrologywiki', pageId: 'PG-A-001' },
      lease: { expiresAt: 'not-a-date' },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.match(json.errors.join('\n'), /lease/i);
});

test('strict verification fails closed when sheet-driven plan source auth is unavailable', () => {
  const fixture = defaultCliFixture({ sheetPlan: true });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.match(json.errors.join('\n'), /sheet-plan verify/i);
});

test('strict verification fails closed when the claims ledger is missing', () => {
  const fixture = defaultCliFixture({ missingClaims: true });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.match(json.errors.join('\n'), /claims.*missing/i);
});

for (const status of ['quarantined', 'human_only', 'archived', 'published']) {
  test(`terminal controller status ${status} excludes the matching needs-human claim`, () => {
    const fixture = defaultCliFixture({
      claims: {
        'PG-A-001': {
          site: 'astrologywiki',
          status: 'needs_human',
          error: 'gate failed',
        },
      },
      queue: [{
        status,
        event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'run-1' },
      }],
    });
    const out = fixture.run();
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    const json = JSON.parse(out.stdout);
    assert.equal(json.eligibleNeedsHumanAfter, 0);
  });
}

test('migration_hold is not terminal eligibility and keeps needs-human fail closed', () => {
  const fixture = defaultCliFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'needs_human',
        error: 'migration pending',
      },
    },
    queue: [{
      status: 'migration_hold',
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'run-1' },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.eligibleNeedsHumanAfter, 1);
});

test('terminal status from another site cannot hide a needs-human claim', () => {
  const fixture = defaultCliFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'needs_human',
        error: 'gate failed',
      },
    },
    queue: [{
      status: 'quarantined',
      event: { site: 'gengrowth', pageId: 'PG-A-001', runId: 'run-1' },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.eligibleNeedsHumanAfter, 1);
});

test('corrupt terminal owner remains fail closed and cannot hide needs-human', () => {
  const fixture = defaultCliFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'needs_human',
        error: 'gate failed',
      },
    },
    queue: [{
      status: 'quarantined',
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'old-run' },
      latestEvent: { site: 'gengrowth', pageId: 'PG-SDS-004', runId: 'run-1' },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.eligibleNeedsHumanAfter, 1);
  assert.match(json.errors.join('\n'), /owner/i);
});
