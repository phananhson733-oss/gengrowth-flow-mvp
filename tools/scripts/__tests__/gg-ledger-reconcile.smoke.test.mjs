import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLedgerReconcile } from '../gg-ledger-reconcile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const reconcileUrl = pathToFileURL(resolve(flow, 'tools/scripts/gg-ledger-reconcile.mjs')).href;

function writeNotificationSidecar(state, overrides = {}) {
  const dir = join(state, 'writeback-notifications', 'pending');
  mkdirSync(dir, { recursive: true });
  const record = {
    schemaVersion: 1,
    kind: 'writeback_terminal',
    notificationKey: 'writeback-terminal:PG-CELEB-055:2026-07-09T10:00:00.000Z:8',
    msgUuid: '6d99342b-f890-5ee1-b650-a9de0a64705a',
    createdAt: '2026-07-16T10:00:00.000Z',
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    fields: {
      pageId: 'PG-CELEB-055',
      stuckSteps: ['archive'],
      attempts: 8,
      firstAt: '2026-07-09T10:00:00.000Z',
      lastError: 'archive:vault unavailable',
      terminalAt: '2026-07-16T10:00:00.000Z',
      reason: 'max-attempts',
    },
    ...overrides,
  };
  const path = join(dir, 'notice.json');
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  return { dir, path, record };
}

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
        notify: async (event, fields) => { phases.push('notify'); phases.push({ event, fields }); },
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
    droppedWritebackAfter: 0,
    droppedWritebackEvidence: [],
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
  pendingWritebacks = [],
  droppedWritebacks = [],
  quarantinedWritebacks = [],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ledger-reconcile-default-'));
  const fakeFlow = join(root, 'flow');
  const scripts = join(fakeFlow, 'tools/scripts');
  const opsTasks = join(root, 'ops/inbox/06-tasks/tasks');
  const state = join(root, 'state');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(opsTasks, { recursive: true });
  const status = join(scripts, 'gg-reconcile-status.mjs');
  const autopilot = join(scripts, 'gg-seo-autopilot.mjs');
  writeFileSync(status, '#!/usr/bin/env node\nprocess.exit(0);\n');
  writeFileSync(autopilot, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(status, 0o755);
  chmodSync(autopilot, 0o755);
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
  if (pendingWritebacks.length > 0) {
    mkdirSync(join(state, 'pending-writeback'), { recursive: true });
    pendingWritebacks.forEach((record, index) => {
      writeFileSync(
        join(state, 'pending-writeback', `${record.pageId || `pending-${index}`}.json`),
        `${JSON.stringify(record)}\n`,
      );
    });
  }
  for (const [directory, records] of [
    ['dropped', droppedWritebacks],
    ['quarantined', quarantinedWritebacks],
  ]) {
    if (records.length === 0) continue;
    mkdirSync(join(state, 'pending-writeback', directory), { recursive: true });
    records.forEach((record, index) => {
      writeFileSync(
        join(state, 'pending-writeback', directory, `${record.pageId || `${directory}-${index}`}.json`),
        `${JSON.stringify(record)}\n`,
      );
    });
  }
  const run = ({ createState = true, dry = true } = {}) => {
    if (createState) mkdirSync(state, { recursive: true });
    return spawnSync('node', [
      resolve(flow, 'tools/scripts/gg-ledger-reconcile.mjs'),
      ...(dry ? ['--dry'] : []),
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
    'droppedWritebackAfter',
    'droppedWritebackEvidence',
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

test('a pending WAL retained after archive rename failure remains strict nonzero', () => {
  const fixture = defaultCliFixture({
    pendingWritebacks: [{
      pageId: 'PG-NODE-013',
      slug: 'node-013',
      site: 'astrologywiki',
      attempts: 8,
      firstAt: '2026-07-16T10:00:00.000Z',
      done: ['sheet', 'plan'],
      lastError: 'archive rename failed: simulated rename failure',
      terminalNotification: {
        pageId: 'PG-NODE-013',
        stuckSteps: ['archive'],
        attempts: 8,
        firstAt: '2026-07-16T10:00:00.000Z',
        lastError: 'archive:disk unavailable',
      },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.pendingWritebackAfter, 1);
  assert.equal(json.droppedWritebackAfter, 0);
});

test('dropped writeback independently blocks strict convergence with structured evidence', () => {
  const evidence = [{
    pageId: 'PG-CELEB-055',
    state: 'dropped',
    stuckSteps: ['archive'],
    attempts: 8,
    firstAt: '2026-07-09T10:00:00.000Z',
    lastError: 'archive:vault unavailable',
  }];
  const out = runStrictFixture(zero({
    droppedWritebackAfter: 1,
    droppedWritebackEvidence: evidence,
  }));
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.result.droppedWritebackAfter, 1);
  assert.deepEqual(out.json.result.droppedWritebackEvidence, evidence);
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

test('new terminal writeback emits one complete deduplicated notification', () => {
  const terminal = {
    pageId: 'PG-CELEB-055',
    stuckSteps: ['archive'],
    attempts: 8,
    firstAt: '2026-07-09T10:00:00.000Z',
    lastError: 'archive:vault unavailable',
    terminalAt: '2026-07-16T10:00:00.000Z',
    reason: 'max-attempts',
    notificationKey: 'writeback-terminal:PG-CELEB-055:2026-07-09T10:00:00.000Z:8',
  };
  const out = runStrictFixture(zero({
    droppedWritebackAfter: 1,
    droppedWritebackEvidence: [{ ...terminal, state: 'dropped' }],
  }), {
    applyResult: {
      terminalNotifications: [
        terminal,
        { ...terminal, lastError: 'duplicate delivery must be coalesced' },
      ],
    },
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.phases[0], 'apply');
  assert.equal(out.json.phases[1], 'verify');
  assert.equal(out.json.phases[2], 'notify');
  assert.equal(out.json.phases.filter((phase) => phase === 'notify').length, 1);
  const sent = out.json.phases[3];
  assert.equal(sent.event, 'batch_summary');
  assert.equal(sent.fields.partial, true);
  assert.match(sent.fields.text, /PG-CELEB-055/);
  assert.match(sent.fields.text, /archive/);
  assert.match(sent.fields.text, /attempts=8/);
  assert.match(sent.fields.text, /firstAt=2026-07-09T10:00:00.000Z/);
  assert.match(sent.fields.text, /archive:vault unavailable/);
  assert.match(sent.fields.msgUuid, /^[0-9a-f-]{36}$/);
});

test('silent strict terminal failure keeps durable notification; next unsilenced tick sends exactly once', async () => {
  const state = mkdtempSync(join(tmpdir(), 'writeback-notify-silent-'));
  const sidecar = writeNotificationSidecar(state);
  const previousState = process.env.GG_FLOW_STATE_DIR;
  const previousSilence = process.env.GG_LARK_NOTIFY_SILENCE;
  process.env.GG_FLOW_STATE_DIR = state;
  process.env.GG_LARK_NOTIFY_SILENCE = '1';
  let calls = 0;
  const deps = {
    apply: async () => ({ errors: [], summary: [] }),
    verify: async () => zero({
      droppedWritebackAfter: 1,
      droppedWritebackEvidence: [{
        ...sidecar.record.fields,
        state: 'dropped',
        notificationKey: sidecar.record.notificationKey,
      }],
    }),
    notify: async () => {
      calls += 1;
      return { ok: true, silenced: false, messageId: 'm1' };
    },
    log: () => {},
  };
  try {
    const silent = await runLedgerReconcile({ apply: true, strict: true, deps });
    assert.equal(silent.ok, false, 'strict rc2 equivalent must not erase the notification');
    assert.equal(calls, 0);
    assert.equal(readdirSync(sidecar.dir).filter((name) => name.endsWith('.json')).length, 1);

    delete process.env.GG_LARK_NOTIFY_SILENCE;
    await runLedgerReconcile({ apply: true, strict: true, deps });
    assert.equal(calls, 1);
    assert.equal(readdirSync(sidecar.dir).filter((name) => name.endsWith('.json')).length, 0);
    const sentDir = join(state, 'writeback-notifications', 'sent');
    assert.equal(readdirSync(sentDir).filter((name) => name.endsWith('.json')).length, 1);

    await runLedgerReconcile({ apply: true, strict: true, deps });
    assert.equal(calls, 1, 'sent sidecar must not be replayed');
  } finally {
    if (previousState === undefined) delete process.env.GG_FLOW_STATE_DIR;
    else process.env.GG_FLOW_STATE_DIR = previousState;
    if (previousSilence === undefined) delete process.env.GG_LARK_NOTIFY_SILENCE;
    else process.env.GG_LARK_NOTIFY_SILENCE = previousSilence;
  }
});

test('terminal notification send failure remains pending and retries with the same msgUuid', async () => {
  const state = mkdtempSync(join(tmpdir(), 'writeback-notify-retry-'));
  const sidecar = writeNotificationSidecar(state);
  const previousState = process.env.GG_FLOW_STATE_DIR;
  const previousSilence = process.env.GG_LARK_NOTIFY_SILENCE;
  process.env.GG_FLOW_STATE_DIR = state;
  delete process.env.GG_LARK_NOTIFY_SILENCE;
  const uuids = [];
  let fail = true;
  const deps = {
    apply: async () => ({ errors: [], summary: [] }),
    verify: async () => zero({
      droppedWritebackAfter: 1,
      droppedWritebackEvidence: [{
        ...sidecar.record.fields,
        state: 'dropped',
        notificationKey: sidecar.record.notificationKey,
      }],
    }),
    notify: async (_event, fields) => {
      uuids.push(fields.msgUuid);
      if (fail) return { ok: false, silenced: false, error: 'network-down' };
      return { ok: true, silenced: false, messageId: 'm2' };
    },
    log: () => {},
  };
  try {
    await runLedgerReconcile({ apply: true, strict: true, deps });
    const failed = JSON.parse(readFileSync(sidecar.path, 'utf8'));
    assert.equal(failed.attempts, 1);
    assert.equal(failed.lastError, 'network-down');
    fail = false;
    await runLedgerReconcile({ apply: true, strict: true, deps });
    assert.deepEqual(uuids, [sidecar.record.msgUuid, sidecar.record.msgUuid]);
    assert.equal(existsSync(sidecar.path), false);
    await runLedgerReconcile({ apply: true, strict: true, deps });
    assert.equal(uuids.length, 2);
  } finally {
    if (previousState === undefined) delete process.env.GG_FLOW_STATE_DIR;
    else process.env.GG_FLOW_STATE_DIR = previousState;
    if (previousSilence === undefined) delete process.env.GG_LARK_NOTIFY_SILENCE;
    else process.env.GG_LARK_NOTIFY_SILENCE = previousSilence;
  }
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

test('production-shaped dropped/quarantined directories remain visible to strict verification', () => {
  const fixture = defaultCliFixture({
    claims: {},
    droppedWritebacks: [{
      pageId: 'PG-CELEB-055',
      attempts: 8,
      firstAt: '2026-07-09T10:00:00.000Z',
      done: ['sheet', 'plan'],
      lastError: 'archive:vault unavailable',
    }],
    quarantinedWritebacks: [{
      pageId: 'PG-CELEB-056',
      attempts: 8,
      firstAt: '2026-07-10T10:00:00.000Z',
      done: [],
      lastError: 'sheet:no-token',
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.droppedWritebackAfter, 2);
  assert.deepEqual(
    json.droppedWritebackEvidence.map((row) => [row.pageId, row.state]),
    [
      ['PG-CELEB-055', 'dropped'],
      ['PG-CELEB-056', 'quarantined'],
    ],
  );
});

test('strict apply quarantines PG-TEST WAL before any real backfill and remains nonzero', () => {
  const fixture = defaultCliFixture({
    claims: {},
    pendingWritebacks: [{
      pageId: 'PG-TEST-001',
      slug: 'test-001',
      site: 'astrologywiki',
      firstAt: '2026-07-16T10:00:00.000Z',
      attempts: 0,
      done: [],
    }],
  });
  const out = fixture.run({ dry: false });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.pendingWritebackAfter, 0);
  assert.equal(json.droppedWritebackAfter, 1);
  assert.equal(
    existsSync(join(fixture.state, 'pending-writeback', 'quarantined', 'PG-TEST-001.json')),
    true,
  );
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
          failedAt: '2026-07-16T10:00:00.000Z',
        },
      },
      queue: [{
        status,
        event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'run-1' },
        ...(status === 'published'
          ? {
            updatedAt: '2026-07-16T09:00:00.000Z',
            latestEvent: {
              site: 'astrologywiki',
              pageId: 'PG-A-001',
              runId: 'run-1',
              createdAt: '2026-07-16T11:00:00.000Z',
            },
          }
          : { updatedAt: '2026-07-16T11:00:00.000Z' }),
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

test('terminal record older than a newer claim failure cannot hide needs-human', () => {
  const fixture = defaultCliFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'needs_human',
        error: 'new gate failed',
        failedAt: '2026-07-16T11:00:00.000Z',
      },
    },
    queue: [{
      status: 'published',
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'old-run' },
      updatedAt: '2026-07-16T12:00:00.000Z',
      latestEvent: {
        site: 'astrologywiki',
        pageId: 'PG-A-001',
        runId: 'old-run',
        createdAt: '2026-07-16T10:00:00.000Z',
      },
    }],
  });
  const out = fixture.run();
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  const json = JSON.parse(out.stdout);
  assert.equal(json.eligibleNeedsHumanAfter, 1);
});
