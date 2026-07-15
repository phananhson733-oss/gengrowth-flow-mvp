import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireRepairLease,
  enqueueRepairEvent,
  listEligibleRepairEvents,
  normalizeRepairEvidence,
  readRepairRecord,
  recoverExpiredLeases,
  repairEventFingerprint,
  transitionRepairEvent,
  validateRepairEvent,
} from '../lib/seo-repair-events.mjs';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_C = '33333333-3333-4333-8333-333333333333';

function event(overrides = {}) {
  return {
    schemaVersion: 2,
    eventId: UUID_A,
    runId: 'gengrowth-publish-20260715T213000',
    site: 'gengrowth',
    lane: 'publish',
    pageId: 'PG-WLS-007',
    slug: 'chatgpt-seo',
    stage: 'fact_gate',
    errorKind: 'tool_exit',
    summary: 'codex exited 3',
    stderr: 'reviewer stderr tail',
    logFile: '/tmp/fact.log',
    logOffsetStart: 10,
    logOffsetEnd: 90,
    canonicalRetry: ['node', 'tools/scripts/gg-codex-pr-review.mjs', '--source', '/tmp/article.md'],
    createdAt: '2026-07-15T13:30:00.000Z',
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'seo-repair-events-'));
  const queueDir = join(root, 'queue');
  t.after(async () => rm(root, { recursive: true, force: true }));
  return { root, queueDir };
}

test('validates argv retry, bounds raw evidence, and redacts common secrets', () => {
  const raw = event({
    stderr: `token=secret-value\n${'x'.repeat(20_000)}`,
  });
  const valid = validateRepairEvent(raw);
  assert.deepEqual(valid.canonicalRetry.slice(0, 2), ['node', 'tools/scripts/gg-codex-pr-review.mjs']);
  assert.equal(valid.stderr.includes('secret-value'), false);
  assert.ok(valid.stderr.length <= 8_192);
  assert.throws(
    () => validateRepairEvent({ ...raw, canonicalRetry: 'node reviewer.mjs' }),
    /canonicalRetry must be an argv array/,
  );
  assert.throws(
    () => validateRepairEvent({ ...raw, site: 'unknown' }),
    /site must be astrologywiki or gengrowth/,
  );
});

test('normalizes runtime noise while preserving stable factual evidence', () => {
  const a = '2026-07-15 18:31 pid 123 /tmp/x https://preview-a.vercel.app SVG age 14';
  const b = '2026-07-15 18:32 pid 999 /tmp/y preview-b.vercel.app SVG age 14';
  assert.equal(normalizeRepairEvidence(a), normalizeRepairEvidence(b));
  assert.notEqual(
    repairEventFingerprint(event({ summary: a })),
    repairEventFingerprint(event({ summary: 'SVG age 29' })),
  );
});

test('same active fingerprint merges observations into one atomically visible record', async (t) => {
  const { queueDir } = await fixture(t);
  const first = await enqueueRepairEvent(event(), { queueDir });
  const second = await enqueueRepairEvent(event({
    eventId: UUID_B,
    createdAt: '2026-07-15T13:31:00.000Z',
    stderr: 'reviewer stderr tail',
  }), { queueDir });

  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.observations, 2);
  assert.equal(second.event.eventId, UUID_A);
  assert.equal(second.latestEvent.eventId, UUID_B);
  const names = await readdir(queueDir);
  assert.deepEqual(names.filter((name) => name.endsWith('.json')), [`${UUID_A}.json`]);
  assert.deepEqual(names.filter((name) => name.includes('.tmp-')), []);
  assert.equal(JSON.parse(await readFile(join(queueDir, `${UUID_A}.json`), 'utf8')).observations, 2);
});

