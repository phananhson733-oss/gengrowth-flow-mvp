#!/usr/bin/env node
// Smoke test for lib/structure-checks.mjs.
//
// SC1 — bolded direct-answer definition in the first H2 section (FAIL; both
//        templates hard-require it).
// SC2 — internal-link tier counting (WARN only; never blocks).
//
// Run: node --test tools/scripts/__tests__/lib-structure-checks.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkBoldedDefinition,
  checkInternalLinkTier,
  checkParagraphLength,
  checkLinkDistribution,
  checkParagraphFragmentation,
} from '../lib/structure-checks.mjs';

// ============================================================
// SC1 — bolded definition
// ============================================================

test('SC1: first H2 section with bolded definition → PASS', () => {
  const draft = `# Blue Aura Meaning

## What is Blue Aura?

Blue aura usually reads as **a calm, communicative energy field tied to the throat center**. It points to clarity of voice.

## Why It Matters for Self-Awareness

People feel misread as cold.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true, r.note);
  assert.equal(r.severity, 'fail');
});

test('SC1: first H2 section with NO bold → FAIL', () => {
  const draft = `# Blue Aura Meaning

## What is Blue Aura?

Blue aura usually reads as a calm, communicative energy field tied to the throat center.

## Why It Matters for Self-Awareness

People feel misread as cold.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.length >= 1, 'violation populated');
  assert.ok(typeof r.violations[0].line === 'number', 'violation carries a line number');
});

test('SC1: empty bold span **** is not a real bold → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nThis has an empty **** span only.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
});

test('SC1: bold appearing only in a LATER section still FAILS (must be first section)', () => {
  const draft = `# X

## What is X?

Plain prose with no bold here.

## Why It Matters for Self-Awareness

Here is **a bolded phrase** but in the wrong section.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, false);
});

test('SC1: no H2 at all → PASS (H2-count check is authoritative, no double-fail)', () => {
  const draft = `# X\n\nJust an intro with no sections.`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true);
});

// Realistic ZH-shaped section (entity translated) still passes when bold present.
test('SC1: ZH-shaped first section with bold → PASS', () => {
  const draft = `# 蓝色气场代表什么：含义与解读

## 蓝色气场是什么？

蓝色气场通常被理解为 **一种与喉轮相关、偏向冷静与沟通的能量状态**。它指向表达的清晰度。

## 为什么了解它能帮助自我觉察

人们常被误读为冷漠。`;
  const r = checkBoldedDefinition(draft);
  assert.equal(r.pass, true, r.note);
});

// ============================================================
// SC2 — internal-link tier counting (WARN)
// ============================================================

function draftWithLinks(n) {
  const links = Array.from({ length: n }, (_, i) =>
    `[[<TBD-internal-link: explainer number ${i + 1}>]]`).join('\n');
  return `# X\n\n## What is X?\n\n**Bold def.**\n\n## Related Reading\n\n${links}`;
}

test('SC2: severity is fail', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T2' });
  assert.equal(r.severity, 'fail');
});

test('SC2: T1 with 4 links → FAIL (below floor 5)', () => {
  const r = checkInternalLinkTier(draftWithLinks(4), { tier: 'T1' });
  assert.equal(r.pass, false);
  assert.equal(r.severity, 'fail');
  assert.ok(r.violations[0].hint.includes('≥ 5'));
});

