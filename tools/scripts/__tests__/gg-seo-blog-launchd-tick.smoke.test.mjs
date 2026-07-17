import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
const fileIdentity = (path) => `${lstatSync(path).dev}:${lstatSync(path).ino}`;

test('SEO launchd runner owns pre/post drain, strict reconcile, readiness, then terminal summary', () => {
  assert.equal(existsSync(runner), true, `missing runner: ${runner}`);
  const source = readFileSync(runner, 'utf8');
  const nightlySource = readFileSync(resolve(flow, 'tools/scripts/gg-nightly-seo.sh'), 'utf8');

  assert.match(source, /gg-seo-blog-launchd\.lock/);
  assert.match(source, /GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW/);
  assert.match(source, /com\.gengrowth\.seo-nightly/);
  assert.match(source, /gg-nightly-seo\.sh/);
  assert.match(source, /gg-seo-brief-preflight\.mjs/);
  assert.match(source, /gg-topic-register-tick\.sh/);
  assert.match(source, /gg-seo-repair-hook\.mjs/);
  assert.match(source, /gg-seo-repair-controller\.mjs/);
  assert.match(source, /gg-ledger-reconcile\.mjs/);
  assert.match(source, /--notify-only/);
  assert.match(source, /gg-seo-readiness\.mjs/);
  assert.match(source, /gg-batch-summary\.mjs/);
  assert.match(source, /GG_WRITEBACK_LOCK_DIR/);
  assert.match(source, /GG_NIGHTLY_ITEMS_PLAN/);
  assert.match(source, /GG_NIGHTLY_ITEMS_DIR_IDENTITY/);
  assert.match(source, /shasum -a 256/);
  assert.doesNotMatch(source, /tomllib|automation\.toml/i);
  assert.doesNotMatch(source, /codex.*exec/is);
  assert.ok(source.indexOf('node "$BRIEF_PREFLIGHT"') < source.indexOf('node "$REPAIR_CONTROLLER" drain'));
  assert.ok(source.indexOf('node "$REPAIR_CONTROLLER" drain') < source.indexOf('bash "$NIGHTLY"'));
  assert.ok(source.indexOf('bash "$NIGHTLY"') < source.indexOf('node "$REPAIR_HOOK"'));
  assert.ok(source.lastIndexOf('node "$RECONCILE"') < source.indexOf('node "$READINESS"'));
  assert.ok(source.indexOf('node "$READINESS"') < source.indexOf('node "$BATCH_SUMMARY"'));
  assert.doesNotMatch(nightlySource, /gg-batch-summary/);
  assert.match(nightlySource, /GG_SEO_PLAN/);
  assert.match(nightlySource, /GG_NIGHTLY_ITEMS_PLAN/);
  assert.doesNotMatch(nightlySource, /2026-05-27-W22-blog-output-plan\.md|PLAN_NAME=/);
  assert.doesNotMatch(nightlySource, /GG_AUTOPILOT_PLAN="\$PLAN_NAME"/);
});

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function runnerHarness({
  briefPreflightExit = 0,
  briefPreflightMutatesPlan = false,
  nightlyExit = 0,
  hookExit = 0,
  controllerExit = 0,
  reconcileExit = 0,
  preReconcileExit = reconcileExit,
  postReconcileExit = reconcileExit,
  preReconcileJson = null,
  postReconcileJson = null,
  readinessExit = 0,
  summaryExit = 0,
  lockHeld = false,
  useEnvFile = false,
  collidePinnedOracle = false,
  controllerMutatesSnapshot = false,
  controllerReplacesSnapshotDir = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-launchd-runner-'));
  const flow = join(root, 'flow');
  const oracle = join(root, 'oracle');
  const dirtyOracle = join(root, 'dirty-oracle');
  const opsTasks = join(root, 'ops/inbox-maboyang/06-tasks/tasks');
  mkdirSync(flow, { recursive: true });
  mkdirSync(join(oracle, '.git'), { recursive: true });
  mkdirSync(join(dirtyOracle, '.git'), { recursive: true });
  mkdirSync(opsTasks, { recursive: true });
  const events = join(root, 'events.log');
  const briefPreflightArgs = join(root, 'brief-preflight-args.json');
  const hookArgs = join(root, 'hook-args.json');
  const controllerArgs = join(root, 'controller-args.log');
  const summaryArgs = join(root, 'summary-args.json');
  const nightlyEnv = join(root, 'nightly-env.json');
  const reconcileEnv = join(root, 'reconcile-env.json');
  const reconcileCount = join(root, 'reconcile-count.txt');
  const readinessArgs = join(root, 'readiness-args.json');
  const nightlyLog = join(root, 'nightly.log');
  const launchdLog = join(root, 'launchd.log');
  const launchdErr = join(root, 'launchd.err.log');
  const envFile = join(root, '_gg.env');
  const plan = join(opsTasks, 'plan.md');
  const claims = join(opsTasks, '.autopilot-claims.json');
  const victimDir = join(root, 'victim');
  const victimFile = join(victimDir, 'active-plan.md');
  const initialPlanContent = '- [ ] `PG-A-001` alpha\n';
  writeFileSync(plan, initialPlanContent);
  writeFileSync(claims, '{}');
  writeFileSync(nightlyLog, 'existing bytes\n');
  mkdirSync(victimDir);
  writeFileSync(victimFile, 'VICTIM-MUST-SURVIVE\n');
  const lock = join(root, 'launchd.lock');
  if (lockHeld) mkdirSync(lock);

  const briefPreflight = join(root, 'brief-preflight.mjs');
  writeFileSync(briefPreflight, [
    "import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    "appendFileSync(process.env.GG_TEST_EVENTS, 'brief-preflight\\n');",
    "writeFileSync(process.env.GG_TEST_BRIEF_PREFLIGHT_ARGS, JSON.stringify({ args, silence: process.env.GG_LARK_NOTIFY_SILENCE || null }));",
    ...(briefPreflightMutatesPlan ? [
      "const plan = args[args.indexOf('--plan') + 1];",
      'chmodSync(plan, 0o600);',
      "writeFileSync(plan, '- [ ] `PG-MUTATED-001` changed during preflight\\n');",
    ] : []),
    "const manifestIndex = args.indexOf('--attested-manifest');",
    "if (manifestIndex >= 0) { const plan = args[args.indexOf('--plan') + 1]; const text = readFileSync(plan, 'utf8'); const digest = (await import('node:crypto')).createHash('sha256').update(text).digest('hex'); writeFileSync(args[manifestIndex + 1], JSON.stringify({ version: 1, plan_sha256: digest, requested_page_ids: ['PG-A-001'], rows: [{ page_id: 'PG-A-001', raw_line: '- [ ] `PG-A-001` alpha', keyword: 'alpha' }] })); }",
    "process.stdout.write(JSON.stringify({ mode: 'semantic-repair-only', status: 'noop' }) + '\\n');",
    `process.exit(${briefPreflightExit});`,
    '',
  ].join('\n'));
  const topicRegister = executable(
    join(root, 'topic-register-tick.sh'),
    '#!/bin/sh\nexit 0\n',
  );

  const nightly = executable(join(root, 'nightly.sh'), [
    '#!/bin/sh',
    'printf "nightly\\n" >> "$GG_TEST_EVENTS"',
    'node -e \'const fs=require("node:fs"); fs.writeFileSync(process.env.GG_TEST_NIGHTLY_ENV, JSON.stringify({ runId: process.env.GG_SEO_REPAIR_RUN_ID || null, logFile: process.env.GG_SEO_REPAIR_LOG_FILE || null, offsetStart: process.env.GG_SEO_REPAIR_LOG_OFFSET_START || null, offsetEnd: process.env.GG_SEO_REPAIR_LOG_OFFSET_END || null, oracle: process.env.GG_AUTOMATION_ORACLE_DIR || null, canonicalPlan: process.env.GG_SEO_PLAN || null, itemsPlan: process.env.GG_NIGHTLY_ITEMS_PLAN || null, itemsSha: process.env.GG_NIGHTLY_ITEMS_SHA256 || null, itemsDirIdentity: process.env.GG_NIGHTLY_ITEMS_DIR_IDENTITY || null, manifest: process.env.GG_NIGHTLY_ATTESTED_MANIFEST || null, canonicalContent: fs.readFileSync(process.env.GG_SEO_PLAN, "utf8"), itemsContent: fs.readFileSync(process.env.GG_NIGHTLY_ITEMS_PLAN, "utf8") }))\'',
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
  const controller = join(root, 'controller.mjs');
  writeFileSync(controller, [
    "import { appendFileSync, chmodSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_EVENTS, 'drain\\n');",
    "appendFileSync(process.env.GG_TEST_CONTROLLER_ARGS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    ...(controllerMutatesSnapshot ? [
      "const preflight = JSON.parse(readFileSync(process.env.GG_TEST_BRIEF_PREFLIGHT_ARGS, 'utf8'));",
      "const snapshot = preflight.args[preflight.args.indexOf('--plan') + 1];",
      'chmodSync(snapshot, 0o600);',
      "writeFileSync(snapshot, '- [ ] `PG-DRAIN-001` changed by drain\\n');",
    ] : []),
    ...(controllerReplacesSnapshotDir ? [
      "const preflight = JSON.parse(readFileSync(process.env.GG_TEST_BRIEF_PREFLIGHT_ARGS, 'utf8'));",
      "const snapshot = preflight.args[preflight.args.indexOf('--plan') + 1];",
      "const dir = new URL('.', `file://${snapshot}`).pathname.replace(/\\/$/, '');",
      "const manifestIndex = preflight.args.indexOf('--attested-manifest');",
      "if (manifestIndex >= 0) rmSync(preflight.args[manifestIndex + 1]);",
      'rmSync(snapshot);',
      'rmdirSync(dir);',
      'symlinkSync(process.env.GG_TEST_VICTIM_DIR, dir, "dir");',
    ] : []),
    `process.exit(${controllerExit});`,
    '',
  ].join('\n'));
  const reconcile = join(root, 'reconcile.mjs');
  writeFileSync(reconcile, [
    "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "const notifyOnly = process.argv.includes('--notify-only');",
    "appendFileSync(process.env.GG_TEST_EVENTS, notifyOnly ? 'notify\\n' : 'reconcile\\n');",
    "appendFileSync(process.env.GG_TEST_RECONCILE_ENV, JSON.stringify({ notifyOnly, silence: process.env.GG_LARK_NOTIFY_SILENCE || null }) + '\\n');",
    "if (notifyOnly) process.exit(0);",
    "const previous = existsSync(process.env.GG_TEST_RECONCILE_COUNT) ? Number(readFileSync(process.env.GG_TEST_RECONCILE_COUNT, 'utf8')) || 0 : 0;",
    "const call = previous + 1;",
    "writeFileSync(process.env.GG_TEST_RECONCILE_COUNT, String(call));",
    `const exits = ${JSON.stringify([preReconcileExit, postReconcileExit])};`,
    `const json = ${JSON.stringify([preReconcileJson, postReconcileJson])};`,
    "if (json[Math.min(call - 1, 1)] !== null) process.stdout.write(JSON.stringify(json[Math.min(call - 1, 1)]) + '\\n');",
    "process.exit(exits[Math.min(call - 1, 1)]);",
    '',
  ].join('\n'));
  const readiness = join(root, 'readiness.mjs');
  writeFileSync(readiness, [
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_EVENTS, 'readiness\\n');",
    "writeFileSync(process.env.GG_TEST_READINESS_ARGS, JSON.stringify(process.argv.slice(2)));",
    `process.exit(${readinessExit});`,
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

  if (useEnvFile) {
    writeFileSync(envFile, [
      `GG_SEO_NIGHTLY_BIN=${JSON.stringify(nightly)}`,
      `GG_SEO_BRIEF_PREFLIGHT_BIN=${JSON.stringify(briefPreflight)}`,
      `GG_SEO_TOPIC_REGISTER_BIN=${JSON.stringify(topicRegister)}`,
      `GG_SEO_REPAIR_HOOK_BIN=${JSON.stringify(hook)}`,
      `GG_SEO_REPAIR_CONTROLLER_BIN=${JSON.stringify(controller)}`,
      `GG_SEO_RECONCILE_BIN=${JSON.stringify(reconcile)}`,
      `GG_SEO_READINESS_BIN=${JSON.stringify(readiness)}`,
      `GG_SEO_BATCH_SUMMARY_BIN=${JSON.stringify(summary)}`,
      `GG_SEO_PLAN=${JSON.stringify(plan)}`,
      `GG_SEO_CLAIMS=${JSON.stringify(claims)}`,
      `GG_AUTOMATION_ORACLE_DIR=${JSON.stringify(join(root, 'interactive-oracle'))}`,
      ...(collidePinnedOracle ? [`PINNED_ORACLE=${JSON.stringify(dirtyOracle)}`] : []),
      '',
    ].join('\n'));
  }

  const configuredPaths = useEnvFile
    ? {}
    : {
      GG_SEO_NIGHTLY_BIN: nightly,
      GG_SEO_BRIEF_PREFLIGHT_BIN: briefPreflight,
      GG_SEO_TOPIC_REGISTER_BIN: topicRegister,
      GG_SEO_REPAIR_HOOK_BIN: hook,
      GG_SEO_REPAIR_CONTROLLER_BIN: controller,
      GG_SEO_RECONCILE_BIN: reconcile,
      GG_SEO_READINESS_BIN: readiness,
      GG_SEO_BATCH_SUMMARY_BIN: summary,
      GG_SEO_PLAN: plan,
      GG_SEO_CLAIMS: claims,
    };
  const run = () => spawnSync('bash', [runner], {
    cwd: flow,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      TMPDIR: root,
      GG_ENV_FILE: useEnvFile ? envFile : '/dev/null',
      GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW: '1',
      GG_SEO_SKIP_LEGACY_CHECK: '1',
      GG_SEO_LAUNCHD_FLOW: flow,
      GG_AUTOMATION_ORACLE_DIR: oracle,
      ...configuredPaths,
      GG_SEO_NIGHTLY_LOG: nightlyLog,
      GG_SEO_LAUNCHD_LOG: launchdLog,
      GG_SEO_LAUNCHD_ERR_LOG: launchdErr,
      GG_SEO_LAUNCHD_LOCK: lock,
      GG_TEST_EVENTS: events,
      GG_TEST_BRIEF_PREFLIGHT_ARGS: briefPreflightArgs,
      GG_TEST_HOOK_ARGS: hookArgs,
      GG_TEST_CONTROLLER_ARGS: controllerArgs,
      GG_TEST_SUMMARY_ARGS: summaryArgs,
      GG_TEST_NIGHTLY_ENV: nightlyEnv,
      GG_TEST_RECONCILE_ENV: reconcileEnv,
      GG_TEST_RECONCILE_COUNT: reconcileCount,
      GG_TEST_READINESS_ARGS: readinessArgs,
      GG_TEST_VICTIM_DIR: victimDir,
    },
  });
  const readMaybe = (path) => { try { return readFileSync(path, 'utf8'); } catch { return ''; } };
  return {
    run,
    events: () => readMaybe(events).trim().split('\n').filter(Boolean),
    briefPreflight: () => JSON.parse(readMaybe(briefPreflightArgs) || '{}'),
    hookArgs: () => JSON.parse(readMaybe(hookArgs) || '[]'),
    controllerArgs: () => readMaybe(controllerArgs).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    summaryArgs: () => JSON.parse(readMaybe(summaryArgs) || '[]'),
    nightlyEnv: () => JSON.parse(readMaybe(nightlyEnv) || '{}'),
    reconcileEnv: () => readMaybe(reconcileEnv).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    readinessArgs: () => JSON.parse(readMaybe(readinessArgs) || '[]'),
    log: () => readMaybe(launchdLog),
    plan,
    initialPlanContent,
    topicRegister,
    nightlyLog,
    oracle,
    victimFile,
    root,
  };
}

test('clean runner orders pre/post drain, strict reconcile, readiness, summary and preserves one fire-local run id', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
  const briefPreflight = h.briefPreflight();
  const nightlyEnv = h.nightlyEnv();
  assert.equal(briefPreflight.args[briefPreflight.args.indexOf('--plan') + 1], nightlyEnv.itemsPlan);
  assert.equal(briefPreflight.args[briefPreflight.args.indexOf('--topic-register-wrapper') + 1], h.topicRegister);
  assert.ok(briefPreflight.args.includes('--json'));
  assert.equal(briefPreflight.silence, '1');
  const hookArgs = h.hookArgs();
  const summaryArgs = h.summaryArgs();
  assert.equal(nightlyEnv.canonicalPlan, h.plan);
  assert.notEqual(nightlyEnv.itemsPlan, h.plan);
  assert.equal(nightlyEnv.canonicalContent, h.initialPlanContent);
  assert.equal(nightlyEnv.itemsContent, h.initialPlanContent);
  assert.match(nightlyEnv.itemsDirIdentity, /^\d+:\d+$/);
  assert.equal(existsSync(nightlyEnv.itemsPlan), false, 'launcher removes its exact private snapshot');
  assert.equal(existsSync(dirname(nightlyEnv.itemsPlan)), false, 'launcher removes its empty private directory');
  assert.equal(hookArgs[hookArgs.indexOf('--run-exit') + 1], '0');
  const runId = hookArgs[hookArgs.indexOf('--run-id') + 1];
  assert.match(runId, /^seo-blog-\d{8}T\d{6}Z-\d+$/);
  assert.equal(summaryArgs[summaryArgs.indexOf('--run-id') + 1], runId);
  assert.equal(summaryArgs[summaryArgs.indexOf('--plan') + 1], h.plan);
  assert.equal(nightlyEnv.runId, runId);
  assert.equal(nightlyEnv.logFile, h.nightlyLog);
  assert.equal(nightlyEnv.offsetStart, String(Buffer.byteLength('existing bytes\n')));
  assert.equal(nightlyEnv.offsetEnd, null);
  assert.deepEqual(
    h.reconcileEnv().map((item) => [item.notifyOnly, item.silence]),
    [[false, '1'], [true, '0'], [false, '1'], [true, '0']],
    'strict reconcile remains silent while each durable sidecar flush is explicitly unsilenced',
  );
  assert.equal(h.events().filter((event) => event === 'notify').length, 2);
  assert.equal(h.controllerArgs().length, 2);
  assert.equal(h.controllerArgs()[0][0], 'drain');
  assert.equal(h.controllerArgs()[1][0], 'drain');
  const readinessArgs = h.readinessArgs();
  assert.equal(readinessArgs[readinessArgs.indexOf('--run-id') + 1], runId);
  assert.equal(readinessArgs[readinessArgs.indexOf('--plan') + 1], h.plan);
});

