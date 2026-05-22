#!/usr/bin/env node
// Smoke test for gg-keyword-mine.mjs — pure helpers only, no DataForSEO call.
// Run: node --test tools/scripts/__tests__/gg-keyword-mine.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  DEFAULT_LOCATION_CODE,
  DEFAULT_LANGUAGE_CODE,
  DEFAULT_MAX_KD,
  DEFAULT_MIN_VOLUME,
  DEFAULT_MAX_RESULTS,
  PER_SEED_LIMIT,
  AIO_VOLUME_THRESHOLD,
  MASTER_TAB,
  CANDIDATES_TAB,
  isAioHighRisk,
  computeGeo,
  isNegativeMatch,
  filterAndRank,
  parseLabsItem,
  buildCandidateRow,
  buildMasterRowMine,
  parseArgs,
  parseSeeds,
  parseNegatives,
} from '../gg-keyword-mine.mjs';

// ---------- constants ----------
test('defaults match spec keyword-research-sop §一来源 3 + §二 GEO 闸门', () => {
  assert.equal(DEFAULT_LOCATION_CODE, 2840); // US
  assert.equal(DEFAULT_LANGUAGE_CODE, 'en');
  assert.equal(DEFAULT_MAX_KD, 50);
  assert.equal(DEFAULT_MIN_VOLUME, 50);
  assert.equal(DEFAULT_MAX_RESULTS, 15);
  assert.equal(PER_SEED_LIMIT, 100);
  assert.equal(AIO_VOLUME_THRESHOLD, 500);
});

test('tab names match Sheet schema', () => {
  assert.equal(MASTER_TAB, '关键词主表');
  assert.equal(CANDIDATES_TAB, 'keyword_candidates');
});

// ---------- isAioHighRisk ----------
test('isAioHighRisk: volume ≥ 500 AND definition-word → true', () => {
  assert.equal(isAioHighRisk('what is blue aura', 800), true);
  assert.equal(isAioHighRisk('blue aura meaning', 12100), true);
  assert.equal(isAioHighRisk('blue aura definition', 600), true);
  assert.equal(isAioHighRisk('how does aura work', 1500), true);
  assert.equal(isAioHighRisk('blue aura explained', 700), true);
});

test('isAioHighRisk: volume below 500 → false (regardless of word type)', () => {
  assert.equal(isAioHighRisk('what is blue aura', 400), false);
  assert.equal(isAioHighRisk('blue aura meaning', 499), false);
  assert.equal(isAioHighRisk('blue aura meaning', 0), false);
});

test('isAioHighRisk: no definition-word → false (regardless of volume)', () => {
  assert.equal(isAioHighRisk('best blue aura tools', 5000), false);
  assert.equal(isAioHighRisk('blue aura vs red aura', 2000), false);
  assert.equal(isAioHighRisk('how to read blue aura', 3000), false); // "how to" not "how does"
});

test('isAioHighRisk handles null/invalid volume gracefully', () => {
  assert.equal(isAioHighRisk('what is x', null), false);
  assert.equal(isAioHighRisk('what is x', 'abc'), false);
  assert.equal(isAioHighRisk('what is x', undefined), false);
});

// ---------- computeGeo ----------
test('computeGeo follows the same formula as gg-keyword-fallback (no divergence)', () => {
  // Same inputs → same output as gg-keyword-fallback.computeGeo.
  // High volume, low KD, AIO present → high score.
  const s = computeGeo({ volume: 5000, kd: 10, serpFeatures: ['ai_overview'] });
  assert.ok(s > 2.0);
  // Low volume, high KD → low score.
  const lo = computeGeo({ volume: 100, kd: 80, serpFeatures: [] });
  assert.ok(lo < 1.0);
});

test('computeGeo returns null when volume missing', () => {
  assert.equal(computeGeo({ volume: null, kd: 20, serpFeatures: [] }), null);
});

