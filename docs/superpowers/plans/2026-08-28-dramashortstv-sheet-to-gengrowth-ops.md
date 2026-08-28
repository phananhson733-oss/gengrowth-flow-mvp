---
title: DramaShortsTV Sheet-to-gengrowth-ops Implementation Plan
date: 2026-08-28
updated: 2026-08-28
type: plan
version: v1.0
status: approved
owner: wzb
tags:
  - dramashortstv
  - google-sheets
  - gengrowth-ops
  - git-delivery
aliases:
  - DramaShortsTV 实现计划
  - DramaShortsTV Sheet to Git Plan
---

# DramaShortsTV Sheet-to-gengrowth-ops Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an isolated DramaShortsTV document-delivery lane that reads one explicit Google Sheet row, generates and validates an SOP-compliant Markdown article, writes only that document to `gengrowth-ops`, and commits/pushes only that document to `phananhson733-oss/gengrowth-ops`.

**Architecture:** Add a recognized `dramashortstv` site profile plus focused pure modules for brief normalization, SOP prompt/QA, Markdown output, and Git delivery. A thin CLI composes the existing read-only Sheet bridge, a Claude-only no-tools text worker, and the Codex factual-review primitive through dependency injection so tests use fixtures and temporary Git remotes without touching the live Sheet or Ops repository.

**Tech Stack:** Node.js ESM, built-in `node:test`, existing OAuth/Sheet bridge, Claude print-mode with all tools disabled, existing `gg-codex-pr-review.mjs`, Git CLI.

## Global Constraints

- Workbook must be explicitly `1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos`; ambient workbook defaults are forbidden.
- Writing rules are authoritative from `/Users/awayer_mini/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-26-dramashortstv-blog写作SOP-v1.0.md`.
- The only business artifact is one Markdown below `/Users/awayer_mini/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/`.
- Google Sheet is read-only; no status/URL/audit writeback.
- Never generate hero, inline images, image prompts, plans, or media assets.
- Never call Oracle/GenGrowth publishers, Supabase, Vercel, sitemap, GSC, indexing, recap, or publish-history paths.
- Git delivery stages only the target Markdown, uses ordinary `push origin main`, never force-pushes, and never auto-stashes/resets/rebases/merges/cleans.
- Any unrelated Ops change, wrong remote/branch, nonzero ahead/behind, failed QA, or unverifiable remote state is fail-closed.
- All production behavior follows strict TDD: observe RED, add the minimal implementation, observe GREEN, then refactor.

---

## File Structure

- Create `tools/scripts/lib/dramashortstv-doc.mjs`: workbook/paths constants, content-type mapping, Sheet brief normalization, SOP prompt builder, deterministic QA, final Markdown formatting, output path jail, and atomic write.
- Create `tools/scripts/lib/dramashortstv-git.mjs`: Ops repository preflight, exact staging, commit/push, and remote SHA/blob verification.
- Create `tools/scripts/gg-dramashortstv-doc.mjs`: CLI parsing and orchestration of Sheet bridge, SOP, no-tools Claude generation, QA, factual review, document write, and Git delivery.
- Modify `tools/scripts/lib/site-profile.mjs`: recognize `dramashortstv` and expose its CTA host without changing Oracle/GenGrowth behavior.
- Modify `tools/scripts/__tests__/lib-site-profile.smoke.test.mjs`: cover DramaShortsTV site isolation.
- Create `tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs`: pure normalizer, prompt, QA, formatting, and path tests.
- Create `tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs`: temporary repository and bare-remote delivery tests.
- Create `tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs`: dependency-injected end-to-end CLI tests.
- Modify `tools/README.md`: document the new dry-run/apply entrypoint and its hard boundaries.

---

### Task 1: Register the DramaShortsTV site profile

**Files:**
- Modify: `tools/scripts/lib/site-profile.mjs:18-73`
- Modify: `tools/scripts/__tests__/lib-site-profile.smoke.test.mjs`

**Interfaces:**
- Consumes: `activeSite(env)`, `configSnapshotPath(repoRoot, env)`, `siteCtaHost(env)`.
- Produces: recognized site id `dramashortstv`, isolated config cache, CTA host `dramashortstv.com`.

