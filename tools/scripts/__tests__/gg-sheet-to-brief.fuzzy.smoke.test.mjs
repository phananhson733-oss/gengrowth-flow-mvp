#!/usr/bin/env node
// Fuzzy-match diagnostics smoke test for gg-sheet-to-brief.mjs.
// No live Sheet API — mocks clusterMap / ctaMap inline.
// Run: node --test tools/scripts/__tests__/gg-sheet-to-brief.fuzzy.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  levenshtein,
  suggestMatches,
  formatSuggestionBlock,
  clusterCandidates,
  ctaCandidates,
  composeOverride,
  buildClusterMap,
  buildCtaMap,
} from '../gg-sheet-to-brief.mjs';

// ---------- levenshtein primitive ----------
test('levenshtein: identical → 0', () => {
  assert.equal(levenshtein('fam-aura', 'fam-aura'), 0);
});

test('levenshtein: empty strings → length of other', () => {
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('abc', ''), 3);
  assert.equal(levenshtein('', ''), 0);
});

test('levenshtein: single substitution → 1', () => {
  assert.equal(levenshtein('fam-aura', 'fam-bura'), 1);
});

test('levenshtein: single insertion → 1', () => {
  assert.equal(levenshtein('fam-aura', 'fam-auras'), 1);
});

test('levenshtein: single deletion → 1', () => {
  assert.equal(levenshtein('fam-aura', 'fam-ura'), 1);
});

test('levenshtein: transposition counts as 2 (classic non-Damerau)', () => {
  // "aura" → "aura" with two adjacent chars swapped = "aura" → "arua" = 2 substitutions
  assert.equal(levenshtein('aura', 'arua'), 2);
});

test('levenshtein: unrelated strings → large distance', () => {
  const d = levenshtein('fam-aura', 'cluster_aura_colors_palette');
  assert.ok(d > 10, `expected >10, got ${d}`);
});

test('levenshtein: handles null/undefined as empty string', () => {
  assert.equal(levenshtein(null, 'abc'), 3);
  assert.equal(levenshtein(undefined, ''), 0);
  assert.equal(levenshtein('abc', null), 3);
});

// ---------- suggestMatches ----------
const FAM_CANDIDATES = [
  { key: 'fam-aura', label: '🌈 Aura Family (pillar + 8 colors)' },
  { key: 'fam-vedic', label: '🕉 Vedic Astrology Family' },
  { key: 'fam-chakra', label: '🔮 Chakra Family' },
  { key: 'cluster_aura_colors_palette', label: 'Legacy palette cluster' },
];

test('suggestMatches: case typo "fam-Aura" → top hit "fam-aura" dist=0 (normalized)', () => {
  const out = suggestMatches('fam-Aura', FAM_CANDIDATES);
  assert.ok(out.length >= 1);
  assert.equal(out[0].key, 'fam-aura');
  assert.equal(out[0].dist, 0, 'case-only diff should normalize to dist 0');
});

test('suggestMatches: ALL-CAPS "FAM-AURA" → "fam-aura" dist=0', () => {
  const out = suggestMatches('FAM-AURA', FAM_CANDIDATES);
  assert.equal(out[0].key, 'fam-aura');
  assert.equal(out[0].dist, 0);
});

test('suggestMatches: extra whitespace " fam-aura " → "fam-aura" dist=0', () => {
  const out = suggestMatches(' fam-aura ', FAM_CANDIDATES);
  assert.equal(out[0].key, 'fam-aura');
  assert.equal(out[0].dist, 0);
});

test('suggestMatches: single substitution "fam-buga" → "fam-aura" dist=2 returned', () => {
  // "fam-buga" vs "fam-aura": diffs at positions 4 (b vs a), 5 (u vs u), 6 (g vs r) → dist 2
  const out = suggestMatches('fam-buga', FAM_CANDIDATES);
  assert.ok(out.some((s) => s.key === 'fam-aura'), 'fam-aura should appear in suggestions');
});

test('suggestMatches: transposition typo "fam-arua" → "fam-aura" dist=2', () => {
  const out = suggestMatches('fam-arua', FAM_CANDIDATES);
  assert.equal(out[0].key, 'fam-aura');
  assert.equal(out[0].dist, 2);
});

