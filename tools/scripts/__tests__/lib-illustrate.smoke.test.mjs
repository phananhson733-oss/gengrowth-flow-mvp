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
  // Asserts the CONTRACT, not the wording: a person, an unlabeled circular chart, a
  // reading action, no celebrity likeness — and never the abstract clause's face ban.
  assert.match(prompt, /editorial portrait/i);
  assert.match(prompt, /studies an unlabeled circular natal chart/i);
  assert.match(prompt, /no celebrity likeness/i);
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
  assert.match(prompt, /non-actor character archetypes/i);
  assert.match(prompt, /concrete setting from the narrative/i);
  // Added after a Marvel roster came back wearing recognizable DC chest emblems.
  assert.match(prompt, /no real emblems or actor likeness/i);
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

// --- typology-concept ---------------------------------------------------------
// "INTP zodiac sign" contains "zodiac sign", which the celebrity-portrait catch-all
// swallowed — so a concept article with no person in it was being drawn as a
// public-figure portrait. The v2 calendar queues ~40 more MBTI × sign crossovers.
test('MBTI × sign crossovers are a concept scene, not a celebrity portrait', () => {
  for (const [slug, title] of [
    ['intp-zodiac-sign', 'Reading the INTP Zodiac Sign Without Blurring Systems'],
    ['esfp-zodiac-sign', 'Reading the ESFP Zodiac Sign Without Fixed Labels'],
    ['enfp-gemini', 'Reading ENFP Gemini Without Blurring Type and Sign'],
    ['mbti-zodiac-compatibility', 'MBTI Zodiac Compatibility Explained'],
  ]) {
    assert.equal(classifyHeroTheme({ slug, title, content: '' }), 'typology-concept', slug);
  }
  const prompt = buildTemplateHeroPrompt({
    slug: 'intp-zodiac-sign', title: 'Reading the INTP Zodiac Sign Without Blurring Systems', content: '',
  });
  assert.match(prompt, /four paired brass markers/i);   // the type system, as objects
  assert.match(prompt, /unlabeled circular zodiac wheel/i); // the sign system
  assert.match(prompt, /no faces/i);
  assert.doesNotMatch(prompt, /editorial portrait/i);
});

// The typology signal is read from slug+title only. An unrelated article that says
// "personality type" once in prose must keep its own theme — this is exactly how the
// Wanda Maximoff page first misclassified.
test('a passing "personality type" mention in prose does not hijack the theme', () => {
  assert.equal(
    classifyHeroTheme({
      slug: 'wanda-maximoff-zodiac-sign',
      title: 'Wanda Maximoff Zodiac Sign Reads Grief Through Aquarius',
      content: 'A sign is not a personality type, and the character arc is fiction.',
    }),
    'fictional-character-scene',
  );
});

// --- group-roster -------------------------------------------------------------
test('idol-group rosters are an ensemble, not one portrait or a couple scene', () => {
  for (const [slug, title] of [
    ['ive-members-zodiac-signs', 'IVE Members Zodiac Signs Read as a Verified Sun-Sign Map'],
    ['seventeen-zodiac-signs', 'SEVENTEEN Zodiac Signs by Member With Official Dates'],
    ['bts-members-zodiac-signs', "All Seven BTS Members' Zodiac Signs, Explained"],
  ]) {
    assert.equal(classifyHeroTheme({ slug, title, content: '' }), 'group-roster', slug);
  }
  const prompt = buildTemplateHeroPrompt({
    slug: 'ive-members-zodiac-signs', title: 'IVE Members Zodiac Signs', content: '',
  });
  // group-roster is deliberately PEOPLE-FREE: three rounds of crowd prompts could not
  // hold a member count, kept returning backlit silhouettes seen from behind, and put
  // recognizable DC emblems on a Marvel roster. A still life carries the same reading
  // with none of the count, likeness, or trademark risk.
  assert.match(prompt, /no people/i);
  assert.match(prompt, /one prop per member/i);
});

// A group's internal compatibility is still the group — the bare "compatibility"
// keyword otherwise routed it to the two-person relationship scene.
test('group compatibility stays a roster, not a two-person romance scene', () => {
  assert.equal(
    classifyHeroTheme({
      slug: 'bts-compatibility-zodiac',
      title: 'BTS Compatibility Zodiac Without Matchmaking Myths',
      content: 'Symbolic Sun-sign compatibility across the seven members.',
    }),
    'group-roster',
  );
});

