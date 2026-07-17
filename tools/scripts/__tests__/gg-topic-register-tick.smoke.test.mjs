#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..', '..');
const wrapper = join(repo, 'tools', 'scripts', 'gg-topic-register-tick.sh');

function printCommand(extraEnv = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-print-command-'));
  return spawnSync('bash', [wrapper, '--print-command'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOG_DIR: join(tmp, 'logs'),
      GG_TOPIC_REGISTER_PRODUCTS: 'all',
      GG_TOPIC_REGISTER_LIMIT: '10',
      ...extraEnv,
    },
  });
}

function captureExit(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitFor(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function withTimeout(promise, label, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('wrapper enables v1 fallback by default when v2 preprocessor needs evidence', () => {
  const r = printCommand();

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--llm claude/);
  // v1 fallback 默认开：不应出现禁用 flag
  assert.doesNotMatch(r.stdout, /--no-preprocessor-fallback/);
});

test('wrapper still allows explicitly selecting codex', () => {
  const r = printCommand({ GG_TOPIC_REGISTER_LLM: 'codex' });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--llm codex/);
});

test('wrapper still allows explicitly disabling preprocessor fallback', () => {
  const r = printCommand({ GG_TOPIC_REGISTER_ALLOW_PREPROCESSOR_FALLBACK: '0' });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--no-preprocessor-fallback/);
});

test('wrapper gives Node an internal budget before the outer timeout can kill it', () => {
  const r = printCommand({ GG_TOPIC_REGISTER_TIMEOUT: '900' });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--run-budget-ms 840000\b/);
});

test('wrapper emits structured JSON when an active lock skips the run', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-lock-'));
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  mkdirSync(lock);
  mkdirSync(logDir);
  writeFileSync(join(lock, 'pid'), String(process.pid));

  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_APPLY: '0',
      GG_TOPIC_REGISTER_LLM: 'none',
    },
  });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const logs = readdirSync(logDir).filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 1);
  const log = readFileSync(join(logDir, logs[0]), 'utf8');
  assert.match(log, /lock_active/);
  assert.match(log, /"skipped": true/);
});

test('wrapper maps strict semantic repair to one bounded command', () => {
  const r = printCommand({
    GG_TOPIC_REGISTER_PRODUCTS: 'astrologywiki',
    GG_TOPIC_REGISTER_LIMIT: '2',
    GG_TOPIC_REGISTER_LLM: 'none',
    GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
    GG_TOPIC_REGISTER_APPLY: '1',
    GG_TOPIC_REGISTER_NO_NOTIFY: '1',
    GG_TOPIC_REGISTER_REPAIR_PAGE_IDS: 'PG-WDIF-002,PG-WDIN-001',
    GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY: '1',
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--product astrologywiki/);
  assert.match(r.stdout, /--limit 2/);
  assert.match(r.stdout, /--semantic-repair-only/);
  assert.match(r.stdout, /--apply/);
  assert.match(r.stdout, /--no-notify/);
  assert.match(r.stdout, /--repair-page-ids PG-WDIF-002,PG-WDIN-001/);
  assert.doesNotMatch(
    r.stdout,
    /--llm|--discover-evidence|--include-incomplete|--generate|--audit|--reassign-existing/,
  );
});

test('_gg.env cannot overwrite an explicit semantic repair mode', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-semantic-env-'));
  const envFile = join(tmp, '_gg.env');
  writeFileSync(envFile, 'GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY=0\n');
  const r = printCommand({
    GG_TOPIC_REGISTER_ENV_FILE: envFile,
    GG_TOPIC_REGISTER_LLM: 'none',
    GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
    GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY: '1',
  });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--semantic-repair-only/);
});

test('require-run turns an active lock into structured rc 75 without stealing it', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-strict-lock-'));
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const resultFile = join(tmp, 'result.json');
  mkdirSync(lock);
  mkdirSync(logDir);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
    },
  });
  assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ok: false,
    skipped: true,
    reason: 'lock_active',
    active_pid: String(process.pid),
  });
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), String(process.pid));
});

