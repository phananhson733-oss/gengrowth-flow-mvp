#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/gg-topic-register-tick.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = join(__dirname, '..', '..', '..');
const wrapper = join(repo, 'tools', 'scripts', 'gg-topic-register-tick.sh');

function printCommand(extraEnv = {}) {
  return spawnSync('bash', [wrapper, '--print-command'], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GG_TOPIC_REGISTER_ENV_FILE: '/dev/null',
      GG_TOPIC_REGISTER_PRODUCTS: 'all',
      GG_TOPIC_REGISTER_LIMIT: '10',
      ...extraEnv,
    },
  });
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
