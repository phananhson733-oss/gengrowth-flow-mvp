#!/usr/bin/env node
// Smoke test for the batch-line replacement map (buildReplacements) — the pure
// core of renderAuraPrompt that gg-render-batch.smoke could not cover because it
// would need real RAG caches on disk. buildReplacements takes already-rendered
// RAG block strings, so we drive it with real persona cards (no mocks) and the
// REAL Definition / Pillar templates, then assert ZERO residual {{...}} after
// substitution — the exact condition renderAuraPrompt hard-exits (process.exit(1))
// on. This is the regression that shipped: batch EN Definition crashed because
// the 4 {{author_*}} placeholders had no key in the map.
//
// Run: node --test tools/scripts/__tests__/render-aura-author.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildReplacements,
  authorPromptCapsule,
  authorityAllowlist,
  journalPromptsBlock,
} from '../lib/_render-aura-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'lib', 'content-draft-templates');

// The exact regex renderAuraPrompt uses for its hard-exit decision.
const RESIDUAL_PLACEHOLDER = /\{\{[A-Z_a-z]+\}\}/;

function loadTemplate(name) {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8');
}

function substitute(template, replacements) {
  let out = template;
  for (const [k, v] of Object.entries(replacements)) {
    out = out.split(k).join(v == null ? '' : String(v));
  }
  return out;
}

// Minimal but COMPLETE cfg — every field a template references. RAG blocks are
// supplied as plain strings (renderAuraPrompt renders these from disk; here we
// pass realistic non-empty XML so substitution mirrors production).
function baseCfg(overrides = {}) {
  return {
    page_id: 'page_blue_aura_meaning',
    entity: 'Blue Aura',
    target_keyword: 'blue aura meaning',
    associated_keywords: ['blue aura color', 'throat chakra aura'],
    search_volume: '1900',
    cluster_jtbd: 'understand what a blue aura signals',
    content_angle: 'calm communicative energy',
    internal_link_rule: 'link to the aura colors pillar',
    cta_text: 'Read the full aura color guide',
    cta_target_url: 'https://astrologywiki.com/aura-colors',
    tier: 'T2',
    template: 'Definition',
    tier_gate_block: '<!-- tier gate -->',
    rl6_hint: 'no clinical claims',
    ...overrides,
  };
}

const RAG = {
  entityPassport: '<source name="entity-passport"><field name="x" domain="d">v</field></source>',
  frictionMine: '<source name="friction-mine"><field name="t" source="s" mentions="3">q</field></source>',
  serpSnippets: '<source name="serp-top" query="blue aura meaning"><field name="serp#1">s</field></source>',
  obsidianRag: '<!-- obsidian-rag: vault gap -->',
};

// ---------- authorPromptCapsule (pure, never throws, always 4 keys) ----------

test('authorPromptCapsule: valid id → 4 non-empty escaped capsule fields', () => {
  const c = authorPromptCapsule({ author_id: 'marcus-orion' });
  assert.equal(Object.keys(c).length, 4);
  assert.ok(c['{{author_voice_rule}}'].length > 0);
  assert.ok(c['{{author_allowed_moves}}'].length > 0);
  assert.ok(c['{{author_forbidden_moves}}'].length > 0);
  assert.ok(c['{{author_credential_meta}}'].length > 0);
});

test('authorPromptCapsule: quoted id is normalized like the fixture path', () => {
  const c = authorPromptCapsule({ author_id: '"marcus-orion"' });
  assert.ok(c['{{author_voice_rule}}'].length > 0);
});

test('authorPromptCapsule: absent / invalid / unknown → 4 empty-string keys (never throws)', () => {
  for (const cfg of [{}, { author_id: '' }, { author_id: 'not a writer!' }, { author_id: 'no-such-card' }]) {
    const c = authorPromptCapsule(cfg);
    assert.deepEqual(c, {
      '{{author_voice_rule}}': '',
      '{{author_allowed_moves}}': '',
      '{{author_forbidden_moves}}': '',
      '{{author_credential_meta}}': '',
    });
  }
});

// ---------- authorityAllowlist (pure, never throws, neutral default) ----------

test('authorityAllowlist: valid author_id → curated founder directive', () => {
  const s = authorityAllowlist({ author_id: 'elena-vane' });
  assert.ok(s.length > 0);
  assert.match(s, /Anodea Judith/);
  assert.match(s, /Cyndi Dale/);
  // Anti-hallucination guard text is present.
  assert.match(s, /et al\./);
});

test('authorityAllowlist: quoted / cased id normalizes like the rest of the pipeline', () => {
  assert.equal(authorityAllowlist({ author_id: '"Marcus-Orion"' }), authorityAllowlist({ author_id: 'marcus-orion' }));
  assert.match(authorityAllowlist({ author_id: 'marcus-orion' }), /Dane Rudhyar/);
});

test('authorityAllowlist: absent / invalid / unknown author_id → "" (neutral default)', () => {
  for (const cfg of [{}, { author_id: '' }, { author_id: 'no-such-author' }]) {
    assert.equal(authorityAllowlist(cfg), '');
  }
});