test('_gg.env cannot overwrite explicit require-run and result-file values', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-strict-env-'));
  const envFile = join(tmp, '_gg.env');
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const resultFile = join(tmp, 'explicit-result.json');
  const envResultFile = join(tmp, 'env-result.json');
  mkdirSync(lock);
  mkdirSync(logDir);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  writeFileSync(
    envFile,
    `GG_TOPIC_REGISTER_REQUIRE_RUN=0\nGG_TOPIC_REGISTER_RESULT_FILE=${envResultFile}\n`,
  );
  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      GG_TOPIC_REGISTER_ENV_FILE: envFile,
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
    },
  });

  assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ok: false,
    skipped: true,
    reason: 'lock_active',
    active_pid: String(process.pid),
  });
  assert.equal(existsSync(envResultFile), false);
});

test('require-run turns a lost lock race into structured rc 75 without removing the lock path', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-lock-race-'));
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const resultFile = join(tmp, 'result.json');
  mkdirSync(logDir);
  writeFileSync(lock, 'race-winner');
  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
    },
  });
  assert.equal(r.status, 75, `${r.stdout}${r.stderr}`);
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ok: false,
    skipped: true,
    reason: 'lock_race',
  });
  assert.equal(readFileSync(lock, 'utf8'), 'race-winner');
});

test('wrapper atomically writes pure Node stdout JSON to the result artifact', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-result-'));
  const bashEnv = join(tmp, 'bash-env');
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const resultDir = join(tmp, 'results');
  const resultFile = join(resultDir, 'result.json');
  mkdirSync(logDir);
  writeFileSync(
    bashEnv,
    'node() { printf \'%s\\n\' \'{"ok":true,"payload":"node-only"}\'; printf \'%s\\n\' \'node diagnostic\' >&2; }\n' +
      'gtimeout() { shift 3; "$@"; }\n',
  );

  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      BASH_ENV: bashEnv,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_LLM: 'none',
      GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
      GG_TOPIC_REGISTER_TIMEOUT: '10',
    },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(readFileSync(resultFile, 'utf8'), '{"ok":true,"payload":"node-only"}\n');
  assert.deepEqual(readdirSync(resultDir), ['result.json']);
  const logs = readdirSync(logDir).filter((f) => f.endsWith('.log'));
  assert.equal(logs.length, 1);
  const log = readFileSync(join(logDir, logs[0]), 'utf8');
  assert.match(log, /node diagnostic/);
  assert.match(log, /\{"ok":true,"payload":"node-only"\}/);
  assert.match(log, /topic-register ok/);
  assert.doesNotMatch(readFileSync(resultFile, 'utf8'), /node diagnostic|topic-register ok/);
});

test('an old canonical lock without a pid is recovered and enters Node exactly once', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-orphan-lock-'));
  const bashEnv = join(tmp, 'bash-env');
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const marker = join(tmp, 'node-calls');
  const resultFile = join(tmp, 'result.json');
  mkdirSync(lock);
  mkdirSync(logDir);
  const old = new Date(Date.now() - 10_000);
  utimesSync(lock, old, old);
  writeFileSync(
    bashEnv,
    'node() { command printf \'node\\n\' >> "$GG_TEST_NODE_MARKER"; printf \'%s\\n\' \'{"ok":true,"recovered":"orphan"}\'; }\n' +
      'gtimeout() { shift 3; "$@"; }\n',
  );

  const r = spawnSync('bash', [wrapper], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      BASH_ENV: bashEnv,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
      GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
      GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS: '1',
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
      GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
      GG_TEST_NODE_MARKER: marker,
    },
  });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(readFileSync(marker, 'utf8'), 'node\n');
  assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
    ok: true,
    recovered: 'orphan',
  });
});

