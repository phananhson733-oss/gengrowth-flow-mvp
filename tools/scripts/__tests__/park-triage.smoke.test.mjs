// park-triage.smoke.test.mjs — 三分诊 triagePark：transient(工具没跑成)/unfixable(时效死)/fixable(可改稿)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triagePark } from '../lib/park-classify.mjs';

test('transient：工具没跑成 → retry 类', () => {
  assert.equal(triagePark('codex exited 3'), 'transient');
  assert.equal(triagePark('preview-wait timeout'), 'transient');
  assert.equal(triagePark({ error: 'chrome verify failed: HTTP 503' }), 'transient');
});

test('unfixable：时效过期/事件已发生/前提死 → archive 类（改稿救不了）', () => {
  // WC-045 真实 error：review FAIL + stale-match，应判 unfixable（不是白烧自修）
  assert.equal(triagePark('review[codex] FAIL: stale topic — Mexico vs England match already played 2026-07-06'), 'unfixable');
  assert.equal(triagePark('codex FAIL: the event has passed'), 'unfixable');
  assert.equal(triagePark({ error: 'review[astrology] FAIL: premise is false — the match was never scheduled' }), 'unfixable');
});

test('fixable：判决类 FAIL 但可改稿 → fix 类（Jupiter 事实错 / RL4 漂移 / 缺关键词）', () => {
  assert.equal(triagePark('review[astrology] FAIL: Jupiter in Gemini is wrong; it transits Cancer then Leo'), 'fixable');
  assert.equal(triagePark('phase2 FAIL: drifted sections "Common Misreadings"'), 'fixable');
  assert.equal(triagePark({ error: 'review[schema] FAIL: assoc_keywords stray keyword' }), 'fixable');
});

test('fixable（F1 收紧防误判）：含 premise/never/expired/date-passed/relevant 但实为可改稿事实错 → 不误 archive', () => {
  // 这些是评审给的 false-positive：自然措辞撞旧宽正则，但改稿能修，绝不能 archive 掉
  assert.equal(triagePark('codex FAIL: the core premise is wrong: Mercury is not retrograde'), 'fixable');
  assert.equal(triagePark('review[astrology] FAIL: this claim never happened in the transit'), 'fixable');
  assert.equal(triagePark('review FAIL: the promo code shown has expired in the example table'), 'fixable');
  assert.equal(triagePark('review[schema] FAIL: publish date passed to frontmatter is 2026-13-01'), 'fixable');
  assert.equal(triagePark('review[content] FAIL: this section is no longer relevant, remove it'), 'fixable');
});

test('无 error → unfixable（保守交人工看，不自动改）', () => {
  assert.equal(triagePark(''), 'unfixable');
  assert.equal(triagePark({ error: '' }), 'unfixable');
});
