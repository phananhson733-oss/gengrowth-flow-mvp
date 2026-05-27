#!/usr/bin/env node
// Smoke tests for the tri-model-eval must-fix batch (2026-05-27):
//   #4 SC4 first-link 150-word/200-字 window
//   #6 SC8 CTA exact cta_target_url match + banned anchor text
//   #9 SC9b Sources entries named in body (WARN)
// Run: node --test tools/scripts/__tests__/lib-structure-checks-evalfix.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkLinkDistribution,
  checkCtaUrl,
  checkSourcesNamesInBody,
} from '../lib/structure-checks.mjs';

const LINK = (kw) => `[[<TBD-internal-link: ${kw} | semantic context | reason to click>]]`;

// ---------- #4 SC4 first-link window ----------

test('SC4: first internal link early in body → PASS', () => {
  const draft = `# X\n\n## What is X?\n\nX is the thing. See ${LINK('pillar')} for the hub.\n\n## Related Reading\n\n${LINK('other')}`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC4: first internal link after 150 words → FAIL (首链优先权)', () => {
  const filler = Array.from({ length: 160 }, () => 'word').join(' ');
  const draft = `# X\n\n## What is X?\n\n${filler}\n\nNow the hub: ${LINK('pillar')}.\n\n## Related Reading\n\n${LINK('other')}`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, false);
  assert.ok(/first/i.test(r.note), r.note);
});

test('SC4: all links dumped in Related Reading → FAIL (none in body)', () => {
  const draft = `# X\n\n## What is X?\n\nProse with no links.\n\n## Related Reading\n\n${LINK('a')}\n${LINK('b')}`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, false);
  assert.ok(/inline in body prose/.test(r.note));
});

// ---------- #6 SC8 CTA exact match + banned anchor ----------

const CTA = (body) => `# X\n\n## Take Action\n\n${body}`;

test('SC8: CTA URL matches cta_target_url → PASS', () => {
  const r = checkCtaUrl(CTA('Build your chart at https://astrologywiki.com/orange-aura.'),
    { cta_target_url: 'https://astrologywiki.com/orange-aura' });
  assert.equal(r.pass, true, r.note);
});

test('SC8: CTA URL is a different own-domain page → FAIL (≠ cta_target_url)', () => {
  const r = checkCtaUrl(CTA('Read more at https://astrologywiki.com/not-the-target.'),
    { cta_target_url: 'https://astrologywiki.com/orange-aura' });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /cta_target_url/.test(`${v.text} ${v.hint}`)));
});

test('SC8: banned anchor text "click here" → FAIL', () => {
  const r = checkCtaUrl(CTA('[click here](https://astrologywiki.com/orange-aura) to start.'),
    { cta_target_url: 'https://astrologywiki.com/orange-aura' });
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /anchor/i.test(`${v.text} ${v.hint}`)));
});

test('SC8: no cta_target_url given → backward-compatible (any real URL passes)', () => {
  const r = checkCtaUrl(CTA('Go to https://astrologywiki.com/anything.'));
  assert.equal(r.pass, true, r.note);
});

// ---------- #9 SC9b Sources named in body ----------

test('SC9b: source name appears in body → PASS', () => {
  const draft = `# X\n\n## What is X?\n\nThe work of Anodea Judith grounds this reading.\n\n## Sources\n\n- Anodea Judith — chakra system framing`;
  const r = checkSourcesNamesInBody(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC9b: source name NOT in body → WARN', () => {
  const draft = `# X\n\n## What is X?\n\nGeneric prose with no named authority.\n\n## Sources\n\n- Carl Jung — archetypes`;
  const r = checkSourcesNamesInBody(draft);
  assert.equal(r.severity, 'warn');
  assert.equal(r.pass, false);
  assert.ok(r.violations.some((v) => /Carl Jung/.test(v.text)));
});

test('SC9b: no Sources section → PASS (SC9 authoritative)', () => {
  const r = checkSourcesNamesInBody(`# X\n\n## What is X?\n\nBody only.`);
  assert.equal(r.pass, true);
});