test('abandoned reclaim claims with missing or dead pids are recovered safely', () => {
  for (const claimState of ['missing', 'dead']) {
    const tmp = mkdtempSync(join(tmpdir(), `gg-topic-register-abandoned-${claimState}-`));
    const bashEnv = join(tmp, 'bash-env');
    const lock = join(tmp, 'lock');
    const reclaim = join(lock, '.reclaim');
    const logDir = join(tmp, 'logs');
    const marker = join(tmp, 'node-calls');
    mkdirSync(reclaim, { recursive: true });
    mkdirSync(logDir);
    writeFileSync(join(lock, 'pid'), '999991');
    if (claimState === 'dead') writeFileSync(join(reclaim, 'pid'), '999992');
    const old = new Date(Date.now() - 10_000);
    utimesSync(reclaim, old, old);
    writeFileSync(
      bashEnv,
      'node() { command printf \'node\\n\' >> "$GG_TEST_NODE_MARKER"; printf \'%s\\n\' \'{"ok":true,"recovered":"claim"}\'; }\n' +
        'gtimeout() { shift 3; "$@"; }\n',
    );

    const r = spawnSync('bash', [wrapper], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        BASH_ENV: bashEnv,
        GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
        GG_TOPIC_REGISTER_LOCK: lock,
        GG_TOPIC_REGISTER_LOG_DIR: logDir,
        GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
        GG_TOPIC_REGISTER_RESULT_FILE: join(tmp, 'result.json'),
        GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS: '1',
        GG_TOPIC_REGISTER_APPLY: '1',
        GG_TOPIC_REGISTER_LLM: 'none',
        GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
        GG_TEST_NODE_MARKER: marker,
      },
    });

    assert.equal(r.status, 0, `${claimState}: ${r.stdout}${r.stderr}`);
    assert.equal(readFileSync(marker, 'utf8'), 'node\n', claimState);
  }
});

test('a pid-less lock inside initialization grace is never stolen in default or strict mode', () => {
  for (const requireRun of ['0', '1']) {
    const tmp = mkdtempSync(join(tmpdir(), `gg-topic-register-live-init-${requireRun}-`));
    const bashEnv = join(tmp, 'bash-env');
    const lock = join(tmp, 'lock');
    const logDir = join(tmp, 'logs');
    const marker = join(tmp, 'node-called');
    const resultFile = join(tmp, 'result.json');
    mkdirSync(lock);
    mkdirSync(logDir);
    writeFileSync(join(lock, 'initializing'), 'owner-state');
    writeFileSync(
      bashEnv,
      'node() { command touch "$GG_TEST_NODE_MARKER"; printf \'%s\\n\' \'{"ok":true}\'; }\n' +
        'gtimeout() { shift 3; "$@"; }\n',
    );

    const r = spawnSync('bash', [wrapper], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        BASH_ENV: bashEnv,
        GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
        GG_TOPIC_REGISTER_LOCK: lock,
        GG_TOPIC_REGISTER_LOG_DIR: logDir,
        GG_TOPIC_REGISTER_REQUIRE_RUN: requireRun,
        GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
        GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS: '60',
        GG_TOPIC_REGISTER_APPLY: '1',
        GG_TOPIC_REGISTER_LLM: 'none',
        GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
        GG_TEST_NODE_MARKER: marker,
      },
    });

    assert.equal(r.status, requireRun === '1' ? 75 : 0, `${r.stdout}${r.stderr}`);
    assert.equal(existsSync(marker), false, requireRun);
    assert.equal(readFileSync(join(lock, 'initializing'), 'utf8'), 'owner-state');
    assert.deepEqual(JSON.parse(readFileSync(resultFile, 'utf8')), {
      ok: requireRun !== '1',
      skipped: true,
      reason: 'lock_race',
    });
  }
});

