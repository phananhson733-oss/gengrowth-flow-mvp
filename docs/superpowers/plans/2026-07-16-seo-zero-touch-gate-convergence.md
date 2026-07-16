---
title: SEO Zero-touch Gate Convergence Implementation Plan
date: 2026-07-16
updated: 2026-07-16
type: plan
version: v1.0
status: final
owner: wzb
tags:
  - seo
  - zero-touch
  - quality-gates
  - tdd
aliases:
  - SEO 零人值守门禁收敛实施计划
---

# SEO Zero-touch Gate Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每次自动修复后在同一不可变 commit SHA 上全量重过安全门禁，并把机械结构差异收敛为 profile 驱动的确定性检查。

**Architecture:** preview gate 使用外层 repair round，而不是在单个 dimension 内局部重跑。每轮先 pin branch head，再执行 Chrome、全部 reviewer、Codex、最终链接/资产检查；任何 edit 产生新 SHA 后整轮作废并从头开始。Phase 2 将语义安全线与 profile 结构阈值分离，normalizer 只做非语义、幂等变换。

**Tech Stack:** Node.js ESM、`node:test`、现有 preview/review/Codex gate、GitHub CLI、Phase 2 validator、Markdown structural profiles。

## Global Constraints

- 事实、占星计算、引用、资产、链接、canonical、Article JSON-LD、CTA 与生产验证始终 fail closed。
- required 模式无法取得 branch head SHA 时不得 mark-verified 或 merge。
- 任何 edit 后必须在新 SHA 上重跑全部门禁；旧 SHA 的任一 PASS 不得复用。
- merge 必须使用已审核 SHA 的 `--match-head-commit`，禁止 unpinned fallback。
- 每个 gate incident 最多 3 次总 repair edit、单 dimension 最多 2 次；相同 SHA/失败连续两次进入 `no_progress`。
- normalizer 不得修改事实、数字、日期、URL、slug、CTA、来源、资产引用或正文语义。
- 结构 profile 必须显式版本化，旧 manifest 无 profile 时保持兼容默认值。
- 不通过降低事实门禁或 force publish 达成测试绿色。

---

### Task 1: Pin Every Gate Round to One Commit SHA

**Files:**
- Modify: `tools/scripts/gg-preview-gate.mjs`
- Modify: `tools/scripts/gg-seo-autopilot.mjs`
- Modify: `tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`
- Create: `tools/scripts/__tests__/seo-autopilot-merge-gate.smoke.test.mjs`

**Interfaces:**
- Gate evidence: `{ reviewedHeadRefOid, repairRound, checks }`
- CLI: `gg-seo-autopilot.mjs --mark-verified ... --head-ref-oid <40-hex-sha>`
- Helper: `resolveBranchHead(branch, repo, deps): Promise<string>`

- [ ] **Step 1: Write RED SHA integrity tests**

```js
test('a repair invalidates every earlier gate result and reruns all checks on the new SHA', async () => {
  const fixture = gateFixture({ heads: ['a'.repeat(40), 'b'.repeat(40), 'b'.repeat(40)] });
  fixture.reviewVerdicts.schema = ['FAIL', 'PASS'];
  const result = await runGate(fixture);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.callsFor('chrome').map((x) => x.head), ['a'.repeat(40), 'b'.repeat(40)]);
  for (const dim of ['fact', 'astrology', 'schema']) {
    assert.deepEqual(fixture.callsFor(dim).map((x) => x.head), ['a'.repeat(40), 'b'.repeat(40)]);
  }
  assert.deepEqual(fixture.callsFor('codex').map((x) => x.head), ['a'.repeat(40), 'b'.repeat(40)]);
  assert.equal(fixture.markVerifiedArgs['head-ref-oid'], 'b'.repeat(40));
});

test('branch head drift during a gate round blocks verification', async () => {
  const fixture = gateFixture({ heads: ['a'.repeat(40), 'b'.repeat(40)] });
  const result = await runGate(fixture);
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /head drift/i);
  assert.equal(fixture.markVerifiedCalls, 0);
  assert.equal(fixture.mergeCalls, 0);
});

test('required mode cannot verify when branch head is unavailable', async () => {
  const fixture = gateFixture({ heads: [null] });
  const result = await runGate(fixture);
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /headRefOid required/);
});
```

Add merge tests: missing `headRefOid`, malformed SHA, or current PR head mismatch must throw before `gh pr merge`.

