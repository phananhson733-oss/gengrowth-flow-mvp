#!/usr/bin/env node
// Smoke test for lib/structure-checks.mjs SC11 — banned templated heading
// patterns (FAIL, EN only).
//
// SC11 catches the three grammatically-broken, mass-production-signalling H2/H3
// patterns the 2026-06-13 SEO audit found live across ~16 articles:
//   (1) the literal boilerplate phrase "vs Adjacent Concepts"
//   (2) "What is " followed by a lowercase letter (broken casing — verbatim
//       keyword injected without Title Case, e.g. "## What is full moon ritual?")
//   (3) "How to Read " followed by a lowercase multi-word phrase (verbatim
//       lowercase keyword injected, e.g. "## How to Read full moon energy in Yourself")
//
// Run: node --test tools/scripts/__tests__/lib-structure-checks-sc11.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { checkBannedHeadings } from '../lib/structure-checks.mjs';

// ------------------------------------------------------------
// severity + empty-input contract
// ------------------------------------------------------------

test('SC11: severity is fail', () => {
  const r = checkBannedHeadings('# X\n\n## What Is a Full Moon Ritual?\n\nBody.');
  assert.equal(r.severity, 'fail');
});

test('SC11: empty draft → PASS (skipped, no double-fail)', () => {
  const r = checkBannedHeadings('');
  assert.equal(r.pass, true);
});

// ------------------------------------------------------------
// Pattern 1 — "vs Adjacent Concepts" boilerplate
// ------------------------------------------------------------

test('SC11: H2 with "vs Adjacent Concepts" → FAIL', () => {
  const draft = `# Full Moon Ritual

## What Is a Full Moon Ritual?

A full moon ritual is **a structured moment of reflection**.

## Full Moon Ritual vs Adjacent Concepts: How It Works + Trade-offs

Comparison prose here.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
  assert.ok(r.violations.length >= 1, 'violation populated');
  assert.equal(typeof r.violations[0].line, 'number');
  assert.ok(/adjacent concepts/i.test(r.violations[0].text), r.violations[0].text);
});

test('SC11: "vs Adjacent Concepts" match is case-insensitive', () => {
  const draft = `# X\n\n## Something VS ADJACENT CONCEPTS here`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
});

test('SC11: a real, specific comparison heading naming the concept → PASS', () => {
  const draft = `# Full Moon Ritual

## What Is a Full Moon Ritual?

A full moon ritual is **a structured moment of reflection**.

## Full Moon vs New Moon Energy: What Actually Differs

Comparison prose here.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

// ------------------------------------------------------------
// Pattern 2 — "What is <lowercase>" broken casing
// ------------------------------------------------------------

test('SC11: "## What is full moon ritual?" (lowercase) → FAIL', () => {
  const draft = `# Full Moon Ritual\n\n## What is full moon ritual?\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
  assert.ok(/what is/i.test(r.violations[0].text), r.violations[0].text);
});

test('SC11: "## What Is a Full Moon Ritual?" (Title Case) → PASS', () => {
  const draft = `# Full Moon Ritual\n\n## What Is a Full Moon Ritual?\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC11: "## What Is the Root Chakra?" (article lowercase but heading Title-Cased) → PASS', () => {
  // "Is" is capitalised; "the" being lowercase is correct Title Case for articles.
  const draft = `# Root Chakra\n\n## What Is the Root Chakra?\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC11: "## What is The Root Chakra?" (lowercase is + odd casing) → FAIL', () => {
  const draft = `# Root Chakra\n\n## What is The Root Chakra?\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
});

// ------------------------------------------------------------
// Pattern 3 — "How to Read <lowercase phrase>" verbatim keyword
// ------------------------------------------------------------

test('SC11: "## How to Read full moon energy in Yourself" → FAIL', () => {
  const draft = `# Full Moon\n\n## How to Read full moon energy in Yourself\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
  assert.ok(/how to read/i.test(r.violations[0].text), r.violations[0].text);
});

test('SC11: "## How to Read Your Full Moon Energy" (Title Case) → PASS', () => {
  const draft = `# Full Moon\n\n## How to Read Your Full Moon Energy\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC11: "## How to Read a Birth Chart in Plain English" (Title Case) → PASS', () => {
  const draft = `# Birth Chart\n\n## How to Read a Birth Chart in Plain English\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

// ------------------------------------------------------------
// Cross-pattern / false-positive guards
// ------------------------------------------------------------

test('SC11: a fully clean article (all three sections de-templated) → PASS', () => {
  const draft = `# What a Full Moon Ritual Really Does for Reflection

## What Is a Full Moon Ritual?

A full moon ritual is **a structured pause for reflection**.

## Full Moon vs New Moon Energy: What Actually Differs

Comparison prose.

## How to Read Your Own Full-Moon Patterns

Observation cues.

## Sources

- Some Author — contribution.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC11: H3 headings are also scanned', () => {
  const draft = `# X\n\n## Why It Matters\n\nIntro.\n\n### What is something lowercase?\n\nBody.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, false);
});

test('SC11: ZH headings are not flagged (EN-only check)', () => {
  // The casing/grammar heuristics are English-specific; ZH entity headings must
  // not false-positive (the ZH template translates the entity in-place).
  const draft = `# 满月仪式\n\n## 满月仪式是什么？\n\n正文。\n\n## 如何在自己身上读出满月能量\n\n正文。`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});

test('SC11: prose body mentioning these phrases is NOT flagged (headings only)', () => {
  // Only `## `/`### ` heading lines are scanned, never body prose.
  const draft = `# X

## What Is a Full Moon Ritual?

People often ask what is the difference, and how to read full moon energy in everyday life, versus adjacent concepts like new moon work.`;
  const r = checkBannedHeadings(draft);
  assert.equal(r.pass, true, r.note);
});