// ---------- isNegativeMatch ----------
test('isNegativeMatch: substring case-insensitive', () => {
  assert.equal(isNegativeMatch('miami dade bus tracker', ['miami', 'bus tracker']), true);
  assert.equal(isNegativeMatch('Miami DADE Bus Tracker', ['miami']), true);
  assert.equal(isNegativeMatch('blue aura', ['miami']), false);
});

test('isNegativeMatch: empty negatives list returns false', () => {
  assert.equal(isNegativeMatch('anything', []), false);
  assert.equal(isNegativeMatch('anything', null), false);
});

// ---------- filterAndRank ----------
test('filterAndRank dedupes case-insensitively and applies KD/volume gates', () => {
  const cands = [
    { keyword: 'blue aura meaning', volume: 12100, kd: 8, cpc: 1.2 },     // pass
    { keyword: 'Blue Aura Meaning', volume: 9999, kd: 5, cpc: 1.0 },      // dedupe
    { keyword: 'blue aura', volume: 30, kd: 5, cpc: 0.5 },                // volume < 50 → drop
    { keyword: 'aura colors', volume: 5400, kd: 60, cpc: 2.0 },           // KD > 50 → drop
    { keyword: 'green aura meaning', volume: 1800, kd: 12, cpc: 1.1 },    // pass
  ];
  const out = filterAndRank(cands, { maxKd: 50, minVolume: 50, maxResults: 10 });
  assert.equal(out.length, 2);
  // GEO descending order
  assert.equal(out[0].keyword, 'blue aura meaning'); // higher volume → higher GEO
  assert.equal(out[1].keyword, 'green aura meaning');
});

test('filterAndRank caps at maxResults', () => {
  const cands = Array.from({ length: 30 }, (_, i) => ({
    keyword: `kw_${i}`,
    volume: 1000 + i,
    kd: 10,
  }));
  const out = filterAndRank(cands, { maxResults: 5 });
  assert.equal(out.length, 5);
});

