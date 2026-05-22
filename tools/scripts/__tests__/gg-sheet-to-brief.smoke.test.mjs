#!/usr/bin/env node
// Smoke test for gg-sheet-to-brief.mjs — pure helpers only (no network).
// Run: node --test tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SCHEMA_VERSION,
  PAGES_TAB,
  CLUSTERS_TAB,
  CTA_TAB,
  STANDARD_RL6_HINT,
  PSYCH_SAFETY_RL6_HINT,
  buildClusterMap,
  buildCtaMap,
  lookupCta,
  buildTierGateBlock,
  fallbackFrictionThemes,
  composeOverride,
  validateOutPath,
  parseArgs,
} from '../gg-sheet-to-brief.mjs';

// ---------- constants ----------
test('SCHEMA_VERSION pinned to "1"', () => {
  assert.equal(SCHEMA_VERSION, '1');
});

test('Tab names match the 03-marketing/03-seo/keyword-sheet-setup.gs schema', () => {
  assert.equal(PAGES_TAB, '选题登记表');
  assert.equal(CLUSTERS_TAB, '主题集群表');
  assert.equal(CTA_TAB, 'CTA Map');
});

test('RL6 hints distinguish psych-safety=Y from baseline', () => {
  assert.ok(STANDARD_RL6_HINT.includes('clinical'));
  // PSYCH_SAFETY_RL6_HINT must reference both the disclaimer requirement and the blacklist enforcement.
  assert.ok(/免责声明|disclaimer|not a clinical/i.test(PSYCH_SAFETY_RL6_HINT));
  assert.ok(/黑名单|blacklist|healing.*disorder|disorder.*syndrome/i.test(PSYCH_SAFETY_RL6_HINT));
  assert.notEqual(STANDARD_RL6_HINT, PSYCH_SAFETY_RL6_HINT);
});

// ---------- buildClusterMap ----------
const CLUSTER_HEADER = [
  'cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role',
  'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page',
  'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule',
  'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric',
  'child_entities',
];

test('buildClusterMap indexes by cluster_id and parses child_entities', () => {
  const rows = [
    CLUSTER_HEADER,
    [
      'clu_aura_colors', 'Aura Colors 核心', '量产线', 'Core Astrology', '流量',
      'Aura', 'understand my aura color meaning', '12 color framework angle', '高', '/wiki/aura-colors',
      'aura colors × 12', 'blue, red, yellow', 'page_blue_aura_meaning,page_red_aura_meaning', 'Pillar↔Series',
      '工具页', 'N', 'P0', 'Week 1', 'Day 30: 5 keys in Top50',
      'blue aura, red aura, yellow aura',
    ],
  ];
  const map = buildClusterMap(rows);
  assert.equal(map.size, 1);
  const c = map.get('clu_aura_colors');
  assert.equal(c.cluster_name, 'Aura Colors 核心');
  assert.equal(c.track, '量产线');
  assert.equal(c.jtbd, 'understand my aura color meaning');
  assert.equal(c.internal_link_rule, 'Pillar↔Series');
  assert.deepEqual(c.child_entities, ['blue aura', 'red aura', 'yellow aura']);
});

test('buildClusterMap skips rows with blank cluster_id', () => {
  const rows = [
    CLUSTER_HEADER,
    [''], // empty cluster_id
    ['clu_x', 'X', '量产线'],
  ];
  const map = buildClusterMap(rows);
  assert.equal(map.size, 1);
  assert.ok(map.has('clu_x'));
});

test('buildClusterMap returns empty Map on empty input', () => {
  assert.equal(buildClusterMap([]).size, 0);
});

// ---------- buildCtaMap + lookupCta ----------
const CTA_HEADER = ['cta_id', 'page_role', 'cta_文案', 'target_url', 'ga4_event_name', 'track'];

test('buildCtaMap returns {map, dupes} and keys by "page_role||track"', () => {
  const rows = [
    CTA_HEADER,
    ['cta_tool_pillar', 'Pillar', '探索你的星盘', 'https://x/tool', 'tool_click', '量产线'],
    ['cta_news_b', 'Series', '订阅 newsletter', 'https://x/news', 'newsletter_signup', '精修线'],
  ];
  const { map, dupes } = buildCtaMap(rows);
  assert.equal(map.size, 2);
  assert.equal(dupes.length, 0);
  assert.ok(map.has('Pillar||量产线'));
  assert.ok(map.has('Series||精修线'));
});

