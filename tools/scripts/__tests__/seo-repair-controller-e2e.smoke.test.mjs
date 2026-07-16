import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = 'tools/scripts/gg-seo-repair-controller.mjs';

function event(overrides = {}) {
  return {
    schemaVersion: 2,
    eventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    runId: 'run-20260715',
    site: 'gengrowth',
    lane: 'publish',
    pageId: 'PG-WLS-007',
    slug: 'chatgpt-seo',
    stage: 'fact_gate',
    errorKind: 'tool_exit',
    summary: 'codex exited 3',
    stderr: 'reviewer stderr',
    logFile: '/tmp/fact.log',
    logOffsetStart: 0,
    logOffsetEnd: 100,
    canonicalRetry: ['node', 'tools/scripts/gg-codex-pr-review.mjs', '--source', '/tmp/article.md'],
    createdAt: '2026-07-15T14:00:00.000Z',
    ...overrides,
  };
}

function harness(t) {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-controller-cli-'));
  const queueDir = join(root, 'queue');
  const lockDir = join(root, 'controller.lock');
  const adapterCalls = join(root, 'adapter-calls.log');
  const notifyCalls = join(root, 'notify-calls.log');
  const adapterModule = join(root, 'fake-adapters.mjs');
  const notifyModule = join(root, 'fake-notify.mjs');
  writeFileSync(adapterModule, [
    "import { appendFileSync } from 'node:fs';",
    "const execute = async ({ record, strategy, attemptDeadlineAt }) => {",
    "  appendFileSync(process.env.GG_TEST_ADAPTER_CALLS, JSON.stringify({ pageId: record.event.pageId, strategy, attemptDeadlineAt }) + '\\n');",
    "  return { terminal: 'published', evidence: { checks: { production_200: true, backfilled: true } } };",
    "};",
    "export default { gengrowth: { execute }, astrologywiki: { execute } };",
    '',
  ].join('\n'));
  writeFileSync(notifyModule, [
    "import { appendFileSync } from 'node:fs';",
    "export default async function notify(payload) {",
    "  appendFileSync(process.env.GG_TEST_NOTIFY_CALLS, JSON.stringify(payload) + '\\n');",
    "}",
    '',
  ].join('\n'));

  const env = {
    ...process.env,
    HOME: root,
    GG_FLOW_STATE_DIR: root,
    GG_SEO_REPAIR_QUEUE_DIR: queueDir,
    GG_SEO_REPAIR_CONTROLLER_LOCK: lockDir,
    GG_SEO_REPAIR_ADAPTER_MODULE: adapterModule,
    GG_SEO_REPAIR_NOTIFY_MODULE: notifyModule,
    GG_TEST_ADAPTER_CALLS: adapterCalls,
    GG_TEST_NOTIFY_CALLS: notifyCalls,
  };
  const run = (args, extraEnv = {}) => spawnSync('node', [CLI, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...env, ...extraEnv },
  });
  const json = (result) => JSON.parse(result.stdout.trim().split('\n').at(-1));
  const lines = (path) => {
    try { return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch { return []; }
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, queueDir, lockDir, adapterCalls, notifyCalls, run, json, lines };
}

test('enqueue and inspect expose one durable schema-v2 event', (t) => {
  const h = harness(t);
  const path = join(h.root, 'event.json');
  writeFileSync(path, JSON.stringify(event()));
  const enqueued = h.run(['enqueue', '--event-json', path]);
  assert.equal(enqueued.status, 0, `${enqueued.stdout}\n${enqueued.stderr}`);
  assert.equal(h.json(enqueued).record.status, 'queued');
  const inspected = h.run(['inspect', '--page-id', 'PG-WLS-007']);
  assert.equal(inspected.status, 0, `${inspected.stdout}\n${inspected.stderr}`);
  assert.equal(h.json(inspected).records.length, 1);
  assert.equal(h.json(inspected).records[0].event.stderr, 'reviewer stderr');
});

