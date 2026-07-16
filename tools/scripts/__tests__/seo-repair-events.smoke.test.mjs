import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  acquireRepairLease,
  compactRepairIncident,
  enqueueRepairEvent,
  isActiveRepairStatus,
  listEligibleRepairEvents,
  listRepairRecords,
  normalizeRepairEvidence,
  readRepairRecord,
  recoverExpiredLeases,
  repairIncidentId,
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

test('incident identity is stable for pages and lane-scoped for run failures', () => {
  assert.equal(
    repairIncidentId(event({ stage: 'authoring', lane: 'author' })),
    repairIncidentId(event({ stage: 'backfill', lane: 'backfill' })),
  );
  assert.notEqual(
    repairIncidentId(event({ pageId: 'RUN', lane: 'author' })),
    repairIncidentId(event({ pageId: 'RUN', lane: 'publish' })),
  );
});

test('growing cumulative stderr remains one active incident', async (t) => {
  const { queueDir } = await fixture(t);
  const first = event({ eventId: 'e1', stderr: 'authoring failed\n' });
  const second = event({
    eventId: 'e2',
    stderr: 'authoring failed\nnew unrelated tick output\n',
    createdAt: '2026-07-15T13:31:00.000Z',
  });
  assert.equal(repairEventFingerprint(first), repairEventFingerprint(second));
  await enqueueRepairEvent(first, { queueDir });
  await enqueueRepairEvent(second, { queueDir });
  const active = (await listRepairRecords({ queueDir })).filter((record) => isActiveRepairStatus(record.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].observations, 2);
  assert.deepEqual(active[0].sourceEventIds.sort(), ['e1', 'e2']);
});

test('concurrent producers create one active incident head', async (t) => {
  const { queueDir } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => enqueueRepairEvent(
    event({
      eventId: `e${index}`,
      createdAt: new Date(Date.UTC(2026, 6, 16, 4, 0, index)).toISOString(),
    }),
    { queueDir },
  )));
  const active = (await listRepairRecords({ queueDir })).filter((record) => isActiveRepairStatus(record.status));
  assert.equal(active.length, 1);
  assert.equal(active[0].observations, 8);
});

test('an abandoned incident lock without owner metadata is recovered after its grace period', async (t) => {
  const { queueDir } = await fixture(t);
  const lockDir = join(queueDir, '.incident-locks', repairIncidentId(event()));
  await mkdir(lockDir, { recursive: true });
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockDir, stale, stale);
  const queued = await enqueueRepairEvent(event(), { queueDir });
  assert.equal(queued.status, 'queued');
});

