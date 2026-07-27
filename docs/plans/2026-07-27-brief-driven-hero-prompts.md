---
title: Brief-Driven Hero Prompts Implementation Plan
date: 2026-07-27
updated: 2026-07-27
type: plan
version: v1.0
status: approved
owner: wzb
tags:
  - illustration
  - hero-images
  - content-production
  - automation
aliases:
  - Brief-Driven Hero Plan
  - 主题驱动主视觉计划
---

# Brief-Driven Hero Prompts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make automatic blog hero prompts visibly represent the article Brief and content, reserving abstract imagery for articles with no concrete subject.

**Architecture:** Extend the existing deterministic `classifyHeroTheme()` classifier with a `fictional-character-scene` route that runs before generic person/zodiac detection. Keep existing categories for real people, relationships, sports, and country events; update the deterministic fallback prompt and LLM planning rules so every concrete topic specifies its subject, relationship, setting, and reader task.

**Tech Stack:** Node.js built-in test runner; ESM modules; JSON image plans; local FLUX image generator for manual article heroes.

---

### Task 1: Define the required classification behavior with failing tests

**Files:**

- Modify: `tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`
- Modify: `tools/scripts/lib/illustrate.mjs`

**Step 1: Write the failing test**

Add a test that calls `classifyHeroTheme()` with a Harry Potter character-zodiac article and expects `fictional-character-scene`. Add prompt assertions requiring a non-actor, non-photoreal character ensemble and a story setting.

**Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: FAIL because the current classifier returns `celebrity-portrait`.

**Step 3: Write minimal implementation**

Add the fictional-IP classifier before the real-person birth-chart/zodiac fallback. Add one deterministic prompt branch with a role-based ensemble, concrete story setting, celestial archetype motifs, and no actor resemblance.

**Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: PASS.

### Task 2: Make planner instructions Brief-first rather than style-first

**Files:**

- Modify: `tools/scripts/lib/illustrate.mjs`
- Test: `tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

**Step 1: Write the failing test**

Add an assertion that `buildHeroPlanningRules()` requires the planner to extract the subject, key relationship, concrete setting, and reader task from the article Brief/content before composing a hero prompt.

**Step 2: Run test to verify it fails**

Run: `node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: FAIL because this four-part prompt contract does not yet exist.

**Step 3: Write minimal implementation**

Add the four-part prompt contract and fictional-IP category to `buildHeroPlanningRules()`. Keep the existing one-scene, no-text, crop-safe constraints.

**Step 4: Run test to verify it passes**

Run: `node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: PASS.

### Task 3: Verify regression safety and prepare article-specific hero regeneration

**Files:**

- Modify: `tools/scripts/lib/illustrate.mjs`
- Modify: `tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`
- Create: article-specific image plans in the isolated Oracle worktree only

**Step 1: Run the complete prompt-helper test file**

Run: `node --test tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: all tests pass, including real-person, relationship, sports, fictional-IP, sizing, and provider behavior.

**Step 2: Verify the source diff**

Run: `git diff --check -- tools/scripts/lib/illustrate.mjs tools/scripts/__tests__/lib-illustrate.smoke.test.mjs`

Expected: no output.

**Step 3: Regenerate article heroes from content-specific plans**

For the BLACKPINK article, create a stylized four-performer stage composition with individual zodiac motifs, no real likenesses and no text. For the Harry Potter article, create a non-actor ensemble of distinct student/mentor archetypes in a magical school setting, with celestial motifs that support the character-sign comparison.

**Step 4: Verify images and article wiring**

Run the visual inspection, `gg-hero-qa.mjs`, exact 1200×675 assertion, article data assertions, and `npm run build` in the isolated Oracle worktree.

**Step 5: Commit scoped source files**

Commit only the changed Flow prompt logic/tests and the intended Oracle article/image files. Do not include build-generated static pages or abandoned draft images.
