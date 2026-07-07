// lib-red-lines-rl4.smoke.test.mjs — RL4 关键词锚检查：免责声明打头的 section 不应被误判漂移。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRL4 } from '../lib/red-lines.mjs';

const CTX = { targetKeyword: 'Mexico vs England astrology prediction', entity: 'Mexico vs England Astrology Prediction' };

// Take Action 节以强制免责声明开头，真正含关键词的内容在其后一段。
const WITH_DISCLAIMER = `## What Is a Mexico vs England Astrology Prediction?

A Mexico vs England astrology prediction reads the symbolic backdrop of the fixture. It layers national charts and transits into one Mexico vs England astrology prediction lens.

## Take Action

This is not a clinical interpretation or mental health advice.

Start by generating your free birth chart — the same houses and transits a Mexico vs England astrology prediction leans on. This kind of Mexico vs England astrology prediction becomes a mirror for your own timing.
`;

test('RL4：section 以免责声明开头时，锚点用其后实质段落（不误判漂移）', () => {
  const r = checkRL4(WITH_DISCLAIMER, CTX);
  assert.equal(r.pass, true, `不应因免责声明首段漂移: ${r.note}`);
  assert.ok(!/Take Action/.test(r.note || ''), `Take Action 不该被列为漂移: ${r.note}`);
});

test('RL4：真正缺关键词的 prose section 仍判漂移（修复不放水，容差=2 处才 FAIL）', () => {
  // 2 个通用 section 都缺关键词 → 超容差 → FAIL（证明免责声明跳过不会放行真漂移）
  const GENERIC = `## What Is a Mexico vs England Astrology Prediction?

A Mexico vs England astrology prediction reads the fixture's symbolic backdrop via a Mexico vs England astrology prediction lens.

## Why It Matters

Understanding this kind of reading matters because it hands you a low-stakes way to practice symbolism, and what you notice about the two teams mirrors what you notice about yourself.

## How to Reflect

Sit with the tension you feel and notice which side you instinctively defend; that instinct often tracks how you show up for people and causes in daily life.
`;
  const r = checkRL4(GENERIC, CTX);
  assert.equal(r.pass, false, '2 个真缺关键词的通用 section 应超容差 FAIL');
  assert.match(r.note || '', /Why It Matters|How to Reflect/);
});
