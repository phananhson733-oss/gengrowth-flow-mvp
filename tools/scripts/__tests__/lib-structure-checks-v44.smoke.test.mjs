#!/usr/bin/env node
// Smoke test for the v4.4 structure checks added on top of SC1-SC4.
//
// SC5 — FAQ section present with >=3 PAA-style Q&A (FAIL).
// SC6 — H1 carries a value proposition, not a bare keyword (WARN).
// SC7 — snippet bold definition followed by >=3 bullet points (WARN).
// SC8 — Take Action / CTA section contains a real link, not a link-less CTA (FAIL).
// SC9 — Sources section present with >=1 named entry (FAIL).
//
// Run: node --test tools/scripts/__tests__/lib-structure-checks-v44.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkFaqSection,
  checkH1ValueProp,
  checkSnippetBullets,
  checkCtaUrl,
  checkSourcesSection,
} from '../lib/structure-checks.mjs';

// ============================================================
// SC5 — FAQ section
// ============================================================

const FAQ_BLOCK = `## Frequently Asked Questions

**What does an orange aura mean spiritually?**

It points to creative drive and sociability. Readers treat it as a snapshot of current energy.

**Can an orange aura change over time?**

Yes. Most readers see color as a state, not a permanent label.

**Is an orange aura rare?**

It is fairly common in people moving through active, expressive phases. It rarely stays fixed.
`;

test('SC5: FAQ section with 3 bolded questions → PASS', () => {
  const draft = `# Orange Aura Meaning\n\n## What is Orange Aura?\n\nBody.\n\n${FAQ_BLOCK}`;
  const r = checkFaqSection(draft);
  assert.equal(r.id, 'sc5_faq_section');
  assert.equal(r.severity, 'fail');
  assert.equal(r.pass, true);
});

test('SC5: missing FAQ section → FAIL', () => {
  const draft = `# Orange Aura Meaning\n\n## What is Orange Aura?\n\nBody only, no FAQ.`;
  const r = checkFaqSection(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.length >= 1);
});

test('SC5: FAQ section with only 2 questions → FAIL', () => {
  const twoQ = `## Frequently Asked Questions

**Question one?**

Answer one. Second sentence.

**Question two?**

Answer two. Second sentence.
`;
  const draft = `# X\n\n## What is X?\n\nBody.\n\n${twoQ}`;
  const r = checkFaqSection(draft);
  assert.equal(r.pass, false);
});

test('SC5: inline bold question inside an answer is NOT counted → FAIL', () => {
  // Only one real whole-line question; the other "**…?**" is mid-answer.
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Frequently Asked Questions\n\n**Is X real?**\n\nYes. Some ask **really?** but it holds.\n\nMore prose with **what about Y?** inline only.`;
  const r = checkFaqSection(draft);
  assert.equal(r.pass, false);
});

test('SC5: ZH FAQ heading 常见问题 → PASS', () => {
  const zh = `## 常见问题

**橙色光环代表什么？**

代表创造力与社交能量。它是当下状态的快照。

**橙色光环会改变吗？**

会。多数解读者视颜色为状态而非固定标签。

**橙色光环常见吗？**

在表达活跃期的人身上较常见。它很少固定不变。
`;
  const draft = `# 橙色光环含义\n\n## 橙色光环是什么？\n\n正文。\n\n${zh}`;
  const r = checkFaqSection(draft);
  assert.equal(r.pass, true);
});

// ============================================================
// SC6 — H1 value proposition (WARN)
// ============================================================

test('SC6: bare-keyword H1 equal to target_keyword → WARN (pass=false)', () => {
  const draft = `# Orange Aura Meaning\n\n## What is Orange Aura?\n\nBody.`;
  const r = checkH1ValueProp(draft, { target_keyword: 'orange aura meaning' });
  assert.equal(r.id, 'sc6_h1_value_prop');
  assert.equal(r.severity, 'warn');
  assert.equal(r.pass, false);
});

test('SC6: H1 = `[keyword]: [clause]` rigid colon template → WARN (清单 §1 forbids)', () => {
  const draft = `# Orange Aura Meaning: Reading Your Energy Without Fear or Labels\n\n## What is Orange Aura?\n\nBody.`;
  const r = checkH1ValueProp(draft, { target_keyword: 'orange aura meaning' });
  assert.equal(r.pass, false);
  assert.ok(/colon|冒号|rigid|模板/.test(`${r.violations[0].text} ${r.violations[0].hint} ${r.note}`));
});

