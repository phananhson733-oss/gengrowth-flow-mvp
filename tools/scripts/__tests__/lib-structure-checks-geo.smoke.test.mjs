#!/usr/bin/env node
// Smoke test for lib/structure-checks.geo.mjs (SC-GEO) + lib/citability.mjs.
//
// SC-GEO scores GEO citability and, in warn mode (the Phase 1 default), NEVER
// fails the pipeline. These tests pin: determinism, never-throws, the
// citation/stat/definition-rich draft scoring above bare prose, warn-vs-fail
// semantics, and the weak-lever advisory.
//
// Run: node --test tools/scripts/__tests__/lib-structure-checks-geo.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { scoreCitability, extractCitabilityFeatures } from '../lib/citability.mjs';
import { checkScGeo, SC_GEO_DEFAULT_THRESHOLD } from '../lib/structure-checks.geo.mjs';

// Citation/stat/definition/structure-rich draft → should score high.
const RICH = `## What is white label keyword research

**White label keyword research is the practice of producing keyword data under an agency's own brand.**

According to research by Ahrefs, 68% of agencies resell SEO data. A 2024 study by SparkToro found that 1,200,000 searches per month go unbranded.

- Tool access
- Client portal
- Branded export

> "Branding the delivery layer is the differentiator," per a report by Backlinko.

See the full method at [the guide](https://example.com/guide). The workflow is defined as a three-step pipeline.`;

// Bare prose, no stats/citations/lists/definitions → should score low.
const BARE = `White label stuff can be useful for some agencies that want to do things.
It might help in various ways and people generally like it when things work out.
There are many considerations and it depends on the situation and what you want.`;

test('scoreCitability: deterministic, same input same score', () => {
  assert.equal(scoreCitability(RICH).score, scoreCitability(RICH).score);
});

test('scoreCitability: rich draft scores strictly higher than bare prose', () => {
  assert.ok(scoreCitability(RICH).score > scoreCitability(BARE).score);
});

test('citability: never throws on empty / non-string', () => {
  assert.equal(scoreCitability('').score, 0);
  assert.equal(scoreCitability(undefined).score, 0);
  assert.equal(scoreCitability(null).score, 0);
  assert.ok(extractCitabilityFeatures(42).raw.statistics === 0);
});

test('SC-GEO warn mode never fails even when below threshold', () => {
  const r = checkScGeo(BARE); // default warn
  assert.equal(r.mode, 'warn');
  assert.equal(r.pass, true); // warn never fails the pipeline
  assert.ok(r.score < SC_GEO_DEFAULT_THRESHOLD);
  assert.equal(r.level, 'warn');
  assert.ok(r.weakFeatures.length > 0);
});

test('SC-GEO fail mode fails a weak draft, passes a strong one', () => {
  const weak = checkScGeo(BARE, { mode: 'fail', threshold: 0.5 });
  assert.equal(weak.pass, false);
  assert.equal(weak.level, 'fail');

  const strong = checkScGeo(RICH, { mode: 'fail', threshold: 0.1 });
  assert.equal(strong.pass, true);
  assert.equal(strong.level, 'ok');
});

test('SC-GEO: result shape is stable', () => {
  const r = checkScGeo(RICH);
  assert.equal(r.check, 'SC-GEO');
  assert.equal(typeof r.score, 'number');
  assert.equal(typeof r.detail, 'string');
  assert.ok(r.features && r.features.normalized);
});
