import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairFingerprint } from '../lib/seo-repair-hook.mjs';

const HOOK = 'tools/scripts/gg-seo-repair-hook.mjs';

function executable(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
  return path;
}

function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'seo-repair-hook-'));
  const ops = join(root, 'ops');
  const tasks = join(ops, 'inbox-maboyang/06-tasks/tasks');
  const stateDir = join(root, 'state');
  const bin = join(root, 'bin');
  const oracle = join(root, 'oracle');
  mkdirSync(tasks, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(oracle, '.git'), { recursive: true });

  const plan = join(tasks, 'plan.md');
  const claims = join(tasks, '.autopilot-claims.json');
  const log = join(root, 'nightly.log');
  const calls = join(root, 'codex-calls.log');
  const prompt = join(root, 'prompt.txt');
  const verifierCalls = join(root, 'verifier-calls.log');
  const controllerCalls = join(root, 'controller-calls.log');
  const statePath = join(stateDir, 'seo-repair-hook.json');
  writeFileSync(plan, options.plan || '- [ ] `PG-A-001` alpha\n- [ ] `PG-OTHER-001` other\n');
  writeFileSync(claims, JSON.stringify(options.claims || {}));
  writeFileSync(log, options.log || '===== nightly-seo done =====\n');
  if (options.archived) writeFileSync(join(tasks, '.flow-driver-archived.json'), JSON.stringify(options.archived));
  if (options.stateRaw !== undefined) writeFileSync(statePath, options.stateRaw);
  else if (options.state) writeFileSync(statePath, JSON.stringify(options.state));
  if (options.pendingWriteback) {
    const pendingDir = join(stateDir, 'pending-writeback');
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(pendingDir, `${options.pendingWriteback}.json`), JSON.stringify({ pageId: options.pendingWriteback }));
  }
  if (options.stateUnwritable) chmodSync(stateDir, 0o500);

  const timeoutBin = executable(
    join(bin, 'gtimeout'),
    options.timeoutExit ? '#!/bin/sh\nexit 124\n' : '#!/bin/sh\nshift\nexec "$@"\n',
  );
  const codexBin = executable(join(bin, 'codex'), [
    '#!/bin/sh',
    'printf "call\\n" >> "$GG_TEST_CODEX_CALLS"',
    'cat > "$GG_TEST_PROMPT"',
    'exit "${GG_TEST_CODEX_EXIT:-0}"',
    '',
  ].join('\n'));
  const verifier = join(root, 'fake-verifier.mjs');
  writeFileSync(verifier, [
    "import { readFileSync, appendFileSync } from 'node:fs';",
    "const argv = process.argv.slice(2);",
    "const get = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : ''; };",
    "appendFileSync(process.env.GG_TEST_VERIFIER_CALLS, 'call\\n');",
    "const targets = JSON.parse(readFileSync(get('--targets'), 'utf8'));",
    "const terminal = process.env.GG_TEST_VERIFY_TERMINAL || 'published';",
    "const ok = terminal === 'published' || terminal === 'archived';",
    "const results = targets.map((target) => ({ pageId: target.pageId, slug: target.slug || '', ok, terminal, checks: { fake: ok }, reason: ok ? '' : 'still pending' }));",
    "process.stdout.write(JSON.stringify({ ok, results }) + '\\n');",
    "process.exit(ok ? 0 : 2);",
    '',
  ].join('\n'));
  const controller = join(root, 'fake-controller.mjs');
  writeFileSync(controller, [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.GG_TEST_CONTROLLER_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "process.stdout.write(JSON.stringify({ ok: true, command: process.argv[2], imported: 1, processed: 1 }) + '\\n');",
    '',
  ].join('\n'));

  const run = () => spawnSync('node', [
    HOOK,
    '--run-start', '2026-07-15T10:00:00.000Z',
    '--run-exit', String(options.runExit ?? 0),
    '--log-file', log,
    '--log-offset', '0',
    '--claims', claims,
    '--plan', plan,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      GG_OPS_DIR: ops,
      GG_FLOW_STATE_DIR: stateDir,
      GG_AUTOMATION_ORACLE_DIR: oracle,
      GG_SEO_REPAIR_HOOK_ENABLED: options.enabled === false ? '0' : '1',
      GG_SEO_REPAIR_CONTROLLER_V2_ENABLED: options.v2 ? '1' : '0',
      GG_SEO_REPAIR_CONTROLLER_BIN: controller,
      GG_SEO_REPAIR_CODEX_BIN: codexBin,
      GG_SEO_REPAIR_TIMEOUT_BIN: timeoutBin,
      GG_SEO_REPAIR_TIMEOUT_SECONDS: '30',
      GG_SEO_REPAIR_MAX_TARGETS: '2',
      GG_SEO_REPAIR_MAX_ATTEMPTS: '2',
      GG_REPAIR_VERIFY_BIN: verifier,
      GG_SEO_REPAIR_LOG_DIR: join(root, 'repair-logs'),
      GG_SEO_REPAIR_NO_NOTIFY: '1',
      GG_TEST_CODEX_CALLS: calls,
      GG_TEST_PROMPT: prompt,
      GG_TEST_CODEX_EXIT: String(options.codexExit ?? 0),
      GG_TEST_VERIFY_TERMINAL: options.verifyTerminal || 'published',
      GG_TEST_VERIFIER_CALLS: verifierCalls,
      GG_TEST_CONTROLLER_CALLS: controllerCalls,
    },
  });

  const readMaybe = (path, fallback = '') => {
    try { return readFileSync(path, 'utf8'); } catch { return fallback; }
  };
  return {
    run,
    codexCalls: () => readMaybe(calls).trim().split('\n').filter(Boolean).length,
    verifierCalls: () => readMaybe(verifierCalls).trim().split('\n').filter(Boolean).length,
    controllerCalls: () => readMaybe(controllerCalls).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    prompt: () => readMaybe(prompt),
    state: () => JSON.parse(readMaybe(statePath, '{}')),
  };
}

