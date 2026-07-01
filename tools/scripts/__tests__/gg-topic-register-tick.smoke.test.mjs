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
  assert.match(r.stdout, /--allow-preprocessor-fallback/);
});

test('wrapper still allows explicitly selecting codex', () => {
  const r = printCommand({ GG_TOPIC_REGISTER_LLM: 'codex' });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /--llm codex/);
});

test('wrapper still allows explicitly disabling preprocessor fallback', () => {
  const r = printCommand({ GG_TOPIC_REGISTER_ALLOW_PREPROCESSOR_FALLBACK: '0' });

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stdout, /--allow-preprocessor-fallback/);
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
