#!/usr/bin/env node
// Smoke test for RL11 — weak definitional verbs (WARN, non-blocking).
//
// "is about" / "relates to" are vague where the template wants a precise
// mechanism verb. False-positive risk is high, so RL11 is WARN ONLY: it returns
// pass:true (never blocks publish) with warn:true + a suggested replacement
// when it flags something.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl11.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL11, RL11_WEAK_VERB_PHRASES } from '../lib/red-lines.mjs';

// ---------- weak verbs → WARN (pass stays true, warn flag set) ----------
const WEAK = [
  'Saturn return is about reckoning with maturity.',
  'This transit relates to long-term commitments.',
];

for (const phrase of WEAK) {
  test(`RL11: weak verb → WARN not FAIL :: ${phrase.slice(0, 30)}`, () => {
    const draft = `# X\n\n## What is X?\n\n${phrase}`;
    const r = checkRL11(draft);
    assert.equal(r.pass, true, 'RL11 must never block (pass:true)');
    assert.equal(r.warn, true, 'warn flag should be set');
    assert.ok(Array.isArray(r.violations) && r.violations.length >= 1, 'violations populated');
    assert.ok(/governs|filters|modulates|correlates/.test(r.violations[0].hint), 'hint suggests replacements');
    assert.ok(typeof r.violations[0].line === 'number', 'violation carries a line number');
  });
}

// ---------- clean prose → no warn ----------
const CLEAN = [
  'Saturn return governs the maturity checkpoint of the late twenties.',
  'This cycle modulates how settled a person feels.',
  'Blue correlates with calm communication in subtle-energy traditions.',
];

for (const phrase of CLEAN) {
  test(`RL11: precise verb → no warn :: ${phrase.slice(0, 30)}`, () => {
    const draft = `# X\n\n## What is X?\n\n${phrase}`;
    const r = checkRL11(draft);
    assert.equal(r.pass, true);
    assert.equal(r.warn, false, 'no warn for precise verbs');
    assert.equal(r.violations.length, 0);
  });
}

test('RL11: exported phrase list is non-empty frozen array', () => {
  assert.ok(Array.isArray(RL11_WEAK_VERB_PHRASES) && RL11_WEAK_VERB_PHRASES.length > 0);
});

test('RL11: never blocks even with multiple hits', () => {
  const draft = `# X\n\n## What is X?\n\nIt is about one thing and relates to another.`;
  const r = checkRL11(draft);
  assert.equal(r.pass, true);
  assert.equal(r.warn, true);
  assert.ok(r.violations.length >= 2);
});
