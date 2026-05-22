#!/usr/bin/env node
// Smoke test for lib/red-lines.mjs RL6 — guards against the v8 wiring bug
// where _phase2-validate.mjs:308 passed `psych_safety_flag` but RL6 read
// `effectivePsychSafety`, causing all psych-safety=Y pages to silently pass
// as "N/A". Fixed 2026-05-22 by (a) caller passes effectivePsychSafety, and
// (b) RL6 accepts either field name as a defensive fallback.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl6.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL6 } from '../lib/red-lines.mjs';

const DISCLAIMER = 'This is not a clinical interpretation or medical advice.';

const DRAFT_WITH_DISCLAIMER = `# Heading

Some body text.

${DISCLAIMER}

More body text about reflection.`;

const DRAFT_NO_DISCLAIMER = `# Heading

Some body text.

More body text about reflection.`;

// ---------- psych_safety=N: N/A pass (both field names) ----------
test('RL6: psych_safety=N → N/A pass (effectivePsychSafety)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { effectivePsychSafety: 'N' });
  assert.equal(r.pass, true);
  assert.match(r.note, /N\/A/);
});

test('RL6: psych_safety=N → N/A pass (legacy psych_safety_flag)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { psych_safety_flag: 'N' });
  assert.equal(r.pass, true);
  assert.match(r.note, /N\/A/);
});

// ---------- psych_safety=Y + no disclaimer: must FAIL ----------
test('RL6: psych_safety=Y + no disclaimer → FAIL (effectivePsychSafety)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { effectivePsychSafety: 'Y' });
  assert.equal(r.pass, false);
  assert.match(r.note, /missing required disclaimer/);
});

test('RL6: psych_safety=Y + no disclaimer → FAIL (legacy psych_safety_flag)', () => {
  // This is the exact bug case: v8 caller was passing psych_safety_flag but
  // RL6 only read effectivePsychSafety, so this returned pass:true before fix.
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { psych_safety_flag: 'Y' });
  assert.equal(r.pass, false, 'BUG REGRESSION: legacy field name silently bypassed RL6');
  assert.match(r.note, /missing required disclaimer/);
});

// ---------- psych_safety=Y + disclaimer present: PASS ----------
test('RL6: psych_safety=Y + disclaimer present → PASS', () => {
  const r = checkRL6(DRAFT_WITH_DISCLAIMER, { effectivePsychSafety: 'Y' });
  assert.equal(r.pass, true);
  assert.match(r.note, /disclaimer found/);
});

// ---------- Tier-1 blacklist word: must FAIL ----------
test('RL6: psych_safety=Y + tier-1 blacklist word ("disorder") → FAIL', () => {
  const draft = `${DRAFT_WITH_DISCLAIMER}\n\nThis is often confused with a disorder.`;
  const r = checkRL6(draft, { effectivePsychSafety: 'Y' });
  assert.equal(r.pass, false);
  assert.match(r.note, /blacklist/);
});

// ---------- precedence: effectivePsychSafety wins over psych_safety_flag ----------
test('RL6: effectivePsychSafety takes precedence over psych_safety_flag', () => {
  // If caller sets both, the canonical field (effectivePsychSafety) wins.
  const r = checkRL6(DRAFT_NO_DISCLAIMER, {
    effectivePsychSafety: 'N',
    psych_safety_flag: 'Y',
  });
  assert.equal(r.pass, true, 'effectivePsychSafety=N should yield N/A pass even when legacy flag says Y');
});

// ---------- strict mode: unknown / missing fields fail loudly ----------
test('RL6: missing both fields → FAIL (wiring bug, not silent N/A)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, {});
  assert.equal(r.pass, false);
  assert.match(r.note, /wiring bug/i);
});

test('RL6: non-canonical value "yes" → FAIL (wiring bug)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { effectivePsychSafety: 'yes' });
  assert.equal(r.pass, false);
  assert.match(r.note, /wiring bug/i);
});

test('RL6: lowercase "y" → FAIL (wiring bug, prevents typo regression)', () => {
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { effectivePsychSafety: 'y' });
  assert.equal(r.pass, false);
  assert.match(r.note, /wiring bug/i);
});

test('RL6: third-party field name (e.g. psychSafety camelCase) → FAIL', () => {
  // Future-proofing: if someone adds yet another field name, it fails loud instead of silently N/A.
  const r = checkRL6(DRAFT_NO_DISCLAIMER, { psychSafety: 'Y' });
  assert.equal(r.pass, false);
  assert.match(r.note, /wiring bug/i);
});
