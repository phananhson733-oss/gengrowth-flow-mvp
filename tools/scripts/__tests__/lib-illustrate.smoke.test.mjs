#!/usr/bin/env node
// Smoke tests for tools/scripts/lib/illustrate.mjs prompt planning helpers.
// Run: node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  classifyHeroTheme,
  buildTemplateHeroPrompt,
  buildHeroPlanningRules,
} from '../lib/illustrate.mjs';

test('celebrity birth-chart topics use stylized portrait guidance', () => {
  const theme = classifyHeroTheme({
    slug: 'arthur-fery-birth-chart',
    title: 'What the Arthur Fery Birth Chart Shows Beyond His Cancer Sun',
    content: 'Arthur Fery was born on July 12, 2002.',
  });
  assert.equal(theme, 'celebrity-portrait');
  const prompt = buildTemplateHeroPrompt({
    title: 'What the Arthur Fery Birth Chart Shows Beyond His Cancer Sun',
    slug: 'arthur-fery-birth-chart',
    content: 'Arthur Fery was born on July 12, 2002.',
  });
  assert.match(prompt, /stylized editorial portrait/i);
  assert.doesNotMatch(prompt, /no human faces/i);
});

test('relationship and sports-match topics get concrete scene guidance', () => {
  assert.equal(
    classifyHeroTheme({
      slug: 'jwoww-zack-carpinello-wedding-synastry',
      title: 'JWoww and Zack Carpinello Wedding Synastry',
      content: 'A wedding synastry reading for two people.',
    }),
    'relationship-scene',
  );
  assert.equal(
    classifyHeroTheme({
      slug: 'scotland-brazil-world-cup-astrology',
      title: 'Scotland vs Brazil World Cup Astrology',
      content: 'A national-team football matchup.',
    }),
    'sports-matchup',
  );
});

test('LLM planning rules require specific subject classification before abstract fallback', () => {
  const rules = buildHeroPlanningRules();
  assert.match(rules, /celebrity-portrait/i);
  assert.match(rules, /relationship-scene/i);
  assert.match(rules, /sports-matchup/i);
  assert.match(rules, /only use abstract-atmospheric/i);
});