test('malformed enqueue exits 2 without creating executable work', (t) => {
  const h = harness(t);
  const path = join(h.root, 'bad-event.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, canonicalRetry: 'node bad' }));
  const result = h.run(['enqueue', '--event-json', path]);
  assert.equal(result.status, 2);
  assert.match(h.json(result).error, /canonicalRetry|site|event/i);
  const inspected = h.run(['inspect']);
  assert.deepEqual(h.json(inspected).records, []);
});

test('compact requires incident ownership arguments and emits one canonical JSON record', (t) => {
  const h = harness(t);
  const missing = h.run(['compact', '--site', 'gengrowth']);
  assert.equal(missing.status, 2);
  assert.match(h.json(missing).error, /--site.*--page-id|--page-id/i);

  const path = join(h.root, 'compact-event.json');
  writeFileSync(path, JSON.stringify(event({ eventId: 'compact-source' })));
  const enqueued = h.run(['enqueue', '--event-json', path]);
  assert.equal(enqueued.status, 0, `${enqueued.stdout}\n${enqueued.stderr}`);
  const compacted = h.run([
    'compact', '--site', 'gengrowth', '--page-id', 'PG-WLS-007', '--verification-credit', '1',
  ]);
  assert.equal(compacted.status, 0, `${compacted.stdout}\n${compacted.stderr}`);
  const payload = h.json(compacted);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'compact');
  assert.equal(payload.record.status, 'migration_hold');
  assert.equal(payload.record.verificationCredit, 1);

  const again = h.json(h.run([
    'compact', '--site', 'gengrowth', '--page-id', 'PG-WLS-007', '--verification-credit', '1',
  ]));
  assert.equal(again.record.event.eventId, payload.record.event.eventId);
  const records = h.json(h.run(['inspect', '--page-id', 'PG-WLS-007'])).records;
  assert.equal(records.filter((record) => record.status === 'migration_hold').length, 1);
});

