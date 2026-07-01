#!/usr/bin/env node
// Run: node --test tools/scripts/__tests__/gg-brief-suggest-llm-timeout.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { callLLM } from '../gg-brief-suggest.mjs';

test('callLLM enforces the topic-register per-row timeout and kills slow workers', async () => {
  const binDir = mkdtempSync(join(tmpdir(), 'gg-fake-codex-'));
  const fakeCodex = join(binDir, 'codex');
  writeFileSync(fakeCodex, [
    '#!/bin/sh',
    'cat >/dev/null',
    'sleep 1',
    'printf "SHOULD_NOT_FINISH\\n"',
  ].join('\n'));
  chmodSync(fakeCodex, 0o755);

  const oldPath = process.env.PATH;
  const oldTopicTimeout = process.env.GG_TOPIC_REGISTER_LLM_TIMEOUT_MS;
  const oldGenericTimeout = process.env.GG_LLM_TIMEOUT_MS;
  process.env.PATH = `${binDir}:${oldPath || ''}`;
  process.env.GG_TOPIC_REGISTER_LLM_TIMEOUT_MS = '50';
  delete process.env.GG_LLM_TIMEOUT_MS;

  const started = Date.now();
  try {
    await assert.rejects(
      () => callLLM({ llm: 'codex', prompt: 'timeout test prompt' }),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 900, 'worker should be killed before its 1s sleep completes');
  } finally {
    process.env.PATH = oldPath;
    if (oldTopicTimeout == null) delete process.env.GG_TOPIC_REGISTER_LLM_TIMEOUT_MS;
    else process.env.GG_TOPIC_REGISTER_LLM_TIMEOUT_MS = oldTopicTimeout;
    if (oldGenericTimeout == null) delete process.env.GG_LLM_TIMEOUT_MS;
    else process.env.GG_LLM_TIMEOUT_MS = oldGenericTimeout;
  }
});