- [ ] **Step 1: Write the failing site-profile tests**

Add assertions:

```js
test('dramashortstv resolves to its own site profile', () => {
  assert.equal(activeSite({ GG_SITE: 'dramashortstv' }), 'dramashortstv');
  assert.equal(
    configSnapshotPath(ROOT, { GG_SITE: 'dramashortstv' }),
    join(ROOT, '.gg-cache', 'sites', 'dramashortstv', 'config-snapshot.json'),
  );
  assert.equal(siteCtaHost({ GG_SITE: 'dramashortstv' }), 'dramashortstv.com');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tools/scripts/__tests__/lib-site-profile.smoke.test.mjs
```

Expected: FAIL because `activeSite()` returns `oracle` and CTA host is `astrologywiki.com`.

- [ ] **Step 3: Add the minimal profile**

Change the constants to:

```js
export const KNOWN_SITES = new Set(['gengrowth', 'dramashortstv']);

const SITE_CTA_HOST = {
  oracle: 'astrologywiki.com',
  gengrowth: 'gengrowth.ai',
  dramashortstv: 'dramashortstv.com',
};
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same test command. Expected: all tests pass, including unchanged Oracle/GenGrowth cases.

- [ ] **Step 5: Commit the task**

```bash
git add -- tools/scripts/lib/site-profile.mjs tools/scripts/__tests__/lib-site-profile.smoke.test.mjs
git commit -m "feat: register DramaShortsTV site profile"
```

---

### Task 2: Implement pure brief normalization, SOP prompt, QA, and document formatting

**Files:**
- Create: `tools/scripts/lib/dramashortstv-doc.mjs`
- Create: `tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs`

**Interfaces:**
- Produces `DRAMA_WORKBOOK_ID`, `normalizeDramaBrief(payload)`, `buildDramaPrompt({ brief, sopText })`, `validateDramaDraft({ markdown, contentType })`, `formatDramaDocument({ draft, brief, date })`, `resolveDramaOutputPath({ opsDir, date, topicSlug })`, and `atomicWriteDramaDocument({ targetPath, content })`.
- `normalizeDramaBrief()` returns `{ pageId, contentType, targetKeyword, associatedKeywords, entity, friction, logic, contentAngle, clusterId, pageRole, template, sourceRow, notes }`.

- [ ] **Step 1: Write failing normalization tests**

Use a Sheet-bridge fixture shaped like the verified row 4 payload and assert:

```js
const brief = normalizeDramaBrief({
  page_dramabox_vs_reelshort: {
    page_id: 'page_dramabox_vs_reelshort',
    target_keyword: 'dramabox vs reelshort',
    associated_keywords: ['best short drama apps'],
    entity: 'DramaBox vs ReelShort',
    cluster_id: 'clu_app_profiles',
    page_role: 'Support',
    template: 'Comparison',
    content_angle: 'Real developer identity and cancellation complaints',
    tier_gate_block: 'astrology-only text',
    rl6_hint: 'interpretive framework',
    friction_themes: [{ scrubbed_quote: 'Users fear cancellation traps' }],
  },
});
assert.equal(brief.contentType, 'comparison');
assert.equal(brief.pageId, 'page_dramabox_vs_reelshort');
assert.deepEqual(brief.associatedKeywords, ['best short drama apps']);
assert.doesNotMatch(JSON.stringify(brief), /interpretive framework|tier_gate_block/);
```

Add failures for missing `cluster_id`, unknown template mapping, and parentheses-only actor keyword notes.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement constants, mapping, and normalization**

Implement these exact mappings:

```js
export const DRAMA_WORKBOOK_ID = '1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos';
export const DRAMA_OUTPUT_SUBDIR = 'inbox-maboyang/05-blog/dramashortstv';