test('filterAndRank applies negatives', () => {
  const cands = [
    { keyword: 'blue aura', volume: 1000, kd: 10 },
    { keyword: 'miami dade transit', volume: 5000, kd: 5 },
  ];
  const out = filterAndRank(cands, { negatives: ['miami'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].keyword, 'blue aura');
});

test('filterAndRank attaches geo_score + aio_risk to each result', () => {
  const cands = [{ keyword: 'what is blue aura', volume: 12100, kd: 8 }];
  const out = filterAndRank(cands, {});
  assert.ok(typeof out[0].geo_score === 'number');
  assert.equal(out[0].aio_risk, '⚠️疑似高风险');
});

// ---------- parseLabsItem ----------
test('parseLabsItem: full DataForSEO Labs response shape', () => {
  const item = {
    keyword: 'blue aura',
    keyword_info: {
      search_volume: 12100,
      keyword_difficulty: 8,
      cpc: 1.23,
      competition_level: 'LOW',
    },
    search_intent_info: { main_intent: 'informational' },
    serp_info: { serp_item_types: ['organic', 'ai_overview'] },
  };
  const c = parseLabsItem(item);
  assert.equal(c.keyword, 'blue aura');
  assert.equal(c.volume, 12100);
  assert.equal(c.kd, 8);
  assert.equal(c.cpc, 1.23);
  assert.equal(c.competition, 'LOW');
  assert.equal(c.intent, 'informational');
  assert.deepEqual(c.serp_features, ['organic', 'ai_overview']);
});

test('parseLabsItem: missing keyword_info → nulls preserved (no NaN)', () => {
  const item = { keyword: 'x' };
  const c = parseLabsItem(item);
  assert.equal(c.keyword, 'x');
  assert.equal(c.volume, null);
  assert.equal(c.kd, null);
  assert.equal(c.cpc, null);
  assert.deepEqual(c.serp_features, []);
});

test('parseLabsItem: null/empty item → null (skipped by caller)', () => {
  assert.equal(parseLabsItem(null), null);
  assert.equal(parseLabsItem({}), null);
  assert.equal(parseLabsItem({ keyword: '' }), null);
});

// ---------- buildCandidateRow ----------
test('buildCandidateRow emits 11 cells matching keyword_candidates schema', () => {
  const c = {
    keyword: 'blue aura meaning',
    volume: 12100,
    kd: 8,
    cpc: 1.2,
    serp_features: ['organic', 'ai_overview'],
    geo_score: 5.8,
    aio_risk: '⚠️疑似高风险',
  };
  const row = buildCandidateRow(c, { runId: 'mine-001', entity: 'aura' });
  assert.equal(row.length, 11);
  assert.equal(row[0], 'mine-001');
  assert.equal(row[1], 'aura');
  assert.equal(row[2], 'blue aura meaning');
  assert.equal(row[3], 'seed');
  assert.equal(row[4], 12100);
  assert.equal(row[5], 8);
  assert.equal(row[7], 'organic,ai_overview');
  assert.equal(row[8], 5.8);
  assert.equal(row[9], '⚠️疑似高风险');
  assert.equal(row[10], ''); // wzb_approve blank
});

// ---------- buildMasterRowMine ----------
test('buildMasterRowMine emits exactly 5 cells (A-E) — no formula columns', () => {
  const c = { keyword: 'x', volume: 100, kd: 10, cpc: 1.0 };
  const row = buildMasterRowMine(c);
  assert.equal(row.length, 5);
  assert.equal(row[0], 'x');
  assert.equal(row[1], '种子词拓展');
  assert.equal(row[2], 100);
  assert.equal(row[3], 10);
  assert.equal(row[4], 1.0);
  // Critical: 6th cell must not exist (F = Trends 公式列 starts here)
  assert.equal(row[5], undefined);
});

test('buildMasterRowMine source is always 种子词拓展 (matches dropdown legal value)', () => {
  const row = buildMasterRowMine({ keyword: 'x' });
  assert.equal(row[1], '种子词拓展');
});

// ---------- parseSeeds ----------
test('parseSeeds splits comma/Chinese-comma/newline', () => {
  assert.deepEqual(parseSeeds('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(parseSeeds('a，b、c'), ['a', 'b', 'c']);
  assert.deepEqual(parseSeeds('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseSeeds(' a , b , c '), ['a', 'b', 'c']);
  assert.deepEqual(parseSeeds(''), []);
  assert.deepEqual(parseSeeds(null), []);
});

// ---------- parseNegatives ----------
test('parseNegatives prefers CLI flag, falls back to env', () => {
  const prevEnv = process.env.GG_NEGATIVE_KEYWORDS;
  process.env.GG_NEGATIVE_KEYWORDS = 'foo,bar';
  try {
    // CLI flag wins
    assert.deepEqual(parseNegatives('miami'), ['miami']);
    // Empty CLI → env
    assert.deepEqual(parseNegatives(''), ['foo', 'bar']);
    assert.deepEqual(parseNegatives(undefined), ['foo', 'bar']);
  } finally {
    if (prevEnv === undefined) delete process.env.GG_NEGATIVE_KEYWORDS;
    else process.env.GG_NEGATIVE_KEYWORDS = prevEnv;
  }
});

// ---------- parseArgs ----------
test('parseArgs accepts --target-master + --dry-run', () => {
  const args = parseArgs(['--seeds', 'a,b', '--dry-run', '--target-master']);
  assert.equal(args.seeds, 'a,b');
  assert.equal(args.dry_run, true);
  assert.equal(args.target_master, true);
});

test('parseArgs accepts numeric overrides', () => {
  const args = parseArgs(['--max-kd', '30', '--min-volume', '100', '--max-results', '10']);
  assert.equal(args.max_kd, '30');
  assert.equal(args.min_volume, '100');
  assert.equal(args.max_results, '10');
});
