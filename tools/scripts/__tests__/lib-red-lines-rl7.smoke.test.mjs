#!/usr/bin/env node
// Smoke test for lib/red-lines.mjs RL7 — per-author banned-token red line.
//
// RL7 scans the draft body for any token in ctx.authorBannedTokens (filled by
// Lane A content-draft from the author persona capsule). A red line: a hit is a
// hard FAIL, never warn-then-fail. Scope guards (Codex #9): skip YAML
// frontmatter, blockquotes, fenced code; exempt a banned token that is a
// substring of ctx.targetKeyword; word-boundary + case-insensitive matching.
//
// Run: node --test tools/scripts/__tests__/lib-red-lines-rl7.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkRL7 } from '../lib/red-lines.mjs';

const BODY = `# Blue Aura Meaning

The color blue speaks to calm and clarity.

It is about communication, not about anything else.`;

// ---------- no hits → pass ----------
test('RL7: banned tokens, none present → PASS', () => {
  const r = checkRL7(BODY, { authorBannedTokens: ['energy', 'vibration'] });
  assert.equal(r.pass, true);
});

// ---------- ctx with no authorBannedTokens → pass (author has no black list) ----------
test('RL7: ctx without authorBannedTokens → PASS (skip)', () => {
  const r = checkRL7(BODY, {});
  assert.equal(r.pass, true);
});

test('RL7: empty authorBannedTokens array → PASS (skip)', () => {
  const r = checkRL7(BODY, { authorBannedTokens: [] });
  assert.equal(r.pass, true);
});

// ---------- hit in body → FAIL + evidence ----------
test('RL7: banned token in body → FAIL with evidence', () => {
  const draft = `# Title

Your aura is pure energy radiating outward.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, false);
  assert.ok(Array.isArray(r.evidence) && r.evidence.length >= 1, 'evidence should be populated');
  assert.match(JSON.stringify(r.evidence), /energy/i);
});

// ---------- target_keyword substring exemption ----------
test('RL7: banned token that is substring of targetKeyword → exempt → PASS', () => {
  // Marcus bans "energy" but the entry is "planetary energy" — exempt for this article.
  const draft = `# Planetary Energy

This piece explores planetary energy in depth.`;
  const r = checkRL7(draft, {
    authorBannedTokens: ['energy'],
    targetKeyword: 'planetary energy',
  });
  assert.equal(r.pass, true);
});

// ---------- frontmatter is not scanned ----------
test('RL7: banned token only in YAML frontmatter → not counted → PASS', () => {
  const draft = `---
title: Energy of Blue
tags:
  - energy
---

# Blue

Calm and clear, all about communication.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, true);
});

// ---------- blockquote is not scanned ----------
test('RL7: banned token only inside a blockquote → not counted → PASS', () => {
  const draft = `# Blue

> The ancients wrote: all is energy and motion.

Calm and clear prose follows.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, true);
});

// ---------- fenced code is not scanned ----------
test('RL7: banned token only inside fenced code → not counted → PASS', () => {
  const draft = `# Blue

\`\`\`
const energy = 42;
\`\`\`

Calm and clear prose.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, true);
});

// ---------- word boundary: "energetic" should not trip "energy" ----------
test('RL7: word-boundary — "energetic" does not trip banned "energy" → PASS', () => {
  const draft = `# Blue

She felt energetic and alive this morning.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, true);
});

// ---------- case insensitive ----------
test('RL7: case-insensitive match → FAIL', () => {
  const draft = `# Blue

The whole thing is pure ENERGY.`;
  const r = checkRL7(draft, { authorBannedTokens: ['energy'] });
  assert.equal(r.pass, false);
});

// ---------- multi-word banned token ----------
test('RL7: multi-word banned token matched in body → FAIL', () => {
  const draft = `# Blue

This will manifest your destiny overnight.`;
  const r = checkRL7(draft, { authorBannedTokens: ['manifest your destiny'] });
  assert.equal(r.pass, false);
  assert.match(JSON.stringify(r.evidence), /manifest your destiny/i);
});
