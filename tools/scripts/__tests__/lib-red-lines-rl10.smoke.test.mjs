#!/usr/bin/env node
// Smoke test for RL10 — de-personalization / chat residue (EN + ZH).
//
// Wiki entries are not chat replies. A bare second-person "you"/"your" is LEGAL
// (FAQ voice); RL10 only flags a fixed set of conversational residue phrases
// that betray a chat turn. Hit = FAIL.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl10.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL10, RL10_CHAT_RESIDUE_PHRASES } from '../lib/red-lines.mjs';
import { checkRL10Zh } from '../lib/red-lines.zh.mjs';

// ---------- EN residue phrases → FAIL ----------
const EN_RESIDUE = [
  'As you said, blue auras lean calm.',
  'Like you said, this transit feels heavy.',
  'As you mentioned, the throat center matters here.',
  'You mentioned the discomfort earlier.',
  'Your logic about the cycle holds up.',
];

for (const phrase of EN_RESIDUE) {
  test(`RL10 EN: chat residue → FAIL :: ${phrase.slice(0, 30)}`, () => {
    const draft = `# Title\n\n## What is X?\n\n${phrase}`;
    const r = checkRL10(draft);
    assert.equal(r.pass, false, `expected FAIL for: ${phrase}`);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, 'evidence populated');
    assert.ok(typeof r.evidence[0].line === 'number', 'evidence carries line number');
  });
}

// ---------- bare second-person "you"/"your" is LEGAL → PASS ----------
const EN_LEGAL = [
  'When you notice this energy, pause and reflect.',
  'Your chart will not change, but your reading might.',
  'Ask yourself what you want from this season.',
  'You can read this as a season of consolidation.',
  'How does this show up in your daily routine?',
  // Generic second-person hypotheticals are LEGITIMATE astrology prose, not chat
  // residue (removed from the FAIL set after a real false-positive review).
  'You might feel unsettled during this passage.',
  'This makes you feel exposed.',
];

for (const phrase of EN_LEGAL) {
  test(`RL10 EN: legal second-person → PASS :: ${phrase.slice(0, 30)}`, () => {
    const draft = `# Title\n\n## What is X?\n\n${phrase}`;
    const r = checkRL10(draft);
    assert.equal(r.pass, true, `expected PASS for: ${phrase}`);
  });
}

test('RL10 EN: exported phrase list is non-empty frozen array', () => {
  assert.ok(Array.isArray(RL10_CHAT_RESIDUE_PHRASES) && RL10_CHAT_RESIDUE_PHRASES.length > 0);
});

// ---------- ZH residue phrases → FAIL ----------
const ZH_RESIDUE = [
  '如你所说，这个能量偏冷静。',
  '你说的那种不安确实常见。',
  '你的逻辑在这里是成立的。',
  '这让你感觉被看穿。',
  '正如你提到的，喉轮很关键。',
];

for (const phrase of ZH_RESIDUE) {
  test(`RL10 ZH: chat residue → FAIL :: ${phrase.slice(0, 12)}`, () => {
    const draft = `# 标题\n\n## X 是什么？\n\n${phrase}`;
    const r = checkRL10Zh(draft);
    assert.equal(r.pass, false, `expected FAIL for: ${phrase}`);
    assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, 'evidence populated');
  });
}

// ---------- bare ZH second-person 你/您 is LEGAL → PASS ----------
const ZH_LEGAL = [
  '当你注意到这种能量时，停下来反思。',
  '你的星盘不会改变，但解读会。',
  '问问你自己想从这个季节得到什么。',
];

for (const phrase of ZH_LEGAL) {
  test(`RL10 ZH: legal second-person → PASS :: ${phrase.slice(0, 10)}`, () => {
    const draft = `# 标题\n\n## X 是什么？\n\n${phrase}`;
    const r = checkRL10Zh(draft);
    assert.equal(r.pass, true, `expected PASS for: ${phrase}`);
  });
}

// ---------- frontmatter / fenced code exemption ----------
test('RL10 EN: residue only in fenced code → PASS', () => {
  const draft = '# X\n\n## What is X?\n\n```\nas you said\n```\n\nPlain prose.';
  const r = checkRL10(draft);
  assert.equal(r.pass, true);
});