test('buildCtaMap: first row wins on duplicate (page_role, track), records dupe', () => {
  const rows = [
    CTA_HEADER,
    ['c1', 'Pillar', 'p1', 'https://x/1', 'e1', '量产线'],
    ['c2', 'Pillar', 'p2', 'https://x/2', 'e2', '量产线'], // duplicate
  ];
  const { map, dupes } = buildCtaMap(rows);
  assert.equal(map.size, 1);
  assert.equal(map.get('Pillar||量产线').cta_id, 'c1', 'first row must win');
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].key, 'Pillar||量产线');
});

test('lookupCta exact match wins (accepts both bare Map and {map,dupes})', () => {
  const rows = [
    CTA_HEADER,
    ['c1', 'Pillar', 'p1', 'https://x/1', 'e1', '量产线'],
    ['c2', 'Pillar', 'p2', 'https://x/2', 'e2', '精修线'],
  ];
  const built = buildCtaMap(rows);
  assert.equal(lookupCta(built, 'Pillar', '量产线').cta_id, 'c1');
  assert.equal(lookupCta(built.map, 'Pillar', '精修线').cta_id, 'c2');
});

test('lookupCta fallback: no track → 量产线 default', () => {
  const { map } = buildCtaMap([
    CTA_HEADER,
    ['c1', 'Series', 's1', 'https://x/u1', 'e1', '量产线'],
  ]);
  assert.equal(lookupCta(map, 'Series', '').cta_id, 'c1');
  assert.equal(lookupCta(map, 'Series', undefined).cta_id, 'c1');
});

test('lookupCta returns null when page_role not in map', () => {
  const { map } = buildCtaMap([CTA_HEADER, ['c1', 'Pillar', 'p1', 'https://x/1', 'e1', '量产线']]);
  assert.equal(lookupCta(map, 'Wiki', '量产线'), null);
  assert.equal(lookupCta(map, '', '量产线'), null);
});

test('lookupCta skips CTAs with placeholder target_url (newsletter 待搭建)', () => {
  const { map } = buildCtaMap([
    CTA_HEADER,
    ['c1', 'Series', '订阅', '（newsletter URL，待搭建）', 'newsletter_signup', '精修线'],
    ['c2', 'Series', '查工具', 'https://astrologywiki.com/tools/x', 'tool_click', '量产线'],
  ]);
  // Precision: 精修线 newsletter is placeholder → fall back to 量产线 tool.
  assert.equal(lookupCta(map, 'Series', '精修线').cta_id, 'c2', 'should skip placeholder URL and fall back');
});

test('lookupCta last-resort fallback is deterministic (sorted)', () => {
  // No exact match, no 量产线 default — should iterate matching keys in sorted order.
  const { map } = buildCtaMap([
    CTA_HEADER,
    ['cZ', 'Pillar', 'pZ', 'https://x/z', 'eZ', 'zzz'],
    ['cA', 'Pillar', 'pA', 'https://x/a', 'eA', 'aaa'],
  ]);
  assert.equal(lookupCta(map, 'Pillar', 'unknown').cta_id, 'cA', 'sorted "aaa" comes before "zzz"');
});

// ---------- buildTierGateBlock ----------
test('buildTierGateBlock T1 Pillar gets 9 sections + 2500-3500 words', () => {
  const block = buildTierGateBlock({
    tier: 'T1',
    template: 'Pillar',
    entity: 'Chakra System',
    friction_brief: 'people confuse 7 vs 12 chakra systems',
    logic_brief: 'frame as interpretive framework, not anatomy',
    target_keyword: 'chakra system',
  });
  assert.match(block, /T1 Pillar/);
  assert.match(block, /2500-3500/);
  assert.match(block, /9 sections/);
  assert.match(block, /Hub|重装/);
  assert.match(block, /people confuse 7 vs 12 chakra systems/);
  assert.match(block, /frame as interpretive framework/);
});

test('buildTierGateBlock T2 Definition gets 7 sections + 1500-1800 words', () => {
  const block = buildTierGateBlock({
    tier: 'T2',
    template: 'Definition',
    entity: 'Orange Aura',
    friction_brief: 'shade confusion',
    logic_brief: 'frame as interpretive framework',
    target_keyword: 'orange aura meaning',
  });
  assert.match(block, /T2 Definition/);
  assert.match(block, /1500-1800/);
  assert.match(block, /7 sections/);
  assert.match(block, /标准版/);
});