test('pid publication failure or unprovable ownership fails closed before Node', () => {
  for (const failureMode of ['publish-failure', 'owner-changed']) {
    const tmp = mkdtempSync(join(tmpdir(), `gg-topic-register-publish-${failureMode}-`));
    const bashEnv = join(tmp, 'bash-env');
    const lock = join(tmp, 'lock');
    const logDir = join(tmp, 'logs');
    const marker = join(tmp, 'node-called');
    const resultFile = join(tmp, 'result.json');
    mkdirSync(logDir);
    const fault =
      failureMode === 'publish-failure'
        ? 'mkdir() { if [ "$#" -eq 1 ] && [ "$1" = "$GG_TOPIC_REGISTER_LOCK" ]; then command mkdir "$1" || return; command mkdir "$1/pid"; return 0; fi; command mkdir "$@"; }\n'
        : 'mv() { if [ "$#" -eq 2 ] && [ "$2" = "$GG_TOPIC_REGISTER_LOCK/pid" ]; then command mv "$@" || return; command printf \'999993\\n\' > "$2"; return 0; fi; command mv "$@"; }\n';
    writeFileSync(
      bashEnv,
      fault +
        'node() { command touch "$GG_TEST_NODE_MARKER"; printf \'%s\\n\' \'{"ok":true}\'; }\n' +
        'gtimeout() { shift 3; "$@"; }\n',
    );

    const r = spawnSync('bash', [wrapper], {
      cwd: repo,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: tmp,
        BASH_ENV: bashEnv,
        GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
        GG_TOPIC_REGISTER_LOCK: lock,
        GG_TOPIC_REGISTER_LOG_DIR: logDir,
        GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
        GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
        GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS: '1',
        GG_TOPIC_REGISTER_APPLY: '1',
        GG_TOPIC_REGISTER_LLM: 'none',
        GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
        GG_TEST_NODE_MARKER: marker,
      },
    });

    assert.equal(r.status, 75, `${failureMode}: ${r.stdout}${r.stderr}`);
    assert.equal(existsSync(marker), false, failureMode);
    assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).reason, 'lock_race');
  }
});

test('stale-lock reclaim lets exactly one strict apply runner enter Node and preserves its lock', { timeout: 15000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-stale-race-'));
  const harnessDir = join(tmp, 'harness');
  const bashEnv = join(tmp, 'bash-env');
  const lock = join(tmp, 'lock');
  const logDir = join(tmp, 'logs');
  const stalePid = '999999';
  mkdirSync(harnessDir);
  mkdirSync(lock);
  mkdirSync(logDir);
  writeFileSync(join(lock, 'pid'), stalePid);
  writeFileSync(
    bashEnv,
    'wait_for_file() { local waited=0; while [ ! -f "$1" ]; do waited=$((waited + 1)); if [ "$waited" -ge 500 ]; then return 1; fi; /bin/sleep 0.01; done; }\n' +
      'kill() { if [ "${1:-}" = "-0" ] && [ "${2:-}" = "$GG_TEST_STALE_PID" ]; then command touch "$GG_TEST_HARNESS/checked.$GG_TEST_ROLE"; wait_for_file "$GG_TEST_HARNESS/checked.$GG_TEST_OTHER_ROLE" || return 1; if [ "$GG_TEST_ROLE" = "B" ]; then wait_for_file "$GG_TEST_HARNESS/node.A" || return 1; fi; return 1; fi; builtin kill "$@"; }\n' +
      'node() { command touch "$GG_TEST_HARNESS/node.$GG_TEST_ROLE"; if [ "$GG_TEST_ROLE" = "A" ]; then wait_for_file "$GG_TEST_HARNESS/release.A" || return 99; fi; printf \'{"ok":true,"role":"%s"}\\n\' "$GG_TEST_ROLE"; }\n' +
      'gtimeout() { shift 3; "$@"; }\n',
  );

  const commonEnv = {
    PATH: process.env.PATH,
    HOME: tmp,
    BASH_ENV: bashEnv,
    GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
    GG_TOPIC_REGISTER_LOCK: lock,
    GG_TOPIC_REGISTER_LOG_DIR: logDir,
    GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
    GG_TOPIC_REGISTER_APPLY: '1',
    GG_TOPIC_REGISTER_LLM: 'none',
    GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
    GG_TOPIC_REGISTER_TIMEOUT: '10',
    GG_TEST_HARNESS: harnessDir,
    GG_TEST_STALE_PID: stalePid,
  };
  const runnerA = spawn('bash', [wrapper], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...commonEnv,
      GG_TEST_ROLE: 'A',
      GG_TEST_OTHER_ROLE: 'B',
      GG_TOPIC_REGISTER_RESULT_FILE: join(tmp, 'result-A.json'),
    },
  });
  const runnerAExit = captureExit(runnerA);
  const runnerB = spawn('bash', [wrapper], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...commonEnv,
      GG_TEST_ROLE: 'B',
      GG_TEST_OTHER_ROLE: 'A',
      GG_TOPIC_REGISTER_RESULT_FILE: join(tmp, 'result-B.json'),
    },
  });
  const runnerBExit = captureExit(runnerB);
  let runnerAResult;

  try {
    const runnerBResult = await withTimeout(runnerBExit, 'runner B exit');
    const nodeEntries = readdirSync(harnessDir)
      .filter((entry) => entry.startsWith('node.'))
      .sort();
    assert.deepEqual(nodeEntries, ['node.A']);
    assert.equal(runnerBResult.code, 75, `${runnerBResult.stdout}${runnerBResult.stderr}`);
    assert.deepEqual(JSON.parse(readFileSync(join(tmp, 'result-B.json'), 'utf8')), {
      ok: false,
      skipped: true,
      reason: 'lock_active',
      active_pid: String(runnerA.pid),
    });
    assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(runnerA.pid));
  } finally {
    writeFileSync(join(harnessDir, 'release.A'), '');
    runnerAResult = await withTimeout(runnerAExit, 'runner A exit');
    if (runnerB.exitCode === null) runnerB.kill('SIGTERM');
  }

  assert.equal(runnerAResult.code, 0, `${runnerAResult.stdout}${runnerAResult.stderr}`);
});

