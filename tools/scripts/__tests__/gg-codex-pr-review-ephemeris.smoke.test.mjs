#!/usr/bin/env node
// The codex fact-check prompt must NOT FAIL on astrological ephemeris (planetary
// transit / ingress / retrograde) dates: GPT cannot verify ephemeris without tools and
// multi-stage ingresses cause false positives (PG-WC-028: "Chiron entered Taurus June 19
// 2026" is correct — initial ingress — but was FAILed). Mundane facts stay in scope.
// Run: node --test tools/scripts/__tests__/gg-codex-pr-review-ephemeris.smoke.test.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildPrompt } from '../gg-codex-pr-review.mjs';

test('fact-check prompt puts planetary transit/ingress ephemeris timing OUT OF SCOPE', () => {
  const p = buildPrompt('+ Chiron entered Taurus on June 19, 2026\n');
  assert.match(p, /ingress|transit|ephemeris/i);
  assert.match(p, /out of scope|do not (flag|fail|park)/i);
});

test('fact-check prompt keeps mundane real-world facts (birth/sports/event dates) in scope', () => {
  const p = buildPrompt('diff');
  assert.match(p, /birth date|sports|schedule|result/i);
  assert.match(p, /must FAIL|in scope/i);
});

test('birth-time provenance or rating is not guessed without authoritative evidence in the diff', () => {
  const p = buildPrompt(
    'diff --git a/data/articles/x.ts b/data/articles/x.ts\n'
    + '+A 6:31 AM birth time circulates online but is not reliably verified.',
  );
  assert.match(p, /birth.time.*provenance|provenance.*birth.time/i);
  assert.match(p, /do not fail|out of scope/i);
  assert.match(p, /authoritative.*source.*diff|diff.*authoritative.*source/i);
});
