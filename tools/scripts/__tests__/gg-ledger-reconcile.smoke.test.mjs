import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const reconcileUrl = pathToFileURL(resolve(flow, 'tools/scripts/gg-ledger-reconcile.mjs')).href;

function runStrictFixture(verification, { applyResult = {}, strict = true } = {}) {
  const source = `
    import { runLedgerReconcile } from ${JSON.stringify(reconcileUrl)};
    const verification = JSON.parse(process.env.GG_TEST_VERIFICATION);
    const applyResult = JSON.parse(process.env.GG_TEST_APPLY_RESULT);
    const phases = [];
    const result = await runLedgerReconcile({
      apply: true,
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

