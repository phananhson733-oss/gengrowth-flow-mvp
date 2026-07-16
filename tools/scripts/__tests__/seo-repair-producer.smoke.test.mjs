import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  eventFromClaim,
  persistRepairAndDrain,
} from '../lib/seo-repair-producer.mjs';
import {
  listRepairRecords,
} from '../lib/seo-repair-events.mjs';
import { drainRepairQueue } from '../lib/seo-repair-controller.mjs';

const FLOW = resolve(dirname(new URL(import.meta.url).pathname), '../../..');

function baseEvent(overrides = {}) {
  return {
    schemaVersion: 2,
    eventId: 'producer-e1',
    runId: 'run-producer-1',
    site: 'astrologywiki',
    lane: 'preview',
    pageId: 'PG-TEST-001',
    slug: 'test-article',
    stage: 'pushed-preview',
    errorKind: 'gate_fail',
    summary: 'schema review failed',
    stderr: 'review stderr',
    logFile: '/tmp/producer.log',
    logOffsetStart: 12,
    logOffsetEnd: 44,
    canonicalRetry: [
      'node',
      'tools/scripts/gg-seo-autopilot.mjs',
      '--retry-failed',
      '--branch',
      'seo/auto/test',
    ],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-producer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('event is durable before bounded drain starts and a drain crash cannot erase it', async (t) => {
  const queueDir = join(tempRoot(t), 'queue');
  const order = [];
  await assert.rejects(() => persistRepairAndDrain({
    event: baseEvent(),
    queueDir,
    enqueue: async (event, options) => {
      order.push('enqueue');
      const { enqueueRepairEvent } = await import('../lib/seo-repair-events.mjs');
      return enqueueRepairEvent(event, options);
    },
    drain: async () => {
      order.push('drain');
      throw new Error('simulated SIGTERM boundary');
    },
    strict: true,
  }), /simulated SIGTERM boundary/);

  assert.deepEqual(order, ['enqueue', 'drain']);
  const records = await listRepairRecords({ queueDir });
  assert.equal(records.length, 1);
  assert.equal(records[0].event.eventId, 'producer-e1');
});

test('strict producer fails closed when event persistence fails', async () => {
  let drainCalls = 0;
  await assert.rejects(() => persistRepairAndDrain({
    event: baseEvent(),
    queueDir: '/tmp/unused-producer-queue',
    enqueue: async () => { throw new Error('read-only state'); },
    drain: async () => { drainCalls += 1; },
    strict: true,
  }), /read-only state/);
  assert.equal(drainCalls, 0);
});

test('busy controller result is accepted after durable enqueue', async (t) => {
  const queueDir = join(tempRoot(t), 'queue');
  const result = await persistRepairAndDrain({
    event: baseEvent(),
    queueDir,
    drain: async () => ({ ok: true, busy: true }),
    strict: true,
  });
  assert.equal(result.durable, true);
  assert.equal(result.busy, true);
  assert.equal((await listRepairRecords({ queueDir })).length, 1);
});

test('eventFromClaim maps a parked claim into one bounded schema-v2 producer event', () => {
  const event = eventFromClaim({
    site: 'astrologywiki',
    runId: 'astrologywiki-fire-7',
    pageId: 'PG-TEST-007',
    claim: {
      status: 'needs_human',
      stage: 'pushed-preview',
      slug: 'preview-seven',
      branch: 'seo/auto/preview-seven',
      error: 'codex timed out after 600 seconds',
    },
    logFile: '/tmp/nightly.log',
    offsets: { start: 20, end: 60 },
    createdAt: '2026-07-16T10:00:00.000Z',
  });
  assert.equal(event.site, 'astrologywiki');
  assert.equal(event.runId, 'astrologywiki-fire-7');
  assert.equal(event.pageId, 'PG-TEST-007');
  assert.equal(event.lane, 'preview');
  assert.equal(event.errorKind, 'timeout');
  assert.equal(event.logOffsetStart, 20);
  assert.equal(event.logOffsetEnd, 60);
  assert.deepEqual(event.canonicalRetry, [
    'node',
    'tools/scripts/gg-seo-autopilot.mjs',
    '--retry-failed',
    '--branch',
    'seo/auto/preview-seven',
  ]);
});

test('eventFromClaim classifies authoring failures without matching auth inside authoring', () => {
  const cases = [
    { error: 'authoring: phase2 failed', expected: 'gate_fail' },
    { error: 'no row for PG-WLS-007 in workbook', expected: 'source' },
    { error: 'authoring timed out after 1200 seconds', expected: 'timeout' },
    { error: 'unauthorized: credential expired', expected: 'auth' },
    { error: 'authentication failed for provider', expected: 'auth' },
  ];
  for (const [index, fixture] of cases.entries()) {
    const event = eventFromClaim({
      site: 'gengrowth',
      runId: `gengrowth-author-classification-${index}`,
      pageId: 'PG-WLS-007',
      claim: {
        status: 'needs_human',
        stage: 'authoring',
        error: fixture.error,
      },
      logFile: '/tmp/no-log',
      offsets: { start: 0, end: 0 },
      createdAt: '2026-07-16T10:00:00.000Z',
    });
    assert.equal(event.errorKind, fixture.expected, fixture.error);
  }
});

test('a killed producer leaves work that a later drain consumes without rerunning the outer job', async (t) => {
  const root = tempRoot(t);
  const queueDir = join(root, 'queue');
  const outerCalls = join(root, 'outer-calls.log');
  const child = join(root, 'producer-child.mjs');
  const producerUrl = pathToFileURL(join(FLOW, 'tools/scripts/lib/seo-repair-producer.mjs')).href;
  writeFileSync(child, [
    `import { persistRepairAndDrain } from ${JSON.stringify(producerUrl)};`,
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.OUTER_CALLS, 'nightly\\n');",
    `const event = ${JSON.stringify(baseEvent({
      eventId: 'producer-kill-e1',
      runId: 'producer-kill-run',
      createdAt: new Date().toISOString(),
    }))};`,
    'await persistRepairAndDrain({',
    '  event,',
    '  queueDir: process.env.QUEUE_DIR,',
    "  drain: async () => { process.kill(process.pid, 'SIGTERM'); await new Promise(() => {}); },",
    '  strict: true,',
    '});',
    '',
  ].join('\n'));

  const status = await new Promise((resolveStatus) => {
    const childProcess = spawn(globalThis.process.execPath, [child], {
      env: { ...globalThis.process.env, QUEUE_DIR: queueDir, OUTER_CALLS: outerCalls },
      stdio: 'ignore',
    });
    childProcess.on('close', (code, signal) => resolveStatus({ code, signal }));
  });
  assert.equal(status.signal, 'SIGTERM');
  assert.equal(readFileSync(outerCalls, 'utf8'), 'nightly\n');
  assert.equal((await listRepairRecords({ queueDir })).length, 1);

  let adapterCalls = 0;
  const drained = await drainRepairQueue({
    queueDir,
    adapters: {
      astrologywiki: {
        execute: async () => {
          adapterCalls += 1;
          return { terminal: 'published', evidence: { production_200: true } };
        },
      },
    },
    notifyTerminal: async () => {},
    owner: 'later-controller',
    maxTargets: 1,
    budgetMs: 10_000,
    agingMs: 0,
  });
  assert.equal(drained.processed, 1);
  assert.equal(adapterCalls, 1);
  assert.equal(readFileSync(outerCalls, 'utf8'), 'nightly\n');
});
