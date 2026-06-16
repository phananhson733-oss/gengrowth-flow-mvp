#!/usr/bin/env node
// Smoke test for lib/red-lines.gengrowth.mjs — B2B SEO+GEO red-line profile.
//
// Pins: domain-generic checks are re-exported as functions; astrology-only
// checks are dropped (no-op PASS); RL8-B2B requires attribution for research
// claims; RL12-B2B flags bare URLs / orphan citations; the aggregate composes.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-gengrowth.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkRL1, checkRL2, checkRL3, checkRL4, checkRL5, checkRL6, checkRL7,
  checkRL8, checkRL9, checkRL10, checkRL11, checkRL12, checkRL13,
} from '../lib/red-lines.gengrowth.mjs';

test('all 13 checkRL names are exported as functions (drop-in for _phase2-validate)', () => {
  for (const fn of [checkRL1, checkRL2, checkRL3, checkRL4, checkRL5, checkRL6, checkRL7,
    checkRL8, checkRL9, checkRL10, checkRL11, checkRL12, checkRL13]) {
    assert.equal(typeof fn, 'function');
  }
});

test('astrology-only checks (RL1/RL2/RL6/RL9) are dropped → PASS no-op', () => {
  for (const fn of [checkRL1, checkRL2, checkRL6, checkRL9]) {
    const r = fn('anything at all', {});
    assert.equal(r.pass, true);
    assert.ok(/n\/a for gengrowth/i.test(r.note));
  }
});

test('RL8-B2B: unattributed research claim FAILS', () => {
  const r = checkRL8('Research shows that white label SEO grows agencies fast.');
  assert.equal(r.pass, false);
  assert.ok(r.evidence.length >= 1);
});

test('RL8-B2B: attributed research claim PASSES', () => {
  assert.equal(checkRL8('According to a 2024 report by Ahrefs, 68% of agencies resell SEO data.').pass, true);
  assert.equal(checkRL8('The data shows strong demand, per a 2023 SparkToro survey.').pass, true);
  assert.equal(checkRL8('A study by Gartner found rising white-label adoption.').pass, true);
});

test('RL8-B2B: prose with no research claim PASSES; empty PASSES', () => {
  assert.equal(checkRL8('Agencies use white-label tools to deliver branded reports.').pass, true);
  assert.equal(checkRL8('').pass, true);
  assert.equal(checkRL8(undefined).pass, true);
});

test('RL12-B2B: bare external URL FAILS; markdown link & TBD placeholder PASS', () => {
  assert.equal(checkRL12('See https://example.com/report for details.').pass, false);
  assert.equal(checkRL12('See [the report](https://example.com/report) for details.').pass, true);
  assert.equal(checkRL12('Reference: [[<TBD-external-link: ahrefs white-label study>]].').pass, true);
});

test('RL12-B2B: orphan "et al." FAILS; attributed author PASSES; never throws', () => {
  assert.equal(checkRL12('Data from et al. confirms the trend.').pass, false);
  assert.equal(checkRL12('Smith et al. (2024) documented the pattern.').pass, true);
  assert.equal(checkRL12('').pass, true);
});

test('RL8-B2B does not flag attributed claims inside a Sources section', () => {
  const md = `## How it works\nAgencies resell branded reports.\n\n## Sources\nResearch shows growth, studies show demand.`;
  // The Sources section is excluded from the prose scan.
  assert.equal(checkRL8(md).pass, true);
});

// (No aggregate redLinesCheck test: the gengrowth path runs the 13 EN checks
// individually via _phase2-validate, which supplies a full ctx. RL3/RL4/RL5
// need that ctx, so a ctx-less aggregate would be a mis-call, not a real path.)
