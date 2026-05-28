#!/usr/bin/env node
// Smoke test: ctaUrlForLang lang-segment rewrite + buildReplacements wiring the
// derived CTA URL into both the prompt substitution map and its return value
// (renderAuraPrompt writes that return value to the fixture as cta_target_url,
// which _phase2-validate reads back for the SC8 exact-target check). Internal-link
// CTAs hit the /:lang/wiki/:id SPA route, so a ZH article must link the /zh/ page.
//
// Run: node --test tools/scripts/__tests__/lib-cta-url-for-lang.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ctaUrlForLang, buildReplacements } from '../lib/_render-aura-shared.mjs';

test('ctaUrlForLang rewrites the /<lang>/ wiki segment to match output language', () => {
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/en/wiki/astrology-houses', 'zh'),
    'https://astrologywiki.com/zh/wiki/astrology-houses'
  );
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/en/wiki/astrology-houses', 'en'),
    'https://astrologywiki.com/en/wiki/astrology-houses'
  );
  // symmetric: a stored /zh/ URL rendered for an EN article flips back to /en/
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/zh/wiki/north-node-vs-south-node', 'en'),
    'https://astrologywiki.com/en/wiki/north-node-vs-south-node'
  );
});

test('ctaUrlForLang leaves tool-page (no lang segment) and empty URLs unchanged', () => {
  // aura tool-page CTA has no /en/|/zh/ segment — must pass through verbatim
  assert.equal(
    ctaUrlForLang('https://astrologywiki.com/tools/aura-reading-quiz', 'zh'),
    'https://astrologywiki.com/tools/aura-reading-quiz'
  );
  assert.equal(ctaUrlForLang('', 'zh'), '');
  assert.equal(ctaUrlForLang(undefined, 'zh'), undefined);
});

const cfg = (language) => ({
  page_id: 'PG-HOUSE-002',
  entity: 'The 8th House',
  target_keyword: '8th house',
  cta_text: 'Read the full Astrological Houses guide',
  cta_target_url: 'https://astrologywiki.com/en/wiki/astrology-houses',
  template: 'Definition',
  language,
});

test('buildReplacements derives the ZH CTA URL into both map and return value', () => {
  const { replacements, ctaTargetUrl } = buildReplacements(cfg('zh'));
  const want = 'https://astrologywiki.com/zh/wiki/astrology-houses';
  assert.equal(ctaTargetUrl, want, 'returned ctaTargetUrl (fixture source) must be /zh/');
  assert.equal(replacements['{{cta_target_url}}'], want, 'prompt {{cta_target_url}} must be /zh/');
});

test('buildReplacements keeps the EN CTA URL for an EN render', () => {
  const { replacements, ctaTargetUrl } = buildReplacements(cfg('en'));
  const want = 'https://astrologywiki.com/en/wiki/astrology-houses';
  assert.equal(ctaTargetUrl, want);
  assert.equal(replacements['{{cta_target_url}}'], want);
});
