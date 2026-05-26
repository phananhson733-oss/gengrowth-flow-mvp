#!/usr/bin/env node
// Smoke test for lib/structure-checks.mjs.
//
// SC1 — bolded direct-answer definition in the first H2 section (FAIL; both
//        templates hard-require it).
// SC2 — internal-link tier counting (WARN only; never blocks).
//
// Run: node --test tools/scripts/__tests__/lib-structure-checks.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkBoldedDefinition,
  checkInternalLinkTier,
} from '../lib/structure-checks.mjs';

// ============================================================
// SC1 — bolded definition
// ============================================================

test('SC1: first H2 section with bolded definition → PASS', () => {
  const draft = `# Blue Aura Meaning

## What is Blue Aura?

Blue aura usually reads as **a calm, communicative energy field tied to the throat center**. It points to clarity of voice.

## Why It Matters for Self-Awareness

People feel misread as cold.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true, r.note);
  assert.equal(r.severity, 'fail');
});

test('SC1: first H2 section with NO bold → FAIL', () => {
  const draft = `# Blue Aura Meaning

## What is Blue Aura?

Blue aura usually reads as a calm, communicative energy field tied to the throat center.

## Why It Matters for Self-Awareness

People feel misread as cold.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.length >= 1, 'violation populated');
  assert.ok(typeof r.violations[0].line === 'number', 'violation carries a line number');
});

test('SC1: empty bold span **** is not a real bold → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nThis has an empty **** span only.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
});

test('SC1: bold appearing only in a LATER section still FAILS (must be first section)', () => {
  const draft = `# X

## What is X?

Plain prose with no bold here.

## Why It Matters for Self-Awareness

Here is **a bolded phrase** but in the wrong section.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
});

test('SC1: no H2 at all → PASS (H2-count check is authoritative, no double-fail)', () => {
  const draft = `# X\n\nJust an intro with no sections.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true);
});

// Realistic ZH-shaped section (entity translated) still passes when bold present.
test('SC1: ZH-shaped first section with bold → PASS', () => {
  const draft = `# 蓝色气场代表什么：含义与解读

## 蓝色气场是什么？

蓝色气场通常被理解为 **一种与喉轮相关、偏向冷静与沟通的能量状态**。它指向表达的清晰度。

## 为什么了解它能帮助自我觉察

人们常被误读为冷漠。`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true, r.note);
});

// ============================================================
// SC2 — internal-link tier counting (WARN)
// ============================================================

function draftWithLinks(n) {
  const links = Array.from({ length: n }, (_, i) =>
    `[[<TBD-internal-link: explainer number ${i + 1}>]]`).join('\n');
  return `# X\n\n## What is X?\n\n**Bold def.**\n\n## Related Reading\n\n${links}`;
}

test('SC2: severity is warn', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T2' });
  assert.equal(r.severity, 'warn');
});

test('SC2: T2 with ≥3 links → PASS', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T2' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T2 with 2 links → WARN (pass:false but severity warn)', () => {
  const r = checkInternalLinkTier(draftWithLinks(2), { tier: 'T2' });
  assert.equal(r.pass, false);
  assert.equal(r.severity, 'warn');
  assert.ok(r.violations[0].hint.includes('≥ 3'));
});

test('SC2: T3 with 1 link → PASS (within 1-2 band)', () => {
  const r = checkInternalLinkTier(draftWithLinks(1), { tier: 'T3' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T3 with 2 links → PASS', () => {
  const r = checkInternalLinkTier(draftWithLinks(2), { tier: 'T3' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T3 with 3 links → WARN (over ceiling)', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T3' });
  assert.equal(r.pass, false);
  assert.ok(r.violations[0].hint.includes('≤ 2'));
});

test('SC2: unknown tier (T1) → PASS with no opinion', () => {
  const r = checkInternalLinkTier(draftWithLinks(0), { tier: 'T1' });
  assert.equal(r.pass, true);
  assert.ok(/no tier floor/.test(r.note));
});

test('SC2: only counts TBD-format links, ignores invented anchors', () => {
  const draft = `# X\n\n## What is X?\n\n**Bold.**\n\n## Related Reading\n\n[[Invented Anchor]]\n[[Another One]]`;
  const r = checkInternalLinkTier(draft, { tier: 'T2' });
  // 0 TBD links → below T2 floor → WARN (the 2 invented anchors are not counted).
  assert.equal(r.pass, false);
  assert.ok(/0 TBD internal-link/.test(r.note));
});
