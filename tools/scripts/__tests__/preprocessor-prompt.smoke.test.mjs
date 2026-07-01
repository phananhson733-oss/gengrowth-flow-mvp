#!/usr/bin/env node
// Smoke test for lib/preprocessor-prompt.mjs — the single-source-of-truth for the
// "content variable" field contract shared by gg-brief-suggest.mjs (automated path)
// and the manual 变量预处理器 ChatGPT-paste prompt.
// Run: node --test tools/scripts/__tests__/preprocessor-prompt.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  FIELD_RULES,
  ASTROLOGY_SAFETY_RULE,
  LEXICAL_HYGIENE_RULE,
  PROMPT_INJECTION_NOTICE,
  ABORT_RULE,
  CONFIDENCE_ANCHORS,
  GAP_FALSIFIABILITY_RULE,
  DRAFT_ANGLE_RULE,
  frictionShape,
  logicShape,
  astrologyClaimRisk,
  gapFalsifiable,
  confidenceValid,
  renderPreprocessorPrompt,
} from '../lib/preprocessor-prompt.mjs';

// ---------- FIELD_RULES: field contract aligned to canonical spec ----------

test('FIELD_RULES covers the 5 content-variable fields', () => {
  for (const k of ['entity', 'entity_topology', 'friction', 'logic', 'content_angle']) {
    assert.ok(typeof FIELD_RULES[k] === 'string' && FIELD_RULES[k].length > 10, `${k} rule missing`);
  }
});

test('FIELD_RULES.logic is Mechanism+Trade-off paragraph, NOT a one-sentence angle (fixes gg-brief-suggest:158)', () => {
  const r = FIELD_RULES.logic;
  assert.match(r, /机制|Mechanism/i);
  assert.match(r, /权衡|Trade-?off/i);
  // must demand a multi-sentence paragraph, not "ONE sentence"
  assert.doesNotMatch(r, /\bONE sentence\b/i);
  assert.match(r, /3|three|段|paragraph|sentences/i);
});

test('FIELD_RULES.friction is a single ≤25-word objective statement (fixes gg-brief-suggest:157 "3-5 sentences")', () => {
  const r = FIELD_RULES.friction;
  assert.match(r, /25/);
  assert.doesNotMatch(r, /3-5\s+(plain-prose\s+)?sentences/i);
  assert.match(r, /I\/you\/we|第三人称|third-person/i);
});

test('FIELD_RULES.entity_topology encodes the §4 triad and folds into Logic (no sheet column)', () => {
  const r = FIELD_RULES.entity_topology;
  assert.match(r, /↔/);
  assert.match(r, /Logic/i);
});

test('FIELD_RULES.content_angle is differentiated angle, no embedded audit labels', () => {
  assert.match(FIELD_RULES.content_angle, /angle|角度/i);
});

// ---------- safety / abort / evidence rule constants ----------

test('safety + abort + injection + gap + draft-angle rule constants are present', () => {
  assert.match(ASTROLOGY_SAFETY_RULE, /predict|cause|proof|prove|科学|scientific/i);
  assert.match(ABORT_RULE, /Needs More Evidence/i);
  assert.match(ABORT_RULE, /5/); // SERP < 5
  assert.match(PROMPT_INJECTION_NOTICE, /untrusted|instruction|指令|证据/i);
  assert.match(LEXICAL_HYGIENE_RULE, /governs|strong verb|recursive|architecture/i);
  assert.match(CONFIDENCE_ANCHORS, /High/);
  assert.match(GAP_FALSIFIABILITY_RULE, /title|snippet/i);
  assert.match(DRAFT_ANGLE_RULE, /KEPT|NARROWED|REJECTED/);
});

// ---------- frictionShape validator ----------

test('frictionShape accepts a valid ≤25-word third-person single sentence', () => {
  const v = 'Seekers conflate aura color with a fixed personality type because quiz-based SERP trains users to expect one permanent answer.';
  assert.equal(frictionShape(v).ok, true);
});

test('frictionShape rejects first/second person', () => {
  const r = frictionShape('I keep failing to find what my aura color actually means.');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /person|pronoun|人称/i.test(x)));
});

test('frictionShape rejects >25 words', () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ') + '.';
  assert.equal(frictionShape(long).ok, false);
});

test('frictionShape rejects multi-sentence (3-5 sentence drift)', () => {
  const r = frictionShape('Readers are confused. They cannot tell shades apart. The top results do not help.');
  assert.equal(r.ok, false);
  assert.ok(r.reasons.some((x) => /sentence|句/i.test(x)));
});

test('frictionShape rejects empty', () => {
  assert.equal(frictionShape('').ok, false);
});

// ---------- logicShape validator ----------

