#!/usr/bin/env node
// Smoke tests for tools/scripts/lib/illustrate.mjs prompt planning helpers.
// Run: node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  classifyHeroTheme,
  buildTemplateHeroPrompt,
  buildHeroPlanningRules,
  buildHeroImageSizingRules,
  buildIllustrationRunEnv,
} from '../lib/illustrate.mjs';

test('celebrity birth-chart topics put a person and natal chart into one concrete action', () => {
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
  assert.match(prompt, /actively consults/i);
  assert.match(prompt, /circular natal chart/i);
  assert.doesNotMatch(prompt, /standalone chart wheel/i);
  assert.doesNotMatch(prompt, /nebula wash/i);
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

test('fictional character zodiac topics use a non-actor ensemble in a story setting', () => {
  const input = {
    slug: 'harry-potter-characters-zodiac-signs',
    title: 'Harry Potter Characters Zodiac Signs Explained Through Story Archetypes',
    content: 'A fictional character zodiac sign guide comparing major magical-school characters through story behavior.',
  };
  assert.equal(classifyHeroTheme(input), 'fictional-character-scene');
  const prompt = buildTemplateHeroPrompt(input);
  assert.match(prompt, /non-actor/i);
  assert.match(prompt, /role-based ensemble/i);
  assert.match(prompt, /story setting/i);
});

test('LLM planning rules require specific subject classification before abstract fallback', () => {
  const rules = buildHeroPlanningRules();
  assert.match(rules, /celebrity-portrait/i);
  assert.match(rules, /relationship-scene/i);
  assert.match(rules, /sports-matchup/i);
  assert.match(rules, /only use abstract-atmospheric/i);
});

test('LLM planning rules require Brief-first visual evidence', () => {
  const rules = buildHeroPlanningRules();
  assert.match(rules, /subject/i);
  assert.match(rules, /key relationship/i);
  assert.match(rules, /concrete setting/i);
  assert.match(rules, /reader task/i);
  assert.match(rules, /fictional-character-scene/i);
});

test('LLM planning rules keep birth-chart visuals grounded in the person and reading action', () => {
  const rules = buildHeroPlanningRules();
  assert.match(rules, /birth-chart articles/i);
  assert.match(rules, /person.*chart-reading action/i);
  assert.match(rules, /not a standalone diagram/i);
  assert.match(rules, /celestial motifs only as subordinate texture/i);
});

test('image sizing rules document hero and Google structured-data variants', () => {
  const rules = buildHeroImageSizingRules();
  assert.match(rules, /1200.x.675/i);
  assert.match(rules, /1200.x.630/i);
  assert.match(rules, /1200.x.1200/i);
  assert.match(rules, /1200.x.900/i);
  assert.match(rules, /Article JSON-LD/i);
});

test('flow defaults hero generation to Hermes image2 while allowing overrides', () => {
  const exists = (p) => p.endsWith('/hermes-agent/.venv/bin/python');
  const env = buildIllustrationRunEnv({
    env: { HOME: '/Users/tester' },
    exists,
  });
  assert.equal(env.GG_HERO_PROVIDER, 'hermes-image2');
  assert.equal(env.GG_HERMES_AGENT_DIR, '/Users/tester/hermes-agent');
  assert.equal(env.GG_HERMES_PYTHON, '/Users/tester/hermes-agent/.venv/bin/python');

  const override = buildIllustrationRunEnv({
    env: {
      HOME: '/Users/tester',
      GG_HERO_PROVIDER: 'gemini',
      GG_HERMES_AGENT_DIR: '/custom/hermes',
      GG_HERMES_PYTHON: '/custom/python',
    },
    exists,
  });
  assert.equal(override.GG_HERO_PROVIDER, 'gemini');
  assert.equal(override.GG_HERMES_AGENT_DIR, '/custom/hermes');
  assert.equal(override.GG_HERMES_PYTHON, '/custom/python');
});