test('buildTierGateBlock falls back to TODO when friction/logic empty', () => {
  const block = buildTierGateBlock({
    tier: 'T2',
    template: 'Definition',
    entity: 'X',
    target_keyword: 'x meaning',
  });
  assert.match(block, /TODO/);
});

test('buildTierGateBlock defaults to T2 Definition when no tier/template', () => {
  const block = buildTierGateBlock({ entity: 'X', target_keyword: 'x' });
  assert.match(block, /T2 Definition/);
});

// ---------- fallbackFrictionThemes ----------
test('fallbackFrictionThemes returns exactly 3 entries', () => {
  const themes = fallbackFrictionThemes('shade confusion is the main issue', 'orange aura');
  assert.equal(themes.length, 3);
  for (const t of themes) {
    assert.ok(t.theme);
    assert.ok(t.scrubbed_quote);
    assert.equal(t.domain, 'old.reddit.com');
  }
});

test('fallbackFrictionThemes derives theme name from first friction phrase', () => {
  const themes = fallbackFrictionThemes('shade_confusion: hard to tell tints', 'x');
  assert.match(themes[0].theme, /shade/);
});

test('fallbackFrictionThemes handles empty friction_brief', () => {
  const themes = fallbackFrictionThemes('', 'x meaning');
  assert.equal(themes.length, 3);
  assert.match(themes[0].scrubbed_quote, /TODO/);
});

// ---------- composeOverride ----------
function makeRow(overrides = {}) {
  return {
    source_row: 5,
    page_id: 'page_orange_aura_meaning',
    brief: {
      target_keyword: 'orange aura meaning',
      associated_keywords: ['orange aura'],
      search_volume: '5400',
      tier: 'T2',
      template: 'Definition',
      entity: 'Orange Aura',
      friction_brief: 'shade confusion',
      logic_brief: 'interpretive framework not anatomy',
      content_angle: 'creative/playful angle',
      cluster_id: 'clu_aura_colors',
      page_role: 'Series',
      psych_safety_flag: 'N',
      ...overrides,
    },
  };
}

function makeCtx(overrides = {}) {
  const clusterMap = new Map([
    [
      'clu_aura_colors',
      {
        cluster_id: 'clu_aura_colors',
        cluster_name: 'Aura Colors',
        track: '量产线',
        jtbd: 'understand my aura color',
        content_angle: 'cluster-level angle (fallback)',
        internal_link_rule: 'Pillar↔Series',
        child_entities: [],
      },
    ],
  ]);
  const ctaMap = new Map([
    [
      'Series||量产线',
      {
        cta_id: 'cta_tool_series',
        page_role: 'Series',
        cta_text: '查你的对应落座',
        target_url: 'https://astrologywiki.com/tools/aura-quiz',
        ga4_event_name: 'tool_click',
        track: '量产线',
      },
    ],
  ]);
  return { clusterMap, ctaMap, repo: '/tmp/__nonexistent_repo_for_test', ...overrides };
}

test('composeOverride produces all 13 cfg fields for a full Sheet row', () => {
  const row = makeRow();
  const ctx = makeCtx();
  const { entry, warnings } = composeOverride(row, ctx);
  assert.equal(entry.page_id, 'page_orange_aura_meaning');
  assert.equal(entry.entity, 'Orange Aura');
  assert.equal(entry.target_keyword, 'orange aura meaning');
  assert.deepEqual(entry.associated_keywords, ['orange aura']);
  assert.equal(entry.search_volume, '5400');
  assert.equal(entry.cluster_jtbd, 'understand my aura color');
  assert.equal(entry.content_angle, 'creative/playful angle');
  assert.equal(entry.internal_link_rule, 'Pillar↔Series');
  assert.equal(entry.cta_text, '查你的对应落座');
  assert.equal(entry.cta_target_url, 'https://astrologywiki.com/tools/aura-quiz');
  assert.match(entry.tier_gate_block, /T2 Definition/);
  assert.equal(entry.rl6_hint, STANDARD_RL6_HINT);
  assert.equal(entry.friction_themes.length, 3);
  assert.equal(entry.tier, 'T2');
  assert.equal(entry.template, 'Definition');
  assert.equal(entry.psych_safety_flag, 'N');
  assert.equal(warnings.length, 0);
});

