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
  NEGATIVES_RANGE,
  KD_VOL_CONFLICT_KD_MAX,
  KD_VOL_CONFLICT_VOLUME_MIN,
  MASTER_TAB,
  CANDIDATES_TAB,
  SUSPICIOUS_SINGLE_TERMS,
  isAioHighRisk,
  computeGeo,
  computeRecommendFlags,
  isNegativeMatch,
  mergeNegatives,
  filterAndRank,
  parseLabsItem,
  buildCandidateRow,
  buildMasterRowMine,
  parseArgs,
  parseSeeds,
  parseNegatives,
  validateSeed,
  tokenize,
  readNegativesFromSheet,
  _resetNegativesCacheForTests,
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

test('filterAndRank attaches geo_score + aio_risk (now ⚠️AIO) to each result', () => {
  const cands = [{ keyword: 'what is blue aura', volume: 12100, kd: 8 }];
  const out = filterAndRank(cands, {});
  assert.ok(typeof out[0].geo_score === 'number');
  assert.equal(out[0].aio_risk, '⚠️AIO');
});

// ---------- 修法 #5: 嫌疑词 flags ----------
test('computeRecommendFlags: AIO trigger preserved', () => {
  const f = computeRecommendFlags('what is blue aura', { volume: 12100, kd: 8, seed: 'blue aura', entity: 'aura' });
  assert.deepEqual(f, ['⚠️AIO']);
});

test('computeRecommendFlags: kd-vol-conflict when KD≤5 AND volume≥5000', () => {
  const f = computeRecommendFlags('blue aura', { volume: 8000, kd: 3, seed: 'blue aura', entity: 'aura' });
  assert.ok(f.includes('⚠️kd-vol-conflict'));
});

test('computeRecommendFlags: kd-vol-conflict NOT triggered when KD > 5', () => {
  const f = computeRecommendFlags('blue aura', { volume: 8000, kd: 6, seed: 'blue aura', entity: 'aura' });
  assert.ok(!f.includes('⚠️kd-vol-conflict'));
});

test('computeRecommendFlags: kd-vol-conflict NOT triggered when volume < 5000', () => {
  const f = computeRecommendFlags('blue aura', { volume: 4999, kd: 3, seed: 'blue aura', entity: 'aura' });
  assert.ok(!f.includes('⚠️kd-vol-conflict'));
});

test('computeRecommendFlags: entity-mismatch when ≥3 tokens AND zero overlap', () => {
  // query "miami dade bus" has 3 tokens; seed/entity "blue aura" has tokens [blue,aura];
  // no overlap → flag it.
  const f = computeRecommendFlags('miami dade bus tracker', { volume: 6000, kd: 20, seed: 'blue aura', entity: 'aura' });
  assert.ok(f.includes('⚠️entity-mismatch'));
});

test('computeRecommendFlags: entity-mismatch NOT triggered when one token overlaps', () => {
  const f = computeRecommendFlags('aura color reading', { volume: 6000, kd: 20, seed: 'blue aura', entity: 'aura' });
  assert.ok(!f.includes('⚠️entity-mismatch'));
});

test('computeRecommendFlags: entity-mismatch NOT triggered when <3 tokens', () => {
  const f = computeRecommendFlags('miami dade', { volume: 6000, kd: 20, seed: 'blue aura', entity: 'aura' });
  assert.ok(!f.includes('⚠️entity-mismatch'));
});

test('computeRecommendFlags: multiple flags concatenated', () => {
  // AIO + entity-mismatch + kd-vol-conflict all trigger.
  const f = computeRecommendFlags('what is miami transit explained', {
    volume: 9000, kd: 3, seed: 'blue aura', entity: 'aura',
  });
  assert.ok(f.includes('⚠️AIO'));
  assert.ok(f.includes('⚠️kd-vol-conflict'));
  assert.ok(f.includes('⚠️entity-mismatch'));
});

test('filterAndRank joins multiple flags with pipe in ai_recommend column', () => {
  const cands = [{ keyword: 'what is miami transit explained', volume: 9000, kd: 3, source_seed: 'blue aura' }];
  const out = filterAndRank(cands, { entity: 'aura', minVolume: 0, maxKd: 100 });
  const parts = out[0].aio_risk.split('|');
  assert.ok(parts.includes('⚠️AIO'));
  assert.ok(parts.includes('⚠️kd-vol-conflict'));
  assert.ok(parts.includes('⚠️entity-mismatch'));
});

