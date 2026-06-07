#!/usr/bin/env node
// Smoke tests for review-fact-guard.mjs.
// Run: node --test tools/scripts/__tests__/lib-review-fact-guard.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  detectProtectedFactDrift,
  extractProtectedReviewFacts,
  summarizeProtectedFactDrift,
} from '../lib/review-fact-guard.mjs';

test('extractProtectedReviewFacts captures dates, exact times, sign degrees, and urls', () => {
  const facts = extractProtectedReviewFacts(`
    Full moon June 30, 2026 peaks at 7:56 p.m. EDT / 23:56 UTC.
    Mercury stations at 26° Cancer.
    CTA: https://astrologywiki.com/en/wiki/how-to-read-birth-chart
  `);
  assert.deepEqual(facts.calendar_dates, ['june 30, 2026']);
  assert.deepEqual(facts.exact_times, ['23:56 utc', '7:56 p.m. edt']);
  assert.deepEqual(facts.sign_degrees, ['26° cancer']);
  assert.deepEqual(facts.urls, ['https://astrologywiki.com/en/wiki/how-to-read-birth-chart']);
});

test('detectProtectedFactDrift ignores prose-only rewrites when protected facts stay identical', () => {
  const before = 'Full moon June 30, 2026 favors review. CTA https://example.com/x';
  const after = 'Full moon June 30, 2026 favors a slower review window. CTA https://example.com/x';
  const drift = detectProtectedFactDrift(before, after);
  assert.equal(drift.hasDrift, false);
  assert.equal(summarizeProtectedFactDrift(drift), 'no protected-fact drift');
});

test('detectProtectedFactDrift flags newly introduced calendar dates', () => {
  const before = 'The peak lands on June 30, 2026.';
  const after = 'The peak lands on June 29, 2026 for US readers and June 30, 2026 elsewhere.';
  const drift = detectProtectedFactDrift(before, after);
  assert.equal(drift.hasDrift, true);
  assert.deepEqual(drift.categories.calendar_dates.added, ['june 29, 2026']);
  assert.deepEqual(drift.categories.calendar_dates.removed, []);
  assert.match(summarizeProtectedFactDrift(drift), /calendar_dates/);
});

test('detectProtectedFactDrift flags swapped urls and sign-degree edits', () => {
  const before = 'Mercury stations at 26° Cancer. CTA https://example.com/a';
  const after = 'Mercury stations at 26° Gemini. CTA https://example.com/b';
  const drift = detectProtectedFactDrift(before, after);
  assert.equal(drift.hasDrift, true);
  assert.deepEqual(drift.categories.sign_degrees.removed, ['26° cancer']);
  assert.deepEqual(drift.categories.sign_degrees.added, ['26° gemini']);
  assert.deepEqual(drift.categories.urls.removed, ['https://example.com/a']);
  assert.deepEqual(drift.categories.urls.added, ['https://example.com/b']);
});