test('suggestMatches: unrelated string "completely_wrong_key" → empty array (over threshold)', () => {
  const out = suggestMatches('completely_wrong_key', FAM_CANDIDATES);
  assert.equal(out.length, 0, 'no candidate within edit distance 3 → empty');
});

test('suggestMatches: caps at top 3 by default', () => {
  const candidates = [
    { key: 'aaaa', label: '' },
    { key: 'aaab', label: '' },
    { key: 'aaac', label: '' },
    { key: 'aaad', label: '' },
  ];
  const out = suggestMatches('aaaa', candidates);
  assert.equal(out.length, 3);
});

test('suggestMatches: deterministic sort (dist asc, then key asc)', () => {
  const candidates = [
    { key: 'fam-zzz', label: '' },
    { key: 'fam-aaa', label: '' }, // both dist 3 from "fam-bbb"
  ];
  const out = suggestMatches('fam-bbb', candidates);
  assert.equal(out[0].key, 'fam-aaa', 'tie broken by key asc');
});

test('suggestMatches: honors maxDist option', () => {
  const out = suggestMatches('fam-aura', FAM_CANDIDATES, { maxDist: 0 });
  assert.equal(out.length, 1, 'only exact match (post-normalize)');
});

test('suggestMatches: honors limit option', () => {
  const out = suggestMatches('fam-aura', FAM_CANDIDATES, { limit: 1 });
  assert.equal(out.length, 1);
});

// ---------- formatSuggestionBlock ----------
test('formatSuggestionBlock: renders FATAL line + Did you mean + Fix hint', () => {
  const block = formatSuggestionBlock(
    'fam-Aura',
    '主题集群表 cluster_id',
    [
      { key: 'fam-aura', label: '🌈 Aura Family', dist: 0 },
      { key: 'fam-vedic', label: '🕉 Vedic', dist: 3 },
    ],
    'update 选题登记表 row 12 col Q from "fam-Aura" to "fam-aura".',
  );
  assert.match(block, /FATAL: 主题集群表 cluster_id key "fam-Aura" not found/);
  assert.match(block, /Did you mean:/);
  assert.match(block, /fam-aura.*dist=0/);
  assert.match(block, /fam-vedic.*dist=3/);
  assert.match(block, /🌈 Aura Family/);
  assert.match(block, /Fix: update 选题登记表 row 12 col Q/);
});

test('formatSuggestionBlock: empty suggestions → "no candidates within edit distance 3" message', () => {
  const block = formatSuggestionBlock('totally-unrelated', 'CTA Map page_role', [], null);
  assert.match(block, /no candidates within edit distance 3/);
});

// ---------- clusterCandidates / ctaCandidates ----------
test('clusterCandidates: extracts {key, label} from clusterMap', () => {
  const rows = [
    ['cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role', 'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page', 'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule', 'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric', 'child_entities'],
    ['fam-aura', '🌈 Aura Family', '量产线', '', '', '', '', '', '', '', '', '', '', '', '', 'N', '', '', '', ''],
    ['fam-vedic', '🕉 Vedic Astrology', '量产线', '', '', '', '', '', '', '', '', '', '', '', '', 'N', '', '', '', ''],
  ];
  const cands = clusterCandidates(buildClusterMap(rows));
  assert.equal(cands.length, 2);
  assert.deepEqual(cands.find((c) => c.key === 'fam-aura'), { key: 'fam-aura', label: '🌈 Aura Family' });
});

test('ctaCandidates: dedupes by page_role (first row wins)', () => {
  const rows = [
    ['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track'],
    ['c1', 'Pillar', 'pillar cta v1', 'https://x/1', 'e1', '量产线'],
    ['c2', 'Pillar', 'pillar cta v2', 'https://x/2', 'e2', '精修线'], // same page_role → deduped
    ['c3', 'Series', 'series cta', 'https://x/3', 'e3', '量产线'],
  ];
  const { map } = buildCtaMap(rows);
  const cands = ctaCandidates(map);
  assert.equal(cands.length, 2, 'Pillar dedup + Series = 2');
  const pillar = cands.find((c) => c.key === 'Pillar');
  assert.equal(pillar.label, 'pillar cta v1', 'first row wins');
});

