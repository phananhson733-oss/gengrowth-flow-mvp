import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const wiki = '/Users/awayer_mini/gengrowth-wiki';
const runner = resolve(flow, 'tools/scripts/gg-seo-blog-launchd-tick.sh');
const authorTick = resolve(flow, 'tools/scripts/gg-gengrowth-author-tick.sh');
const seoPlist = resolve(flow, 'tools/launchd/com.gengrowth.seo-blog.plist');
const notesPlist = resolve(wiki, 'tools/launchd/com.gengrowth.wiki-notes-digest.plist');

test('SEO launchd runner owns nightly, hook, reconcile, then terminal summary', () => {
  assert.equal(existsSync(runner), true, `missing runner: ${runner}`);
  const source = readFileSync(runner, 'utf8');
  const nightlySource = readFileSync(resolve(flow, 'tools/scripts/gg-nightly-seo.sh'), 'utf8');

  assert.match(source, /gg-seo-blog-launchd\.lock/);
  assert.match(source, /GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW/);
  assert.match(source, /com\.gengrowth\.seo-nightly/);
  assert.match(source, /gg-nightly-seo\.sh/);
  assert.match(source, /gg-seo-repair-hook\.mjs/);
  assert.match(source, /gg-ledger-reconcile\.mjs/);
  assert.match(source, /gg-batch-summary\.mjs/);
  assert.doesNotMatch(source, /tomllib|automation\.toml/i);
  assert.doesNotMatch(source, /codex.*exec/is);
  assert.ok(source.indexOf('"$NIGHTLY"') < source.indexOf('"$REPAIR_HOOK"'));
  assert.ok(source.indexOf('"$REPAIR_HOOK"') < source.indexOf('"$RECONCILE"'));
  assert.ok(source.indexOf('"$RECONCILE"') < source.indexOf('"$BATCH_SUMMARY"'));
  assert.doesNotMatch(nightlySource, /gg-batch-summary/);
});

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function runnerHarness({
  nightlyExit = 0,
  hookExit = 0,
  reconcileExit = 0,
  summaryExit = 0,
  lockHeld = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-launchd-runner-'));
  const flow = join(root, 'flow');
  const oracle = join(root, 'oracle');
  const opsTasks = join(root, 'ops/inbox/06-tasks/tasks');
  mkdirSync(flow, { recursive: true });
  mkdirSync(join(oracle, '.git'), { recursive: true });
  mkdirSync(opsTasks, { recursive: true });
  const events = join(root, 'events.log');
  const hookArgs = join(root, 'hook-args.json');
  const summaryArgs = join(root, 'summary-args.json');
  const nightlyEnv = join(root, 'nightly-env.json');
  const reconcileEnv = join(root, 'reconcile-env.json');
  const nightlyLog = join(root, 'nightly.log');
  const launchdLog = join(root, 'launchd.log');
  const launchdErr = join(root, 'launchd.err.log');
  const plan = join(opsTasks, 'plan.md');
  const claims = join(opsTasks, '.autopilot-claims.json');
  writeFileSync(plan, '- [ ] `PG-A-001` alpha\n');
  writeFileSync(claims, '{}');
  writeFileSync(nightlyLog, 'existing bytes\n');
  const lock = join(root, 'launchd.lock');
  if (lockHeld) mkdirSync(lock);

  const nightly = executable(join(root, 'nightly.sh'), [
    '#!/bin/sh',
    'printf "nightly\\n" >> "$GG_TEST_EVENTS"',
    'node -e \'require("node:fs").writeFileSync(process.env.GG_TEST_NIGHTLY_ENV, JSON.stringify({ runId: process.env.GG_SEO_REPAIR_RUN_ID || null, logFile: process.env.GG_SEO_REPAIR_LOG_FILE || null, offsetStart: process.env.GG_SEO_REPAIR_LOG_OFFSET_START || null, offsetEnd: process.env.GG_SEO_REPAIR_LOG_OFFSET_END || null }))\'',
    'printf "nightly body\\n" >> "$GG_SEO_NIGHTLY_LOG"',
    `exit ${nightlyExit}`,
    '',
  ].join('\n'));
  const hook = join(root, 'hook.mjs');
  writeFileSync(hook, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_EVENTS, 'hook\\n');",
    "writeFileSync(process.env.GG_TEST_HOOK_ARGS, JSON.stringify(process.argv.slice(2)));",
    `process.exit(${hookExit});`,
    '',
  ].join('\n'));
  const reconcile = join(root, 'reconcile.mjs');
  writeFileSync(reconcile, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_EVENTS, 'reconcile\\n');",
    "writeFileSync(process.env.GG_TEST_RECONCILE_ENV, JSON.stringify({ silence: process.env.GG_LARK_NOTIFY_SILENCE || null }));",
    `process.exit(${reconcileExit});`,
    '',
  ].join('\n'));
  const summary = join(root, 'summary.mjs');
  writeFileSync(summary, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_EVENTS, 'summary\\n');",
    "writeFileSync(process.env.GG_TEST_SUMMARY_ARGS, JSON.stringify(process.argv.slice(2)));",
    `process.exit(${summaryExit});`,
    '',
  ].join('\n'));

  const run = () => spawnSync('bash', [runner], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      GG_ENV_FILE: '/dev/null',
      GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW: '1',
      GG_SEO_SKIP_LEGACY_CHECK: '1',
      GG_SEO_LAUNCHD_FLOW: flow,
      GG_AUTOMATION_ORACLE_DIR: oracle,
      GG_SEO_NIGHTLY_BIN: nightly,
      GG_SEO_REPAIR_HOOK_BIN: hook,
      GG_SEO_RECONCILE_BIN: reconcile,
      GG_SEO_BATCH_SUMMARY_BIN: summary,
      GG_SEO_NIGHTLY_LOG: nightlyLog,
      GG_SEO_LAUNCHD_LOG: launchdLog,
      GG_SEO_LAUNCHD_ERR_LOG: launchdErr,
      GG_SEO_LAUNCHD_LOCK: lock,
      GG_SEO_PLAN: plan,
      GG_SEO_CLAIMS: claims,
      GG_TEST_EVENTS: events,
      GG_TEST_HOOK_ARGS: hookArgs,
      GG_TEST_SUMMARY_ARGS: summaryArgs,
      GG_TEST_NIGHTLY_ENV: nightlyEnv,
      GG_TEST_RECONCILE_ENV: reconcileEnv,
    },
  });
  const readMaybe = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  return {
    run,
    events: () => readMaybe(events).trim().split('\n').filter(Boolean),
    hookArgs: () => JSON.parse(readMaybe(hookArgs) || '[]'),
    summaryArgs: () => JSON.parse(readMaybe(summaryArgs) || '[]'),
    nightlyEnv: () => JSON.parse(readMaybe(nightlyEnv) || '{}'),
    reconcileEnv: () => JSON.parse(readMaybe(reconcileEnv) || '{}'),
    log: () => readMaybe(launchdLog),
    plan,
    nightlyLog,
  };
}