test('an expired incident lock owned by a live pid is not reclaimed', async (t) => {
  const { queueDir } = await fixture(t);
  const incidentId = repairIncidentId(event());
  const lockDir = join(queueDir, '.incident-locks', incidentId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({
    pid: process.pid,
    token: 'live-owner',
    incidentId,
    acquiredAt: '2026-07-15T12:00:00.000Z',
    expiresAt: '2026-07-15T12:00:01.000Z',
  })}\n`, 'utf8');
  let observedLiveOwner = 0;

  const queued = await enqueueRepairEvent(event(), {
    queueDir,
    async faultInjector(point) {
      if (point !== 'live-lock-observed') return;
      observedLiveOwner += 1;
      await rm(lockDir, { recursive: true, force: true });
    },
  });

  assert.equal(observedLiveOwner, 1);
  assert.equal(queued.status, 'queued');
});

test('an incident lock owned by a dead pid is recovered', async (t) => {
  const { queueDir } = await fixture(t);
  const incidentId = repairIncidentId(event());
  const lockDir = join(queueDir, '.incident-locks', incidentId);
  await mkdir(lockDir, { recursive: true });
  await writeFile(join(lockDir, 'owner.json'), `${JSON.stringify({
    pid: 2_147_483_647,
    token: 'dead-owner',
    incidentId,
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  })}\n`, 'utf8');

  const queued = await enqueueRepairEvent(event(), { queueDir });
  assert.equal(queued.status, 'queued');
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

test('changed stable error supersedes the previous generation and preserves budget', async (t) => {
  const { queueDir } = await fixture(t);
  const old = await enqueueRepairEvent(event({ eventId: 'old', summary: 'missing draft' }), { queueDir });
  await transitionRepairEvent(old, {
    status: 'repair_pending',
    totalAttempts: 2,
    agentMutationAttempts: 1,
  }, { queueDir });
  const next = await enqueueRepairEvent(event({
    eventId: UUID_B,
    summary: 'fact gate failed',
    createdAt: '2026-07-15T13:31:00.000Z',
  }), { queueDir });
  const records = await listRepairRecords({ queueDir });
  assert.equal(records.find((record) => record.event.eventId === 'old').status, 'superseded');
  assert.equal(next.generation, 2);
  assert.equal(next.totalAttempts, 2);
  assert.equal(next.agentMutationAttempts, 1);
  assert.equal(next.parentGenerationId, 'old');
  assert.equal(records.filter((record) => isActiveRepairStatus(record.status)).length, 1);
});

test('stale transition cannot revive a superseded generation', async (t) => {
  const { queueDir } = await fixture(t);
  const old = await enqueueRepairEvent(event({
    eventId: 'stale-old',
    summary: 'missing draft',
  }), { queueDir });
  const leasedOld = await acquireRepairLease(old, {
    queueDir,
    owner: 'controller-old',
    now: new Date('2026-07-15T14:00:00.000Z'),
  });
  const head = await enqueueRepairEvent(event({
    eventId: 'fresh-head',
    summary: 'fact gate failed',
    createdAt: '2026-07-15T14:00:10.000Z',
  }), { queueDir });

  await assert.rejects(
    transitionRepairEvent(leasedOld, {
      status: 'repair_pending',
      evidence: { staleWriter: true },
    }, {
      queueDir,
      now: new Date('2026-07-15T14:00:20.000Z'),
    }),
    /stale|authoritative|superseded/i,
  );

  const records = await listRepairRecords({ queueDir });
  const eligible = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:00:30.000Z'),
  });
  assert.equal(records.find((record) => record.event.eventId === 'stale-old').status, 'superseded');
  assert.deepEqual(eligible.map((record) => record.event.eventId), [head.event.eventId]);
});

test('leased transition preserves same-generation observations added during repair', async (t) => {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event({ eventId: 'leased-observation-a' }), { queueDir });
  const leased = await acquireRepairLease(queued, {
    queueDir,
    owner: 'controller-a',
    now: new Date('2026-07-15T14:00:00.000Z'),
  });
  await enqueueRepairEvent(event({
    eventId: 'leased-observation-b',
    createdAt: '2026-07-15T14:00:10.000Z',
  }), { queueDir });

  const pending = await transitionRepairEvent(leased, {
    status: 'repair_pending',
    evidence: { retryFailed: true },
  }, {
    queueDir,
    now: new Date('2026-07-15T14:00:20.000Z'),
  });

  assert.equal(pending.observations, 2);
  assert.deepEqual(pending.sourceEventIds.sort(), ['leased-observation-a', 'leased-observation-b']);
  assert.equal(pending.status, 'repair_pending');
});

test('replaying an eventId is idempotent and rejects identity collisions', async (t) => {
  const { queueDir } = await fixture(t);
  const original = event({ eventId: 'event-replay' });
  const first = await enqueueRepairEvent(original, { queueDir });
  const replay = await enqueueRepairEvent(original, { queueDir });

  assert.equal(replay.observations, first.observations);
  assert.deepEqual(replay.sourceEventIds, first.sourceEventIds);
  assert.deepEqual(replay.sourceEvents, first.sourceEvents);
  assert.deepEqual(replay.history, first.history);

  await assert.rejects(
    enqueueRepairEvent(event({
      eventId: 'event-replay',
      stderr: 'different raw evidence',
    }), { queueDir }),
    /eventId.*collision|identity collision/i,
  );
});

test('enqueue recovers a durable generation transaction after an injected crash', async (t) => {
  const { queueDir } = await fixture(t);
  const old = await enqueueRepairEvent(event({
    eventId: 'transaction-old',
    summary: 'missing draft',
  }), { queueDir });
  await transitionRepairEvent(old, {
    status: 'repair_pending',
    totalAttempts: 2,
    agentMutationAttempts: 1,
  }, { queueDir });
  const changed = event({
    eventId: 'transaction-new',
    summary: 'fact gate failed',
    createdAt: '2026-07-15T14:01:00.000Z',
  });

  await assert.rejects(
    enqueueRepairEvent(changed, {
      queueDir,
      faultInjector(point) {
        if (point === 'after-supersede-before-head-write') {
          throw new Error('injected transaction crash');
        }
      },
    }),
    /injected transaction crash/,
  );

  const recovered = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].event.eventId, changed.eventId);
  assert.equal(recovered[0].generation, 2);
  assert.equal(recovered[0].totalAttempts, 2);
  assert.equal(recovered[0].agentMutationAttempts, 1);
  assert.equal(recovered[0].parentGenerationId, old.event.eventId);
  assert.deepEqual(recovered[0].sourceEventIds, [changed.eventId]);
  assert.deepEqual(recovered[0].sourceEvents, [validateRepairEvent(changed)]);
});

test('stale acquire is fenced when a producer installs a newer generation first', async (t) => {
  const { queueDir } = await fixture(t);
  const old = await enqueueRepairEvent(event({
    eventId: 'acquire-old',
    summary: 'missing draft',
  }), { queueDir });
  const changed = event({
    eventId: 'acquire-new',
    summary: 'fact gate failed',
    createdAt: '2026-07-15T14:01:00.000Z',
  });
  let producerHead = null;

  const leased = await acquireRepairLease(old, {
    queueDir,
    owner: 'stale-controller',
    async faultInjector(point) {
      if (point === 'before-incident-lock') {
        producerHead = await enqueueRepairEvent(changed, { queueDir });
      }
    },
  });

  assert.equal(leased, null);
  const eligible = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.deepEqual(eligible.map((record) => record.event.eventId), [producerHead.event.eventId]);
});

test('compaction is append-only, preserves source evidence, and is idempotent', async (t) => {
  const { queueDir } = await fixture(t);
  const source = await enqueueRepairEvent(event({ eventId: 'source-a' }), { queueDir });
  await transitionRepairEvent(source, {
    status: 'repair_pending',
    strategyAttempts: { deterministic_retry: 2 },
    totalAttempts: 2,
  }, { queueDir });
  const legacy = {
    ...source,
    event: event({ eventId: 'source-b', createdAt: '2026-07-15T13:31:00.000Z' }),
    latestEvent: event({ eventId: 'source-b', createdAt: '2026-07-15T13:31:00.000Z' }),
    fingerprint: 'legacy-fingerprint',
    status: 'repair_pending',
    observations: 1,
    strategyAttempts: { deterministic_retry: 1, agent_content_asset_link: 2 },
    totalAttempts: 3,
    sourceEventIds: ['source-b'],
    history: [{ status: 'queued', at: '2026-07-15T13:31:00.000Z', evidence: { eventId: 'source-b' } }],
  };
  await writeFile(join(queueDir, 'source-b.json'), `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const first = await compactRepairIncident({
    queueDir,
    site: 'gengrowth',
    pageId: 'PG-WLS-007',
    hold: 'migration-review',
    verificationCredit: 1,
  });
  assert.equal(first.status, 'migration_hold');
  assert.deepEqual(first.strategyAttempts, { deterministic_retry: 3, agent_content_asset_link: 2 });
  assert.deepEqual(first.sourceEventIds.sort(), ['source-a', 'source-b']);
  assert.deepEqual(first.sourceFingerprints.sort(), [source.fingerprint, 'legacy-fingerprint'].sort());
  assert.equal(first.sourceHistories.length, 2);
  assert.equal(first.hold, 'migration-review');
  assert.equal(first.verificationCredit, 1);

  const again = await compactRepairIncident({
    queueDir,
    site: 'gengrowth',
    pageId: 'PG-WLS-007',
    hold: 'migration-review',
    verificationCredit: 1,
  });
  assert.deepEqual(again, first);
  const records = await listRepairRecords({ queueDir });
  assert.equal(records.filter((record) => record.status === 'migration_hold').length, 1);
  assert.equal(records.filter((record) => record.status === 'superseded').length, 2);
  assert.equal(records.every((record) => record.status !== 'superseded' || record.supersededBy === first.event.eventId), true);
});

