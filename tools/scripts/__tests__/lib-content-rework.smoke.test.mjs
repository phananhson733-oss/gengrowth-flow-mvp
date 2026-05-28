#!/usr/bin/env node
// Smoke tests for lib/content-rework.mjs — the Phase 2 fail → rework-prompt builder.
// Run: node --test tools/scripts/__tests__/lib-content-rework.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  buildReworkPrompt,
  structureFixHint,
  RL_FIX_HINTS,
  MAX_REWORK_ITERATIONS,
} from '../lib/content-rework.mjs';

const BASE_CTX = {
  pageId: 'page_chiron_7th_house',
  template: 'Tutorial',
  tier: 'T2',
  targetKeyword: 'chiron in 7th house',
  entity: 'Chiron',
  effectivePsychSafety: 'Y',
  iteration: 1,
};

const SAMPLE_DRAFT = '# Title\n\n## Section\nbody text about chiron.\n';

test('rework: failed red line → its id + note + targeted hint appear', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: {
      all_pass: false,
      rules: [
        { id: 'rl5_no_keyword_stuffing', pass: false, note: 'keyword count 15 > 12' },
        { id: 'rl1_no_clinical_claim', pass: true },
      ],
    },
    structureResult: { ok: true, issues: [] },
    ctx: BASE_CTX,
  });
  assert.match(out, /rl5_no_keyword_stuffing/);
  assert.match(out, /keyword count 15 > 12/);
  assert.match(out, /出现次数超限/); // the RL5 fix hint
  // a passing rule must NOT show up as a fix item
  assert.doesNotMatch(out, /### rl1_no_clinical_claim/);
});

test('rework: structure issue → matched directive (H2 count)', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: true, rules: [] },
    structureResult: { ok: false, issues: ['Tutorial expected 8 H2 sections, got 6'] },
    ctx: BASE_CTX,
  });
  assert.match(out, /Tutorial expected 8 H2 sections, got 6/);
  assert.match(out, /Tutorial = 8 节/);
});

test('rework: original draft embedded verbatim inside a fenced block', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: false, rules: [{ id: 'rl3_no_serp_plagiarism', pass: false, note: 'n' }] },
    structureResult: { ok: true, issues: [] },
    ctx: BASE_CTX,
  });
  assert.ok(out.includes(SAMPLE_DRAFT), 'draft body must be embedded for full context');
  assert.match(out, /````````markdown/); // fenced so markdown inside does not break out
});

test('rework: both red lines and structure failures listed together', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: false, rules: [{ id: 'rl6_psych_safety_disclaimer', pass: false, note: 'missing disclaimer' }] },
    structureResult: { ok: false, issues: ['psych_safety=Y but disclaimer line missing'] },
    ctx: BASE_CTX,
  });
  assert.match(out, /未通过的红线/);
  assert.match(out, /未通过的结构校验/);
  assert.match(out, /rl6_psych_safety_disclaimer/);
});

test('rework: iteration over MAX → escalation note present', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: false, rules: [{ id: 'rl5_no_keyword_stuffing', pass: false, note: 'n' }] },
    structureResult: { ok: true, issues: [] },
    ctx: { ...BASE_CTX, iteration: MAX_REWORK_ITERATIONS + 1 },
  });
  assert.match(out, /转人工审核/);
  assert.match(out, new RegExp(`第 ${MAX_REWORK_ITERATIONS + 1} 次`));
});

test('rework: page_id + template metadata header rendered', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: false, rules: [{ id: 'rl1_no_clinical_claim', pass: false, note: 'n' }] },
    structureResult: { ok: true, issues: [] },
    ctx: BASE_CTX,
  });
  assert.match(out, /page_chiron_7th_house/);
  assert.match(out, /Tutorial \/ T2/);
});

test('rework: empty failure set → still produces non-empty self-check prompt (defensive)', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: true, rules: [] },
    structureResult: { ok: true, issues: [] },
    ctx: BASE_CTX,
  });
  assert.ok(out.length > 0);
  assert.match(out, /自查/);
  assert.ok(out.includes(SAMPLE_DRAFT));
});

test('rework: unknown red line id → falls back to generic hint, no crash', () => {
  const out = buildReworkPrompt({
    draftMd: SAMPLE_DRAFT,
    redLineResult: { all_pass: false, rules: [{ id: 'rl_future_unknown', pass: false, note: 'x' }] },
    structureResult: { ok: true, issues: [] },
    ctx: BASE_CTX,
  });
  assert.match(out, /rl_future_unknown/);
  assert.match(out, /按红线说明修正/);
});

test('structureFixHint: known patterns map, unknown falls back', () => {
  assert.match(structureFixHint('missing H1 heading'), /H1 标题/);
  assert.match(structureFixHint('Tutorial Step count = 1 (< 3 required)'), /至少 3 个明确编号/);
  assert.match(structureFixHint('CTA anchor not found (cta text/url/H2)'), /CTA 段落/);
  assert.match(structureFixHint('some brand new issue text'), /按上面给出的问题描述修正/);
});

test('structureFixHint: SC3 段落过长 → v4.5 short-paragraph directive', () => {
  // matches the issue text gg-content-draft.structureCheck now emits
  assert.match(structureFixHint('SC3 段落过长 (L42): 120 words — "X is …"'), /编号列表|2-3 句|≤~60/);
});

test('structureFixHint: SC4 内链分布 → 首链优先权 directive', () => {
  assert.match(structureFixHint('SC4 内链分布: 0/3 internal link(s) inline in body prose — all parked in Related Reading'), /首链优先权|内联/);
});

test('RL_FIX_HINTS covers the blocking red lines that can fail', () => {
  for (const id of [
    'rl1_no_clinical_claim',
    'rl2_no_competitor_smear',
    'rl3_no_serp_plagiarism',
    'rl4_keyword_anchored',
    'rl5_no_keyword_stuffing',
    'rl6_psych_safety_disclaimer',
    'rl7_author_banned_tokens',
    'rl8_no_scientific_endorsement',
    'rl9_atom_label_leak',
    'rl10_depersonalization',
    'rl12_citation_hallucination',
  ]) {
    assert.ok(RL_FIX_HINTS[id], `missing fix hint for ${id}`);
  }
});
