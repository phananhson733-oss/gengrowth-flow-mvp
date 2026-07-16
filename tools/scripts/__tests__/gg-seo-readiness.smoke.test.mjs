import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const readinessUrl = pathToFileURL(resolve(flow, 'tools/scripts/gg-seo-readiness.mjs')).href;

function strictZero(overrides = {}) {
  return {
    ok: true,
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

function readinessFixture({
  plan = '- [x] `PG-A-001` alpha\n',
  claims = { 'PG-A-001': { site: 'astrologywiki', status: 'done' } },
  queue = [],
  strictResult = strictZero(),
  staleReport = [],
  contamination = [],
  missingClaims = false,
  now = '2026-07-16T11:00:00.000Z',
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-readiness-'));
  const state = join(root, 'state');
  const queueDir = join(state, 'seo-repair-queue');
  mkdirSync(queueDir, { recursive: true });
  const planPath = join(root, 'plan.md');
  const claimsPath = join(root, 'claims.json');
  writeFileSync(planPath, plan);
  if (!missingClaims) writeFileSync(claimsPath, `${JSON.stringify(claims, null, 2)}\n`);
  queue.forEach((record, index) => {
    writeFileSync(join(queueDir, `record-${index}.json`), `${JSON.stringify(record, null, 2)}\n`);
  });
  contamination.forEach((name) => {
    writeFileSync(join(state, `${name}.json`), `${JSON.stringify({ pageId: name })}\n`);
  });
  const source = `
    import { evaluateSeoReadiness } from ${JSON.stringify(readinessUrl)};
    const result = await evaluateSeoReadiness({
      site: 'astrologywiki',
      planPath: process.env.GG_TEST_PLAN,
      runId: 'run-1',
      deps: {
        stateDir: process.env.GG_TEST_STATE,
        claimsPath: process.env.GG_TEST_CLAIMS,
        queueDir: process.env.GG_TEST_QUEUE,
        strictResult: JSON.parse(process.env.GG_TEST_STRICT),
        staleReport: JSON.parse(process.env.GG_TEST_STALE),
        now: new Date(process.env.GG_TEST_NOW),
      },
    });
    process.stdout.write(JSON.stringify(result));
    if (!result.ok) process.exitCode = 2;
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', source], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      GG_FLOW_STATE_DIR: state,
      GG_TEST_PLAN: planPath,
      GG_TEST_STATE: state,
      GG_TEST_CLAIMS: claimsPath,
      GG_TEST_QUEUE: queueDir,
      GG_TEST_STRICT: JSON.stringify(strictResult),
      GG_TEST_STALE: JSON.stringify(staleReport),
      GG_TEST_NOW: now,
    },
  });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch {}
  return { status: result.status, json, stdout: result.stdout, stderr: result.stderr };
}

test('terminal scoped state is ready', () => {
  const out = readinessFixture();
  assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.ok, true);
  assert.deepEqual(out.json.testContamination, []);
});

test('unchecked plan item independently blocks readiness', () => {
  const out = readinessFixture({ plan: '- [ ] `PG-A-001` alpha\n' });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.planUncheckedAfter, 1);
});

test('active repair independently blocks readiness', () => {
  const out = readinessFixture({
    queue: [{
      status: 'repair_pending',
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'run-1' },
    }],
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.activeRepairAfter, 1);
});

test('active scoped claim independently blocks readiness even with a future lease', () => {
  const out = readinessFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'active',
        leaseUntil: '2026-07-16T12:00:00.000Z',
      },
    },
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.activeRepairAfter, 1);
});

test('expired lease independently blocks readiness', () => {
  const out = readinessFixture({
    queue: [{
      status: 'repairing',
      lease: { expiresAt: '2026-07-16T10:00:00.000Z' },
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'run-1' },
    }],
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.expiredLeasesAfter, 1);
});

test('eligible needs-human claim independently blocks readiness', () => {
  const out = readinessFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'needs_human',
        error: 'gate failed',
      },
    },
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.eligibleNeedsHumanAfter, 1);
});

test('stale report state independently blocks readiness', () => {
  const out = readinessFixture({
    staleReport: [{ pageId: 'PG-A-001', stale: true }],
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.staleReportAfter, 1);
});

test('production-shaped state containing PG-TEST-001 fails closed with explicit contamination', () => {
  const out = readinessFixture({ contamination: ['PG-TEST-001'] });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.deepEqual(out.json.testContamination, ['PG-TEST-001']);
});

test('strict verification drift is carried into readiness and blocks it', () => {
  const out = readinessFixture({
    strictResult: strictZero({ ok: false, sheetFlipsAfter: 2 }),
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.sheetFlipsAfter, 2);
});

test('conflicting latestEvent owner cannot hide an active repair from the selected site', () => {
  const out = readinessFixture({
    queue: [{
      status: 'repair_pending',
      event: { site: 'astrologywiki', pageId: 'PG-A-001', runId: 'old-run' },
      latestEvent: { site: 'gengrowth', pageId: 'PG-SDS-004', runId: 'run-1' },
    }],
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.match(out.json.errors.join('\n'), /owner/i);
});

test('missing claims ledger fails closed instead of becoming an empty ledger', () => {
  const out = readinessFixture({ missingClaims: true });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.match(out.json.errors.join('\n'), /claims.*missing/i);
});

test('active scoped claim with an invalid lease timestamp fails closed', () => {
  const out = readinessFixture({
    claims: {
      'PG-A-001': {
        site: 'astrologywiki',
        status: 'active',
        leaseUntil: 'not-a-date',
      },
    },
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.expiredLeasesAfter, 1);
  assert.match(out.json.errors.join('\n'), /lease/i);
});

for (const status of ['quarantined', 'human_only', 'archived', 'published']) {
  test(`terminal scoped controller status ${status} excludes matching needs-human eligibility`, () => {
    const out = readinessFixture({
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
        updatedAt: '2026-07-16T11:00:00.000Z',
      }],
    });
    assert.equal(out.status, 0, `${out.stdout}\n${out.stderr}`);
    assert.equal(out.json.eligibleNeedsHumanAfter, 0);
  });
}

test('migration_hold remains eligible needs-human and blocks readiness', () => {
  const out = readinessFixture({
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
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.eligibleNeedsHumanAfter, 1);
});

test('corrupt terminal owner cannot hide a matching needs-human claim', () => {
  const out = readinessFixture({
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
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.eligibleNeedsHumanAfter, 1);
  assert.match(out.json.errors.join('\n'), /owner/i);
});

test('terminal record older than a newer scoped claim failure cannot unblock readiness', () => {
  const out = readinessFixture({
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
      updatedAt: '2026-07-16T10:00:00.000Z',
    }],
  });
  assert.equal(out.status, 2, `${out.stdout}\n${out.stderr}`);
  assert.equal(out.json.eligibleNeedsHumanAfter, 1);
});