test('eligible reads finish a compact transaction after canonical write crash', async (t) => {
  const { queueDir } = await fixture(t);
  await enqueueRepairEvent(event({ eventId: 'compact-crash-source' }), { queueDir });

  await assert.rejects(
    compactRepairIncident({
      queueDir,
      site: 'gengrowth',
      pageId: 'PG-WLS-007',
      hold: 'migration-review',
      verificationCredit: 1,
      faultInjector(point) {
        if (point === 'after-canonical-before-source-supersede') {
          throw new Error('injected compact crash');
        }
      },
    }),
    /injected compact crash/,
  );

  const eligible = await listEligibleRepairEvents({
    queueDir,
    now: new Date('2026-07-15T14:02:00.000Z'),
  });
  assert.deepEqual(eligible, []);
  const records = await listRepairRecords({ queueDir });
  assert.equal(records.filter((record) => record.status === 'migration_hold').length, 1);
  assert.equal(records.find((record) => record.event.eventId === 'compact-crash-source').status, 'superseded');
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

function legacyPreparedIntent({ transactionId, incidentId, writes, operation = 'replace_generation' }) {
  return {
    schemaVersion: 1,
    transactionId,
    incidentId,
    operation,
    phase: 'prepared',
    createdAt: '2026-07-15T14:03:00.000Z',
    writes,
  };
}

async function writeLegacyTransaction(queueDir, filename, intent) {
  const directory = join(queueDir, '.incident-transactions');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
}

function transactionHead(record) {
  return {
    eventId: record.event.eventId,
    generation: Number(record.generation || 1),
    revision: Number(record.revision || 0),
    fingerprint: record.fingerprint,
  };
}

function preparedIntentV2({
  transactionId,
  incidentId,
  causalRevision,
  expectedHead,
  resultHead,
  writes,
  operation = 'replace_generation',
}) {
  return {
    schemaVersion: 2,
    transactionId,
    incidentId,
    causalRevision,
    operation,
    phase: 'prepared',
    createdAt: '2026-07-15T14:03:00.000Z',
    expectedHead,
    resultHead,
    writes,
  };
}

test('prepared transaction recovery quarantines a path traversal without writing outside the queue', async (t) => {
  const { root, queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event({ eventId: 'path-owner' }), { queueDir });
  const incidentId = repairIncidentId(queued.event);
  const transactionId = `${incidentId}-path-traversal`;
  await writeLegacyTransaction(queueDir, `${transactionId}.json`, legacyPreparedIntent({
    transactionId,
    incidentId,
    writes: [{
      filename: '../escaped.json',
      record: queued,
    }],
  }));

  await listRepairRecords({ queueDir });

  await assert.rejects(readFile(join(root, 'escaped.json'), 'utf8'), /ENOENT/);
  const quarantine = await readdir(join(queueDir, '.incident-transactions', 'quarantine'));
  const holds = await readdir(join(queueDir, '.incident-transactions', 'holds'));
  assert.equal(quarantine.some((name) => name.includes('path-traversal')), true);
  assert.equal(holds.length, 1);
});

test('corrupt prepared transaction is quarantined once, holds its inferred incident, and leaves other work operable', async (t) => {
  const { queueDir } = await fixture(t);
  const affected = await enqueueRepairEvent(event({
    eventId: 'corrupt-owner',
    pageId: 'PG-CORRUPT-001',
  }), { queueDir });
  const unaffected = await enqueueRepairEvent(event({
    eventId: 'unaffected-owner',
    pageId: 'PG-HEALTHY-001',
  }), { queueDir });
  const affectedIncidentId = repairIncidentId(affected.event);
  const transactionDirectory = join(queueDir, '.incident-transactions');
  await mkdir(transactionDirectory, { recursive: true });
  await writeFile(join(transactionDirectory, `${affectedIncidentId}-corrupt.json`), '{broken', 'utf8');

  const first = await listEligibleRepairEvents({ queueDir });
  const second = await listEligibleRepairEvents({ queueDir });

  assert.deepEqual(first.map((record) => record.event.eventId), [unaffected.event.eventId]);
  assert.deepEqual(second.map((record) => record.event.eventId), [unaffected.event.eventId]);
  const quarantined = await readdir(join(transactionDirectory, 'quarantine'));
  const holds = await readdir(join(transactionDirectory, 'holds'));
  assert.equal(quarantined.length, 1);
  assert.equal(holds.length, 1);
  assert.match(await readFile(join(transactionDirectory, 'holds', holds[0]), 'utf8'), /corrupt transaction intent/i);
});

test('an intent locked to one incident cannot overwrite a record owned by another incident', async (t) => {
  const { queueDir } = await fixture(t);
  const owner = await enqueueRepairEvent(event({
    eventId: 'incident-a-owner',
    pageId: 'PG-INCIDENT-A',
  }), { queueDir });
  const victim = await enqueueRepairEvent(event({
    eventId: 'incident-b-victim',
    pageId: 'PG-INCIDENT-B',
  }), { queueDir });
  const incidentId = repairIncidentId(owner.event);
  const transactionId = `${incidentId}-cross-incident`;
  const overwritten = {
    ...victim,
    status: 'superseded',
    revision: Number(victim.revision) + 1,
    supersededBy: owner.event.eventId,
    updatedAt: '2026-07-15T14:03:00.000Z',
  };
  await writeLegacyTransaction(queueDir, `${transactionId}.json`, preparedIntentV2({
    transactionId,
    incidentId,
    causalRevision: 1,
    expectedHead: transactionHead(owner),
    resultHead: transactionHead(owner),
    writes: [{
      filename: `${victim.event.eventId}.json`,
      expectedRevision: victim.revision,
      record: overwritten,
    }],
  }));

  await listRepairRecords({ queueDir });

  assert.deepEqual(await readRepairRecord(join(queueDir, `${victim.event.eventId}.json`)), victim);
  const quarantine = await readdir(join(queueDir, '.incident-transactions', 'quarantine'));
  assert.equal(quarantine.some((name) => name.includes('cross-incident')), true);
});

test('committed transaction history is archived outside the hot scan and ordinary reads never parse the archive', async (t) => {
  const { queueDir } = await fixture(t);
  const queued = await enqueueRepairEvent(event({ eventId: 'archive-owner' }), { queueDir });
  const incidentId = repairIncidentId(queued.event);
  const transactionId = `${incidentId}-committed`;
  await writeLegacyTransaction(queueDir, `${transactionId}.json`, {
    ...legacyPreparedIntent({ transactionId, incidentId, writes: [] }),
    phase: 'committed',
    committedAt: '2026-07-15T14:04:00.000Z',
  });
  const instrumentation = { pendingReads: 0, committedReads: 0 };

  await listRepairRecords({ queueDir, transactionInstrumentation: instrumentation });
  assert.equal(instrumentation.pendingReads, 1);
  assert.equal(instrumentation.committedReads, 0);
  const committedDirectory = join(queueDir, '.incident-transactions', 'committed');
  assert.equal((await readdir(committedDirectory)).length, 1);
  assert.equal((await readdir(join(queueDir, '.incident-transactions'))).some((name) => name.endsWith('.json')), false);
  await Promise.all(Array.from({ length: 452 }, (_, index) => writeFile(
    join(committedDirectory, `historical-${String(index).padStart(3, '0')}.json`),
    '{deliberately-not-a-hot-intent',
    'utf8',
  )));

  instrumentation.pendingReads = 0;
  instrumentation.committedReads = 0;
  await listRepairRecords({ queueDir, transactionInstrumentation: instrumentation });
  assert.deepEqual(instrumentation, { pendingReads: 0, committedReads: 0 });
});

test('an older random-filename intent cannot overwrite a newer committed causal revision', async (t) => {
  const { queueDir } = await fixture(t);
  const original = await enqueueRepairEvent(event({
    eventId: 'causal-original',
    summary: 'old failure',
  }), { queueDir });
  const head = await enqueueRepairEvent(event({
    eventId: 'causal-new-head',
    summary: 'new failure',
    createdAt: '2026-07-15T14:05:00.000Z',
  }), { queueDir });
  const incidentId = repairIncidentId(original.event);
  const transactionDirectory = join(queueDir, '.incident-transactions');
  const committedOriginal = await readRepairRecord(join(queueDir, `${original.event.eventId}.json`));
  const committedTransactionId = `${incidentId}-newer-committed`;
  await writeFile(join(transactionDirectory, `${committedTransactionId}.json`), `${JSON.stringify({
    ...preparedIntentV2({
      transactionId: committedTransactionId,
      incidentId,
      causalRevision: 2,
      expectedHead: transactionHead(original),
      resultHead: transactionHead(head),
      writes: [
        {
          filename: `${original.event.eventId}.json`,
          expectedRevision: original.revision,
          record: committedOriginal,
        },
        {
          filename: `${head.event.eventId}.json`,
          expectedRevision: 0,
          record: head,
        },
      ],
    }),
    phase: 'committed',
    committedAt: '2026-07-15T14:05:01.000Z',
  }, null, 2)}\n`, 'utf8');

  const staleHeadEvent = event({
    eventId: 'causal-stale-head',
    summary: 'stale failure',
    createdAt: '2026-07-15T14:04:00.000Z',
  });
  const staleHead = {
    ...original,
    event: staleHeadEvent,
    latestEvent: staleHeadEvent,
    fingerprint: repairEventFingerprint(staleHeadEvent),
    generation: 2,
    revision: 1,
    parentGenerationId: original.event.eventId,
    updatedAt: staleHeadEvent.createdAt,
  };
  const staleSource = {
    ...original,
    status: 'superseded',
    revision: Number(original.revision) + 1,
    supersededBy: staleHead.event.eventId,
    updatedAt: staleHead.event.createdAt,
  };
  const staleTransactionId = `${incidentId}-zzzz-older`;
  await writeLegacyTransaction(queueDir, `${staleTransactionId}.json`, preparedIntentV2({
    transactionId: staleTransactionId,
    incidentId,
    causalRevision: 1,
    expectedHead: transactionHead(original),
    resultHead: transactionHead(staleHead),
    writes: [
      {
        filename: `${original.event.eventId}.json`,
        expectedRevision: original.revision,
        record: staleSource,
      },
      {
        filename: `${staleHead.event.eventId}.json`,
        expectedRevision: 0,
        record: staleHead,
      },
    ],
  }));

  const records = await listRepairRecords({ queueDir });

  assert.equal(records.find((record) => record.event.eventId === head.event.eventId).status, 'queued');
  assert.equal(records.some((record) => record.event.eventId === staleHead.event.eventId), false);
  assert.equal((await readdir(join(transactionDirectory, 'quarantine')))
    .some((name) => name.includes('zzzz-older')), true);
});