// A real named couple must still reach relationship-scene.
test('a named couple is still a relationship scene', () => {
  assert.equal(
    classifyHeroTheme({
      slug: 'taylor-swift-and-travis-kelce',
      title: 'What the Taylor Swift and Travis Kelce Synastry Chart Reveals',
      content: 'A two-person synastry comparison.',
    }),
    'relationship-scene',
  );
});

// --- fictional figures --------------------------------------------------------
// Named comic / mythological figures are fiction, not public figures. Before this,
// "Thor zodiac sign" fell through to celebrity-portrait and would have been drawn as
// a real person consulting a natal chart.
test('named comic and mythological figures are fictional, not celebrities', () => {
  for (const [slug, title] of [
    ['thor-zodiac-sign', 'What the Thor Zodiac Sign Really Means in Astrology'],
    ['wanda-maximoff-zodiac-sign', 'Wanda Maximoff Zodiac Sign Reads Grief Through Aquarius'],
    ['marvel-characters-zodiac-signs', 'Marvel Characters Zodiac Signs Without Canon Confusion'],
    ['eren-yeager-zodiac-sign', 'Eren Yeager Zodiac Sign'],
    ['jon-snow-zodiac-sign', 'Jon Snow Zodiac Sign'],
  ]) {
    assert.equal(classifyHeroTheme({ slug, title, content: '' }), 'fictional-character-scene', slug);
  }
});

// Guard the other direction: a real public figure must NOT drift into fiction.
test('a real public figure stays a celebrity portrait', () => {
  for (const [slug, title] of [
    ['billie-eilish-birth-chart', 'Billie Eilish Birth Chart Without Guessing Her Rising Sign'],
    ['sabrina-carpenter-zodiac-sign', 'Sabrina Carpenter Zodiac Sign and What It Actually Shows'],
    ['rihanna-birth-chart', 'How to Read the Rihanna Birth Chart With Care'],
  ]) {
    assert.equal(classifyHeroTheme({ slug, title, content: '' }), 'celebrity-portrait', slug);
  }
});

// --- CLIP token budget -------------------------------------------------------
// FLUX conditions on CLIP (hard 77-token limit) as well as T5. On 2026-07-29 the
// old 63-word BASE_STYLE pushed the whole style tail — including its own no-text
// rule — past that window; the generator logged "input was truncated because CLIP
// can only handle sequences up to 77 tokens" and two heroes came back carrying
// invented watermark signatures. A scene description runs ~35 words, so the style
// tail has roughly 20 to spend. This guards the budget, not the wording.
test('template hero prompts stay inside the CLIP token budget', () => {
  const cases = [
    { slug: 'intp-zodiac-sign', title: 'Reading the INTP Zodiac Sign Without Blurring Systems' },
    { slug: 'ive-members-zodiac-signs', title: 'IVE Members Zodiac Signs Read as a Verified Sun-Sign Map' },
    { slug: 'thor-zodiac-sign', title: 'What the Thor Zodiac Sign Really Means in Astrology' },
    { slug: 'billie-eilish-birth-chart', title: 'Billie Eilish Birth Chart Without Guessing Her Rising Sign' },
    { slug: 'taylor-swift-and-travis-kelce', title: 'What the Swift-Kelce Synastry Chart Reveals' },
    { slug: 'saturn-return', title: 'Saturn Return Explained' },
  ];
  for (const c of cases) {
    const words = buildTemplateHeroPrompt({ ...c, content: '' }).split(/\s+/).length;
    // ~77 tokens is roughly 55-60 English words; punctuation and hex codes cost extra,
    // so 60 is the ceiling a whole prompt may reach before CLIP starts dropping the tail.
    assert.ok(words <= 60, `${c.slug}: ${words} words exceeds the CLIP budget`);
  }
});

// Hex colour codes tokenize character by character and are disproportionately
// expensive; the palette must be named rather than spelled out.
test('the style clause names the palette instead of spelling hex codes', () => {
  const prompt = buildTemplateHeroPrompt({ slug: 'saturn-return', title: 'Saturn Return', content: '' });
  assert.doesNotMatch(prompt, /#[0-9a-f]{6}/i);
  assert.match(prompt, /no watermark/i);
});
