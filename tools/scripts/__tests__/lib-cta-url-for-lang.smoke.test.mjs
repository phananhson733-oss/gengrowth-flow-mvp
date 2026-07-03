#!/usr/bin/env node
// Smoke test: ctaUrlForLang EN normalization + buildReplacements wiring the
// derived CTA URL into both the prompt substitution map and its return value
// (renderAuraPrompt writes that return value to the fixture as cta_target_url,
// which _phase2-validate reads back for the SC8 exact-target check).
//
// EN-only (2026-07-03): ctaUrlForLang no longer takes a lang param — a legacy
// /zh/ URL in an old override is normalized back to /en/, and a zh cfg.language
// is rejected by renderAuraPrompt upstream.
//
// Run: node --test tools/scripts/__tests__/lib-cta-url-for-lang.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ctaUrlForLang, buildReplacements } from '../lib/_render-aura-shared.mjs';

test('ctaUrlForLang keeps /en/ and normalizes a legacy /zh/ URL back to /en/', () => {
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/en/wiki/astrology-houses'),
    'https://astrologywiki.com/en/wiki/astrology-houses'
  );
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/zh/wiki/north-node-vs-south-node'),
    'https://astrologywiki.com/en/wiki/north-node-vs-south-node'
  );
});

test('ctaUrlForLang leaves tool-page (no lang segment) and empty URLs unchanged', () => {
  // aura tool-page CTA has no /en/|/zh/ segment — must pass through verbatim
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/tools/aura-reading-quiz'),
    'https://astrologywiki.com/tools/aura-reading-quiz'
  );
  assert.equal(ctaUrlForLang(''), '');
  assert.equal(ctaUrlForLang(undefined), undefined);
});

const cfg = (ctaTargetUrl) => ({
  page_id: 'PG-HOUSE-002',
  entity: 'The 8th House',
  target_keyword: '8th house',
  cta_text: 'Read the full Astrological Houses guide',
  cta_target_url: ctaTargetUrl,
  template: 'Definition',
});

test('buildReplacements wires the EN CTA URL into both map and return value', () => {
  const { replacements, ctaTargetUrl } = buildReplacements(cfg('https://astrologywiki.com/en/wiki/astrology-houses'));
  const want = 'https://astrologywiki.com/en/wiki/astrology-houses';
  assert.equal(ctaTargetUrl, want);
  assert.equal(replacements['{{cta_target_url}}'], want);
});

test('buildReplacements normalizes a legacy /zh/ override CTA back to /en/', () => {
  const { replacements, ctaTargetUrl } = buildReplacements(cfg('https://astrologywiki.com/zh/wiki/astrology-houses'));
  const want = 'https://astrologywiki.com/en/wiki/astrology-houses';
  assert.equal(ctaTargetUrl, want, 'legacy /zh/ CTA must normalize to /en/');
  assert.equal(replacements['{{cta_target_url}}'], want);
});