test('runner sources migration config before deriving tools and plan while retaining the pinned Oracle baseline', () => {
  const h = runnerHarness({ useEnvFile: true });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
  assert.equal(h.briefPreflight().args[h.briefPreflight().args.indexOf('--plan') + 1], h.nightlyEnv().itemsPlan);
  assert.equal(h.briefPreflight().args[h.briefPreflight().args.indexOf('--topic-register-wrapper') + 1], h.topicRegister);
  assert.equal(h.nightlyEnv().oracle, h.oracle);
  assert.equal(h.hookArgs()[h.hookArgs().indexOf('--plan') + 1], h.plan);
  assert.equal(h.readinessArgs()[h.readinessArgs().indexOf('--plan') + 1], h.plan);
});

test('nightly nonzero is passed to hook and a recovered fire still reaches reconcile and summary', () => {
  const h = runnerHarness({ nightlyExit: 7, hookExit: 0 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
  const args = h.hookArgs();
  assert.equal(args[args.indexOf('--run-exit') + 1], '7');
});

test('hook failure is returned and cannot emit a false-success terminal summary', () => {
  const h = runnerHarness({ nightlyExit: 0, hookExit: 2 });
  const result = h.run();
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook']);
});

test('pre-reconcile failure flushes durable writeback notifications before early exit', () => {
  const h = runnerHarness({ reconcileExit: 4 });
  const result = h.run();
  assert.equal(result.status, 4, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify']);
});

test('active brief preflight failure stops before drain and nightly without notifications', () => {
  const h = runnerHarness({ briefPreflightExit: 9 });
  const result = h.run();
  assert.equal(result.status, 9, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight']);
  assert.match(h.log(), /active brief preflight failed.*abort before nightly/i);
  assert.doesNotMatch(h.log(), /running pre-fire repair drain/i);
});

test('active brief snapshot mutation during preflight fails closed before drain', () => {
  const h = runnerHarness({ briefPreflightMutatesPlan: true });
  const result = h.run();
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight']);
  assert.match(h.log(), /active brief snapshot changed during preflight.*abort before nightly/i);
  const snapshot = h.briefPreflight().args[h.briefPreflight().args.indexOf('--plan') + 1];
  assert.equal(existsSync(snapshot), false);
  assert.equal(existsSync(dirname(snapshot)), false);
});

test('snapshot changed by pre-fire drain is rejected immediately before nightly', () => {
  const h = runnerHarness({ controllerMutatesSnapshot: true });
  const result = h.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify']);
  assert.match(h.log(), /snapshot.*changed|identity.*failed|integrity.*failed/i);
});

test('snapshot directory replacement by parent symlink fails closed and cleanup preserves victim evidence', () => {
  const h = runnerHarness({ controllerReplacesSnapshotDir: true });
  const result = h.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify']);
  assert.equal(readFileSync(h.victimFile, 'utf8'), 'VICTIM-MUST-SURVIVE\n');
  assert.match(h.log(), /cleanup.*identity|ownership.*unknown|snapshot.*identity/i);
});

function nightlyArtifactHarness({
  missingSnapshot = false,
  tamperedSnapshot = false,
  activeSnapshotWithEmptyManifest = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gg-nightly-artifact-guard-'));
  const flowRoot = join(root, 'flow');
  const bin = join(root, '.local/bin');
  const canonical = join(root, 'canonical.md');
  const snapshot = join(root, 'snapshot.md');
  const manifest = join(root, 'attested.json');
  const claims = join(root, 'claims.json');
  const calls = join(root, 'business-calls.log');
  const log = join(root, 'nightly.log');
  const lock = join(root, 'nightly.lock');
  mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const planText = activeSnapshotWithEmptyManifest
    ? '- [ ] `PG-EMPTY-001` active but omitted\n'
    : '- [x] `PG-DONE-001` done\n';
  const digest = createHash('sha256').update(planText).digest('hex');
  writeFileSync(canonical, planText);
  writeFileSync(snapshot, planText);
  writeFileSync(manifest, JSON.stringify({ version: 1, plan_sha256: digest, requested_page_ids: [], rows: [] }));
  writeFileSync(claims, '{}\n');
  executable(join(bin, 'node'), '#!/bin/sh\nprintf "node\\t%s\\n" "$*" >> "$GG_TEST_BUSINESS_CALLS"\nexit 0\n');
  executable(join(bin, 'curl'), '#!/bin/sh\nprintf "curl\\t%s\\n" "$*" >> "$GG_TEST_BUSINESS_CALLS"\nexit 0\n');
  if (missingSnapshot) rmSync(snapshot);
  if (tamperedSnapshot) writeFileSync(snapshot, '- [ ] `PG-DRIFT-001` drift\n');
  const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
    cwd: flowRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      GG_SEO_PLAN: canonical,
      GG_NIGHTLY_ITEMS_PLAN: snapshot,
      GG_NIGHTLY_ITEMS_SHA256: digest,
      GG_NIGHTLY_ITEMS_IDENTITY: missingSnapshot ? 'missing:identity' : fileIdentity(snapshot),
      GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
      GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
      GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
      GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
      GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
      GG_NIGHTLY_FLOW: flowRoot,
      GG_NIGHTLY_CLAIMS: claims,
      GG_NIGHTLY_LOG: log,
      GG_NIGHTLY_LOCK: lock,
      GG_TEST_BUSINESS_CALLS: calls,
    },
  });
  return {
    root,
    result,
    calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
    log: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

test('nightly rejects missing or digest-drifted snapshot before replay or any business node call', () => {
  for (const options of [{ missingSnapshot: true }, { tamperedSnapshot: true }]) {
    const h = nightlyArtifactHarness(options);
    try {
      assert.notEqual(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}\n${h.log}`);
      assert.doesNotMatch(h.calls, /gg-notify|gg-seo-autopilot|gg-preview-gate|curl/);
    } finally {
      rmSync(h.root, { recursive: true, force: true });
    }
  }
});

test('nightly rejects a self-consistent empty manifest when the snapshot still has an active canonical row', () => {
  const h = nightlyArtifactHarness({ activeSnapshotWithEmptyManifest: true });
  try {
    assert.notEqual(h.result.status, 0, `${h.result.stdout}\n${h.result.stderr}\n${h.log}`);
    assert.equal(h.calls, '', 'manifest disagreement must stop before replay-outbox or auto-retry');
  } finally {
    rmSync(h.root, { recursive: true, force: true });
  }
});

test('queue-time snapshot mutation cannot change the private plan bytes consumed by author', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-nightly-private-run-copy-'));
  const pid = `PG-RUNCOPY-${process.pid}`;
  const flowRoot = join(root, 'flow');
  const bin = join(root, '.local/bin');
  const canonical = join(root, 'canonical.md');
  const snapshot = join(root, 'snapshot.md');
  const manifest = join(root, 'attested.json');
  const claims = join(root, 'claims.json');
  const calls = join(root, 'calls.log');
  const authorInput = join(root, 'author-input.md');
  const log = join(root, 'nightly.log');
  const lock = join(root, 'nightly.lock');
  const rawLine = `- [ ] \`${pid}\` original keyword`;
  const planText = `${rawLine}\n`;
  const changedText = `- [ ] \`${pid}\` changed keyword\n`;
  const digest = createHash('sha256').update(planText).digest('hex');
  try {
    mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(canonical, planText);
    writeFileSync(snapshot, planText);
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      plan_sha256: digest,
      requested_page_ids: [pid],
      rows: [{ page_id: pid, raw_line: rawLine, keyword: 'original keyword' }],
    }));
    writeFileSync(claims, '{}\n');
    executable(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
    executable(join(bin, 'node'), [
      '#!/bin/bash',
      'printf \'%s\\t%s\\n\' "${GG_AUTOPILOT_PLAN:-}" "$*" >> "$GG_TEST_NODE_CALLS"',
      "if printf '%s\\n' \"$*\" | grep -q 'gg-notify.mjs replay-outbox'; then",
      '  chmod u+w "$GG_NIGHTLY_ITEMS_PLAN"',
      '  printf \'%s\' "$GG_TEST_CHANGED_SNAPSHOT" > "$GG_NIGHTLY_ITEMS_PLAN"',
      'fi',
      `if printf '%s\\n' "$*" | grep -q -- '--author --task ${pid}'; then`,
      '  cp "$GG_AUTOPILOT_PLAN" "$GG_TEST_AUTHOR_INPUT"',
      '  mkdir -p _staging',
      `  : > "_staging/${pid}-en.md"`,
      'fi',
      "if printf '%s\\n' \"$*\" | grep -q 'gg-seo-autopilot.mjs --limit 1'; then printf 'seo/auto/2026-07-17-run-copy\\n'; fi",
      'exit 0',
      '',
    ].join('\n'));
    const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
      cwd: flowRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GG_SEO_PLAN: canonical,
        GG_NIGHTLY_ITEMS_PLAN: snapshot,
        GG_NIGHTLY_ITEMS_SHA256: digest,
        GG_NIGHTLY_ITEMS_IDENTITY: fileIdentity(snapshot),
        GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
        GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
        GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
        GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
        GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
        GG_NIGHTLY_FLOW: flowRoot,
        GG_NIGHTLY_CLAIMS: claims,
        GG_NIGHTLY_LOG: log,
        GG_NIGHTLY_LOCK: lock,
        GG_TEST_NODE_CALLS: calls,
        GG_TEST_AUTHOR_INPUT: authorInput,
        GG_TEST_CHANGED_SNAPSHOT: changedText,
      },
    });
    const nightlyLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${nightlyLog}`);
    assert.equal(readFileSync(authorInput, 'utf8'), planText);
    assert.doesNotMatch(readFileSync(authorInput, 'utf8'), /changed keyword/);
    const authorCall = readFileSync(calls, 'utf8').split('\n').find((line) => line.includes(`--author --task ${pid}`));
    assert.ok(authorCall, 'author should consume the already-attested private run input');
    assert.notEqual(authorCall.split('\t')[0], snapshot);
  } finally {
    rmSync(`/tmp/nightly-plan-${pid}.md`, { force: true });
    rmSync(`/tmp/nightly-scan-${pid}.log`, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy predictable nightly plan and scan paths cannot overwrite or feed publish', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-nightly-legacy-path-attack-'));
  const pid = `PG-LEGACYPATH-${process.pid}`;
  const flowRoot = join(root, 'flow');
  const bin = join(root, '.local/bin');
  const canonical = join(root, 'canonical.md');
  const snapshot = join(root, 'snapshot.md');
  const manifest = join(root, 'attested.json');
  const claims = join(root, 'claims.json');
  const calls = join(root, 'calls.log');
  const scanInput = join(root, 'scan-input.md');
  const planVictim = join(root, 'plan-victim.txt');
  const scanVictim = join(root, 'scan-victim.txt');
  const log = join(root, 'nightly.log');
  const lock = join(root, 'nightly.lock');
  const legacyPlan = `/tmp/nightly-plan-${pid}.md`;
  const legacyScan = `/tmp/nightly-scan-${pid}.log`;
  const rawLine = `- [ ] \`${pid}\` safe keyword`;
  const planText = `${rawLine}\n`;
  const digest = createHash('sha256').update(planText).digest('hex');
  try {
    mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(canonical, planText);
    writeFileSync(snapshot, planText);
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      plan_sha256: digest,
      requested_page_ids: [pid],
      rows: [{ page_id: pid, raw_line: rawLine, keyword: 'safe keyword' }],
    }));
    writeFileSync(claims, '{}\n');
    writeFileSync(planVictim, 'PLAN-VICTIM-MUST-SURVIVE\n');
    writeFileSync(scanVictim, 'SCAN-VICTIM-MUST-SURVIVE\n');
    rmSync(legacyPlan, { force: true });
    rmSync(legacyScan, { force: true });
    symlinkSync(planVictim, legacyPlan);
    symlinkSync(scanVictim, legacyScan);
    executable(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
    executable(join(bin, 'node'), [
      '#!/bin/bash',
      'printf \'%s\\t%s\\n\' "${GG_AUTOPILOT_PLAN:-}" "$*" >> "$GG_TEST_NODE_CALLS"',
      `if printf '%s\\n' "$*" | grep -q -- '--author --task ${pid}'; then`,
      '  mkdir -p _staging',
      `  : > "_staging/${pid}-en.md"`,
      'fi',
      "if printf '%s\\n' \"$*\" | grep -q 'gg-seo-autopilot.mjs --limit 1'; then",
      '  cp "$GG_AUTOPILOT_PLAN" "$GG_TEST_SCAN_INPUT"',
      `  printf 'seo/auto/2026-07-17-${pid}\\n'`,
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
      cwd: flowRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GG_SEO_PLAN: canonical,
        GG_NIGHTLY_ITEMS_PLAN: snapshot,
        GG_NIGHTLY_ITEMS_SHA256: digest,
        GG_NIGHTLY_ITEMS_IDENTITY: fileIdentity(snapshot),
        GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
        GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
        GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
        GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
        GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
        GG_NIGHTLY_FLOW: flowRoot,
        GG_NIGHTLY_CLAIMS: claims,
        GG_NIGHTLY_LOG: log,
        GG_NIGHTLY_LOCK: lock,
        GG_TEST_NODE_CALLS: calls,
        GG_TEST_SCAN_INPUT: scanInput,
      },
    });
    const nightlyLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${nightlyLog}`);
    assert.equal(readFileSync(planVictim, 'utf8'), 'PLAN-VICTIM-MUST-SURVIVE\n');
    assert.equal(readFileSync(scanVictim, 'utf8'), 'SCAN-VICTIM-MUST-SURVIVE\n');
    assert.equal(readFileSync(scanInput, 'utf8'), `# nightly targeted publish\n\n${rawLine}\n`);
    const scanCall = readFileSync(calls, 'utf8').split('\n').find((line) => line.includes('gg-seo-autopilot.mjs --limit 1'));
    assert.ok(scanCall);
    assert.notEqual(scanCall.split('\t')[0], legacyPlan);
    assert.notEqual(scanCall.split('\t')[0], planVictim);
  } finally {
    rmSync(legacyPlan, { force: true });
    rmSync(legacyScan, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('precreated run-private plan or scan entry stops before targeted publish', () => {
  for (const attackedName of ['nightly-plan', 'nightly-scan']) {
    const root = mkdtempSync(join(tmpdir(), `gg-nightly-private-${attackedName}-attack-`));
    const pid = `PG-${attackedName === 'nightly-plan' ? 'PLAN' : 'SCAN'}ATTACK-${process.pid}`;
    const flowRoot = join(root, 'flow');
    const bin = join(root, '.local/bin');
    const canonical = join(root, 'canonical.md');
    const snapshot = join(root, 'snapshot.md');
    const manifest = join(root, 'attested.json');
    const claims = join(root, 'claims.json');
    const calls = join(root, 'calls.log');
    const victim = join(root, 'victim.txt');
    const log = join(root, 'nightly.log');
    const lock = join(root, 'nightly.lock');
    const rawLine = `- [ ] \`${pid}\` safe keyword`;
    const planText = `${rawLine}\n`;
    const digest = createHash('sha256').update(planText).digest('hex');
    try {
      mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(canonical, planText);
      writeFileSync(snapshot, planText);
      writeFileSync(manifest, JSON.stringify({
        version: 1,
        plan_sha256: digest,
        requested_page_ids: [pid],
        rows: [{ page_id: pid, raw_line: rawLine, keyword: 'safe keyword' }],
      }));
      writeFileSync(claims, '{}\n');
      writeFileSync(victim, 'ATTACKER-CONTENT-MUST-SURVIVE\n');
      executable(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
      const attackedFile = `${attackedName}-${pid}.${attackedName === 'nightly-plan' ? 'md' : 'log'}`;
      executable(join(bin, 'node'), [
        '#!/bin/bash',
        'printf \'%s\\t%s\\n\' "${GG_AUTOPILOT_PLAN:-}" "$*" >> "$GG_TEST_NODE_CALLS"',
        `if printf '%s\\n' "$*" | grep -q -- '--author --task ${pid}'; then`,
        '  private_dir="$(dirname "$GG_AUTOPILOT_PLAN")"',
        `  ln -s "$GG_TEST_ATTACK_VICTIM" "$private_dir/${attackedFile}"`,
        '  mkdir -p _staging',
        `  : > "_staging/${pid}-en.md"`,
        'fi',
        "if printf '%s\\n' \"$*\" | grep -q 'gg-seo-autopilot.mjs --limit 1'; then printf 'seo/auto/2026-07-17-attack\\n'; fi",
        'exit 0',
        '',
      ].join('\n'));
      const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
        cwd: flowRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          GG_SEO_PLAN: canonical,
          GG_NIGHTLY_ITEMS_PLAN: snapshot,
          GG_NIGHTLY_ITEMS_SHA256: digest,
          GG_NIGHTLY_ITEMS_IDENTITY: fileIdentity(snapshot),
          GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
          GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
          GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
          GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
          GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
          GG_NIGHTLY_FLOW: flowRoot,
          GG_NIGHTLY_CLAIMS: claims,
          GG_NIGHTLY_LOG: log,
          GG_NIGHTLY_LOCK: lock,
          GG_TEST_NODE_CALLS: calls,
          GG_TEST_ATTACK_VICTIM: victim,
        },
      });
      const callLog = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
      const nightlyLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
      assert.notEqual(result.status, 0, `${attackedName}: ${result.stdout}\n${result.stderr}\n${nightlyLog}`);
      assert.doesNotMatch(callLog, /gg-seo-autopilot\.mjs --limit 1/, attackedName);
      assert.doesNotMatch(callLog, /gg-preview-gate\.mjs/, attackedName);
      assert.equal(readFileSync(victim, 'utf8'), 'ATTACKER-CONTENT-MUST-SURVIVE\n');
    } finally {
      rmSync(`/tmp/nightly-plan-${pid}.md`, { force: true });
      rmSync(`/tmp/nightly-scan-${pid}.log`, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('nightly authors from the proven snapshot and stops keyword, checked, or removed canonical drift after author', () => {
  for (const [variant, mutation] of [
    ['keyword', (pid) => `- [ ] \`${pid}\` changed keyword`],
    ['checked', (pid) => `- [x] \`${pid}\` old keyword`],
    ['removed', () => ''],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `gg-nightly-row-${variant}-`));
    const pid = `PG-ROW${variant.toUpperCase()}-${process.pid}`;
    const flowRoot = join(root, 'flow');
    const bin = join(root, '.local/bin');
    const canonical = join(root, 'canonical.md');
    const snapshot = join(root, 'snapshot.md');
    const manifest = join(root, 'attested.json');
    const claims = join(root, 'claims.json');
    const calls = join(root, 'calls.log');
    const log = join(root, 'nightly.log');
    const lock = join(root, 'nightly.lock');
    const rawLine = `- [ ] \`${pid}\` old keyword`;
    const planText = `${rawLine}\n`;
    const digest = createHash('sha256').update(planText).digest('hex');
    try {
      mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(canonical, planText);
      writeFileSync(snapshot, planText);
      writeFileSync(manifest, JSON.stringify({
        version: 1,
        plan_sha256: digest,
        requested_page_ids: [pid],
        rows: [{ page_id: pid, raw_line: rawLine, keyword: 'old keyword' }],
      }));
      writeFileSync(claims, '{}\n');
      executable(join(bin, 'curl'), '#!/bin/sh\nexit 1\n');
      executable(join(bin, 'node'), [
        '#!/bin/bash',
        'printf \'%s\\t%s\\n\' "${GG_AUTOPILOT_PLAN:-}" "$*" >> "$GG_TEST_NODE_CALLS"',
        `if printf '%s\\n' "$*" | grep -q -- '--author --task ${pid}'; then`,
        '  mkdir -p _staging',
        `  : > "_staging/${pid}-en.md"`,
        '  printf \'%s\\n\' "$GG_TEST_CANONICAL_MUTATION" > "$GG_SEO_PLAN"',
        'fi',
        "if printf '%s\\n' \"$*\" | grep -q 'gg-seo-autopilot.mjs --limit 1'; then printf 'seo/auto/2026-07-17-row\\n'; fi",
        'exit 0',
        '',
      ].join('\n'));
      const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
        cwd: flowRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
          GG_SEO_PLAN: canonical,
          GG_NIGHTLY_ITEMS_PLAN: snapshot,
          GG_NIGHTLY_ITEMS_SHA256: digest,
          GG_NIGHTLY_ITEMS_IDENTITY: fileIdentity(snapshot),
          GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
          GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
          GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
          GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
          GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
          GG_NIGHTLY_FLOW: flowRoot,
          GG_NIGHTLY_CLAIMS: claims,
          GG_NIGHTLY_LOG: log,
          GG_NIGHTLY_LOCK: lock,
          GG_TEST_NODE_CALLS: calls,
          GG_TEST_CANONICAL_MUTATION: mutation(pid),
        },
      });
      const callLog = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
      const nightlyLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
      assert.equal(result.status, 0, `${variant}: ${result.stdout}\n${result.stderr}\n${nightlyLog}`);
      const authorCall = callLog.split('\n').find((line) => line.includes(`--author --task ${pid} `));
      assert.ok(authorCall, variant);
      const authorPlan = authorCall.split('\t')[0];
      assert.notEqual(authorPlan, snapshot, variant);
      assert.notEqual(authorPlan, canonical, variant);
      assert.match(authorPlan, /\/gg-nightly-run-input\.[^/]+\/active-plan\.md$/, variant);
      assert.doesNotMatch(callLog, /gg-seo-autopilot\.mjs --limit 1/, variant);
      assert.doesNotMatch(callLog, /gg-preview-gate\.mjs/, variant);
      assert.doesNotMatch(nightlyLog, /MERGED/, variant);
      assert.match(nightlyLog, /canonical raw row.*changed|no longer matches.*attested/i, variant);
    } finally {
      rmSync(`/tmp/nightly-plan-${pid}.md`, { force: true });
      rmSync(`/tmp/nightly-scan-${pid}.log`, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('real nightly consumes only the proven snapshot and rechecks canonical unchecked ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-nightly-snapshot-contract-'));
  const suffix = String(process.pid);
  const keep = `PG-KEEP-${suffix}`;
  const removed = `PG-REMOVED-${suffix}`;
  const added = `PG-ADDED-${suffix}`;
  const flowRoot = join(root, 'gengrowth-flow-mvp');
  const tasks = join(root, 'gengrowth-ops/inbox-maboyang/06-tasks/tasks');
  const bin = join(root, '.local/bin');
  const canonical = join(tasks, '2026-05-27-W22-blog-output-plan.md');
  const snapshot = join(root, 'private-items-plan.md');
  const manifest = join(root, 'attested-manifest.json');
  const claims = join(tasks, '.autopilot-claims.json');
  const calls = join(root, 'node-calls.log');
  const log = join(root, 'nightly.log');
  const lock = join(root, 'nightly.lock');
  const ownedTmp = [keep, removed, added].flatMap((pageId) => [
    `/tmp/nightly-plan-${pageId}.md`,
    `/tmp/nightly-scan-${pageId}.log`,
  ]);
  try {
    mkdirSync(join(flowRoot, 'tools/scripts'), { recursive: true });
    mkdirSync(tasks, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(canonical, [
      `- [ ] \`${keep}\` keep keyword`,
      `- [ ] \`${added}\` added after snapshot`,
      '',
    ].join('\n'));
    const snapshotText = [
      `- [ ] \`${keep}\` keep keyword`,
      `- [ ] \`${removed}\` removed after snapshot`,
      '',
    ].join('\n');
    const snapshotDigest = createHash('sha256').update(snapshotText).digest('hex');
    writeFileSync(snapshot, snapshotText);
    writeFileSync(manifest, JSON.stringify({
      version: 1,
      plan_sha256: snapshotDigest,
      requested_page_ids: [keep, removed],
      rows: [
        { page_id: keep, raw_line: `- [ ] \`${keep}\` keep keyword`, keyword: 'keep keyword' },
        { page_id: removed, raw_line: `- [ ] \`${removed}\` removed after snapshot`, keyword: 'removed after snapshot' },
      ],
    }));
    chmodSync(snapshot, 0o400);
    writeFileSync(claims, '{}\n');
    executable(join(bin, 'curl'), '#!/bin/sh\nexit 0\n');
    executable(join(bin, 'node'), [
      '#!/bin/bash',
      'printf \'%s\\t%s\\n\' "${GG_AUTOPILOT_PLAN:-}" "$*" >> "$GG_TEST_NODE_CALLS"',
      'pid=""',
      'previous=""',
      'for arg in "$@"; do',
      '  if [ "$previous" = "--task" ]; then pid="$arg"; fi',
      '  previous="$arg"',
      'done',
      'if [ -n "$pid" ] && printf \'%s\\n\' "$*" | grep -q -- \'--author\'; then',
      '  mkdir -p _staging',
      '  : > "_staging/${pid}-en.md"',
      'fi',
      'if printf \'%s\\n\' "$*" | grep -q \'gg-seo-autopilot.mjs --limit 1\'; then',
      '  scan_pid="${GG_AUTOPILOT_PLAN##*/nightly-plan-}"',
      '  scan_pid="${scan_pid%.md}"',
      '  printf \'seo/auto/2026-07-17-%s\\n\' "$scan_pid"',
      'fi',
      'exit 0',
      '',
    ].join('\n'));

    const result = spawnSync('bash', [resolve(flow, 'tools/scripts/gg-nightly-seo.sh')], {
      cwd: flowRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        GG_SEO_PLAN: canonical,
        GG_NIGHTLY_ITEMS_PLAN: snapshot,
        GG_NIGHTLY_ITEMS_SHA256: snapshotDigest,
        GG_NIGHTLY_ITEMS_IDENTITY: fileIdentity(snapshot),
        GG_NIGHTLY_ITEMS_DIR_IDENTITY: fileIdentity(dirname(snapshot)),
        GG_NIGHTLY_ATTESTED_MANIFEST: manifest,
        GG_NIGHTLY_ATTESTED_MANIFEST_SHA256: createHash('sha256').update(readFileSync(manifest)).digest('hex'),
        GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY: fileIdentity(manifest),
        GG_NIGHTLY_VALIDATOR_NODE: process.execPath,
        GG_NIGHTLY_FLOW: flowRoot,
        GG_NIGHTLY_CLAIMS: claims,
        GG_NIGHTLY_LOG: log,
        GG_NIGHTLY_LOCK: lock,
        GG_NIGHTLY_MAX: '10',
        GG_TEST_NODE_CALLS: calls,
      },
    });
    const callLog = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
    const nightlyLog = existsSync(log) ? readFileSync(log, 'utf8') : '';
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${nightlyLog}`);
    const authorCall = callLog.split('\n').find((line) => line.includes(`--author --task ${keep} `));
    assert.ok(authorCall);
    const authorPlan = authorCall.split('\t')[0];
    assert.notEqual(authorPlan, snapshot);
    assert.notEqual(authorPlan, canonical);
    assert.match(authorPlan, /\/gg-nightly-run-input\.[^/]+\/active-plan\.md$/);
    assert.doesNotMatch(callLog, new RegExp(`--task ${removed}(?: |$)`));
    assert.doesNotMatch(callLog, new RegExp(`--task ${added}(?: |$)`));
    assert.match(nightlyLog, new RegExp(`${removed}: canonical raw row no longer matches attested snapshot.*skip`, 'i'));
  } finally {
    for (const path of ownedTmp) rmSync(path, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-fire reconcile tolerates only plan and needs-human drift so the natural run can repair it', () => {
  const h = runnerHarness({
    preReconcileExit: 2,
    postReconcileExit: 0,
    preReconcileJson: {
      ok: false,
      pendingWritebackAfter: 0,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 15,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 3,
      droppedWritebackEvidence: [],
      errors: [],
    },
    postReconcileJson: {
      ok: true,
      pendingWritebackAfter: 0,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 0,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 0,
      droppedWritebackEvidence: [],
      errors: [],
    },
  });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
  assert.match(h.log(), /pre-fire reconcile has repairable plan\/needs-human drift; continue/);
});

test('pre-fire reconcile still blocks real ledger, repair, or verification drift', () => {
  const h = runnerHarness({
    preReconcileExit: 2,
    preReconcileJson: {
      ok: false,
      pendingWritebackAfter: 1,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 15,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 3,
      droppedWritebackEvidence: [],
      errors: [],
    },
  });
  const result = h.run();
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify']);
  assert.match(h.log(), /pre-fire strict reconcile failed/);
});

test('post-fire reconcile allows only future plan backlog and still emits the terminal summary', () => {
  const h = runnerHarness({
    preReconcileExit: 0,
    postReconcileExit: 2,
    postReconcileJson: {
      ok: false,
      pendingWritebackAfter: 0,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 15,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 0,
      droppedWritebackEvidence: [],
      errors: [],
    },
  });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
  assert.match(h.log(), /post-fire reconcile has future plan backlog; continue/);
  assert.ok(h.readinessArgs().includes('--allow-plan-backlog'));
});

test('post-fire reconcile does not excuse remaining needs-human work', () => {
  const h = runnerHarness({
    preReconcileExit: 0,
    postReconcileExit: 2,
    postReconcileJson: {
      ok: false,
      pendingWritebackAfter: 0,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 15,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 1,
      droppedWritebackEvidence: [],
      errors: [],
    },
  });
  const result = h.run();
  assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify']);
  assert.match(h.log(), /strict ledger reconcile failed/);
});

for (const [name, mutate] of [
  ['unknown counter', (value) => ({ ...value, archiveBacklogAfter: 1 })],
  ['dropped evidence mismatch', (value) => ({
    ...value,
    droppedWritebackEvidence: [{ pageId: 'PG-BAD-001' }],
  })],
  ['all-zero rc2', (value) => ({
    ...value,
    planUncheckedAfter: 0,
    eligibleNeedsHumanAfter: 0,
  })],
  ['ok true with drift', (value) => ({ ...value, ok: true })],
]) {
  test(`pre-fire reconcile rejects adversarial rc=2 JSON: ${name}`, () => {
    const base = {
      ok: false,
      pendingWritebackAfter: 0,
      droppedWritebackAfter: 0,
      sheetFlipsAfter: 0,
      planUncheckedAfter: 15,
      activeRepairAfter: 0,
      expiredLeasesAfter: 0,
      eligibleNeedsHumanAfter: 3,
      droppedWritebackEvidence: [],
      errors: [],
    };
    const h = runnerHarness({
      preReconcileExit: 2,
      preReconcileJson: mutate(base),
    });
    const result = h.run();
    assert.equal(result.status, 2, `${result.stdout}\n${result.stderr}\n${h.log()}`);
    assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify']);
  });
}

test('readiness failure is returned and cannot emit a false-success terminal summary', () => {
  const h = runnerHarness({ readinessExit: 6 });
  const result = h.run();
  assert.equal(result.status, 6, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness']);
});

test('silent empty summary exit 2 is a successful completed tick', () => {
  const h = runnerHarness({ summaryExit: 2 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
});

test('readiness owns final exit after terminal summary delivery attempt', () => {
  const h = runnerHarness({ summaryExit: 3 });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), ['brief-preflight', 'drain', 'reconcile', 'notify', 'nightly', 'hook', 'drain', 'reconcile', 'notify', 'readiness', 'summary']);
});

test('outer lock makes a concurrent tick skip before nightly or hook', () => {
  const h = runnerHarness({ lockHeld: true });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), []);
  assert.match(h.log(), /another SEO launchd run holds/);
});

test('environment file cannot overwrite the internal pinned Oracle snapshot', () => {
  const h = runnerHarness({ useEnvFile: true, collidePinnedOracle: true });
  const result = h.run();
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}\n${h.log()}`);
  assert.deepEqual(h.events(), []);
  assert.match(result.stderr, /readonly variable|PINNED_ORACLE/i);
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