// ---------- 修法 #3: validateSeed ----------
test('validateSeed: single multi-meaning seed produces warning (not blocking)', () => {
  for (const t of ['transit', 'cycle', 'house', 'mercury', 'aspect', 'sign', 'chart',
    'reading', 'element', 'node', 'phase', 'return']) {
    const v = validateSeed(t);
    assert.equal(v.ok, true, `${t} should not block`);
    assert.ok(v.warning, `${t} should emit warning`);
    assert.match(v.warning, /multi-meaning/);
  }
});

test('validateSeed: multi-token seed (no warning)', () => {
  const v = validateSeed('transit chart');
  assert.equal(v.ok, true);
  assert.equal(v.warning, undefined);
});

test('validateSeed: empty seed rejected', () => {
  const v = validateSeed('');
  assert.equal(v.ok, false);
});

test('SUSPICIOUS_SINGLE_TERMS includes the spec-required astrology bare words', () => {
  for (const t of ['transit', 'cycle', 'house', 'mercury', 'aspect', 'sign',
    'chart', 'reading', 'element', 'node', 'phase', 'return']) {
    assert.ok(SUSPICIOUS_SINGLE_TERMS.has(t), `missing ${t}`);
  }
});

// ---------- 修法 #1: NEGATIVES_RANGE constant + sheet read + merge ----------
test('NEGATIVES_RANGE constant declared at top of file', () => {
  assert.equal(NEGATIVES_RANGE, '⚙️配置!A28:A45');
});

test('mergeNegatives: case-insensitive dedupe, preserves first-seen casing', () => {
  const out = mergeNegatives(['miami', 'Dade'], ['MIAMI', 'transit'], null, ['  ', 'TRANSIT']);
  assert.deepEqual(out, ['miami', 'Dade', 'transit']);
});

test('mergeNegatives: handles empty inputs', () => {
  assert.deepEqual(mergeNegatives(), []);
  assert.deepEqual(mergeNegatives([], null, undefined), []);
});

test('readNegativesFromSheet: parses sheet values response and caches', async () => {
  _resetNegativesCacheForTests();
  // Stub global.fetch (gFetch uses fetch under the hood).
  const orig = global.fetch;
  let calls = 0;
  global.fetch = async (url) => {
    calls++;
    assert.match(String(url), /A28%3AA45|A28:A45/i);
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      text: async () => JSON.stringify({ values: [['miami'], ['dade'], [''], ['bus tracker']] }),
      json: async () => ({ values: [['miami'], ['dade'], [''], ['bus tracker']] }),
    };
  };
  try {
    const a = await readNegativesFromSheet('wb-test', 'tok');
    assert.deepEqual(a, ['miami', 'dade', 'bus tracker']);
    // Second call should be cached (no extra fetch).
    const b = await readNegativesFromSheet('wb-test', 'tok');
    assert.deepEqual(b, ['miami', 'dade', 'bus tracker']);
    assert.equal(calls, 1, 'cache should prevent second fetch');
  } finally {
    global.fetch = orig;
    _resetNegativesCacheForTests();
  }
});

test('readNegativesFromSheet: returns [] on fetch failure (warn-and-continue)', async () => {
  _resetNegativesCacheForTests();
  const orig = global.fetch;
  const origWarn = console.warn;
  let warned = false;
  console.warn = () => { warned = true; };
  global.fetch = async () => ({
    ok: false,
    status: 500,
    headers: new Map([['content-type', 'text/plain']]),
    text: async () => 'boom',
    json: async () => ({}),
  });
  try {
    const out = await readNegativesFromSheet('wb-fail', 'tok');
    assert.deepEqual(out, []);
    assert.ok(warned, 'should console.warn on failure');
  } finally {
    global.fetch = orig;
    console.warn = origWarn;
    _resetNegativesCacheForTests();
  }
});

// ---------- tokenize ----------
test('tokenize: lowercase and split on non-letter/non-digit', () => {
  assert.deepEqual(tokenize('Blue Aura, meaning!'), ['blue', 'aura', 'meaning']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

// ---------- thresholds ----------
test('thresholds for 修法 #5 match spec', () => {
  assert.equal(KD_VOL_CONFLICT_KD_MAX, 5);
  assert.equal(KD_VOL_CONFLICT_VOLUME_MIN, 5000);
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
