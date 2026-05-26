#!/usr/bin/env node
// Smoke test for RL12 — citation / external-link hallucination guard.
//
// The v9-followup relaxed the blanket "never name anyone" rule to allow naming a
// per-page allowlist of REAL founders + external links ONLY as TBD placeholders
// (never real URLs). RL12 enforces the boundary that relaxation must not break:
//   (a) bare external URL in body              → FAIL
//   (b) TBD link whose title is a fringe page  → FAIL
//   (c) hallucinated-citation markers          → FAIL
//   (d) attributed name off the allowlist      → WARN (never blocks)
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl12.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL12 } from '../lib/red-lines.mjs';
import { authorityNamesFor, AUTHORITY_ALLOWLIST } from '../lib/authority-allowlist.mjs';

const wrap = (body) => `# X\n\n## What is X?\n\n${body}`;

// ---------- (a) bare external URL → FAIL ----------

test('RL12 (a): bare http URL in body → FAIL', () => {
  const r = checkRL12(wrap('See https://en.wikipedia.org/wiki/Chakra for more.'));
  assert.equal(r.pass, false);
  assert.match(r.note, /\[a\]/);
});

test('RL12 (a): own publish domain URL (CTA target) is NOT flagged', () => {
  // The Take Action section legitimately contains the real CTA URL on our domain.
  const r = checkRL12(wrap('查你的对应落座 https://astrologywiki.com/tools/birth-chart'));
  assert.equal(r.pass, true, r.note);
  // www. and subdomain variants also pass.
  assert.equal(checkRL12(wrap('See https://www.astrologywiki.com/aura-colors here.')).pass, true);
});

test('RL12 (a): ctx.allowedUrls exempts an explicit off-domain CTA URL', () => {
  const url = 'https://app.partner.io/quiz';
  assert.equal(checkRL12(wrap(`Try it: ${url}`)).pass, false); // off-domain → FAIL by default
  assert.equal(checkRL12(wrap(`Try it: ${url}`), { allowedUrls: [url] }).pass, true); // allowlisted → pass
});

test('RL12 (a): URL inside a TBD external-link placeholder is NOT flagged', () => {
  // A well-formed TBD placeholder must pass — the title segment has no URL, and
  // even if it did, placeholder spans are exempt from the bare-URL scan.
  const r = checkRL12(wrap('[[<TBD-external-link: Wikipedia | Chakra | the system blue maps onto>]]'));
  assert.equal(r.pass, true, r.note);
});

// ---------- (b) fringe Wikipedia title → FAIL ----------

for (const bad of ['Aura (paranormal)', 'Astrology (pseudoscience)', 'Energy (alternative)']) {
  test(`RL12 (b): fringe TBD title FAILs :: ${bad}`, () => {
    const r = checkRL12(wrap(`[[<TBD-external-link: Wikipedia | ${bad} | reason here>]]`));
    assert.equal(r.pass, false);
    assert.match(r.note, /\[b\]/);
  });
}

test('RL12 (b): clean Wikipedia title in TBD placeholder does NOT trip', () => {
  const r = checkRL12(wrap('[[<TBD-external-link: Wikipedia | Saturn | astronomical body behind the cycle>]]'));
  assert.equal(r.pass, true, r.note);
});

// ---------- (c) hallucinated-citation markers → FAIL ----------

const HALLUCINATED = [
  'Barbara Brennan in *Hands of Light* says the field is layered.',
  'Cyndi Dale (2009) writes that the throat center governs voice.',
  'Smith et al. found that cool tones calm the body.',
  'A 2015 study confirmed the calming effect.',
  'A Stanford University study measured the wavelength.',
];
for (const phrase of HALLUCINATED) {
  test(`RL12 (c): hallucinated citation FAILs :: ${phrase.slice(0, 36)}`, () => {
    const r = checkRL12(wrap(phrase));
    assert.equal(r.pass, false, `expected FAIL for: ${phrase}`);
    assert.match(r.note, /\[c\]/);
  });
}

// ---------- (d) off-allowlist named attribution → WARN ----------

test('RL12 (d): off-allowlist attributed name → WARN (pass stays true)', () => {
  const r = checkRL12(wrap('Jane Doe describes the aura as layered energy.'), {
    authorityAllowlist: authorityNamesFor('elena-vane'),
  });
  assert.equal(r.pass, true, 'WARN must never block');
  assert.equal(r.warn, true);
  assert.ok(r.violations.some((v) => v.name === 'Jane Doe'));
});

test('RL12 (d): allowlisted founder attribution does NOT warn', () => {
  // "Anodea Judith" is on elena-vane's allowlist; an attribution to her is allowed.
  const r = checkRL12(wrap('Building on the framework Anodea Judith established, the chakra map orders centers.'), {
    authorityAllowlist: authorityNamesFor('elena-vane'),
  });
  assert.equal(r.pass, true, r.note);
  assert.equal(r.warn, undefined === r.warn ? r.warn : false); // no warn
  assert.ok(!r.violations || r.violations.length === 0);
});

test('RL12 (d): no allowlist context → (d) skipped, (a)(b)(c) still run', () => {
  // No authorityAllowlist passed: a named attribution must NOT warn (skipped)…
  const clean = checkRL12(wrap('Jane Doe describes the aura as layered energy.'));
  assert.equal(clean.pass, true);
  assert.ok(!clean.violations || clean.violations.length === 0, 'd skipped without allowlist');
  // …but a bare URL still FAILs even without allowlist context.
  const url = checkRL12(wrap('See https://example.com for more.'));
  assert.equal(url.pass, false);
});

// ---------- reverse: normal prose + legitimate names do NOT trip ----------