test('SC2: T1 with 5 links → PASS', () => {
  const r = checkInternalLinkTier(draftWithLinks(5), { tier: 'T1' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T2 with ≥3 links → PASS', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T2' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T2 with 2 links → FAIL (below floor)', () => {
  const r = checkInternalLinkTier(draftWithLinks(2), { tier: 'T2' });
  assert.equal(r.pass, false);
  assert.equal(r.severity, 'fail');
  assert.ok(r.violations[0].hint.includes('≥ 3'));
});

test('SC2: T3 with 1 link → PASS (within 1-2 band)', () => {
  const r = checkInternalLinkTier(draftWithLinks(1), { tier: 'T3' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T3 with 2 links → PASS', () => {
  const r = checkInternalLinkTier(draftWithLinks(2), { tier: 'T3' });
  assert.equal(r.pass, true, r.note);
});

test('SC2: T3 with 3 links → WARN (over ceiling)', () => {
  const r = checkInternalLinkTier(draftWithLinks(3), { tier: 'T3' });
  assert.equal(r.pass, false);
  assert.ok(r.violations[0].hint.includes('≤ 2'));
});

test('SC2: unknown tier → PASS with no opinion', () => {
  const r = checkInternalLinkTier(draftWithLinks(0), { tier: 'T9' });
  assert.equal(r.pass, true);
  assert.ok(/no tier floor/.test(r.note));
});

test('SC2: only counts TBD-format links, ignores invented anchors', () => {
  const draft = `# X\n\n## What is X?\n\n**Bold.**\n\n## Related Reading\n\n[[Invented Anchor]]\n[[Another One]]`;
  const r = checkInternalLinkTier(draft, { tier: 'T2' });
  // 0 TBD links → below T2 floor → WARN (the 2 invented anchors are not counted).
  assert.equal(r.pass, false);
  assert.ok(/0 TBD internal-link/.test(r.note));
});

// ============================================================
// SC3 — prose paragraph rhythm (FAIL): 4-5 sentences/paragraph, ~20% tolerance
// (sentence boundary = . ! ? 。！？; FAIL above 7 句 or the word/char backstop)
// ============================================================

const enWords = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
const enSentences = (n) => Array.from({ length: n }, (_, i) => `This is sentence number ${i}.`).join(' ');
const zhSentences = (n) => Array.from({ length: n }, (_, i) => `这是第${i}个句子。`).join('');

test('SC3: severity is fail', () => {
  const r = checkParagraphLength('# X\n\n## What is X?\n\nShort prose.');
  assert.equal(r.severity, 'fail');
});

test('SC3: a 4-5 sentence paragraph → PASS (the target rhythm)', () => {
  const draft = `# X\n\n## What is X?\n\n${enSentences(5)}`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC3: short EN paragraphs → PASS', () => {
  const draft = `# X

## What is X?

X is a calm energy. This is a short chunk.

How it works is simple. Two short sentences only.`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC3: an 8-sentence EN paragraph → FAIL (over the 7 句 wall ceiling)', () => {
  const draft = `# X\n\n## What is X?\n\n${enSentences(8)}`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, false);
  assert.equal(typeof r.violations[0].line, 'number');
  assert.ok(/句 >/.test(r.violations[0].hint), r.violations[0].hint);
});

test('SC3: a run-on EN paragraph past the word backstop → FAIL (words)', () => {
  // 200 words but only 1 sentence — sentence count passes, word backstop catches it.
  const draft = `# X\n\n## What is X?\n\n${enWords(200)}.`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, false);
  assert.ok(/words >/.test(r.violations[0].hint), r.violations[0].hint);
});

test('SC3: an 8-sentence CJK paragraph → FAIL (over 7 句)', () => {
  const draft = `# 蓝色气场\n\n## 蓝色气场是什么？\n\n${zhSentences(8)}`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, false);
  assert.ok(/句 >/.test(r.violations[0].hint), r.violations[0].hint);
});

test('SC3: a long run-on CJK paragraph past the char backstop → FAIL (字)', () => {
  const draft = `# 蓝色气场\n\n## 蓝色气场是什么？\n\n${'蓝'.repeat(440)}。`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, false);
  assert.ok(/字 >/.test(r.violations[0].hint), r.violations[0].hint);
});

test('SC3: short CJK paragraph → PASS', () => {
  const draft = `# 蓝色气场\n\n## 蓝色气场是什么？\n\n蓝色气场是一种以表达和沟通为主调的能量场。`;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC3: tables / lists / blockquotes / fenced code are NOT counted as prose', () => {
  const longCells = enSentences(8);
  const draft = `# X

## Quick Reference Table

| ${longCells} | b | c | d |
| 1 | 2 | 3 | 4 |

## Reflection Prompts

1. ${enSentences(8)}

> ${enSentences(8)}

\`\`\`
${enSentences(8)}
\`\`\``;
  const r = checkParagraphLength(draft);
  assert.equal(r.pass, true, r.note);
});