test('clean runner orders nightly, hook, reconcile, summary and preserves one fire-local run id', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook', 'reconcile', 'summary']);
  const hookArgs = h.hookArgs();
  const summaryArgs = h.summaryArgs();
  const nightlyEnv = h.nightlyEnv();
  assert.equal(hookArgs[hookArgs.indexOf('--run-exit') + 1], '0');
  const runId = hookArgs[hookArgs.indexOf('--run-id') + 1];
  assert.match(runId, /^seo-blog-\d{8}T\d{6}Z-\d+$/);
  assert.equal(summaryArgs[summaryArgs.indexOf('--run-id') + 1], runId);
  assert.equal(summaryArgs[summaryArgs.indexOf('--plan') + 1], h.plan);
  assert.equal(nightlyEnv.runId, runId);
  assert.equal(nightlyEnv.logFile, h.nightlyLog);
  assert.equal(nightlyEnv.offsetStart, String(Buffer.byteLength('existing bytes\n')));
  assert.equal(nightlyEnv.offsetEnd, null);
  assert.equal(h.reconcileEnv().silence, '1', 'outer runner must suppress reconcile-owned batch notifications');
});

test('nightly nonzero is passed to hook and a recovered fire still reaches reconcile and summary', () => {
  const h = runnerHarness({ nightlyExit: 7, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook', 'reconcile', 'summary']);
  const args = h.hookArgs();
  assert.equal(args[args.indexOf('--run-exit') + 1], '7');
});

test('hook failure is returned and cannot emit a false-success terminal summary', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 2 });
  const result = h.run();
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook']);
});

