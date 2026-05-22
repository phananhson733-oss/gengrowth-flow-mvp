#!/usr/bin/env node
// Smoke test for gg-sheet-pull.mjs — pure helpers only (no network).
// Run: node --test tools/scripts/__tests__/gg-sheet-pull.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  SCHEMA_VERSION,
  DEFAULT_TAB,
  REQUIRED_BRIEF_FIELDS,
  OPTIONAL_BRIEF_FIELDS,
  slugifyPageId,
  parseSlice,
  isSectionHeader,
  parseAssociated,
  parseEntity,
  normalizeNumericStr,
  mapRowToBrief,
  identifyGaps,
  classifyRow,
  parseArgs,
} from '../gg-sheet-pull.mjs';

// ---------- constants ----------
test('SCHEMA_VERSION pinned to "1"', () => {
  assert.equal(SCHEMA_VERSION, '1');
});

test('DEFAULT_TAB targets the content brief sheet', () => {
  assert.equal(DEFAULT_TAB, '选题登记表');
});

test('REQUIRED_BRIEF_FIELDS = target_keyword + entity', () => {
  assert.deepEqual([...REQUIRED_BRIEF_FIELDS].sort(), ['entity', 'target_keyword']);
});

test('OPTIONAL_BRIEF_FIELDS includes the 6 renderer-required fields the sheet does not ship', () => {
  for (const f of ['cluster_jtbd', 'internal_link_rule', 'cta_text', 'tier_gate_block', 'rl6_hint', 'friction_themes']) {
    assert.ok(OPTIONAL_BRIEF_FIELDS.includes(f), `OPTIONAL_BRIEF_FIELDS missing ${f}`);
  }
});

// ---------- slugifyPageId ----------
test('slugifyPageId matches the convention used by per-entity render scripts', () => {
  assert.equal(slugifyPageId('blue aura meaning'), 'page_blue_aura_meaning');
  assert.equal(slugifyPageId('Saturn Return'), 'page_saturn_return');
  assert.equal(slugifyPageId('Leo Personality'), 'page_leo_personality');
  assert.equal(slugifyPageId('aura colors'), 'page_aura_colors');
});

test('slugifyPageId collapses runs of non-alphanumeric, trims edges, returns null on blank', () => {
  assert.equal(slugifyPageId('  --foo--bar  '), 'page_foo_bar');
  assert.equal(slugifyPageId('foo___bar'), 'page_foo_bar');
  assert.equal(slugifyPageId(''), null);
  assert.equal(slugifyPageId('   '), null);
  assert.equal(slugifyPageId(null), null);
});

test('slugifyPageId preserves unicode letters/digits but normalizes separators', () => {
  // CJK preserved by \p{L} class
  assert.equal(slugifyPageId('水逆 retrograde'), 'page_水逆_retrograde');
});

// ---------- parseSlice ----------
test('parseSlice() with no spec = all data rows (sheet rows 2..end)', () => {
  assert.deepEqual(parseSlice(null, 10), { start: 2, end: 11 });
  assert.deepEqual(parseSlice(undefined, 5), { start: 2, end: 6 });
});

test('parseSlice("3") = single sheet row', () => {
  assert.deepEqual(parseSlice('3', 100), { start: 3, end: 3 });
});

test('parseSlice("3-7") = inclusive range', () => {
  assert.deepEqual(parseSlice('3-7', 100), { start: 3, end: 7 });
});

test('parseSlice rejects invalid input', () => {
  assert.throws(() => parseSlice('abc', 10), /invalid slice spec/);
  assert.throws(() => parseSlice('7-3', 10), /slice end < start/);
});

// ---------- isSectionHeader ----------
test('isSectionHeader detects markdown headings in cell A', () => {
  assert.equal(isSectionHeader('## 集群 1A：Aura Colors'), true);
  assert.equal(isSectionHeader('### sub'), true);
  assert.equal(isSectionHeader('  ##leading-space'), false); // requires space after #
  assert.equal(isSectionHeader('## with space'), true);
  assert.equal(isSectionHeader('blue aura meaning'), false);
  assert.equal(isSectionHeader(''), false);
  assert.equal(isSectionHeader(null), false);
});

// ---------- parseAssociated ----------
test('parseAssociated handles (无) sentinel and comma/newline splits', () => {
  assert.deepEqual(parseAssociated('(无)'), []);
  assert.deepEqual(parseAssociated('（无）'), []);
  assert.deepEqual(parseAssociated(''), []);
  assert.deepEqual(parseAssociated(null), []);
  assert.deepEqual(parseAssociated('a, b, c'), ['a', 'b', 'c']);
  assert.deepEqual(parseAssociated('a\nb\nc'), ['a', 'b', 'c']);
  assert.deepEqual(parseAssociated('a，b、c'), ['a', 'b', 'c']);
});

// ---------- parseEntity ----------
test('parseEntity splits multi-line Entity into primary + related', () => {
  const r = parseEntity('Throat Chakra\nCommunication\nIntuition');
  assert.equal(r.primary, 'Throat Chakra');
  assert.deepEqual(r.related, ['Communication', 'Intuition']);
});