- [ ] **Step 2: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-sha-red.XXXXXX) node --test tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs tools/scripts/__tests__/seo-autopilot-merge-gate.smoke.test.mjs`

Expected: current gate only reruns one dimension, `--mark-verified` lacks required SHA, and merge still allows unpinned fallback.

- [ ] **Step 3: Implement outer repair rounds**

Replace the per-dimension `repaired` set with an outer loop:

```js
for (let repairRound = 0; repairRound <= maxRepairRounds; repairRound += 1) {
  const reviewedHeadRefOid = await resolveBranchHead(o.branch, o.repo, deps);
  if (!reviewedHeadRefOid) return gateFail(..., 'headRefOid required before gate');

  const outcome = await runFullGateRound({
    reviewedHeadRefOid,
    previewUrl,
    claim,
    articleTs,
    draftMd,
  });

  if (outcome.pass) {
    const currentHead = await resolveBranchHead(o.branch, o.repo, deps);
    if (currentHead !== reviewedHeadRefOid) return gateFail(..., `head drift ${reviewedHeadRefOid} -> ${currentHead}`);
    return markAndMerge({ reviewedHeadRefOid, outcome });
  }

  if (!outcome.repairable || repairRound === maxRepairRounds) return gateFail(..., outcome.reason);
  const repaired = await tryGateRepair({ ...outcome, expectedHead: reviewedHeadRefOid });
  if (!repaired.applied || repaired.headRefOid === reviewedHeadRefOid) return gateFail(..., 'repair made no commit progress');
}
```

`runFullGateRound` always executes Chrome, all three review dimensions, Codex and final asset/link verification for the pinned SHA. It returns the first repairable failure only after recording all completed check evidence; no prior round PASS is reused.

- [ ] **Step 4: Make mark/merge SHA mandatory**

Parse and validate `--head-ref-oid`. `doMarkVerified` must fetch the current PR head and require exact equality with the supplied SHA; failure to fetch is blocking. Store `headRefOid` and `reviewedAt` in the claim. `doMerge` must reject a missing/malformed SHA and always pass `--match-head-commit claim.headRefOid`.

- [ ] **Step 5: Run GREEN and commit**

Run the RED command. Expected all pass. Run `git diff --check`, then commit:

```bash
git add tools/scripts/gg-preview-gate.mjs tools/scripts/gg-seo-autopilot.mjs tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs tools/scripts/__tests__/seo-autopilot-merge-gate.smoke.test.mjs
git commit -m "fix(seo): bind full gates to reviewed commits"
```

---

### Task 2: Final Asset and Link Verification with Bounded Repair Progress

**Files:**
- Create: `tools/scripts/lib/seo-final-artifacts.mjs`
- Create: `tools/scripts/__tests__/seo-final-artifacts.smoke.test.mjs`
- Modify: `tools/scripts/gg-preview-gate.mjs`
- Modify: `tools/scripts/gg-seo-repair-verify.mjs`
- Modify: `tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`
- Modify: `tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs`

**Interfaces:**
- Produces: `verifyFinalLinks({ html, pageUrl, allowedRoutes, sitemapUrls, fetch }): Promise<object>`
- Produces: `verifyFinalAssets({ html, pageUrl, fetch, decodeImage }): Promise<object>`
- Gate budget evidence: `artifactSha`, `failureFingerprint`, `noProgressCount`, `totalRepairEdits`

- [ ] **Step 1: Write RED final-artifact tests**

```js
test('every rendered internal link must be route-or-sitemap verified, 200, and canonical', async () => {
  const result = await verifyFinalLinks({
    html: '<a href="/en/wiki/real">real</a><a href="/en/wiki/fabricated">bad</a>',
    pageUrl: 'https://www.astrologywiki.com/en/wiki/source',
    allowedRoutes: new Set(['/en/wiki/real']),
    sitemapUrls: new Set(['https://www.astrologywiki.com/en/wiki/real']),
    fetch: artifactFetchFixture(),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed.map((x) => x.path), ['/en/wiki/fabricated']);
});

for (const mode of ['404', 'wrong-mime', 'empty', 'decode-fail']) {
  test(`referenced image ${mode} blocks publish`, async () => {
    const result = await verifyFinalAssets(assetFixture(mode));
    assert.equal(result.ok, false);
  });
}

test('unreferenced optional hero with needs_hero does not block', async () => {
  const result = await verifyFinalAssets(assetFixture('no-hero-reference', { needsHero: true }));
  assert.equal(result.ok, true);
});
```

- [ ] **Step 2: Write RED no-progress tests**

Run two repair rounds with identical `artifactSha + failureFingerprint`; assert the second round returns `no_progress`, does not invoke a third edit, and emits a repair event for controller quarantine accounting.

- [ ] **Step 3: Run RED**

Run: `GG_FLOW_STATE_DIR=$(mktemp -d /tmp/seo-artifacts-red.XXXXXX) node --test tools/scripts/__tests__/seo-final-artifacts.smoke.test.mjs tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs`

Expected: missing artifact verifier and no-progress contract fail.

- [ ] **Step 4: Implement deterministic artifact checks**

Normalize internal URLs against the page URL, ignore external/mailto/hash links, then require every internal link to be an allowed route or sitemap URL, HTTP 200, and exact canonical. For every rendered `img/src`, `source/srcset` and relevant SVG reference, require HTTP 200, expected MIME, non-zero body and successful decode/parser validation.

Return named evidence arrays, never a bare boolean. Add `final_links` and `final_assets` to preview gate and terminal verifier checks.

- [ ] **Step 5: Implement repair progress accounting**

Hash the target article plus changed asset bytes before and after every edit. Increment `totalRepairEdits` only when the hash changes. If the same post-edit hash and failure fingerprint recur twice, stop local repair with `no_progress`. Enforce `GG_GATE_REPAIR_MAX_ROUNDS` default 2 and `GG_GATE_REPAIR_TOTAL_BUDGET` default 3, clamped to 1–3.

- [ ] **Step 6: Run GREEN and commit**

Run the RED command and `git diff --check`. Expected all pass. Commit:

```bash
git add tools/scripts/lib/seo-final-artifacts.mjs tools/scripts/__tests__/seo-final-artifacts.smoke.test.mjs tools/scripts/gg-preview-gate.mjs tools/scripts/gg-seo-repair-verify.mjs tools/scripts/__tests__/gg-seo-repair-verify.smoke.test.mjs tools/scripts/__tests__/gg-preview-gate.smoke.test.mjs
git commit -m "fix(seo): verify final links and assets"
```

---

### Task 3: Versioned Structural Profiles and Idempotent Normalization

**Files:**
- Create: `tools/scripts/lib/seo-structural-profile.mjs`
- Create: `tools/scripts/lib/seo-structural-normalizer.mjs`
- Create: `tools/scripts/__tests__/seo-structural-profile.smoke.test.mjs`
- Create: `tools/scripts/__tests__/seo-structural-normalizer.smoke.test.mjs`
- Modify: `tools/scripts/_phase2-validate.mjs`
- Modify: `tools/scripts/lib/iterate-prompt-checks.mjs`
- Create: `tools/scripts/__tests__/phase2-validate.smoke.test.mjs`

**Interfaces:**
- Produces: `resolveStructuralProfile({ site, locale, template, intent, contentTier, manifest }): object`
- Produces: `normalizeStructuralMarkdown(markdown, profile): { markdown, changes, protectedDigestBefore, protectedDigestAfter }`
- Profile version: `seo-structure-v1`

- [ ] **Step 1: Write RED profile compatibility tests**

```js
test('legacy manifest keeps exact legacy H2 behavior', () => {
  const profile = resolveStructuralProfile({ template: 'Definition', contentTier: 'T2', manifest: {} });
  assert.deepEqual(profile.h2Range, [11, 11]);
});

test('profile allows declared optional section without weakening safety checks', () => {
  const profile = resolveStructuralProfile({
    template: 'Definition', contentTier: 'T2',
    manifest: { structural_profile: { version: 'seo-structure-v1', h2_range: [11, 12] } },
  });
  assert.deepEqual(profile.h2Range, [11, 12]);
});

test('one-percent word tolerance accepts 1497 for a 1500 minimum', () => {
  const profile = resolveStructuralProfile({ template: 'Definition', contentTier: 'T2', manifest: {} });
  assert.equal(profile.effectiveWordRange[0], 1485);
});
```

- [ ] **Step 2: Write RED normalizer safety tests**

```js
test('normalizer is idempotent and preserves protected semantics', () => {
  const source = fixtureMarkdownWithDatesUrlsCtaSourcesAndSvg();
  const first = normalizeStructuralMarkdown(source, profileFixture());
  const second = normalizeStructuralMarkdown(first.markdown, profileFixture());
  assert.equal(second.markdown, first.markdown);
  assert.equal(first.protectedDigestAfter, first.protectedDigestBefore);
  assert.deepEqual(second.changes, []);
});
```

The fixture must include dates, numerical claims, URLs, slug, CTA, source citations, image/SVG references and frontmatter so accidental semantic edits are detected.

- [ ] **Step 3: Run RED**

Run: `node --test tools/scripts/__tests__/seo-structural-profile.smoke.test.mjs tools/scripts/__tests__/seo-structural-normalizer.smoke.test.mjs tools/scripts/__tests__/phase2-validate.smoke.test.mjs`

Expected: missing profile/normalizer modules and exact 1500 minimum fail.

- [ ] **Step 4: Implement profile resolver**

Default `seo-structure-v1` derives existing exact H2/H3/FAQ/table/link/keyword values from the manifest/template. It applies a 1% lower word-count tolerance only, never raises the upper bound, and supports explicit ranges only from a valid manifest profile. Invalid versions or inverted ranges fail closed.

The validator must continue running every semantic/red-line check unchanged; profile affects only mechanical structure thresholds.

- [ ] **Step 5: Implement non-semantic normalizer**

Allowed transformations are CRLF→LF, trailing-space removal, blank-line collapse outside code blocks, unordered-list marker normalization and known FAQ heading aliases declared in the profile. Compute a protected digest over frontmatter facts, numbers, dates, URLs, CTA/source lines and asset references before and after; refuse output if it changes.

Run normalizer once before Agent repair. Save normalized output only when `changes.length > 0` and protected digests match.

- [ ] **Step 6: Run GREEN and commit**

Run the RED command plus all red-line/iterate prompt checks. Expected all pass. Commit:

```bash
git add tools/scripts/lib/seo-structural-profile.mjs tools/scripts/lib/seo-structural-normalizer.mjs tools/scripts/__tests__/seo-structural-profile.smoke.test.mjs tools/scripts/__tests__/seo-structural-normalizer.smoke.test.mjs tools/scripts/_phase2-validate.mjs tools/scripts/lib/iterate-prompt-checks.mjs tools/scripts/__tests__/phase2-validate.smoke.test.mjs
git commit -m "feat(seo): make structural gates profile driven"
```

---

### Task 4: Full Regression and Natural Cron Acceptance

**Files:**
- No production code unless a failing acceptance test exposes a defect.
- Runtime evidence: launchd logs, repair queue inspect JSON, strict reconcile/readiness JSON, production verifier JSON.

**Interfaces:**
- Acceptance windows: 18:30, 19:00, 19:30 Asia/Shanghai.

- [ ] **Step 1: Run focused and full hermetic verification**

Use one explicit temporary `GG_FLOW_STATE_DIR`. Run every test from both zero-touch plans, Bash syntax checks, plist lint, `git diff --check`, safety scans for destructive git/force-publish/gate-disable patterns, then the repository full script suite. Require zero failures and no production-state mtime changes.

- [ ] **Step 2: Verify deployment wiring before the first natural window**

Require clean branch/head evidence, `com.gengrowth.seo-blog` as the only nightly starter, `com.gengrowth.seo-reconcile` loaded, Codex Automation paused, legacy jobs disabled/unloaded, no stale live lock or process, and no test-shaped production sidecar.

- [ ] **Step 3: Observe 18:30 without manual kick**

Inject only a hermetic fixture or pre-approved safe canary fault before the window; do not edit a real article after the cron begins. Require stable enqueue, at most one Agent mutation, no duplicate generation, no intermediate human notification and no unsafe publish.

- [ ] **Step 4: Observe 19:00 without manual action**

Require automatic recovery of the same incident, one new reviewed SHA after repair, full gate rerun on that SHA, production publish and backfill without force-publish or operator commands.

- [ ] **Step 5: Observe 19:30 terminal convergence**

Require `activeRepairAfter=0`, `expiredLeasesAfter=0`, `pendingWritebackAfter=0`, `sheetFlipsAfter=0`, `planUncheckedAfter=0`, `eligibleNeedsHumanAfter=0`, no `human_only`/`quarantined`, one site-pure terminal summary and no duplicate notifications.

- [ ] **Step 6: Keep the goal active unless every requirement is proven**

If any count is non-zero, any evidence is missing, or fewer than three natural windows are observed, do not claim zero-touch completion and do not mark the goal complete. Fix the evidenced defect with a new RED test, rerun the affected plan task, and repeat natural acceptance.