const FIXABLE = {
  'PG-A-001': {
    status: 'needs_human',
    stage: 'authoring',
    slug: 'alpha',
    error: 'phase2 FAIL: drifted sections',
  },
};

test('v2 flag delegates the legacy hook arguments to the universal controller', () => {
  const h = harness({ claims: FIXABLE, v2: true });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 0);
  assert.equal(h.verifierCalls(), 0);
  assert.equal(h.controllerCalls().length, 1);
  assert.equal(h.controllerCalls()[0][0], 'import-v1');
  assert.ok(h.controllerCalls()[0].includes('--claims'));
  assert.match(result.stdout, /"processed":1/);
});

test('clean state exits zero without invoking Codex or verifier', () => {
  const h = harness();
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 0);
  assert.equal(h.verifierCalls(), 0);
  assert.match(result.stdout, /^SEO_REPAIR_HOOK_RESULT: /);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout.replace(/^SEO_REPAIR_HOOK_RESULT: /, '')).terminal, 'clean');
});

test('recovered phase2 and Codex review failures do not trigger a synthetic RUN repair', () => {
  const h = harness({
    log: [
      '[autopilot] phase2 attempt 1/3 failed:',
      '- word count 1490 < min 1500',
      '[autopilot] AUTHORED PG-A-001 → draft',
      'codex: FAIL — author claim unsupported',
      'repair[codex]: applied 1 edit(s) + pushed — re-running codex',
      'codex: PASS — PASS',
      'PG-A-001: MERGED → live',
      '===== nightly-seo done =====',
    ].join('\n'),
  });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 0);
  assert.match(result.stdout, /"terminal":"clean"/);
});

