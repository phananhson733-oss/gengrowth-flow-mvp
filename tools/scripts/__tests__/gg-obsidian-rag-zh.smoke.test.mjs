#!/usr/bin/env node
// Smoke test for bilingual-v9-full ZH augmentation in gg-obsidian-rag.mjs.
// Covers: word-aware tokenize() + combineEntityTokens dedup + rankNotes
// dual-language scoring.
// Run: node --test tools/scripts/__tests__/gg-obsidian-rag-zh.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  tokenize,
  combineEntityTokens,
  rankNotes,
  scoreNote,
} from '../gg-obsidian-rag.mjs';

test('tokenize EN regression: unchanged behavior on EN input', () => {
  // Pre-bilingual-v9: words ≥ 2 chars, stop words filtered
  const out = tokenize('Aura color Blue is the energy field');
  assert.ok(out.includes('aura'));
  assert.ok(out.includes('color'));
  assert.ok(out.includes('blue'));
  assert.ok(!out.includes('is'));  // stop word
});

test('tokenize ZH: routes through word-aware tokenizer for CJK', () => {
  const out = tokenize('蓝色气场是西方灵性圈对人体周围能量场');
  // Domain compounds should be preserved as units (not split char-by-char)
  assert.ok(out.includes('蓝色'), `expected 蓝色 in ${JSON.stringify(out)}`);
  assert.ok(out.includes('气场'), `expected 气场 in ${JSON.stringify(out)}`);
  // 能量场 is a 3-char lexicon compound; lexicon rejoin merges it before 能量
  // because LONGEST-FIRST greedy match prefers 能量场 over 能量.
  assert.ok(out.includes('能量场'), `expected 能量场 in ${JSON.stringify(out)}`);
  // Should NOT have bare single chars from these compounds
  assert.equal(out.filter((t) => t === '气').length, 0);
});

test('combineEntityTokens: dedups across EN+ZH', () => {
  const out = combineEntityTokens('Blue Aura', '蓝色气场');
  // EN tokens come first
  assert.ok(out.indexOf('blue') >= 0);
  assert.ok(out.indexOf('aura') >= 0);
  // ZH tokens appended
  assert.ok(out.indexOf('蓝色') >= 0);
  assert.ok(out.indexOf('气场') >= 0);
  // No duplicates
  assert.equal(out.length, new Set(out).size);
});

test('combineEntityTokens: handles missing ZH gracefully (EN-only mode)', () => {
  const out = combineEntityTokens('Blue Aura', null);
  assert.deepEqual(out, ['blue', 'aura']);
});

test('combineEntityTokens: handles missing EN (ZH-only edge case)', () => {
  const out = combineEntityTokens(null, '蓝色气场');
  assert.ok(out.includes('蓝色'));
  assert.ok(out.includes('气场'));
});

test('scoreNote: T1 (title hit) — word-aware tokens enable ZH title matches', () => {
  const note = {
    titleTokens: ['蓝色', '气场', '解读'],
    aliasTokens: [],
    aliasTexts: [],
    headingTokens: [],
  };
  // Search for ZH compound; matches when all entity tokens are in title
  const res = scoreNote(note, ['蓝色', '气场'], '');
  assert.equal(res.tier, 'T1');
  assert.equal(res.score, 1.0);
});

test('rankNotes: dual-language scoring takes max across EN/ZH', () => {
  const noteShape = {
    aliasTokens: [], aliasTexts: [], headingTokens: [], wikilinks: [],
  };
  const index = {
    noteByPath: {
      '/x/en-only.md': { ...noteShape, title: 'Blue Aura Meaning', titleTokens: ['blue', 'aura', 'meaning'] },
      '/x/zh-only.md': { ...noteShape, title: '蓝色气场含义', titleTokens: ['蓝色', '气场', '含义'] },
    },
  };
  // EN-only entity → only en-only.md matched
  const enOnly = rankNotes(index, 'Blue Aura', {});
  assert.equal(enOnly.length, 1);
  assert.ok(enOnly[0].path.endsWith('en-only.md'));

  // Dual-language → both matched
  const dual = rankNotes(index, 'Blue Aura', { entityTokensZh: ['蓝色', '气场'] });
  assert.equal(dual.length, 2);
});

test('rankNotes: empty entity tokens AND empty ZH tokens → no matches', () => {
  const index = { noteByPath: { '/x/a.md': { title: 'A', titleTokens: ['a'], aliasTokens: [], aliasTexts: [], headingTokens: [], wikilinks: [] } } };
  assert.deepEqual(rankNotes(index, '', { entityTokensZh: [] }), []);
});