test('composeOverride: psych_safety=Y switches rl6_hint to PSYCH_SAFETY_RL6_HINT', () => {
  const row = makeRow({ psych_safety_flag: 'Y' });
  const { entry } = composeOverride(row, makeCtx());
  assert.equal(entry.rl6_hint, PSYCH_SAFETY_RL6_HINT);
  assert.equal(entry.psych_safety_flag, 'Y');
});

test('composeOverride: cluster psych_safety=Y triggers Y even if page flag is N', () => {
  // codex review: cluster-level psych flag was being silently dropped. Should be OR.
  const clusterMap = new Map([[
    'clu_healing',
    {
      cluster_id: 'clu_healing',
      track: '精修线',
      jtbd: 'process my chiron pain',
      content_angle: '',
      internal_link_rule: '',
      psych_safety_flag: 'Y',  // cluster says Y
      child_entities: [],
    },
  ]]);
  const ctaMap = new Map([['Series||精修线', { cta_text: 'cta-news', target_url: 'https://x/y', ga4_event_name: 'newsletter_signup', track: '精修线' }]]);
  const row = {
    source_row: 5, page_id: 'page_chiron_pain', brief: {
      target_keyword: 'chiron pain', tier: 'T2', template: 'Definition',
      entity: 'Chiron', cluster_id: 'clu_healing',
      page_role: 'Series', psych_safety_flag: 'N',  // page says N — cluster should still win Y
    },
  };
  const { entry } = composeOverride(row, { clusterMap, ctaMap, repo: '/tmp/x' });
  assert.equal(entry.psych_safety_flag, 'Y', 'cluster=Y must override page=N');
  assert.equal(entry.rl6_hint, PSYCH_SAFETY_RL6_HINT);
});

test('composeOverride: both N → final N', () => {
  const row = makeRow({ psych_safety_flag: 'N' });
  const { entry } = composeOverride(row, makeCtx());
  assert.equal(entry.psych_safety_flag, 'N');
});

test('composeOverride: missing cluster emits warning, blanks cluster fields', () => {
  const row = makeRow({ cluster_id: 'clu_does_not_exist' });
  const { entry, warnings } = composeOverride(row, makeCtx());
  assert.equal(entry.cluster_jtbd, '');
  assert.equal(entry.internal_link_rule, '');
  assert.ok(warnings.some((w) => w.includes('clu_does_not_exist')));
});

test('composeOverride: missing CTA emits warning, blanks cta fields', () => {
  const row = makeRow({ page_role: 'Wiki' }); // not in our test CTA map
  const { entry, warnings } = composeOverride(row, makeCtx());
  assert.equal(entry.cta_text, '');
  assert.ok(warnings.some((w) => w.includes('Wiki')));
});

test('composeOverride: page.content_angle wins over cluster.content_angle', () => {
  const row = makeRow({ content_angle: 'page-specific angle' });
  const { entry } = composeOverride(row, makeCtx());
  assert.equal(entry.content_angle, 'page-specific angle');
});

test('composeOverride: page.content_angle empty → falls back to cluster.content_angle', () => {
  const row = makeRow({ content_angle: '' });
  const { entry } = composeOverride(row, makeCtx());
  assert.equal(entry.content_angle, 'cluster-level angle (fallback)');
});

test('composeOverride: --skip-non-v8 skips Tutorial/Comparison/Programmatic/Case Study', () => {
  for (const tpl of ['Tutorial', 'Comparison', 'Programmatic', 'Case Study']) {
    const row = makeRow({ template: tpl });
    const result = composeOverride(row, { ...makeCtx(), skipNonV8: true });
    assert.equal(result.skip, true, `${tpl} should be skipped`);
    assert.match(result.reason, new RegExp(tpl, 'i'));
  }
});

test('composeOverride: non-v8 template without skip flag still emits warning and falls back to Definition', () => {
  const row = makeRow({ template: 'Tutorial' });
  const result = composeOverride(row, makeCtx());
  assert.ok(result.entry, 'should still produce entry without skip flag');
  assert.equal(result.entry.template, 'Tutorial');
  assert.ok(result.warnings.some((w) => /Tutorial/i.test(w)));
});

test('composeOverride: no page_id → skip', () => {
  const row = { source_row: 9, page_id: null, brief: { target_keyword: '' } };
  const result = composeOverride(row, makeCtx());
  assert.equal(result.skip, true);
  assert.match(result.reason, /no page_id/);
});

