#!/usr/bin/env node
// Smoke test for lib/anti-homogenization.mjs (SOP §7 batch uniqueness).
// Run: node --test tools/scripts/__tests__/lib-anti-homogenization.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkAntiHomogenization } from '../lib/anti-homogenization.mjs';

const DRAFT = `# Orange Aura

## What is Orange Aura?

Orange aura is like a warm hearth in the chest. The work of Anodea Judith grounds this reading.`;

test('no cluster_context → no opinion (pass, no warn)', () => {
  const r = checkAntiHomogenization(DRAFT, undefined);
  assert.equal(r.id, 'anti_homogenization');
  assert.equal(r.pass, true);
  assert.equal(r.warn, false);
});

test('reused metaphor → WARN (pass stays true)', () => {
  const r = checkAntiHomogenization(DRAFT, { used_metaphors: ['warm hearth'] });
  assert.equal(r.pass, true);
  assert.equal(r.warn, true);
  assert.ok(r.violations.some((v) => v.category === 'metaphor' && /hearth/i.test(v.term)));
});

test('reused authority → WARN', () => {
  const r = checkAntiHomogenization(DRAFT, { used_authorities: ['Anodea Judith'] });
  assert.equal(r.warn, true);
  assert.ok(r.violations.some((v) => v.category === 'authority'));
});

test('camelCase keys also accepted', () => {
  const r = checkAntiHomogenization(DRAFT, { usedCoreAnalogies: ['warm hearth'] });
  assert.equal(r.warn, true);
  assert.ok(r.violations.some((v) => v.category === 'analogy'));
});

test('distinct terms → PASS, no warn', () => {
  const r = checkAntiHomogenization(DRAFT, {
    used_metaphors: ['cold mountain stream'],
    used_authorities: ['Liz Greene'],
  });
  assert.equal(r.pass, true);
  assert.equal(r.warn, false);
  assert.equal(r.violations.length, 0);
});

test('too-short terms are ignored (no false positives)', () => {
  // "is" / "a" would match anything; must be filtered by MIN_TERM_LEN.
  const r = checkAntiHomogenization(DRAFT, { used_metaphors: ['is', 'a', 'of'] });
  assert.equal(r.warn, false);
  assert.equal(r.violations.length, 0);
});

test('empty draft → skipped pass', () => {
  const r = checkAntiHomogenization('', { used_metaphors: ['warm hearth'] });
  assert.equal(r.pass, true);
  assert.equal(r.warn, false);
});
