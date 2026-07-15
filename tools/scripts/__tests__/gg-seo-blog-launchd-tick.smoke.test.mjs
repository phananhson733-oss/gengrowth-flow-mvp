import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const flow = resolve(here, '../../..');
const wiki = '/Users/awayer_mini/gengrowth-wiki';
const runner = resolve(flow, 'tools/scripts/gg-seo-blog-launchd-tick.sh');
const seoPlist = resolve(flow, 'tools/launchd/com.gengrowth.seo-blog.plist');
const notesPlist = resolve(wiki, 'tools/launchd/com.gengrowth.wiki-notes-digest.plist');

test('SEO launchd runner directly runs nightly before the conditional hook', () => {
  assert.equal(existsSync(runner), true, `missing runner: ${runner}`);
  const source = readFileSync(runner, 'utf8');

  assert.match(source, /gg-seo-blog-launchd\.lock/);
  assert.match(source, /GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW/);
  assert.match(source, /com\.gengrowth\.seo-nightly/);
  assert.match(source, /gg-nightly-seo\.sh/);
  assert.match(source, /gg-seo-repair-hook\.mjs/);
  assert.doesNotMatch(source, /tomllib|automation\.toml/i);
  assert.doesNotMatch(source, /codex.*exec/is);
  assert.ok(source.indexOf('"$NIGHTLY"') < source.indexOf('"$REPAIR_HOOK"'));
});

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function runnerHarness({ nightlyExit = 0, hookExit = 0, lockHeld = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-launchd-runner-'));
  const flow = join(root, 'flow');
  const oracle = join(root, 'oracle');
  const opsTasks = join(root, 'ops/inbox/06-tasks/tasks');
  mkdirSync(flow, { recursive: true });
  mkdirSync(join(oracle, '.git'), { recursive: true });
  mkdirSync(opsTasks, { recursive: true });
  const events = join(root, 'events.log');
  const hookArgs = join(root, 'hook-args.json');
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
      GG_SEO_NIGHTLY_LOG: nightlyLog,
      GG_SEO_LAUNCHD_LOG: launchdLog,
      GG_SEO_LAUNCHD_ERR_LOG: launchdErr,
      GG_SEO_LAUNCHD_LOCK: lock,
      GG_SEO_PLAN: plan,
      GG_SEO_CLAIMS: claims,
      GG_TEST_EVENTS: events,
      GG_TEST_HOOK_ARGS: hookArgs,
    },
  });
  const readMaybe = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  return {
    run,
    events: () => readMaybe(events).trim().split('\n').filter(Boolean),
    hookArgs: () => JSON.parse(readMaybe(hookArgs) || '[]'),
    log: () => readMaybe(launchdLog),
  };
}

test('clean runner calls nightly then selector hook', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook']);
  const args = h.hookArgs();
  assert.equal(args[args.indexOf('--run-exit') + 1], '0');
});

test('nightly nonzero is passed to hook and hook terminal code owns final exit', () => {
  const h = runnerHarness({ nightlyExit: 7, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['nightly', 'hook']);
  const args = h.hookArgs();
  assert.equal(args[args.indexOf('--run-exit') + 1], '7');
});

test('hook nonzero is returned by the launchd runner', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 2 });
  const result = h.run();
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
});

test('outer lock makes a concurrent tick skip before nightly or hook', () => {
  const h = runnerHarness({ lockHeld: true });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), []);
  assert.match(h.log(), /another SEO launchd run holds/);
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
