import assert from 'node:assert/strict';
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
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const tick = resolve(flow, 'tools/scripts/gg-seo-reconcile-tick.sh');

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function harness({
  hm = '2300',
  owner = null,
  drainExit = 0,
  reconcileExit = 0,
  readinessExit = 0,
  useEnvFile = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-reconcile-tick-'));
  const state = join(root, 'state');
  const queue = join(state, 'seo-repair-queue');
  const lock = join(root, 'tick.lock');
  const events = join(root, 'events.log');
  const plan = join(root, 'plan.md');
  const envFile = join(root, 'gg.env');
  mkdirSync(queue, { recursive: true });
  writeFileSync(plan, '- [x] `PG-A-001` alpha\n');
  if (owner) {
    mkdirSync(lock);
    writeFileSync(join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`);
  }
  const controller = executable(join(root, 'controller.mjs'), [
    '#!/usr/bin/env node',
    "const fs = await import('node:fs');",
    "fs.appendFileSync(process.env.GG_TEST_EVENTS, `drain ${process.argv.slice(2).join(' ')}\\n`);",
    `process.exit(${drainExit});`,
    '',
  ].join('\n'));
  const reconcile = executable(join(root, 'reconcile.mjs'), [
    '#!/usr/bin/env node',
    "const fs = await import('node:fs');",
    "fs.appendFileSync(process.env.GG_TEST_EVENTS, `reconcile ${process.argv.slice(2).join(' ')} silence=${process.env.GG_LARK_NOTIFY_SILENCE || ''}\\n`);",
    `process.exit(${reconcileExit});`,
    '',
  ].join('\n'));
  const readiness = executable(join(root, 'readiness.mjs'), [
    '#!/usr/bin/env node',
    "const fs = await import('node:fs');",
    "fs.appendFileSync(process.env.GG_TEST_EVENTS, `readiness ${process.argv.slice(2).join(' ')} silence=${process.env.GG_LARK_NOTIFY_SILENCE || ''}\\n`);",
    `process.exit(${readinessExit});`,
    '',
  ].join('\n'));
  if (useEnvFile) {
    writeFileSync(envFile, [
      `GG_SEO_REPAIR_CONTROLLER_BIN='${controller}'`,
      `GG_SEO_RECONCILE_BIN='${reconcile}'`,
      `GG_SEO_READINESS_BIN='${readiness}'`,
      `GG_SEO_PLAN='${plan}'`,
      "GG_SEO_SITE='gengrowth'",
      '',
    ].join('\n'));
  }
  const directBins = useEnvFile ? {} : {
    GG_SEO_REPAIR_CONTROLLER_BIN: controller,
    GG_SEO_RECONCILE_BIN: reconcile,
    GG_SEO_READINESS_BIN: readiness,
    GG_SEO_PLAN: plan,
    GG_SEO_SITE: 'astrologywiki',
  };
  const result = spawnSync('bash', [tick], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      GG_FLOW_STATE_DIR: state,
      GG_ENV_FILE: useEnvFile ? envFile : '/dev/null',
      GG_SEO_RECONCILE_NOW_HM: hm,
      GG_SEO_RECONCILE_LOCK: lock,
      GG_SEO_RECONCILE_LOG: join(root, 'out.log'),
      GG_SEO_RECONCILE_ERR_LOG: join(root, 'err.log'),
      GG_SEO_REPAIR_QUEUE_DIR: queue,
      ...directBins,
      GG_TEST_EVENTS: events,
    },
  });
  const lines = (() => {
    try { return readFileSync(events, 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
  })();
  return { result, lines, root, lock };
}

test('reconciler source contains no nightly, author, scan, or producer path', () => {
  const source = readFileSync(tick, 'utf8');
  assert.doesNotMatch(source, /gg-nightly-seo\.sh|--author|\bscan\b|producer/i);
  assert.doesNotMatch(source, /rm\s+-rf/);
  assert.match(source, /droppedWritebackAfter/);
});

test('23:00 tick runs strict reconcile/readiness without draining content repair', () => {
  const h = harness({ hm: '2300' });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 2);
  assert.match(h.lines[0], /^reconcile --strict --json silence=1$/);
  assert.match(h.lines[1], /^readiness .*--json .*silence=1$/);
});

test('19:00 tick drains existing queue before strict reconcile/readiness', () => {
  const h = harness({ hm: '1900' });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.match(h.lines[0], /^drain drain /);
  assert.match(h.lines[1], /^reconcile --strict --json silence=1$/);
  assert.match(h.lines[2], /^readiness .*--json .*silence=1$/);
});

test('live unexpired owner returns a clean busy result', () => {
  const h = harness({
    owner: {
      pid: process.pid,
      token: 'live-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
  });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.deepEqual(h.lines, []);
});

test('dead owner is recovered in the same tick even before lease expiry', () => {
  const h = harness({
    hm: '1900',
    owner: {
      pid: 999999,
      token: 'dead-token',
      expiresAt: '2999-01-01T00:00:00.000Z',
    },
  });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 3);
});

test('expired lease is recovered in the same tick', () => {
  const h = harness({
    owner: {
      pid: process.pid,
      token: 'expired-token',
      expiresAt: '2000-01-01T00:00:00.000Z',
    },
  });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 2);
  const archives = readdirSync(h.root).filter((name) => name.startsWith('tick.lock.stale-'));
  assert.equal(archives.length, 1);
  assert.equal(existsSync(join(h.root, archives[0], 'owner.json')), true);
});

test('controller failure still runs strict reconcile/readiness and owns exit', () => {
  const h = harness({ hm: '1900', drainExit: 7 });
  assert.equal(h.result.status, 7, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 3);
  assert.match(h.lines[0], /^drain /);
  assert.match(h.lines[1], /^reconcile /);
  assert.match(h.lines[2], /^readiness /);
});

test('strict reconcile failure still runs readiness with its machine result', () => {
  const h = harness({ reconcileExit: 5 });
  assert.equal(h.result.status, 5, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 2);
  assert.match(h.lines[0], /^reconcile /);
  assert.match(h.lines[1], /^readiness /);
});

test('environment file is sourced before deriving bins, plan, and site', () => {
  const h = harness({ hm: '1900', useEnvFile: true });
  assert.equal(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}`);
  assert.equal(h.lines.length, 3);
  assert.match(h.lines[2], /--site gengrowth/);
});
