#!/usr/bin/env node
// Smoke test for lib/red-lines.mjs RL9 — atom-block scaffold-label leak.
//
// The current templates instruct flowing prose; they never tell the LLM to
// print internal "Topic-Process-Example" scaffold labels into the body. When
// those labels leak verbatim AS A STRUCTURAL MARKER (line-start + colon, or a
// bare label line), the page reads like a worksheet → hard FAIL. Ordinary prose
// like "For example, Saturn..." must NOT trip it.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl9.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL9 } from '../lib/red-lines.mjs';

// ---------- structural-marker leaks → FAIL ----------
// Only the UNAMBIGUOUS scaffold names are flagged. Bare "Process:" / "Example:"
// were dropped from the FAIL set (they collide with legitimate prose) — see CLEAN.
const LEAKS = [
  'Topic Sentence: Saturn return marks a maturity checkpoint.',
  '(Topic Sentence)',
  'Topic Sentence',
  'Topic-Process-Example',
  '**Topic Sentence:** Saturn return marks a checkpoint.',
];

for (const leak of LEAKS) {
  test(`RL9: scaffold-label leak → FAIL :: ${leak.slice(0, 32)}`, () => {
    const draft = `# Saturn Return\n\n## What is Saturn Return?\n\n${leak}\n\nMore prose here.`;
    const r = checkRL9(draft);
    assert.equal(r.pass, false, `expected FAIL for: ${leak}`);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, 'evidence should be populated');
    assert.ok(typeof r.evidence[0].line === 'number', 'evidence carries a line number');
  });
}

// ---------- legitimate prose → PASS (the load-bearing FP guards) ----------
const CLEAN = [
  'For example, Saturn return tends to surface around age 29.',
  'For instance, a deep blue often reads as more reserved.',
  'This process takes years to complete, for example across two transits.',
  'She relates to her sibling differently after the transit.',
  'The example most people cite is the late-twenties reckoning.',
  'Take the example of someone navigating a career shift.',
  // "Process:" / "Example:" at line start are legitimate prose, not scaffold
  // labels — deliberately excluded from RL9 to stay false-positive free.
  'Process: first the transit begins, then it peaks.',
  'Example: a deep blue often reads as calm speech under pressure.',
  '- **Process:** the cycle unfolds in three stages.',
  '**Example:** when the transit exact-hits the natal placement.',
];

for (const clean of CLEAN) {
  test(`RL9: legitimate prose → PASS :: ${clean.slice(0, 32)}`, () => {
    const draft = `# Saturn Return\n\n## What is Saturn Return?\n\n${clean}`;
    const r = checkRL9(draft);
    assert.equal(r.pass, true, `expected PASS for: ${clean}`);
  });
}

// ---------- a realistic clean template-shaped draft → PASS ----------
test('RL9: realistic clean draft → PASS', () => {
  const draft = `# Saturn Return

## What is Saturn Return?

Saturn return is **the period when transiting Saturn returns to its natal position**. For example, this happens for most people near age 29. Practitioners often describe it as a maturity checkpoint.

## Why It Matters for Self-Awareness

People feel pressure to settle long-term commitments during this passage.`;
  const r = checkRL9(draft);
  assert.equal(r.pass, true);
});

// ---------- heading lines are not flagged ----------
test('RL9: a section title containing "Example" word is not flagged', () => {
  const draft = `# Topic\n\n## What is Topic?\n\nPlain prose with no leaks.`;
  const r = checkRL9(draft);
  assert.equal(r.pass, true);
});