test('changed failure fingerprint starts a child diagnosis generation with parent evidence', async (t) => {
  const { queueDir } = await fixture(t);
  const parent = await enqueueRepairEvent(event(), { queueDir });
  const child = await enqueueRepairEvent(event({
    eventId: UUID_B,
    errorKind: 'gate_fail',
    summary: 'reviewer now returns a real factual FAIL',
    stderr: 'unsupported source claim',
    createdAt: '2026-07-15T13:31:00.000Z',
  }), { queueDir });
  assert.notEqual(child.fingerprint, parent.fingerprint);
  assert.deepEqual(child.parentFingerprints, [parent.fingerprint]);
  assert.equal(child.history[0].evidence.parentFingerprint, parent.fingerprint);
});

test('priority ordering prefers later stages and aging prevents starvation', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event({
    eventId: UUID_A,
    site: 'astrologywiki',
    lane: 'author',
    pageId: 'PG-OLD-001',
    createdAt: '2026-07-15T10:00:00.000Z',
  }), { queueDir });
  await enqueueRepairEvent(event({
    eventId: UUID_B,
    pageId: 'PG-NEW-001',
    lane: 'backfill',
    stage: 'backfill',
    createdAt: '2026-07-15T13:59:00.000Z',
  }), { queueDir });

  const early = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:00:00.000Z'),
    agingMs: 60 * 60 * 1000,
  });
  assert.deepEqual(early.map((record) => record.event.pageId), ['PG-NEW-001', 'PG-OLD-001']);

  await enqueueRepairEvent(event({
    eventId: UUID_C,
    pageId: 'PG-FRESH-001',
    lane: 'backfill',
    stage: 'backfill',
    createdAt: '2026-08-01T13:59:00.000Z',
  }), { queueDir });

  const aged = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-08-01T14:00:00.000Z'),
    agingMs: 60 * 60 * 1000,
  });
  assert.deepEqual(aged.map((record) => record.event.pageId), [
    'PG-NEW-001',
    'PG-OLD-001',
    'PG-FRESH-001',
  ]);
});

test('lease acquisition is single-owner and expired leases recover to queued', async (t) => {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  const leased = await acquireRepairLease(queued, {
    queueDir,
    owner: 'controller-a',
    now: new Date('2026-07-15T14:00:00.000Z'),
    leaseMs: 60_000,
  });
  assert.equal(leased.status, 'repairing');
  assert.equal(leased.lease.owner, 'controller-a');
  assert.equal(await acquireRepairLease(queued, {
    queueDir,
    owner: 'controller-b',
    now: new Date('2026-07-15T14:00:30.000Z'),
    leaseMs: 60_000,
  }), null);

  assert.equal(await recoverExpiredLeases({
    queueDir,
    now: new Date('2026-07-15T14:01:01.000Z'),
  }), 1);
  const recovered = await readRepairRecord(join(queueDir, `${UUID_A}.json`));
  assert.equal(recovered.status, 'queued');
  assert.equal(recovered.lease, null);
});

test('transition records strategy evidence and terminal notification key', async (t) => {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  const leased = await acquireRepairLease(queued, {
    queueDir,
    owner: 'controller-a',
    now: new Date('2026-07-15T14:00:00.000Z'),
    leaseMs: 60_000,
  });
  const terminal = await transitionRepairEvent(leased, {
    status: 'published',
    evidence: { checks: { production_200: true } },
    terminalNotificationKey: `published:gengrowth:PG-WLS-007:${leased.fingerprint}`,
  }, {
    queueDir,
    now: new Date('2026-07-15T14:00:10.000Z'),
  });
  assert.equal(terminal.status, 'published');
  assert.equal(terminal.lease, null);
  assert.equal(terminal.history.at(-1).status, 'published');
  assert.match(terminal.terminalNotificationKey, /^published:gengrowth:PG-WLS-007:/);
});

test('corrupt records are quarantined instead of silently disappearing', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event(), { queueDir });
  await writeFile(join(queueDir, 'broken.json'), '{nope', 'utf8');
  const listed = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:00:00.000Z'),
  });
  assert.equal(listed.length, 1);
  assert.equal((await readdir(join(queueDir, 'quarantine'))).some((name) => name.startsWith('broken.json')), true);
});