export function contentTypeFor({ clusterId, template }) {
  if (clusterId === 'clu_app_trust' && template === 'Definition') return 'safety-guide';
  if (clusterId === 'clu_app_profiles' && template === 'Definition') return 'app-profile';
  if (template === 'Comparison') return 'comparison';
  if (template === 'Brand Playlist') return 'brand-playlist';
  if (clusterId === 'clu_actor_gallery' && template === 'Case Study') return 'actor-profile';
  if (['Reader Bridge', 'Topic Hub'].includes(template)) return 'reader-bridge';
  throw new Error(`unsupported DramaShortsTV content mapping: ${clusterId}/${template}`);
}
```

Strip `tier_gate_block`, `rl6_hint`, author routing, and CTA placeholders. Filter Associated Keywords whose normalized text is parenthetical metadata or contains `不在`, `仅供参考`, `未找到`, `数据` without a real keyword.

- [ ] **Step 4: Write failing prompt and QA tests**

Assert the prompt contains the entire supplied SOP text plus a machine-readable brief block, explicitly says no images/site publishing, and does not contain Oracle/GenGrowth tier-gate prose.

Add one test per blocking QA condition:

```js
assert.equal(validateDramaDraft({ markdown: goodComparison, contentType: 'comparison' }).ok, true);
assert.match(validateDramaDraft({ markdown: `${goodComparison}\nfree coins`, contentType: 'comparison' }).errors.join('\n'), /piracy/i);
assert.match(validateDramaDraft({ markdown: actorWithoutQualifier, contentType: 'actor-profile' }).errors.join('\n'), /same-name qualifier/i);
assert.match(validateDramaDraft({ markdown: draftWithImage, contentType: 'comparison' }).errors.join('\n'), /image/i);
```

- [ ] **Step 5: Verify prompt/QA tests fail for missing behavior**

Run the focused test and confirm failures name missing `buildDramaPrompt`/`validateDramaDraft` behavior.

- [ ] **Step 6: Implement prompt builder and deterministic QA**

`buildDramaPrompt()` must concatenate:

1. task boundary;
2. complete SOP text;
3. normalized brief JSON;
4. content-type instruction;
5. output-only Markdown contract;
6. no-image/no-site/no-placeholder rules.

`validateDramaDraft()` must check H1, SOP-specific required sections, paragraph length, FAQ formatting when the type requires FAQ, piracy terms, raw placeholders, image syntax/HTML, sourced factual numbers, and actor qualifier in H1/first paragraph.

- [ ] **Step 7: Write failing formatting/path/atomic-write tests**

Assert:

```js
const out = formatDramaDocument({ draft: goodComparison, brief, date: '2026-08-28' });
assert.match(out, /^---\ntitle:/);
assert.match(out, /updated: 2026-08-28/);
assert.equal((out.match(/^# /gm) || []).length, 1);
assert.throws(() => resolveDramaOutputPath({ opsDir: '/tmp/ops', date: '2026-08-28', topicSlug: '../escape' }), /unsafe/);
```

Use a temporary directory to prove same bytes are idempotent and different existing bytes refuse overwrite.

- [ ] **Step 8: Implement formatting, path jail, and atomic write**

`formatDramaDocument()` adds Obsidian frontmatter without changing body structure. `resolveDramaOutputPath()` uses `realpath`-safe containment under `DRAMA_OUTPUT_SUBDIR`. `atomicWriteDramaDocument()` writes a sibling temporary file, fsyncs it, and renames only when the target does not exist.

- [ ] **Step 9: Run focused tests and verify GREEN**

Run the focused test. Expected: all cases pass with no warnings.

- [ ] **Step 10: Commit the task**

```bash
git add -- tools/scripts/lib/dramashortstv-doc.mjs tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs
git commit -m "feat: add DramaShortsTV document contract"
```

---

### Task 3: Implement fail-closed document-level Git delivery

**Files:**
- Create: `tools/scripts/lib/dramashortstv-git.mjs`
- Create: `tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs`

**Interfaces:**
- Produces `preflightDramaOpsRepo({ opsDir, expectedRemote, runGit })` and `commitAndPushDramaDocument({ opsDir, relativePath, topicSlug, runGit })`.
- Returns `{ status, commitSha, remoteSha, relativePath, blobSha }` where status is `delivered` or `already-delivered`.

- [ ] **Step 1: Write failing preflight tests**

Build temporary repositories and assert rejection of wrong branch, wrong fetch/push remote, dirty worktree, staged-only changes, and nonzero `HEAD...origin/main`.

```js
await assert.rejects(
  () => preflightDramaOpsRepo({ opsDir: dirtyRepo, expectedRemote: remoteUrl }),
  /worktree.*clean/i,
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement read-only Git preflight**

Use `execFileSync('git', ['-C', opsDir, ...args])` only. Fetch origin, resolve branch and URLs, require exact `0\t0` divergence, and require empty porcelain including staged/untracked changes. Do not run any mutating repair command.

- [ ] **Step 4: Write failing exact-delivery tests**

Create a clean temporary repo plus bare `origin`, add one article, and assert:

- only the target path is staged;
- commit message is `content(dramashortstv): add <topic-slug>`;
- ordinary push succeeds;
- local/remote SHA and blob SHA match;
- an unrelated file appearing after preflight stops before commit;
- push rejection keeps the local commit;
- identical already-remote bytes return `already-delivered` without an empty commit.

- [ ] **Step 5: Verify delivery tests fail before implementation**

Run the focused test and confirm missing function failures.

- [ ] **Step 6: Implement exact stage/commit/push/readback**

Before staging, require porcelain to contain exactly `?? <relativePath>` or ` M <relativePath>`. Run `git diff --check -- <path>`, `git add -- <path>`, then require cached names equal exactly one path. Commit, ordinary push `origin main`, compare `rev-parse HEAD` with `ls-remote origin refs/heads/main`, and compare local/remote blob hashes.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the focused Git test. Expected: all temporary-repository cases pass.

- [ ] **Step 8: Commit the task**

```bash
git add -- tools/scripts/lib/dramashortstv-git.mjs tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs
git commit -m "feat: add exact DramaShortsTV Git delivery"
```

---

### Task 4: Build the dependency-injected single CLI

**Files:**
- Create: `tools/scripts/gg-dramashortstv-doc.mjs`
- Create: `tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs`

**Interfaces:**
- Produces `parseDramaArgs(argv)` and `runDramaShortsDelivery(args, deps)`.
- Real dependencies call `gg-sheet-to-brief.mjs`, a repo-isolated Claude text worker, `gg-codex-pr-review.mjs`, the document module, and Git module.
- Dry-run returns `{ mode: 'dry-run', brief, targetPath, contentType }` without creating files or invoking LLM/Git.

- [ ] **Step 1: Write failing CLI argument tests**

Assert explicit workbook, exactly one selector, and default dry-run:

```js
assert.throws(() => parseDramaArgs([]), /--workbook/);
assert.throws(() => parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4', '--page-id', 'x']), /exactly one/);
assert.equal(parseDramaArgs(['--workbook', DRAMA_WORKBOOK_ID, '--row', '4']).apply, false);
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
node --test tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs
```

Expected: module-not-found failure.

- [ ] **Step 3: Implement argument parser and dry-run orchestration**

Supported flags are `--workbook`, exactly one of `--row`/`--page-id`, `--model` default `claude`, `--apply`, and `--json`. Reject unknown workbook and unsafe selectors. Dry-run invokes only the read-only Sheet dependency, normalizes the brief, and prints the planned target.

- [ ] **Step 4: Write failing apply orchestration test**

Inject fake dependencies recording call order and assert:

```js
assert.deepEqual(calls, [
  'sheet', 'normalize', 'git-preflight', 'sop', 'prompt', 'generate',
  'qa', 'factual-review', 'format', 'write', 'git-deliver',
]);
```

Also assert QA/factual failure prevents write/Git and no dependency named Oracle, GenGrowth, image, Vercel, Supabase, sitemap, or indexing is called.

- [ ] **Step 5: Verify apply orchestration test RED**

Run the focused test and confirm the call order is incomplete.

- [ ] **Step 6: Implement real orchestration**

The real Sheet dependency runs:

```bash
GG_SITE=dramashortstv node tools/scripts/gg-sheet-to-brief.mjs \
  --workbook <id> --row <n> --dry-run --allow-missing-cta
```

The generator writes prompt/draft only below `.gg-cache/sites/dramashortstv/<page_id>/` and invokes Claude in print mode from the repo-isolated worker cwd with `--tools ""`, safe-mode, no-chrome, strict empty MCP config, `dontAsk`, and no session persistence. Only `--model claude` is accepted at the public CLI. The factual reviewer runs `node gg-codex-pr-review.mjs --source <draft>` and accepts only an exit-0 line-anchored `VERDICT: PASS`.

- [ ] **Step 7: Run CLI tests and verify GREEN**

Run focused CLI and module tests. Expected: all pass.

- [ ] **Step 8: Commit the task**

```bash
git add -- tools/scripts/gg-dramashortstv-doc.mjs tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs
git commit -m "feat: add DramaShortsTV Sheet-to-Git CLI"
```

---

### Task 5: Document, integrate, and verify the complete lane

**Files:**
- Modify: `tools/README.md`
- Test: all files from Tasks 1-4

**Interfaces:**
- Documents the final CLI and proof contract.
- Produces a fully regression-tested implementation ready for branch completion review.

- [ ] **Step 1: Write a failing README contract test**

Add to `gg-dramashortstv-doc.smoke.test.mjs`:

```js
test('tools README documents DramaShortsTV hard boundaries', () => {
  const readme = readFileSync(join(ROOT, 'tools', 'README.md'), 'utf8');
  assert.match(readme, /gg-dramashortstv-doc\.mjs/);
  assert.match(readme, /Google Sheet.*read-only/i);
  assert.match(readme, /no hero|不生成.*图片/i);
  assert.match(readme, /phananhson733-oss\/gengrowth-ops/);
});
```

- [ ] **Step 2: Run focused test and verify RED**

Expected: README assertions fail.

- [ ] **Step 3: Add concise README usage**

Document dry-run and apply commands, explicit workbook requirement, exact output directory, SOP path, no-image/no-site boundary, fail-closed Git behavior, and evidence fields.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
node --test \
  tools/scripts/__tests__/lib-site-profile.smoke.test.mjs \
  tools/scripts/__tests__/lib-dramashortstv-doc.smoke.test.mjs \
  tools/scripts/__tests__/lib-dramashortstv-git.smoke.test.mjs \
  tools/scripts/__tests__/gg-dramashortstv-doc.smoke.test.mjs
```

Expected: all focused tests pass.

- [ ] **Step 5: Run syntax and repository checks**

```bash
node --check tools/scripts/gg-dramashortstv-doc.mjs
node --check tools/scripts/lib/dramashortstv-doc.mjs
node --check tools/scripts/lib/dramashortstv-git.mjs
git diff --check
```

Expected: all exit 0 with no output.

- [ ] **Step 6: Run the full test suite**

```bash
node --test 'tools/scripts/__tests__/*.test.mjs'
```

Expected: 0 failures. If the baseline contains a pre-existing failure, reproduce it unchanged on the base commit before proceeding.

- [ ] **Step 7: Run a real read-only Sheet dry-run**

```bash
node tools/scripts/gg-dramashortstv-doc.mjs \
  --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos \
  --row 4 --json
```

Expected: JSON reports `mode=dry-run`, `pageId=page_dramabox_vs_reelshort`, `contentType=comparison`, the planned Ops path, and no local/remote writes.

- [ ] **Step 8: Verify protected repositories remain unchanged**

```bash
git -C /Users/awayer_mini/gengrowth-ops status --short --branch
git -C /Users/awayer_mini/oracle status --short --branch
```

Expected: the same states observed before testing; no generated article or media files.

- [ ] **Step 9: Commit documentation and final integration**

```bash
git add -- tools/README.md
git commit -m "docs: document DramaShortsTV document lane"
```

- [ ] **Step 10: Review final branch scope**

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected: only the planned site-profile, DramaShortsTV modules/tests, and README paths. No Oracle/GenGrowth publisher or media files.
