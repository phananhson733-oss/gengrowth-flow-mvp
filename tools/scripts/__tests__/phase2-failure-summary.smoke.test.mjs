#!/usr/bin/env node

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { summarizePhase2Failure } from '../lib/phase2-failure-summary.mjs';

test('extracts actionable Phase 2 failures and ignores the loaded-fixture diagnostic', () => {
  const error = {
    stdout: [
      '✗ FAIL word count 1445 < min 1485',
      '✗ author banned token(s) matched: "mystical"',
    ].join('\n'),
    stderr: [
      '[phase2] loaded fixture: /tmp/.gg-cache/prompts/PG-X.v8-fixture.json',
      'phase2 failed',
    ].join('\n'),
  };

  assert.equal(
    summarizePhase2Failure(error),
    '- word count 1445 < min 1485\n- author banned token(s) matched: "mystical"',
  );
});

test('fallback summary never presents a fixture path as the failure reason', () => {
  const error = {
    stdout: '',
    stderr: '[phase2] loaded fixture: /tmp/.gg-cache/prompts/PG-X.v8-fixture.json\n',
  };

  const summary = summarizePhase2Failure(error);
  assert.doesNotMatch(summary, /fixture\.json/);
  assert.match(summary, /phase2 exited non-zero/i);
});

test('captures every bullet in a real Phase 2 FAIL block, not only the first item', () => {
  const error = {
    stdout: [
      '▸ Structure check',
      '  ✗ FAIL',
      '    - word count 1445 < min 1485',
      '    - missing required H2: "## <entity> vs <real adjacent concept>"',
      '',
      '▸ RL5 (keyword stuffing)',
      '  ✗ FAIL  target_keyword count = 9 (limit 8)',
      '',
      '▸ RL7 (author banned tokens)',
      '  ✗ FAIL  author banned token(s) matched: "mystical"',
    ].join('\n'),
    stderr: '[phase2] loaded fixture: /tmp/PG-X.v8-fixture.json\n',
  };

  assert.equal(
    summarizePhase2Failure(error),
    [
      '- word count 1445 < min 1485',
      '- missing required H2: "## <entity> vs <real adjacent concept>"',
      '- target_keyword count = 9 (limit 8)',
      '- author banned token(s) matched: "mystical"',
    ].join('\n'),
  );
});