test('SC6: magnetic H1 with keyword woven in (no colon template) → PASS', () => {
  const draft = `# What Your Orange Aura Really Says About Drive and Connection\n\n## What is Orange Aura?\n\nBody.`;
  const r = checkH1ValueProp(draft, { target_keyword: 'orange aura meaning' });
  assert.equal(r.pass, true, r.note);
});

test('SC6: H1 with dash subtitle (not the forbidden colon template) → PASS', () => {
  const draft = `# 8th House Meaning — The Strengths You Keep Giving to Others\n\n## What is the 8th House?\n\nBody.`;
  const r = checkH1ValueProp(draft, { target_keyword: '8th house meaning' });
  assert.equal(r.pass, true);
});

test('SC6: no H1 → PASS (H1-count check authoritative)', () => {
  const r = checkH1ValueProp(`## What is X?\n\nBody.`, { target_keyword: 'x' });
  assert.equal(r.pass, true);
});

// ============================================================
// SC7 — snippet bullets (WARN)
// ============================================================

test('SC7: first section with 3 bullets → PASS', () => {
  const draft = `# Orange Aura Meaning

## What is Orange Aura?

Orange aura usually reads as **a warm, sociable energy field tied to creative drive**.

- Signals expressive, outgoing phases
- Reflects a current state, not a fixed label
- Often appears during active, social periods

More prose.`;
  const r = checkSnippetBullets(draft);
  assert.equal(r.id, 'sc7_snippet_bullets');
  assert.equal(r.severity, 'fail');
  assert.equal(r.pass, true);
});

test('SC7: first section with no bullets → WARN (pass=false)', () => {
  const draft = `# Orange Aura Meaning

## What is Orange Aura?

Orange aura usually reads as **a warm, sociable energy field**. Just prose, no bullets here.`;
  const r = checkSnippetBullets(draft);
  assert.equal(r.pass, false);
});

// ============================================================
// SC8 — CTA link presence (FAIL)
// ============================================================

test('SC8: Take Action with real URL → PASS', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Take Action\n\nMap your chart with the free reading tool at https://astrologywiki.com/reading to see this placement.`;
  const r = checkCtaUrl(draft);
  assert.equal(r.id, 'sc8_cta_url');
  assert.equal(r.severity, 'fail');
  assert.equal(r.pass, true);
});

test('SC8: Take Action with only a TBD placeholder (no real URL) → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Take Action\n\nStart with the [[<TBD-internal-link: free birth chart tool>]] to apply this.`;
  const r = checkCtaUrl(draft);
  assert.equal(r.pass, false);
});

test('SC8: Take Action with example.com stub → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Take Action\n\nGo to https://example.com/tool now.`;
  const r = checkCtaUrl(draft);
  assert.equal(r.pass, false);
});

test('SC8: Take Action with no link → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Take Action\n\nReflect on this placement in your own life.`;
  const r = checkCtaUrl(draft);
  assert.equal(r.pass, false);
});

test('SC8: ZH 下一步行动 with URL → PASS', () => {
  const draft = `# X\n\n## X 是什么？\n\n正文。\n\n## 下一步行动\n\n用免费星盘工具 https://astrologywiki.com/reading 查看你的配置。`;
  const r = checkCtaUrl(draft);
  assert.equal(r.pass, true);
});

// ============================================================
// SC9 — Sources section (FAIL)
// ============================================================

test('SC9: Sources section with named entries → PASS', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Sources\n\n- Liz Greene — pioneer of psychological astrology\n- Howard Sasportas — developed the houses framework`;
  const r = checkSourcesSection(draft);
  assert.equal(r.id, 'sc9_sources_section');
  assert.equal(r.severity, 'fail');
  assert.equal(r.pass, true);
});

test('SC9: missing Sources section → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Take Action\n\nDo the thing at https://astrologywiki.com.`;
  const r = checkSourcesSection(draft);
  assert.equal(r.pass, false);
});

test('SC9: empty Sources section (no entries) → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Sources\n\n`;
  const r = checkSourcesSection(draft);
  assert.equal(r.pass, false);
});

test('SC9: a "## Sources of Confusion" section does NOT satisfy Sources → FAIL', () => {
  const draft = `# X\n\n## What is X?\n\nBody.\n\n## Sources of Confusion\n\n- people mix up A and B\n\n## Take Action\n\nGo to https://astrologywiki.com.`;
  const r = checkSourcesSection(draft);
  assert.equal(r.pass, false);
});

test('SC9: ZH 参考来源 with entries → PASS', () => {
  const draft = `# X\n\n## X 是什么？\n\n正文。\n\n## 参考来源\n\n- Liz Greene — 心理占星学先驱\n- Dane Rudhyar — 人本占星传统`;
  const r = checkSourcesSection(draft);
  assert.equal(r.pass, true);
});