const CLEAN = [
  'Blue aura usually reads as a calm, communicative energy field tied to the throat center.',
  'Traditional subtle-energy teachings describe blue as cooling.',
  'The lineage descending from Parashara organizes the nakshatras.',
  'Choosing throat-led communication over heart-led empathy gets you precision.',
  '[[<TBD-internal-link: throat chakra explainer>]] covers the center in depth.',
];
for (const phrase of CLEAN) {
  test(`RL12: clean prose passes (no allowlist) :: ${phrase.slice(0, 36)}`, () => {
    const r = checkRL12(wrap(phrase));
    assert.equal(r.pass, true, `unexpected FAIL: ${phrase} :: ${r.note}`);
  });
}

test('RL12: clean prose passes WITH allowlist context (no false WARN)', () => {
  for (const phrase of CLEAN) {
    const r = checkRL12(wrap(phrase), { authorityAllowlist: authorityNamesFor('aditi-sharma') });
    assert.equal(r.pass, true, `unexpected FAIL: ${phrase}`);
    assert.ok(!r.violations || r.violations.length === 0, `unexpected WARN: ${phrase}`);
  }
});

// ---------- combined: FAIL + WARN coexist (fail wins, warn carried) ----------

test('RL12: bare URL (fail) + off-allowlist name (warn) → pass:false + violations carried', () => {
  const r = checkRL12(wrap('Jane Doe says so. See https://x.com/page now.'), {
    authorityAllowlist: authorityNamesFor('marcus-orion'),
  });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => v.name === 'Jane Doe'));
});

// ---------- data file integrity ----------

test('authority-allowlist.json: the 4 author_ids resolve to the curated founders', () => {
  assert.deepEqual(authorityNamesFor('elena-vane'), ['Anodea Judith', 'Charles Leadbeater', 'Barbara Ann Brennan', 'Cyndi Dale']);
  assert.deepEqual(authorityNamesFor('julian-thorne'), ['Liz Greene', 'Howard Sasportas', 'Melanie Reinhart', 'Richard Tarnas', 'Robert Hand']);
  assert.deepEqual(authorityNamesFor('aditi-sharma'), ['Parashara', 'Varahamihira', 'B. V. Raman', 'K. N. Rao']);
  assert.deepEqual(authorityNamesFor('marcus-orion'), ['Dane Rudhyar', 'Robert Hand', 'Stephen Arroyo', 'Liz Greene', 'Richard Tarnas']);
});

test('authority-allowlist: unknown / empty author_id → []', () => {
  assert.deepEqual(authorityNamesFor('no-such-author'), []);
  assert.deepEqual(authorityNamesFor(''), []);
  assert.deepEqual(authorityNamesFor(null), []);
  assert.deepEqual(authorityNamesFor(undefined), []);
});

test('authority-allowlist: id is normalized (case / quotes / whitespace)', () => {
  assert.deepEqual(authorityNamesFor('"Marcus-Orion"'), authorityNamesFor('marcus-orion'));
  assert.deepEqual(authorityNamesFor('  elena-vane  '), authorityNamesFor('elena-vane'));
});

test('authority-allowlist: no underscore doc keys leak into the data map', () => {
  assert.ok(!('_comment' in AUTHORITY_ALLOWLIST));
  assert.ok(!('_invariant' in AUTHORITY_ALLOWLIST));
  assert.equal(Object.keys(AUTHORITY_ALLOWLIST).length, 4);
});

// ---------- (a) scheme-less raw URLs also FAIL (codex hardening) ----------
for (const url of ['www.example.com/aura-study', 'en.wikipedia.org/wiki/Chakra', 'example.org/post/123']) {
  test(`RL12 (a): scheme-less raw URL → FAIL :: ${url}`, () => {
    const r = checkRL12(wrap(`See ${url} for more.`));
    assert.equal(r.pass, false, `expected FAIL for scheme-less URL: ${url}`);
    assert.ok(r.evidence.some((e) => e.sub === 'a'), 'evidence carries sub (a)');
  });
}

test('RL12 (a): own-domain scheme-less URL → exempt (CTA target)', () => {
  const r = checkRL12(wrap('Read more at astrologywiki.com/aura/blue.'));
  assert.equal(r.pass, true);
});

test('RL12 (a): bare domain WITHOUT a path is not flagged (FP guard)', () => {
  const r = checkRL12(wrap('People compare notes on example.com forums all the time.'));
  assert.equal(r.pass, true);
});

// ---------- (d) broadened attribution forms → WARN, never block ----------
const RL12_OFFLIST = { authorityAllowlist: ['Anodea Judith'] };
for (const body of [
  'Jane Doe describes the aura as layered energy.',
  'According to Jane Doe, blue maps to the throat center.',
  "Jane Doe's framework treats blue as a communication signal.",
  'The lineage descending from Jane Doe frames this center as expressive.',
]) {
  test(`RL12 (d): off-allowlist attribution → WARN :: ${body.slice(0, 30)}`, () => {
    const r = checkRL12(wrap(body), RL12_OFFLIST);
    assert.equal(r.pass, true, 'WARN must never block publish');
    assert.equal(r.warn, true);
    assert.ok(r.violations.some((v) => /Jane Doe/i.test(v.name)), 'off-list name surfaced');
  });
}

test('RL12 (d): allowlisted founder attribution → no warn', () => {
  const r = checkRL12(wrap("Anodea Judith's framework maps blue to the throat center."), RL12_OFFLIST);
  assert.notEqual(r.warn, true);
});

test('RL12 (d): astrology two-word terms do NOT warn (FP guard)', () => {
  const r = checkRL12(wrap("Mercury Retrograde's influence is often overstated; from New York people still notice it."), RL12_OFFLIST);
  assert.notEqual(r.warn, true);
});
