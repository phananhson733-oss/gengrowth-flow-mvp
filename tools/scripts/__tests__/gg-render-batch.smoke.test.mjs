#!/usr/bin/env node
// Smoke test for gg-render-batch.mjs — pure helpers + RAG-cache probe.
// No renderAuraPrompt invocation here (that would need real RAG caches).
// Run: node --test tools/scripts/__tests__/gg-render-batch.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REQUIRED_CFG_FIELDS,
  REQUIRED_RAG_CACHES,
  parseArgs,
  inSlice,
  parseTier,
  normalizeTemplate,
  composeCfg,
  missingFields,
  missingRagCaches,
} from '../gg-render-batch.mjs';
import { authorFixtureFields } from '../lib/_render-aura-shared.mjs';

// ---------- constants ----------
test('REQUIRED_CFG_FIELDS covers every renderAuraPrompt mandatory input', () => {
  for (const f of [
    'page_id',
    'entity',
    'target_keyword',
    'associated_keywords',
    'search_volume',
    'cluster_jtbd',
    'content_angle',
    'internal_link_rule',
    'cta_text',
    'cta_target_url',
    'tier_gate_block',
    'rl6_hint',
    'friction_themes',
  ]) {
    assert.ok(REQUIRED_CFG_FIELDS.includes(f), `REQUIRED_CFG_FIELDS missing ${f}`);
  }
});

test('REQUIRED_RAG_CACHES = entity-passport + obsidian-rag (SERP is non-blocking)', () => {
  assert.deepEqual([...REQUIRED_RAG_CACHES].sort(), ['entity-passport.rag.json', 'obsidian-rag.json']);
});

// ---------- parseArgs ----------
test('parseArgs handles boolean flags', () => {
  const args = parseArgs(['--batch', '/p.json', '--dry-run', '--continue-on-error']);
  assert.equal(args.batch, '/p.json');
  assert.equal(args.dry_run, true);
  assert.equal(args.continue_on_error, true);
});

// ---------- inSlice ----------
test('inSlice with no slice = match all', () => {
  assert.equal(inSlice(5, null), true);
  assert.equal(inSlice(99, undefined), true);
});

test('inSlice single row N', () => {
  assert.equal(inSlice(5, '5'), true);
  assert.equal(inSlice(6, '5'), false);
});

test('inSlice range N-M (inclusive)', () => {
  assert.equal(inSlice(3, '3-5'), true);
  assert.equal(inSlice(5, '3-5'), true);
  assert.equal(inSlice(6, '3-5'), false);
  assert.equal(inSlice(2, '3-5'), false);
});

test('inSlice rejects malformed input', () => {
  assert.throws(() => inSlice(3, 'abc'), /invalid slice/);
});

// ---------- parseTier ----------
test('parseTier maps Lynne sheet conventions to renderer codes', () => {
  assert.equal(parseTier('Tier 1 (重装)'), 'T1');
  assert.equal(parseTier('Tier 2 (标准)'), 'T2');
  assert.equal(parseTier('Tier 3'), 'T3');
  assert.equal(parseTier('T2'), 'T2');
  assert.equal(parseTier('1'), 'T1');
  assert.equal(parseTier(''), null);
  assert.equal(parseTier(null), null);
});

// ---------- normalizeTemplate ----------
test('normalizeTemplate accepts Pillar + Definition', () => {
  assert.deepEqual(normalizeTemplate('Pillar'), { value: 'Pillar', warning: null });
  assert.deepEqual(normalizeTemplate('pillar'), { value: 'Pillar', warning: null });
  assert.deepEqual(normalizeTemplate('Definition'), { value: 'Definition', warning: null });
});

test('normalizeTemplate warns and falls back when template is Tutorial', () => {
  const r = normalizeTemplate('Tutorial');
  assert.equal(r.value, 'Definition');
  assert.match(r.warning, /Tutorial/);
});

test('normalizeTemplate warns on unknown values', () => {
  const r = normalizeTemplate('FakeType');
  assert.equal(r.value, 'Definition');
  assert.match(r.warning, /unknown template/);
});

test('normalizeTemplate handles empty input', () => {
  assert.deepEqual(normalizeTemplate(''), { value: 'Definition', warning: null });
  assert.deepEqual(normalizeTemplate(null), { value: 'Definition', warning: null });
});

// ---------- composeCfg ----------
test('composeCfg merges brief fields then override (override wins)', () => {
  const row = {
    page_id: 'page_x',
    brief: {
      target_keyword: 'sheet kw',
      entity: 'Sheet Entity',
      associated_keywords: ['a'],
      search_volume: '100',
      content_angle: 'sheet angle',
      cta_target_url: 'sheet-cta',
      tier: 'Tier 1 (重装)',
      template: 'Definition',
    },
  };
  const override = {
    entity: 'Override Entity', // overrides brief
    cluster_jtbd: 'override jtbd', // fills gap
    cta_text: 'click me',
  };
  const { cfg, warnings } = composeCfg(row, override);
  assert.equal(cfg.page_id, 'page_x');
  assert.equal(cfg.entity, 'Override Entity', 'override should win');
  assert.equal(cfg.target_keyword, 'sheet kw');
  assert.equal(cfg.cluster_jtbd, 'override jtbd');
  assert.equal(cfg.cta_text, 'click me');
  assert.equal(cfg.cta_target_url, 'sheet-cta');
  assert.equal(cfg.template, 'Definition');
  assert.equal(cfg.tier, 'T1');
  assert.deepEqual(warnings, []);
});