test('EXIT cleanup preserves a successor lock not owned by the exiting process', { timeout: 10000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-topic-register-owner-cleanup-'));
  const harnessDir = join(tmp, 'harness');
  const bashEnv = join(tmp, 'bash-env');
  const lock = join(tmp, 'lock');
  const displacedLock = join(tmp, 'displaced-lock');
  const logDir = join(tmp, 'logs');
  mkdirSync(harnessDir);
  mkdirSync(logDir);
  writeFileSync(
    bashEnv,
    'node() { command touch "$GG_TEST_HARNESS/node.entered"; local waited=0; while [ ! -f "$GG_TEST_HARNESS/release" ]; do waited=$((waited + 1)); if [ "$waited" -ge 500 ]; then return 99; fi; /bin/sleep 0.01; done; printf \'{"ok":true}\\n\'; }\n' +
      'gtimeout() { shift 3; "$@"; }\n',
  );
  const runner = spawn('bash', [wrapper], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      HOME: tmp,
      BASH_ENV: bashEnv,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_LOCK: lock,
      GG_TOPIC_REGISTER_LOG_DIR: logDir,
      GG_TOPIC_REGISTER_RESULT_FILE: join(tmp, 'result.json'),
      GG_TOPIC_REGISTER_APPLY: '1',
      GG_TOPIC_REGISTER_LLM: 'none',
      GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
      GG_TOPIC_REGISTER_TIMEOUT: '10',
      GG_TEST_HARNESS: harnessDir,
    },
  });
  const runnerExit = captureExit(runner);

  await waitFor(() => existsSync(join(harnessDir, 'node.entered')), 'runner to enter Node');
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(runner.pid));
  renameSync(lock, displacedLock);
  mkdirSync(lock);
  writeFileSync(join(lock, 'pid'), String(process.pid));
  writeFileSync(join(harnessDir, 'release'), '');
  const runnerResult = await withTimeout(runnerExit, 'owner runner exit');

  assert.equal(runnerResult.code, 0, `${runnerResult.stdout}${runnerResult.stderr}`);
  assert.equal(existsSync(lock), true, 'owner cleanup removed a successor lock');
  assert.equal(readFileSync(join(lock, 'pid'), 'utf8').trim(), String(process.pid));
});