test('parseEntity handles single line', () => {
  assert.deepEqual(parseEntity('Blue Aura'), { primary: 'Blue Aura', related: [] });
});

test('parseEntity returns nulls on empty', () => {
  assert.deepEqual(parseEntity(''), { primary: null, related: [] });
  assert.deepEqual(parseEntity(null), { primary: null, related: [] });
});

// ---------- normalizeNumericStr ----------
test('normalizeNumericStr maps "未找到" / null / "" to ""', () => {
  assert.equal(normalizeNumericStr('未找到'), '');
  assert.equal(normalizeNumericStr(null), '');
  assert.equal(normalizeNumericStr(''), '');
  assert.equal(normalizeNumericStr('  '), '');
});

test('normalizeNumericStr preserves real values as strings', () => {
  assert.equal(normalizeNumericStr('9100'), '9100');
  assert.equal(normalizeNumericStr('  9100 '), '9100');
});

// ---------- mapRowToBrief ----------
const SAMPLE_HEADER = [
  'Target Keyword',
  'Associated Keywords',
  '月搜索量',
  ' KD', // intentional leading space — sheet has it
  'Intent',
  'Tier',
  'Template',
  'Entity',
  'Friction',
  'Logic',
  'CTA',
];

test('mapRowToBrief maps a complete brief row to renderer fields', () => {
  const row = [
    'blue aura meaning',
    'blue aura, blue aura personality',
    '12100',
    '0',
    'Info',
    'Tier 2 (标准)',
    'Definition',
    'Blue Aura\nThroat Chakra',
    '',
    'frame blue aura as ...',
    'https://example.com/cta',
  ];
  const { raw, brief } = mapRowToBrief(SAMPLE_HEADER, row);
  assert.equal(brief.target_keyword, 'blue aura meaning');
  assert.deepEqual(brief.associated_keywords, ['blue aura', 'blue aura personality']);
  assert.equal(brief.search_volume, '12100');
  assert.equal(brief.kd, '0');
  assert.equal(brief.intent, 'Info');
  assert.equal(brief.tier, 'Tier 2 (标准)');
  assert.equal(brief.template, 'Definition');
  assert.equal(brief.entity, 'Blue Aura');
  assert.deepEqual(brief.related_entities, ['Throat Chakra']);
  assert.equal(brief.content_angle, 'frame blue aura as ...');
  assert.equal(brief.cta_target_url, 'https://example.com/cta');
  assert.equal(raw['Target Keyword'], 'blue aura meaning');
  // " KD" header is stored with trimmed key in raw too
  assert.equal(raw['KD'], '0');
});

test('mapRowToBrief tolerates short rows (missing trailing cells)', () => {
  const row = ['aura colors', '(无)', '9100'];
  const { brief } = mapRowToBrief(SAMPLE_HEADER, row);
  assert.equal(brief.target_keyword, 'aura colors');
  assert.deepEqual(brief.associated_keywords, []);
  assert.equal(brief.search_volume, '9100');
  assert.equal(brief.intent, '');
});

// ---------- identifyGaps ----------
test('identifyGaps lists every absent OPTIONAL field', () => {
  const brief = { target_keyword: 'x', entity: 'y', search_volume: '100' };
  const todo = identifyGaps(brief);
  // search_volume is present → not in todo. Others absent → in todo.
  for (const f of OPTIONAL_BRIEF_FIELDS) {
    if (f === 'search_volume') {
      assert.ok(!todo.includes(f), 'search_volume should not be flagged');
    } else {
      assert.ok(todo.includes(f), `${f} should be flagged`);
    }
  }
});

test('identifyGaps flags empty associated_keywords array', () => {
  assert.ok(identifyGaps({ associated_keywords: [] }).includes('associated_keywords'));
  assert.ok(!identifyGaps({ associated_keywords: ['x'] }).includes('associated_keywords'));
});

// ---------- classifyRow ----------
test('classifyRow returns "empty" / "section" / "incomplete" / "ready"', () => {
  assert.equal(classifyRow('', {}), 'empty');
  assert.equal(classifyRow(null, {}), 'empty');
  assert.equal(classifyRow('## section', { target_keyword: '## section' }), 'section');
  assert.equal(classifyRow('aura colors', { target_keyword: 'aura colors' }), 'incomplete'); // entity missing
  assert.equal(classifyRow('aura colors', { target_keyword: 'aura colors', entity: 'Aura' }), 'ready');
});

// ---------- parseArgs ----------
test('parseArgs splits flags and pairs key/value', () => {
  const args = parseArgs(['--tab', '关键词主表', '--rows', '3-7', '--dry-run']);
  assert.equal(args.tab, '关键词主表');
  assert.equal(args.rows, '3-7');
  assert.equal(args.dry_run, true);
});

test('parseArgs treats consecutive flags correctly (no value capture)', () => {
  const args = parseArgs(['--dry-run', '--row', '5']);
  assert.equal(args.dry_run, true);
  assert.equal(args.row, '5');
});
