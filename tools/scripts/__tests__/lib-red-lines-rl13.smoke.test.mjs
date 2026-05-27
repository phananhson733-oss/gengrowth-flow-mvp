#!/usr/bin/env node
// Smoke test for RL13 — SOP v4.3 §7 banned jargon + AI metaphors.
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl13.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL13 } from '../lib/red-lines.mjs';

test('RL13: hard jargon (delve) → FAIL', () => {
  const draft = `# Orange Aura\n\n## What is Orange Aura?\n\nLet us delve into the orange aura and its warmth.`;
  const r = checkRL13(draft);
  assert.equal(r.id, 'rl13_banned_jargon');
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /delve/i.test(v.phrase)));
});

test('RL13: AI metaphor (rebooting) → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nThink of it like rebooting your energy each morning.`;
  const r = checkRL13(draft);
  assert.equal(r.pass, false);
});

test('RL13: soft jargon (robust) → WARN (pass stays true)', () => {
  const draft = `# X\n\n## What is X?\n\nThe orange aura points to a robust sense of creative drive.`;
  const r = checkRL13(draft);
  assert.equal(r.pass, true);
  assert.equal(r.warn, true);
  assert.ok(r.violations.some((v) => /robust/i.test(v.phrase)));
});

test('RL13: "architecture" → FAIL (清单 v4.0 §5.3 AI-slop)', () => {
  const draft = `# X\n\n## What is X?\n\nThe architecture of the chart shapes this reading.`;
  const r = checkRL13(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /architecture/i.test(v.phrase)));
});

test('RL13: "mechanism" → FAIL (tri-model eval 2026-05-27 reversed the exclusion)', () => {
  // body prose "mechanism" must fail; the structural role was reworded to
  // "How It Works" in the templates, so the word no longer needs an exception.
  const draft = `# X\n\n## What is X?\n\nThe mechanism here governs how the energy moves.`;
  const r = checkRL13(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /mechanism/i.test(v.phrase)));
});

test('RL13: clean prose → PASS, no warn', () => {
  const draft = `# X\n\n## What is X?\n\nOrange aura reads as warm, creative energy tied to the sacral center. It points to expressive phases.`;
  const r = checkRL13(draft);
  assert.equal(r.pass, true);
  assert.equal(r.warn, false);
  assert.equal(r.violations.length, 0);
});

test('RL13: "lag" word-boundary does not match "flag"/"lagging"', () => {
  const draft = `# X\n\n## What is X?\n\nThis is a flag of creative energy that keeps lagging colors vivid.`;
  const r = checkRL13(draft);
  // "flag" and "lagging" must NOT trip the \\blag\\b soft term.
  assert.ok(!r.violations.some((v) => v.phrase.toLowerCase() === 'lag'));
});
