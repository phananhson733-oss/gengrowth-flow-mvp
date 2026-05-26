#!/usr/bin/env node
// Smoke test for lib/red-lines.mjs RL8 — shared scientific-endorsement red line.
//
// RL8 applies to all authors (no persona dependency). It flags phrasing that
// dresses an astrology / oracle interpretation up as scientific proof
// ("research shows", "scientifically proven", "evidence-based", ...). A hit is
// a hard FAIL. Scope guards: skip YAML frontmatter and fenced code so neutral
// mentions of "science" or quoted source material don't false-positive.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl8.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL8, RL8_SCI_CLAIM_REGEX } from '../lib/red-lines.mjs';

// ---------- each high-risk phrase → FAIL ----------
const HIGH_RISK = [
  'Research shows that the blue aura calms the mind.',
  'Studies show this color lowers stress.',
  'Studies suggest a link to creativity.',
  'This is scientifically proven to work.',
  'Our approach is evidence-based and reliable.',
  'It is clinically proven to reduce anxiety.',
  'The data confirms a strong correlation.',
  'These effects are proven by science.',
  'There is scientific evidence for this reading.',
];

for (const phrase of HIGH_RISK) {
  test(`RL8: high-risk phrase → FAIL :: ${phrase.slice(0, 32)}`, () => {
    const draft = `# Title\n\n${phrase}`;
    const r = checkRL8(draft);
    assert.equal(r.pass, false, `expected FAIL for: ${phrase}`);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, 'evidence should be populated');
  });
}

// ---------- neutral text → pass ----------
test('RL8: neutral interpretive text → PASS', () => {
  const draft = `# Blue Aura

Many people associate blue with calm and clear communication.
This reflection is an invitation, not a prescription.`;
  const r = checkRL8(draft);
  assert.equal(r.pass, true);
});

test('RL8: neutral mention of the word "science" → PASS', () => {
  const draft = `# Blue Aura

The history of color and science is fascinating, but this is symbolic.`;
  const r = checkRL8(draft);
  assert.equal(r.pass, true);
});

// ---------- frontmatter exemption ----------
test('RL8: phrase only in YAML frontmatter → PASS', () => {
  const draft = `---
title: Why research shows blue is calming
---

# Blue

Blue is a symbol of calm.`;
  const r = checkRL8(draft);
  assert.equal(r.pass, true);
});

// ---------- fenced-code exemption ----------
test('RL8: phrase only in fenced code → PASS', () => {
  const draft = `# Blue

\`\`\`
heading = "scientifically proven"
\`\`\`

Blue is a symbol of calm.`;
  const r = checkRL8(draft);
  assert.equal(r.pass, true);
});

// ---------- negation / disclaimer is allowed (not an endorsement) ----------
test('RL8: "no scientific evidence for this" → PASS (honest disclaimer)', () => {
  const r = checkRL8('# Blue\n\nThere is no scientific evidence for this reading.');
  assert.equal(r.pass, true);
});

test('RL8: "this is not evidence-based" → PASS', () => {
  const r = checkRL8('# Blue\n\nThis is not evidence-based and should be read symbolically.');
  assert.equal(r.pass, true);
});

test('RL8: positive endorsement still FAILS despite a negation elsewhere', () => {
  const r = checkRL8('# Blue\n\nThis is not a joke. Studies show this aura is real.');
  assert.equal(r.pass, false);
});

// ---------- exported constant is a regex ----------
test('RL8: RL8_SCI_CLAIM_REGEX is exported regex', () => {
  assert.ok(RL8_SCI_CLAIM_REGEX instanceof RegExp);
});
