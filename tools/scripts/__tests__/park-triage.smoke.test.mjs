// park-triage.smoke.test.mjs — 三分诊 triagePark：transient(工具没跑成)/unfixable(时效死)/fixable(可改稿)。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { triagePark } from '../lib/park-classify.mjs';

test('transient：工具没跑成 → retry 类', () => {
  assert.equal(triagePark('codex exited 3'), 'transient');
  assert.equal(triagePark('preview-wait timeout'), 'transient');
  assert.equal(triagePark({ error: 'chrome verify failed: HTTP 503' }), 'transient');
});

test('unfixable：只认"这个选题不该发"的显式元判决 → archive（改稿救不了）', () => {
  // WC-045 真实 error：三重命中 stale topic + prediction expired + DO NOT PUBLISH
  assert.equal(triagePark('review[codex] FAIL: stale topic — Mexico vs England match already played 2026-07-06, pre-match prediction expired; DO NOT PUBLISH'), 'unfixable');
  assert.equal(triagePark('codex FAIL: this forecast has expired, do not publish'), 'unfixable');
  assert.equal(triagePark({ error: 'review[content] FAIL: topic is dead, no longer worth publishing' }), 'unfixable');
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

test('fixable（对抗评审揪出的碰撞）：描述事件时态/日期/语气错的措辞不该误判 archive → fixable', () => {
  // review Workflow 确认的 4 条：event/match/played/passed 出现在"你把时态/日期写错了"语境里，改稿能修
  assert.equal(triagePark('review[astrology] FAIL: The article claims the Mercury-Mars conjunction already occurred on June 3, but it actually occurs on July 20 - correct the date and tense.'), 'fixable');
  assert.equal(triagePark('review[codex] FAIL: you say the match is over but kickoff is next Saturday - fix.'), 'fixable');
  assert.equal(triagePark('review[content] FAIL: the transit is framed as upcoming but it is active now; it is no longer upcoming - reframe.'), 'fixable');
  assert.equal(triagePark('review[schema] FAIL: event date passed to frontmatter is malformed (2026-13-01)'), 'fixable');
  assert.equal(triagePark('review[astrology] FAIL: the match was over-hyped in the intro'), 'fixable');
  assert.equal(triagePark('review[codex] FAIL: the game was held already? no — fix the tense, event is upcoming'), 'fixable');
});

test('无 error → unfixable（保守交人工看，不自动改）', () => {
  assert.equal(triagePark(''), 'unfixable');
  assert.equal(triagePark({ error: '' }), 'unfixable');
});