test('eligible park persists attempt, invokes Codex once, and verifies the exact target', () => {
  const h = harness({ claims: FIXABLE });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 1);
  assert.equal(h.verifierCalls(), 1);
  assert.match(h.prompt(), /TARGETS_JSON/);
  assert.match(h.prompt(), /PG-A-001/);
  assert.doesNotMatch(h.prompt(), /PG-OTHER-001/);
  assert.match(h.prompt(), /"attempt": 1/);
  const entry = Object.values(h.state())[0];
  assert.equal(entry.attempts, 1);
  assert.equal(entry.status, 'published');
  const output = JSON.parse(result.stdout.replace(/^SEO_REPAIR_HOOK_RESULT: /, ''));
  assert.equal(output.agent.timeoutSeconds, 30);
  assert.equal(Number.isInteger(output.agent.pid), true);
  assert.deepEqual(output.agent.attempts, [{ pageId: 'PG-A-001', attempt: 1 }]);
});

test('done claim with pending writeback is selected for one-shot repair', () => {
  const h = harness({
    plan: '- [x] `PG-A-001` alpha\n',
    claims: {
      'PG-A-001': {
        status: 'done',
        stage: 'published',
        slug: 'alpha',
        branch: 'seo/alpha',
        mergedAt: '2026-07-15T10:00:00Z',
      },
    },
    pendingWriteback: 'PG-A-001',
  });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 1);
  assert.match(h.prompt(), /"stage": "backfill"/);
});

test('disabled hook with an eligible target never increments or invokes Codex', () => {
  const h = harness({ claims: FIXABLE, enabled: false });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.codexCalls(), 0);
  assert.deepEqual(h.state(), {});
  assert.match(result.stdout, /human_only/);
});

test('corrupt state fails closed before invoking Codex', () => {
  const h = harness({ claims: FIXABLE, stateRaw: '{not-json' });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.codexCalls(), 0);
  assert.match(result.stdout, /state_unavailable/);
});

test('unwritable state fails closed before invoking Codex', () => {
  const h = harness({ claims: FIXABLE, stateUnwritable: true });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.codexCalls(), 0);
  assert.match(result.stdout, /state_unavailable/);
});

test('attempt cap produces human_only and third identical fire never invokes Codex', () => {
  const claim = FIXABLE['PG-A-001'];
  const fingerprint = repairFingerprint({ pageId: 'PG-A-001', stage: claim.stage, error: claim.error });
  const h = harness({
    claims: FIXABLE,
    state: { [fingerprint]: { pageId: 'PG-A-001', attempts: 2, status: 'pending' } },
  });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.codexCalls(), 0);
  assert.equal(h.state()[fingerprint].status, 'human_only');
});

test('run-level nonzero without a claim creates one synthetic Agent target', () => {
  const h = harness({ runExit: 7, log: 'fatal wrapper exit 7\n' });
  const result = h.run();
  assert.equal(h.codexCalls(), 1, `${result.stdout}\n${result.stderr}`);
  assert.match(h.prompt(), /"pageId": "RUN"/);
});

test('Agent nonzero consumes one attempt, skips verifier, and remains pending', () => {
  const h = harness({ claims: FIXABLE, codexExit: 9 });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.codexCalls(), 1);
  assert.equal(h.verifierCalls(), 0);
  const entry = Object.values(h.state())[0];
  assert.equal(entry.attempts, 1);
  assert.equal(entry.status, 'pending');
  assert.match(entry.lastError, /codex.*9/i);
});

test('gtimeout exit 124 consumes one attempt and never invokes the verifier', () => {
  const h = harness({ claims: FIXABLE, timeoutExit: true });
  const result = h.run();
  assert.equal(result.status, 2);
  assert.equal(h.verifierCalls(), 0);
  const entry = Object.values(h.state())[0];
  assert.equal(entry.attempts, 1);
  assert.equal(entry.status, 'pending');
  assert.match(entry.lastError, /124/);
});

test('stale unfixable park is archived without invoking Codex', () => {
  const h = harness({
    claims: {
      'PG-A-001': {
        status: 'needs_human',
        stage: 'pushed-preview',
        slug: 'alpha',
        error: 'stale topic — prediction expired — do not publish',
      },
    },
  });
  const result = h.run();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(h.codexCalls(), 0);
  assert.equal(Object.values(h.state())[0].status, 'archived');
  assert.match(result.stdout, /archived/);
});
