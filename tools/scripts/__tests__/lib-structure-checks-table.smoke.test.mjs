#!/usr/bin/env node
// Smoke test for SC10 checkTableIntegrity (v4.4 #3 — table structure gate).
// Run: node --test tools/scripts/__tests__/lib-structure-checks-table.smoke.test.mjs
//
// SC10 enforces the SOP/§3-checklist Decision-Value / Quick-Reference table
// shape objectively (≥4 columns × ≥3 data rows). It deliberately does NOT judge
// cell prose quality (over-strict "full sentence" checks false-fail legitimate
// reference cells like "Throat center"). The banned "Mechanism" header word is
// caught by RL13 (table rows are prose-scanned), not here.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkTableIntegrity } from '../lib/structure-checks.mjs';

const VALID = `# Orange Aura

## Quick Reference Table

| Property | How It Works | Energy Center | How to Observe |
|---|---|---|---|
| Warmth | Sacral emphasis lifts drive | Sacral | You feel restless before action |
| Voice | Throat focus sharpens speech | Throat | Others call you blunt |
| Drive | Solar plexus fuels output | Solar plexus | You over-commit then stall |
`;

test('valid 4-col × 3-row table → pass', () => {
  const r = checkTableIntegrity(VALID);
  assert.equal(r.id, 'sc10_table_integrity');
  assert.equal(r.severity, 'fail');
  assert.equal(r.pass, true);
});

test('2-column table → FAIL (too few columns)', () => {
  const draft = `# X\n\n## Quick Reference Table\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n`;
  const r = checkTableIntegrity(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /column/i.test(`${v.text} ${v.hint}`)));
});

test('4-col but only 2 data rows → FAIL (SOP min 3 rows)', () => {
  const draft = `# X\n\n## Quick Reference Table\n\n| A | B | C | D |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n| 5 | 6 | 7 | 8 |\n`;
  const r = checkTableIntegrity(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /row/i.test(`${v.text} ${v.hint}`)));
});

test('no markdown table → pass (missing section caught by H2 spec elsewhere)', () => {
  const draft = `# X\n\n## What is X?\n\nProse only, no table at all.`;
  const r = checkTableIntegrity(draft);
  assert.equal(r.pass, true);
  assert.match(r.note, /no markdown table/i);
});

test('5 columns × 3 rows → pass (≥4 cols is a floor, not a ceiling)', () => {
  const draft = `# X\n\n## Quick Reference Table\n\n| A | B | C | D | E |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |\n| a | b | c | d | e |\n| x | y | z | w | v |\n`;
  const r = checkTableIntegrity(draft);
  assert.equal(r.pass, true);
});

test('empty draft → skipped pass', () => {
  const r = checkTableIntegrity('');
  assert.equal(r.pass, true);
});