test('live global lock makes a concurrent drain return busy without an adapter call', (t) => {
  const h = harness(t);
  mkdirSync(h.lockDir, { recursive: true });
  writeFileSync(join(h.lockDir, 'owner.json'), JSON.stringify({
    pid: process.pid,
    owner: 'other-controller',
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  const result = h.run(['drain', '--max-targets', '1']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.json(result).busy, true);
  assert.deepEqual(h.lines(h.adapterCalls), []);
});

test('a newly-created lock without owner metadata is treated as busy during its write grace period', (t) => {
  const h = harness(t);
  mkdirSync(h.lockDir, { recursive: true });
  const result = h.run(['drain', '--max-targets', '1']);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.json(result).busy, true);
  assert.deepEqual(h.lines(h.adapterCalls), []);
});

test('maxTargets=1 processes one event and leaves the second queued', (t) => {
  const h = harness(t);
  const fresh = Date.now();
  for (const value of [
    event({ createdAt: new Date(fresh - 1_000).toISOString() }),
    event({
      eventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pageId: 'PG-WLS-008',
      slug: 'seo-agents',
      createdAt: new Date(fresh).toISOString(),
    }),
  ]) {
    const path = join(h.root, `${value.pageId}.json`);
    writeFileSync(path, JSON.stringify(value));
    const result = h.run(['enqueue', '--event-json', path]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  }
  const drained = h.run(['drain', '--max-targets', '1', '--budget-seconds', '30']);
  assert.equal(drained.status, 0, `${drained.stdout}\n${drained.stderr}`);
  assert.equal(h.json(drained).processed, 1);
  assert.equal(h.json(drained).remaining, 1);
  assert.equal(h.lines(h.adapterCalls).length, 1);
  assert.equal(h.lines(h.notifyCalls).length, 1);
  const records = h.json(h.run(['inspect'])).records;
  assert.deepEqual(records.map((record) => record.status).sort(), ['published', 'queued']);
});

test('default CLI drain grants one 25-minute attempt deadline', (t) => {
  const h = harness(t);
  const path = join(h.root, 'event.json');
  writeFileSync(path, JSON.stringify(event({ createdAt: new Date().toISOString() })));
  const enqueued = h.run(['enqueue', '--event-json', path]);
  assert.equal(enqueued.status, 0, `${enqueued.stdout}\n${enqueued.stderr}`);
  const before = Date.now();
  const drained = h.run(['drain', '--max-targets', '1']);
  const after = Date.now();
  assert.equal(drained.status, 0, `${drained.stdout}\n${drained.stderr}`);
  const [call] = h.lines(h.adapterCalls);
  const deadline = Date.parse(call.attemptDeadlineAt);
  assert.equal(deadline >= before + 25 * 60 * 1000, true);
  assert.equal(deadline <= after + 25 * 60 * 1000, true);
});

test('import-v1 converts all repairable claims without applying the v1 attempt cap', (t) => {
  const h = harness(t);
  const claims = join(h.root, 'claims.json');
  const plan = join(h.root, 'plan.md');
  const log = join(h.root, 'nightly.log');
  writeFileSync(claims, JSON.stringify({
    'PG-TRANS-016': {
      status: 'needs_human',
      stage: 'pushed-preview',
      slug: 'saturn-return-age-29',
      branch: 'seo/auto/saturn-return-age-29',
      error: 'codex FAIL — SVG says Saturn Square around age 14',
    },
    'PG-TRANS-018': {
      status: 'needs_human',
      stage: 'pushed-preview',
      slug: 'saturn-return-in-capricorn',
      branch: 'seo/auto/saturn-return-in-capricorn',
      error: 'review[links-seo] FAIL: intended links render as italic text',
    },
  }));
  writeFileSync(plan, '- [ ] `PG-TRANS-016` one\n- [ ] `PG-TRANS-018` two\n');
  writeFileSync(log, 'gate parked\n');
  const imported = h.run([
    'import-v1',
    '--claims', claims,
    '--plan', plan,
    '--log-file', log,
    '--log-offset', '0',
    '--run-exit', '0',
    '--no-drain', '1',
  ]);
  assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
  assert.equal(h.json(imported).imported, 2);
  const records = h.json(h.run(['inspect'])).records;
  assert.deepEqual(records.map((record) => record.event.pageId).sort(), ['PG-TRANS-016', 'PG-TRANS-018']);
  assert.deepEqual(records.map((record) => record.event.errorKind).sort(), ['asset_fail', 'link_fail']);
});

test('import-v1 validates explicit run ids and keeps unchanged same-run legacy claims idempotent', (t) => {
  const h = harness(t);
  const claims = join(h.root, 'claims.json');
  const plan = join(h.root, 'plan.md');
  const log = join(h.root, 'author.log');
  writeFileSync(claims, JSON.stringify({
    'PG-WLS-007': {
      status: 'needs_human',
      stage: 'authoring',
      slug: 'chatgpt-seo',
      error: 'phase2 failed',
      failedAt: '2026-07-16T10:00:00.000Z',
    },
    'PG-OTHER-999': {
      status: 'needs_human',
      stage: 'authoring',
      slug: 'outside-plan',
      error: 'must not import',
      failedAt: '2026-07-16T10:00:00.000Z',
    },
  }));
  writeFileSync(plan, '- [ ] `PG-WLS-007` chatgpt seo\n');
  writeFileSync(log, 'before\nphase2 failed\n');

  const invalid = h.run([
    'import-v1', '--site', 'gengrowth', '--claims', claims, '--plan', plan,
    '--log-file', log, '--log-offset', '7', '--run-id', '../bad run', '--no-drain',
  ]);
  assert.equal(invalid.status, 2);
  assert.match(h.json(invalid).error, /run-id/i);

  const firstArgs = [
    'import-v1', '--site', 'gengrowth', '--claims', claims, '--plan', plan,
    '--log-file', log, '--log-offset', '7', '--run-id', 'gengrowth-author-20260716T100000Z-7',
    '--no-drain',
  ];
  const first = h.run(firstArgs);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(h.json(first).imported, 1);
  const second = h.run([
    'import-v1', '--site', 'gengrowth', '--claims', claims, '--plan', plan,
    '--log-file', log, '--log-offset', '7', '--run-id', 'gengrowth-author-20260716T103000Z-8',
    '--run-exit', '2', '--no-drain',
  ]);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(h.json(second).imported, 0);

  const records = h.json(h.run(['inspect'])).records;
  assert.equal(records.length, 1);
  assert.equal(records[0].event.pageId, 'PG-WLS-007');
  assert.equal(records[0].observations, 1);
  assert.equal(records[0].windowCount, 1);
  assert.equal(records[0].event.runId, 'gengrowth-author-20260716T100000Z-7');
  assert.equal(records[0].event.logOffsetStart, 7);
});

test('import-v1 --site gengrowth preserves site ownership and exact author retry', (t) => {
  const h = harness(t);
  const claims = join(h.root, 'claims.json');
  const plan = join(h.root, 'plan.md');
  const log = join(h.root, 'author.log');
  writeFileSync(claims, JSON.stringify({
    'PG-WLS-007': {
      status: 'needs_human',
      stage: 'authoring',
      slug: 'chatgpt-seo',
      error: 'codex exited 3',
    },
  }));
  writeFileSync(plan, '- [ ] `PG-WLS-007` chatgpt seo\n');
  writeFileSync(log, 'PARK(author) PG-WLS-007: codex exited 3\n');
  const imported = h.run([
    'import-v1', '--site', 'gengrowth', '--claims', claims, '--plan', plan,
    '--log-file', log, '--no-drain', '1',
  ]);
  assert.equal(imported.status, 0, `${imported.stdout}\n${imported.stderr}`);
  const [record] = h.json(h.run(['inspect'])).records;
  assert.equal(record.event.site, 'gengrowth');
  assert.equal(record.event.pageId, 'PG-WLS-007');
  assert.deepEqual(record.event.canonicalRetry.slice(-3), ['--retry-author', '--task', 'PG-WLS-007']);
});