test('composeCfg honors override.page_id as an alias (row 3 → pillar)', () => {
  const row = { page_id: 'page_aura_colors', brief: { target_keyword: 'aura colors', entity: 'aura colors' } };
  const { cfg } = composeCfg(row, { page_id: 'page_aura_colors_pillar' });
  assert.equal(cfg.page_id, 'page_aura_colors_pillar');
});

test('composeCfg falls back to row.page_id when override.page_id absent', () => {
  const row = { page_id: 'page_blue_aura_meaning', brief: {} };
  const { cfg } = composeCfg(row, { entity: 'Blue Aura' });
  assert.equal(cfg.page_id, 'page_blue_aura_meaning');
});

test('composeCfg defaults tier=T2 and template=Definition when both absent', () => {
  const { cfg } = composeCfg({ page_id: 'p', brief: { target_keyword: 'x', entity: 'y' } }, {});
  assert.equal(cfg.tier, 'T2');
  assert.equal(cfg.template, 'Definition');
});

test('composeCfg surfaces Tutorial fallback warning', () => {
  const { cfg, warnings } = composeCfg({ page_id: 'p', brief: { template: 'Tutorial' } }, {});
  assert.equal(cfg.template, 'Definition');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Tutorial/);
});

// ---------- missingFields ----------
test('missingFields returns every cfg field that is empty / null / [] ', () => {
  const cfg = {
    page_id: 'p',
    entity: 'e',
    target_keyword: 'k',
    associated_keywords: [],
    search_volume: '',
    cluster_jtbd: 'x',
  };
  const miss = missingFields(cfg);
  assert.ok(miss.includes('associated_keywords'));
  assert.ok(miss.includes('search_volume'));
  assert.ok(miss.includes('content_angle'));
  assert.ok(!miss.includes('page_id'));
  assert.ok(!miss.includes('cluster_jtbd'));
});

test('missingFields returns [] when all fields present', () => {
  const cfg = {};
  for (const f of REQUIRED_CFG_FIELDS) cfg[f] = f === 'associated_keywords' || f === 'friction_themes' ? ['x'] : 'x';
  assert.deepEqual(missingFields(cfg), []);
});

// ---------- missingRagCaches ----------
test('missingRagCaches scans .gg-cache/<page_id>/ for required cache files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gg-render-batch-rag-'));
  const cacheDir = join(tmp, '.gg-cache', 'page_test');
  mkdirSync(cacheDir, { recursive: true });
  // missing both
  assert.deepEqual([...missingRagCaches('page_test', tmp)].sort(), ['entity-passport.rag.json', 'obsidian-rag.json']);
  // create one
  writeFileSync(join(cacheDir, 'entity-passport.rag.json'), '{}');
  assert.deepEqual(missingRagCaches('page_test', tmp), ['obsidian-rag.json']);
  // create both
  writeFileSync(join(cacheDir, 'obsidian-rag.json'), '{}');
  assert.deepEqual(missingRagCaches('page_test', tmp), []);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------- author routing passthrough (Lane B / T3, batch path) ----------

test('composeCfg carries the pull-resolved author into cfg.author_id', () => {
  const { cfg } = composeCfg({ brief: { entity: 'E', target_keyword: 'k', author: 'marcus-orion', author_source: 'auto' }, page_id: 'page_x' }, {});
  assert.equal(cfg.author_id, 'marcus-orion');
  assert.equal(cfg.author_source, 'auto');
});

test('composeCfg: override.author_id wins over brief.author', () => {
  const { cfg } = composeCfg({ brief: { entity: 'E', target_keyword: 'k', author: 'marcus-orion' }, page_id: 'page_x' }, { author_id: 'elena-vane' });
  assert.equal(cfg.author_id, 'elena-vane');
});

test('composeCfg: no author → cfg omits author_id (clean fixture)', () => {
  const { cfg } = composeCfg({ brief: { entity: 'E', target_keyword: 'k' }, page_id: 'page_x' }, {});
  assert.ok(!('author_id' in cfg), 'author_id must be omitted when no author resolved');
});

test('authorFixtureFields: valid id → author_id + display + banned_tokens', () => {
  const f = authorFixtureFields({ author_id: 'marcus-orion', author_source: 'auto' });
  assert.equal(f.author_id, 'marcus-orion');
  assert.equal(f.author_source, 'auto');
  assert.equal(typeof f.author_display_name, 'string');
  assert.ok(Array.isArray(f.banned_tokens) && f.banned_tokens.length > 0);
});

test('authorFixtureFields: quoted id is normalized', () => {
  const f = authorFixtureFields({ author_id: '"marcus-orion"' });
  assert.equal(f.author_id, 'marcus-orion');
});

test('authorFixtureFields: absent / invalid → {} (no fixture noise)', () => {
  assert.deepEqual(authorFixtureFields({}), {});
  assert.deepEqual(authorFixtureFields({ author_id: 'not-a-writer' }), {});
});