// ============================================================
// SC3b — over-fragmentation (WARN): median sentences/paragraph <= 2
// ============================================================

test('SC3b: a page of single-sentence paragraphs → WARN (over-fragmented)', () => {
  const frags = Array.from({ length: 12 }, (_, i) => `This is fragment number ${i}.`).join('\n\n');
  const draft = `# X\n\n## What is X?\n\n${frags}`;
  const r = checkParagraphFragmentation(draft);
  assert.equal(r.severity, 'warn');
  assert.equal(r.pass, false);
  assert.ok(/median/.test(r.note), r.note);
});

test('SC3b: paragraphs of 4-5 sentences → PASS', () => {
  const paras = Array.from({ length: 12 }, () => enSentences(5)).join('\n\n');
  const draft = `# X\n\n## What is X?\n\n${paras}`;
  const r = checkParagraphFragmentation(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC3b: too few paragraphs to judge → PASS (no opinion)', () => {
  const draft = `# X\n\n## What is X?\n\nOne sentence.\n\nAnother sentence.`;
  const r = checkParagraphFragmentation(draft);
  assert.equal(r.pass, true);
  assert.ok(/too few/.test(r.note), r.note);
});

// ============================================================
// SC4 — internal-link distribution (FAIL)
// ============================================================

test('SC4: severity is fail', () => {
  const r = checkLinkDistribution('# X\n\nno links');
  assert.equal(r.severity, 'fail');
});

test('SC4: all links dumped in Related Reading, none inline → FAIL', () => {
  const draft = `# X

## What is X?

**X is calm.** Plain prose, no inline links here.

## Related Reading

[[<TBD-internal-link: pillar page on aura colors>]]
[[<TBD-internal-link: throat chakra explainer>]]`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, false);
  assert.ok(/0\/2/.test(r.note));
});

test('SC4: at least one link inline in body → PASS', () => {
  const draft = `# X

## What is X?

**X is calm.** See the [[<TBD-internal-link: pillar page on aura colors>]] for the full map.

## Related Reading

[[<TBD-internal-link: throat chakra explainer>]]`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, true, r.note);
  assert.ok(/1\/2/.test(r.note));
});

test('SC4: link buried in a table row / numbered list is NOT inline body → FAIL', () => {
  // Regression: the only "before Related Reading" link sits in a table row and a
  // numbered list — neither is woven into a sentence, so 首链优先权 is NOT met.
  const draft = `# X

## What is X?

**X is calm.** Plain prose, no inline link in a sentence.

## Quick Reference Table

| Property | See |
| calm | [[<TBD-internal-link: throat chakra explainer>]] |

## Reflection Prompts

1. Recall a moment — see [[<TBD-internal-link: pillar page on aura colors>]].

## Related Reading

[[<TBD-internal-link: comparison with violet aura>]]`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, false);
  assert.ok(/0\/3/.test(r.note));
});

test('SC4: no internal links at all → PASS (no opinion)', () => {
  const draft = `# X\n\n## What is X?\n\n**X is calm.** No links anywhere.`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, true);
  assert.ok(/no opinion/.test(r.note));
});

test('SC4: ZH 延伸阅读 split — inline body link → PASS', () => {
  const draft = `# 蓝色气场

## 蓝色气场是什么？

蓝色气场偏冷静，可参考 [[<TBD-internal-link: 气场颜色总览 pillar 页>]] 了解全貌。

## 延伸阅读

[[<TBD-internal-link: 喉轮深度解析>]]`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC4: ZH 延伸阅读 split — all dumped at end → FAIL', () => {
  const draft = `# 蓝色气场

## 蓝色气场是什么？

蓝色气场偏冷静，没有内联链接。

## 延伸阅读

[[<TBD-internal-link: 气场颜色总览 pillar 页>]]
[[<TBD-internal-link: 喉轮深度解析>]]`;
  const r = checkLinkDistribution(draft);
  assert.equal(r.pass, false);
  assert.ok(/0\/2/.test(r.note));
});