test('reconcile failure is returned and cannot emit a false-success terminal summary', () => {
  const h = runnerHarness({ reconcileExit: 4 });
  const result = h.run();
  assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook', 'reconcile']);
});

test('silent empty summary exit 2 is a successful completed tick', () => {
  const h = runnerHarness({ summaryExit: 2 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook', 'reconcile', 'summary']);
});

test('summary delivery failure owns the final nonzero exit', () => {
  const h = runnerHarness({ summaryExit: 3 });
  const result = h.run();
  assert.equal(result.status, 3, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook', 'reconcile', 'summary']);
});

test('outer lock makes a concurrent tick skip before nightly or hook', () => {
  const h = runnerHarness({ lockHeld: true });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), []);
  assert.match(h.log(), /another SEO launchd run holds/);
});

function authorFinalizerHarness({ preflightExit = 0, controllerExit = 0, planExists = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gengrowth-author-finalizer-'));
  const tasks = join(root, 'tasks');
  const logs = join(root, 'logs');
  mkdirSync(tasks, { recursive: true });
  mkdirSync(logs, { recursive: true });
  const plan = join(tasks, 'plan.md');
  const claims = join(tasks, 'claims.json');
  const calls = join(root, 'controller-calls.log');
  const window = join(root, 'controller-window.log');
  const preflightEnv = join(root, 'preflight-env.json');
  const lock = join(root, 'author.lock');
  if (planExists) writeFileSync(plan, '- [x] `PG-WLS-001` already done\n');
  writeFileSync(claims, '{}\n');
  const preflight = executable(join(root, 'preflight.mjs'), [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.GG_TEST_PREFLIGHT_ENV, JSON.stringify({",
    '  runId: process.env.GG_SEO_REPAIR_RUN_ID || null,',
    '  logFile: process.env.GG_SEO_REPAIR_LOG_FILE || null,',
    '  offsetStart: process.env.GG_SEO_REPAIR_LOG_OFFSET_START || null,',
    '}));',
    "process.stderr.write('CURRENT FIRE PREFLIGHT ERROR\\n');",
    `process.exit(${preflightExit});`,
    '',
  ].join('\n'));
  const timeout = executable(join(root, 'gtimeout'), '#!/bin/sh\nshift\nexec "$@"\n');
  const controller = executable(join(root, 'controller.mjs'), [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "appendFileSync(process.env.GG_TEST_CONTROLLER_CALLS, JSON.stringify(args) + '\\n');",
    "const get = (name) => args[args.indexOf(name) + 1];",
    "const bytes = readFileSync(get('--log-file'));",
    "writeFileSync(process.env.GG_TEST_CONTROLLER_WINDOW, bytes.subarray(Number(get('--log-offset')) || 0));",
    `process.exit(${controllerExit});`,
    '',
  ].join('\n'));
  const day = new Date().toISOString().slice(0, 10);
  const logFile = join(logs, `${day}.log`);
  const oldLog = 'OLD FIRE SHOULD STAY OUT\n';
  writeFileSync(logFile, oldLog);
  const result = spawnSync('bash', [authorTick], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      GG_GENGROWTH_OPS_TASKS_DIR: tasks,
      GG_GENGROWTH_PLAN: plan,
      GG_GENGROWTH_PLAN_NAME: 'plan.md',
      GG_GENGROWTH_CLAIMS: claims,
      GG_GENGROWTH_AUTHOR_LOCK: lock,
      GG_GENGROWTH_AUTHOR_LOG_DIR: logs,
      GG_GENGROWTH_AUTHOR_PREFLIGHT_BIN: preflight,
      GG_GENGROWTH_AUTHOR_TIMEOUT_BIN: timeout,
      GG_SEO_REPAIR_CONTROLLER_BIN: controller,
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: '1',
      GG_SHEETS_GENGROWTH_WORKBOOK_ID: 'test-workbook',
      GG_TEST_CONTROLLER_CALLS: calls,
      GG_TEST_CONTROLLER_WINDOW: window,
      GG_TEST_PREFLIGHT_ENV: preflightEnv,
    },
  });
  const callLines = existsSync(calls)
    ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return {
    root,
    result,
    callLines,
    oldLog,
    preflightEnv: existsSync(preflightEnv) ? JSON.parse(readFileSync(preflightEnv, 'utf8')) : null,
    window: existsSync(window) ? readFileSync(window, 'utf8') : '',
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
  };
}

test('Gengrowth author finalizer imports exactly once with one fire-local run id and preserves nonzero rc', () => {
  const h = authorFinalizerHarness({ preflightExit: 1, controllerExit: 0 });
  try {
    assert.equal(h.result.status, 2, `${h.result.stdout}\n${h.result.stderr}\n${h.log}`);
    assert.equal(h.callLines.length, 1);
    const args = h.callLines[0];
    assert.equal(args[0], 'import-v1');
    assert.equal(args[args.indexOf('--run-exit') + 1], '2');
    assert.equal(args[args.indexOf('--log-offset') + 1], String(Buffer.byteLength(h.oldLog)));
    assert.match(args[args.indexOf('--run-id') + 1], /^gengrowth-author-\d{8}T\d{6}Z-\d+$/);
    assert.equal(args[args.indexOf('--budget-seconds') + 1], '1500');
    assert.equal(h.preflightEnv.runId, args[args.indexOf('--run-id') + 1]);
    assert.equal(h.preflightEnv.logFile, args[args.indexOf('--log-file') + 1]);
    assert.equal(h.preflightEnv.offsetStart, args[args.indexOf('--log-offset') + 1]);
    assert.match(h.window, /CURRENT FIRE PREFLIGHT ERROR/);
    assert.doesNotMatch(h.window, /OLD FIRE SHOULD STAY OUT/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('Gengrowth author finalizer fails closed when v2 inputs are unavailable', () => {
  const h = authorFinalizerHarness({ planExists: false });
  try {
    assert.equal(h.result.status, 2, `${h.result.stdout}\n${h.result.stderr}\n${h.log}`);
    assert.equal(h.callLines.length, 0);
    assert.match(h.log, /repair import unavailable/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('Gengrowth author finalizer fails closed when an otherwise clean fire cannot enqueue/import', () => {
  const h = authorFinalizerHarness({ preflightExit: 0, controllerExit: 2 });
  try {
    assert.equal(h.result.status, 2, `${h.result.stdout}\n${h.result.stderr}\n${h.log}`);
    assert.equal(h.callLines.length, 1);
    assert.equal(h.callLines[0][h.callLines[0].indexOf('--run-exit') + 1], '0');
    assert.match(h.log, /repair import\/drain failed/);
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('SEO plist schedules only the approved evening window and never runs at load', () => {
  assert.equal(existsSync(seoPlist), true, `missing SEO plist: ${seoPlist}`);
  const source = readFileSync(seoPlist, 'utf8');

  assert.match(source, /<string>com\.gengrowth\.seo-blog<\/string>/);
  assert.match(source, /<key>RunAtLoad<\/key>\s*<false\/>/s);
  assert.equal((source.match(/<integer>18<\/integer>/g) || []).length, 1);
  assert.equal((source.match(/<integer>19<\/integer>/g) || []).length, 2);
  assert.equal((source.match(/<integer>20<\/integer>/g) || []).length, 2);
  assert.equal((source.match(/<integer>21<\/integer>/g) || []).length, 2);
  assert.equal((source.match(/<integer>30<\/integer>/g) || []).length, 4);
  assert.equal((source.match(/<integer>0<\/integer>/g) || []).length, 3);
});

test('Notes plist runs the existing wiki digest on Monday at 09:07', () => {
  assert.equal(existsSync(notesPlist), true, `missing Notes plist: ${notesPlist}`);
  const source = readFileSync(notesPlist, 'utf8');

  assert.match(source, /<string>com\.gengrowth\.wiki-notes-digest<\/string>/);
  assert.match(source, /weekly-notes-digest\.sh/);
  assert.match(source, /<key>Weekday<\/key>\s*<integer>1<\/integer>/s);
  assert.match(source, /<key>Hour<\/key>\s*<integer>9<\/integer>/s);
  assert.match(source, /<key>Minute<\/key>\s*<integer>7<\/integer>/s);
  assert.match(source, /<key>RunAtLoad<\/key>\s*<false\/>/s);
});