test('logicShape accepts a 3-sentence mechanism paragraph', () => {
  const v = 'The North Node renders blue in most chart software as a visual shorthand. It marks the soul evolutionary leading edge, contrasting with the South Node repository. This color coding is software-specific and varies across platforms.';
  assert.equal(logicShape(v).ok, true);
});

test('logicShape rejects a one-sentence "writing angle" (the gg-brief-suggest:158 bug shape)', () => {
  const r = logicShape('Differentiator vs the top-10 SERP results.');
  assert.equal(r.ok, false);
});

test('logicShape is not fooled by abbreviations into counting a one-liner as multi-sentence', () => {
  // U.S. + e.g. + 3.5 carry internal periods; this is still ONE sentence.
  const oneLiner =
    'The U.S. source context frames the entity, e.g. a reflective 3.5-point lens, as interpretive rather than predictive or measurable in real-world outcomes for readers.';
  assert.equal(logicShape(oneLiner).ok, false);
});

// ---------- astrologyClaimRisk: §4 science boundary ----------

test('astrologyClaimRisk flags prediction / causation / guarantee claims', () => {
  assert.equal(astrologyClaimRisk('Jupiter in Cancer guarantees a World Cup win for the hosts.').risk, true);
  assert.equal(astrologyClaimRisk('Saturn return causes divorce in most people.').risk, true);
  assert.equal(astrologyClaimRisk('This transit predicts the outcome of the match.').risk, true);
});

test('astrologyClaimRisk passes observational hedged framing', () => {
  assert.equal(astrologyClaimRisk('Saturn is traditionally associated with discipline and structure.').risk, false);
});

test('astrologyClaimRisk does NOT flag negated boundary language (the prompt asks for it)', () => {
  assert.equal(astrologyClaimRisk('This is not proof of any outcome.').risk, false);
  assert.equal(astrologyClaimRisk('This does not predict the result of the match.').risk, false);
  assert.equal(astrologyClaimRisk('The placement carries no guarantee of success.').risk, false);
  // but a real claim still fires, and "not only predicts" keeps the claim
  assert.equal(astrologyClaimRisk('Astrology proves the outcome.').risk, true);
  assert.equal(astrologyClaimRisk('It not only predicts but determines the result.').risk, true);
});

// ---------- gapFalsifiable: information-gain hallucination guard ----------

test('gapFalsifiable flags unfalsifiable absolute "none address X"', () => {
  assert.equal(gapFalsifiable('None of the SERP results address the chakra-color mechanism.').ok, false);
});

test('gapFalsifiable passes title-scoped falsifiable phrasing', () => {
  assert.equal(gapFalsifiable('No title in the provided set surfaces the chakra-color mechanism.').ok, true);
});

test('gapFalsifiable flags "not / ignore / pages / competitors" absolute variants', () => {
  assert.equal(gapFalsifiable('Competitors do not mention the chakra-color mechanism.').ok, false);
  assert.equal(gapFalsifiable('All pages ignore the trade-off entirely.').ok, false);
});

test('frictionShape does not misfire on astrology words containing "us" / pronoun substrings', () => {
  assert.equal(frictionShape('Taurus readers overlook house context when judging compatibility.').ok, true);
  assert.equal(frictionShape('Various SERP pages flatten Mars placement into raw motivation.').ok, true);
});

// ---------- confidenceValid ----------

test('confidenceValid accepts High/Medium/Low, rejects junk', () => {
  assert.equal(confidenceValid('High'), true);
  assert.equal(confidenceValid('Medium'), true);
  assert.equal(confidenceValid('Med'), true);
  assert.equal(confidenceValid('Low'), true);
  assert.equal(confidenceValid('very high'), false);
  assert.equal(confidenceValid(''), false);
});

// ---------- renderPreprocessorPrompt: full manual v2.0 prompt ----------

test('renderPreprocessorPrompt emits a two-layer 6-field contract with all guards', () => {
  const p = renderPreprocessorPrompt({
    targetKeyword: 'blue node astrology',
    tier: 'T2',
    template: 'Definition',
    clusterContext: 'cluster: nodal-axis',
  });
  // two output layers
  assert.match(p, /SHEET_FIELDS/);
  assert.match(p, /REVIEW_METADATA/);
  // production fields
  for (const f of ['Entity', 'Entity_Topology', 'Friction', 'Logic', 'Content_Angle']) {
    assert.match(p, new RegExp(f));
  }
  // guards woven in
  assert.match(p, /Needs More Evidence/);
  assert.match(p, /untrusted|证据/i);
  assert.match(p, /predict|scientific|科学/i);
  // the target keyword is interpolated
  assert.match(p, /blue node astrology/);
});