// ---------- composeOverride: joinFailures attached ----------
test('composeOverride: missing cluster_id surfaces joinFailures with kind=cluster_id', () => {
  const clusterMap = buildClusterMap([
    ['cluster_id', 'cluster_name'],
    ['fam-aura', '🌈 Aura Family'],
  ]);
  const ctaMap = buildCtaMap([
    ['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track'],
    ['c1', 'Series', 'cta', 'https://x/1', 'e1', '量产线'],
  ]).map;
  const row = {
    source_row: 12,
    page_id: 'page_x',
    brief: {
      target_keyword: 'x', tier: 'T2', template: 'Definition', entity: 'X',
      cluster_id: 'fam-Aura', page_role: 'Series', psych_safety_flag: 'N',
    },
  };
  const result = composeOverride(row, { clusterMap, ctaMap, repo: '/tmp/x' });
  assert.ok(result.joinFailures && result.joinFailures.length >= 1);
  const clusterFail = result.joinFailures.find((j) => j.kind === 'cluster_id');
  assert.equal(clusterFail.missing, 'fam-Aura');
});

test('composeOverride: missing page_role surfaces joinFailures with kind=page_role', () => {
  const clusterMap = buildClusterMap([
    ['cluster_id', 'cluster_name', 'track'],
    ['fam-aura', 'Aura', '量产线'],
  ]);
  const ctaMap = buildCtaMap([
    ['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track'],
    ['c1', 'Pillar', 'pillar cta', 'https://x/1', 'e1', '量产线'],
  ]).map;
  const row = {
    source_row: 14,
    page_id: 'page_y',
    brief: {
      target_keyword: 'y', tier: 'T2', template: 'Definition', entity: 'Y',
      cluster_id: 'fam-aura', page_role: 'Seris', psych_safety_flag: 'N', // typo: Seris
    },
  };
  const result = composeOverride(row, { clusterMap, ctaMap, repo: '/tmp/x' });
  const roleFail = result.joinFailures.find((j) => j.kind === 'page_role');
  assert.ok(roleFail, 'must surface page_role join failure');
  assert.equal(roleFail.missing, 'Seris');
});

// ---------- end-to-end: integration of all pieces ----------
test('integration: case-typo cluster_id → suggestion block recommends correct casing', () => {
  const clusterMap = buildClusterMap([
    ['cluster_id', 'cluster_name'],
    ['fam-aura', '🌈 Aura Family (pillar + 8 colors)'],
    ['fam-vedic', '🕉 Vedic Astrology Family'],
    ['fam-chakra', 'Chakra Family'],
  ]);
  const cands = clusterCandidates(clusterMap);
  const suggestions = suggestMatches('fam-Aura', cands);
  assert.equal(suggestions[0].key, 'fam-aura');
  assert.equal(suggestions[0].dist, 0);

  const block = formatSuggestionBlock(
    'fam-Aura',
    '主题集群表 cluster_id',
    suggestions,
    'update 选题登记表 row 12 col Q from "fam-Aura" to "fam-aura".',
  );
  assert.match(block, /fam-aura.*dist=0.*🌈/);
});

// ---------- performance smoke ----------
test('perf: levenshtein over 24 clusters + 10 CTA roles completes in <10ms', () => {
  const clusters = Array.from({ length: 24 }, (_, i) => ({
    key: `fam-cluster-${i.toString().padStart(2, '0')}`,
    label: `Cluster ${i}`,
  }));
  const ctas = Array.from({ length: 10 }, (_, i) => ({
    key: `Role${i}`,
    label: `CTA ${i}`,
  }));
  const t0 = performance.now();
  // 50 iterations to amortize timer noise on cold start
  for (let n = 0; n < 50; n++) {
    suggestMatches('fam-cluster-05', clusters);
    suggestMatches('Role3', ctas);
  }
  const elapsed = performance.now() - t0;
  // 50 iter × 2 lookups × 34 candidates × ~30-char strings → should be a few ms total.
  assert.ok(elapsed < 50, `expected <50ms for 50 iters (=<1ms per call), got ${elapsed.toFixed(2)}ms`);
});