// authority_allowlist placeholder injection into the real Definition template.

test('Definition + authored cfg → {{authority_allowlist}} replaced with founder names', () => {
  const { replacements } = buildReplacements(baseCfg({ author_id: 'elena-vane' }), RAG);
  assert.ok(replacements['{{authority_allowlist}}'].length > 0);
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
  assert.match(rendered, /Anodea Judith/);
  // The relaxed rule text landed (allows naming founders, still bans citations).
  assert.match(rendered, /奠基人命名/);
});

test('Definition + unauthored cfg → {{authority_allowlist}} collapses to "" (no residual)', () => {
  const { replacements } = buildReplacements(baseCfg(), RAG);
  assert.equal(replacements['{{authority_allowlist}}'], '');
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
  // Anonymous-attribution fallback text is still present in the template.
  assert.match(rendered, /traditional subtle-energy teachings describe/);
});

test('Definition: external-link TBD instruction present (no real URL allowed)', () => {
  const { replacements } = buildReplacements(baseCfg(), RAG);
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.match(rendered, /TBD-external-link:/);
  assert.match(rendered, /paranormal/); // the fringe-title ban is documented
});

// ---------- journalPromptsBlock ----------

test('journalPromptsBlock: empty → "" (no bare placeholder survives)', () => {
  assert.equal(journalPromptsBlock(''), '');
  assert.equal(journalPromptsBlock(null), '');
  assert.equal(journalPromptsBlock(undefined), '');
  assert.equal(journalPromptsBlock('   '), '');
});

test('journalPromptsBlock: non-empty → <field>-wrapped, escaped seed block', () => {
  const out = journalPromptsBlock('When did you feel most heard? <ignore>');
  assert.match(out, /<field name="journal_prompts">/);
  assert.match(out, /&lt;ignore&gt;/); // escaped, not raw
  assert.doesNotMatch(out, /<ignore>/);
});

// ---------- the regression: NO residual {{...}} after substitution ----------

test('Definition + UNAUTHORED cfg → zero residual placeholders (the P0 crash)', () => {
  const { replacements } = buildReplacements(baseCfg(), RAG);
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  const residual = rendered.match(/\{\{[A-Z_a-z]+\}\}/g);
  assert.equal(residual, null, `residual placeholders: ${residual && [...new Set(residual)].join(', ')}`);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
});

test('Definition + AUTHORED cfg → zero residual placeholders + capsule filled', () => {
  const { replacements } = buildReplacements(baseCfg({ author_id: 'marcus-orion' }), RAG);
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
  // The capsule actually landed in the prompt (not just empty <field>).
  assert.match(rendered, /<field name="author_voice_rule">.+<\/field>/);
});

test('Definition + journal_prompts present → block rendered, no residual', () => {
  const cfg = baseCfg({ journal_prompts: 'Recall a moment you spoke up. | What did clarity cost you?' });
  const { replacements } = buildReplacements(cfg, RAG);
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
  assert.match(rendered, /## Journal Prompts seed/);
  assert.match(rendered, /Recall a moment you spoke up/);
});

test('Definition + journal_prompts empty → placeholder collapses to "", no residual', () => {
  const { replacements } = buildReplacements(baseCfg(), RAG);
  assert.equal(replacements['{{journal_prompts}}'], '');
  const rendered = substitute(loadTemplate('definition.prompt.md'), replacements);
  assert.doesNotMatch(rendered, /Journal Prompts seed/);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
});

test('Pillar + unauthored cfg → zero residual placeholders', () => {
  const cfg = baseCfg({ template: 'Pillar', child_entities: ['Red Aura', 'Green Aura'], child_count: 2 });
  const { replacements, isPillar } = buildReplacements(cfg, RAG);
  assert.equal(isPillar, true);
  const rendered = substitute(loadTemplate('pillar.prompt.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
});

test('ZH Definition + unauthored cfg → zero residual placeholders', () => {
  const cfg = baseCfg({ language: 'zh' });
  const { replacements, wordRangeArr } = buildReplacements(cfg, RAG);
  assert.deepEqual(wordRangeArr, [1500, 2000]); // ZH char default
  const rendered = substitute(loadTemplate('definition.prompt.zh.md'), replacements);
  assert.doesNotMatch(rendered, RESIDUAL_PLACEHOLDER);
});

// ---------- range derivation parity with the old inline logic ----------

test('buildReplacements ranges: EN definition / EN pillar defaults', () => {
  assert.deepEqual(buildReplacements(baseCfg(), RAG).wordRangeArr, [1500, 1800]);
  assert.deepEqual(buildReplacements(baseCfg(), RAG).kwRangeArr, [5, 8]);
  const pillar = buildReplacements(baseCfg({ template: 'Pillar' }), RAG);
  assert.deepEqual(pillar.wordRangeArr, [2500, 3500]);
  assert.deepEqual(pillar.kwRangeArr, [8, 12]);
});