test('composeOverride: Pillar template pulls child_entities from cluster', () => {
  const clusterMap = new Map([
    [
      'clu_chakras',
      {
        cluster_id: 'clu_chakras',
        track: '量产线',
        jtbd: 'understand chakras',
        content_angle: '',
        internal_link_rule: 'Pillar↔Series',
        child_entities: ['root chakra', 'sacral chakra', 'heart chakra'],
      },
    ],
  ]);
  const row = {
    source_row: 5,
    page_id: 'page_chakra_system_overview',
    brief: {
      target_keyword: 'chakra system',
      tier: 'T1',
      template: 'Pillar',
      entity: 'Chakra System',
      cluster_id: 'clu_chakras',
      page_role: 'Pillar',
      psych_safety_flag: 'N',
    },
  };
  const ctaMap = new Map([['Pillar||量产线', { cta_text: 'cta-p', target_url: 'u' }]]);
  const { entry } = composeOverride(row, { clusterMap, ctaMap, repo: '/tmp/x' });
  assert.equal(entry.template, 'Pillar');
  assert.deepEqual(entry.child_entities, ['root chakra', 'sacral chakra', 'heart chakra']);
  assert.equal(entry.child_count, 3);
});

// ---------- validateOutPath (jail) ----------
const FAKE_REPO = '/tmp/fakerepo';

test('validateOutPath: no --out → ok (uses default)', () => {
  const r = validateOutPath(null, FAKE_REPO);
  assert.equal(r.ok, true);
  assert.equal(r.resolved, null);
});

test('validateOutPath: path inside .gg-cache/overrides/ → ok', () => {
  const r = validateOutPath('/tmp/fakerepo/.gg-cache/overrides/x.json', FAKE_REPO);
  assert.equal(r.ok, true);
  assert.equal(r.resolved, '/tmp/fakerepo/.gg-cache/overrides/x.json');
});

test('validateOutPath: relative path joined to repo root', () => {
  const r = validateOutPath('.gg-cache/overrides/foo.json', FAKE_REPO);
  assert.equal(r.ok, true);
  assert.equal(r.resolved, '/tmp/fakerepo/.gg-cache/overrides/foo.json');
});

test('validateOutPath: path inside _staging/ → ok (test fixtures)', () => {
  const r = validateOutPath('/tmp/fakerepo/_staging/test.json', FAKE_REPO);
  assert.equal(r.ok, true);
});

test('validateOutPath: missing .json suffix → fail', () => {
  const r = validateOutPath('/tmp/fakerepo/.gg-cache/overrides/x.txt', FAKE_REPO);
  assert.equal(r.ok, false);
  assert.match(r.reason, /must end in \.json/);
});

test('validateOutPath: path outside jail roots → fail', () => {
  const r = validateOutPath('/etc/evil.json', FAKE_REPO);
  assert.equal(r.ok, false);
  assert.match(r.reason, /inside/);
});

test('validateOutPath: traversal via .. is blocked (codex review v2 found this bypass)', () => {
  // Critical: the path string starts with the allowed prefix, but resolves outside it.
  // Pre-fix this would have slipped through startsWith() into /tmp/fakerepo/docs/escape.json.
  const r = validateOutPath('/tmp/fakerepo/.gg-cache/overrides/../../docs/escape.json', FAKE_REPO);
  assert.equal(r.ok, false, 'must block .. traversal even when prefix matches');
  assert.match(r.reason, /inside/);
});

test('validateOutPath: traversal via relative .. is also blocked', () => {
  const r = validateOutPath('.gg-cache/overrides/../../docs/escape.json', FAKE_REPO);
  assert.equal(r.ok, false);
});

test('validateOutPath: confusable name "/tmp/fakerepo-evil/x.json" is blocked (must NOT start with fakerepo/.gg-cache)', () => {
  const r = validateOutPath('/tmp/fakerepo-evil/.gg-cache/overrides/x.json', FAKE_REPO);
  assert.equal(r.ok, false, 'fakerepo-evil prefix shares "fakerepo" but is not the jail');
});

// ---------- parseArgs ----------
test('parseArgs handles --skip-non-v8 boolean flag', () => {
  const args = parseArgs(['--rows', '3-7', '--skip-non-v8']);
  assert.equal(args.rows, '3-7');
  assert.equal(args.skip_non_v8, true);
});
