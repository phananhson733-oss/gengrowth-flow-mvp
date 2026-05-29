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

// ---------- keyword exemption (2026-05-29): a blacklist word that IS the SEO
// keyword must not auto-fail the page. "Healing Your Inner Wound" is a real
// target keyword; banning the page from ever writing "healing" makes the
// keyword unrankable. Mirrors RL7's isTokenExemptByKeyword. The exemption is
// scoped to the keyword token only — other blacklist words still fail. ----------
test('RL6: psych_safety=Y + blacklist word ("healing") inside target_keyword → exempt PASS', () => {
  const draft = `${DRAFT_WITH_DISCLAIMER}\n\nWorking on healing here is reframed as reflection.`;
  const r = checkRL6(draft, {
    effectivePsychSafety: 'Y',
    targetKeyword: 'Healing Your Inner Wound',
  });
  assert.equal(r.pass, true, 'a banned word that is the target keyword must be exempt');
  assert.match(r.note, /disclaimer found/);
});

test('RL6: psych_safety=Y + "healing" but NOT in keyword → still FAIL', () => {
  const draft = `${DRAFT_WITH_DISCLAIMER}\n\nThis page is about healing the wound.`;
  const r = checkRL6(draft, {
    effectivePsychSafety: 'Y',
    targetKeyword: 'chiron in 12th house',
  });
  assert.equal(r.pass, false, 'keyword does not contain "healing" → no exemption');
  assert.match(r.note, /blacklist/);
});

test('RL6: keyword exemption is per-word — other blacklist words still FAIL', () => {
  // "healing" exempt by keyword, but "cure" is a separate clinical-overreach claim.
  const draft = `${DRAFT_WITH_DISCLAIMER}\n\nNo amount of healing will cure the placement.`;
  const r = checkRL6(draft, {
    effectivePsychSafety: 'Y',
    targetKeyword: 'Healing Your Inner Wound',
  });
  assert.equal(r.pass, false, '"cure" is not the keyword → must still fail');
  assert.match(r.note, /"cure"/);
});
