#!/usr/bin/env node
// Smoke test for bilingual-v9-full ZH tokenizer upgrade in red-lines.mjs.
// Covers: Intl.Segmenter baseline + ZH_DOMAIN_LEXICON greedy rejoin +
// EN regression (no behavior change when text has no CJK).
// Run: node --test tools/scripts/__tests__/red-lines-tokenizer.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  tokenizeKeepStop,
  tokenizeZh,
  rejoinZhCompounds,
  ZH_DOMAIN_LEXICON,
} from '../lib/red-lines.mjs';

test('tokenizeKeepStop EN regression: lowercase alnum runs unchanged', () => {
  assert.deepEqual(
    tokenizeKeepStop('Hello world 123 aura'),
    ['hello', 'world', '123', 'aura'],
  );
});

test('tokenizeKeepStop EN regression: handles punctuation', () => {
  assert.deepEqual(
    tokenizeKeepStop("It's a blue aura — really?"),
    ['it', 's', 'a', 'blue', 'aura', 'really'],
  );
});

test('tokenizeKeepStop ZH: domain compounds rejoined (气场, 喉轮)', () => {
  const tokens = tokenizeKeepStop('蓝色气场代表什么？气场颜色对照表');
  // 气场 should appear as ONE token, not split into 气 + 场
  assert.ok(tokens.includes('气场'), `expected '气场' in tokens, got: ${JSON.stringify(tokens)}`);
  assert.ok(tokens.includes('对照表'), `expected '对照表' (3-char compound) in tokens`);
  assert.ok(tokens.includes('蓝色'));
  // Should NOT contain bare 气 or 场 as standalone tokens
  assert.equal(tokens.filter((t) => t === '气').length, 0);
  assert.equal(tokens.filter((t) => t === '场').length, 0);
});

test('tokenizeKeepStop ZH: chakra vocab (喉轮 / 心轮 / 海底轮)', () => {
  const tokens = tokenizeKeepStop('喉轮、心轮、海底轮都是脉轮系统的一部分');
  assert.ok(tokens.includes('喉轮'));
  assert.ok(tokens.includes('心轮'));
  assert.ok(tokens.includes('海底轮'));
  assert.ok(tokens.includes('脉轮'));
});

test('tokenizeKeepStop mixed EN+ZH: interleaved correctly', () => {
  const tokens = tokenizeKeepStop('blue 气场 aura 喉轮 chakra');
  assert.deepEqual(tokens, ['blue', '气场', 'aura', '喉轮', 'chakra']);
});

test('rejoinZhCompounds: greedy max-match on segmenter output', () => {
  // Simulating what Intl.Segmenter returns when it splits 气场 → 气 + 场
  const input = ['气', '场', '颜色', '对照', '表'];
  const out = rejoinZhCompounds(input);
  assert.deepEqual(out, ['气场', '颜色', '对照表']);
});

test('rejoinZhCompounds: leaves non-lexicon tokens untouched', () => {
  const input = ['今天', '天气', '不错'];
  const out = rejoinZhCompounds(input);
  assert.deepEqual(out, ['今天', '天气', '不错']);
});

test('tokenizeZh: handles single-char fallback when segmenter splits compound', () => {
  // 自我觉察 is a 4-char compound in our lexicon
  const tokens = tokenizeZh('自我觉察小提示');
  assert.ok(tokens.includes('自我觉察'));
});

test('ZH_DOMAIN_LEXICON: ordered longest-first (greedy max-match correctness)', () => {
  // For each adjacent pair, longer terms must come before shorter ones that
  // are prefixes — otherwise greedy match would stop at the shorter prefix.
  // Verify the lexicon has no obvious prefix-order violations.
  for (let i = 0; i < ZH_DOMAIN_LEXICON.length; i++) {
    for (let j = i + 1; j < ZH_DOMAIN_LEXICON.length; j++) {
      const a = ZH_DOMAIN_LEXICON[i];
      const b = ZH_DOMAIN_LEXICON[j];
      // If b is longer than a AND starts with a → greedy bug (would never
      // match b because a wins first).
      if (b.length > a.length && b.startsWith(a)) {
        assert.fail(
          `lexicon ordering bug: "${a}" (idx ${i}) is a prefix of longer "${b}" (idx ${j}). ` +
          `Move "${b}" earlier in ZH_DOMAIN_LEXICON.`,
        );
      }
    }
  }
});

test('tokenizeKeepStop empty / non-string inputs are safe', () => {
  assert.deepEqual(tokenizeKeepStop(''), []);
  assert.deepEqual(tokenizeKeepStop(null), []);
  assert.deepEqual(tokenizeKeepStop(undefined), []);
  assert.deepEqual(tokenizeKeepStop(123), []);
});
