#!/usr/bin/env node
// Smoke test for lib/red-lines.zh.mjs — Chinese-language red lines.
//
// Covers the ZH counterparts dispatched by _phase2-validate.mjs for zh articles:
//   RL1 (中医违规 + 广告法禁词), RL2 (竞品贬低), RL6 (心理安全 + 神秘学营销),
//   RL7 (作家黑词 — CJK 子串 + ASCII 词边界), RL8 (科学背书).
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-zh.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  checkRL1Zh,
  checkRL2Zh,
  checkRL6Zh,
  checkRL7Zh,
  checkRL8Zh,
} from '../lib/red-lines.zh.mjs';

// ---------- RL1: 中医违规 + 广告法禁词 ----------
test('RL1Zh: 中医违规话术 (打通经络) → FAIL', () => {
  assert.equal(checkRL1Zh('# 蓝色气场\n\n这能打通经络。').pass, false);
});

test('RL1Zh: 广告法绝对禁词 (第一 / 100%) → FAIL', () => {
  assert.equal(checkRL1Zh('# T\n\n全网第一准确的解读。').pass, false);
  assert.equal(checkRL1Zh('# T\n\n100% 有效。').pass, false);
});

test('RL1Zh: 普通解读文 → PASS', () => {
  assert.equal(checkRL1Zh('# 蓝色气场\n\n蓝色常与平静和沟通联系在一起。').pass, true);
});

// ---------- RL2: 竞品贬低 ----------
test('RL2Zh: 竞品名 + 窗口内贬低词 → FAIL', () => {
  assert.equal(checkRL2Zh('# T\n\n测测星座很不准，纯属智商税。').pass, false);
});

test('RL2Zh: 竞品名但无贬低词 → PASS', () => {
  assert.equal(checkRL2Zh('# T\n\n测测星座是一款常见的星座 app。').pass, true);
});

// ---------- RL6: 神秘学营销红线 (always-fail) ----------
test('RL6Zh: 神秘学营销词 (招财 / 改运) → FAIL（不论 psych_safety）', () => {
  const r = checkRL6Zh('# T\n\n这个方法帮你招财改运。', { psych_safety_flag: 'N' });
  assert.equal(r.pass, false);
});

test('RL6Zh: psych_safety=N 且无红线词 → PASS (N/A)', () => {
  assert.equal(checkRL6Zh('# T\n\n蓝色象征平静。', { psych_safety_flag: 'N' }).pass, true);
});

test('RL6Zh: psych_safety=Y 缺中文 disclaimer → FAIL', () => {
  assert.equal(checkRL6Zh('# T\n\n关于焦虑的内容。', { psych_safety_flag: 'Y' }).pass, false);
});

test('RL6Zh: psych_safety=Y + 中文 disclaimer → PASS', () => {
  const draft = '# T\n\n本文不构成临床建议。仅供参考。';
  assert.equal(checkRL6Zh(draft, { psych_safety_flag: 'Y' }).pass, true);
});

// ---------- RL7: 作家黑词 (CJK 子串 + ASCII 词边界) ----------
test('RL7Zh: CJK banned token 子串命中 → FAIL', () => {
  const r = checkRL7Zh('# T\n\n这篇大谈能量与气场。', { authorBannedTokens: ['能量'], targetKeyword: '' });
  assert.equal(r.pass, false);
  assert.match(JSON.stringify(r.evidence), /能量/);
});

test('RL7Zh: ASCII banned token 用词边界（aura 命中，synergy 不误伤 energy）', () => {
  assert.equal(checkRL7Zh('# T\n\n这是 aura 解读。', { authorBannedTokens: ['aura'] }).pass, false);
  assert.equal(checkRL7Zh('# T\n\nteam synergy 团队。', { authorBannedTokens: ['energy'] }).pass, true);
});

test('RL7Zh: token 命中 target_keyword（整串）→ 豁免 PASS', () => {
  const r = checkRL7Zh('# T\n\n蓝色能量解读。', { authorBannedTokens: ['能量'], targetKeyword: '蓝色能量气场' });
  assert.equal(r.pass, true);
});

test('RL7Zh: 空黑词清单 → N/A PASS', () => {
  assert.equal(checkRL7Zh('# T\n\n任意内容。', { authorBannedTokens: [] }).pass, true);
});

test('RL7Zh: frontmatter / fenced code 内的黑词不算命中 → PASS', () => {
  assert.equal(checkRL7Zh('---\ntitle: 能量\n---\n\n正常内容。', { authorBannedTokens: ['能量'] }).pass, true);
  assert.equal(checkRL7Zh('# T\n\n```\n能量\n```\n正常。', { authorBannedTokens: ['能量'] }).pass, true);
});

// ---------- RL8: 科学背书 ----------
test('RL8Zh: 科学背书短语 (研究表明 / 科学证明) → FAIL', () => {
  assert.equal(checkRL8Zh('# T\n\n研究表明蓝色让人平静。').pass, false);
  assert.equal(checkRL8Zh('# T\n\n这已被科学证明。').pass, false);
});

test('RL8Zh: 普通解读 → PASS', () => {
  assert.equal(checkRL8Zh('# T\n\n许多人把蓝色与平静联系在一起。').pass, true);
});

test('RL8Zh: frontmatter 内的短语不算命中 → PASS', () => {
  assert.equal(checkRL8Zh('---\ntitle: 研究表明\n---\n\n正常内容。').pass, true);
});
