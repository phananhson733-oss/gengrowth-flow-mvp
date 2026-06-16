---
title: New multi-site SEO flow — full read + launchd cron reload decision
date: 2026-06-17
type: analysis
status: draft
tags:
  - flow
  - autopilot
  - cron
  - multi-site
  - seo
---

# New multi-site SEO flow — full read + cron reload decision

Synthesis of 7 subsystem deep-reads plus live verification on this machine
(`awayer_mini`), to decide whether/how to reload the launchd `com.gengrowth.seo-autopilot`
job. **Bottom line: do NOT reload the full loop as-is. The W25 gengrowth plan now sorts
last, so the autopilot would author gengrowth B2B drafts and publish them to
www.astrologywiki.com (the astrology site). This is live, not hypothetical — passing
gengrowth drafts already sit in `_staging/`.**

---

## 1. End-to-end flow map (the NEW flow)

The pipeline has a Sheets-driven **upstream** (keyword → cluster → queue) and a
plan-markdown-driven **downstream** (task → author → publish), and the two halves are
joined only loosely by keyword, not by a shared task id.

**Upstream (per-workbook, Sheets):**
`gg-keyword-mine` fans seeds to DataForSEO → `keyword_candidates` (wzb marks
`wzb_approve=Y`) → `gg-keyword-promote` writes `关键词主表 A-I` (R-col formula auto-buckets
趋势词/快速胜利/战略词/长尾词/跳过) → `gg-cluster-init` clusters 快速胜利+长尾词 into
`主题集群表 (c-001…)` (human fills priority/week) → `gg-cluster-sync --apply` (run every
tick) syncs `keywords_included → 关键词主表 AC` (additive/idempotent) → `gg-queue-build`
JOINs master×clusters and appends `选题登记表 Status=待写`. The cluster-sync tick is the
only upstream step wired into cron.

**The join (disconnect):** the autopilot does NOT read the sheet queue to pick work. It
reads the ops **plan markdown**. `latestPlan()` globs
`~/gengrowth-ops/inbox/06-tasks/tasks/*blog-output-plan*.md`, `.sort()`s, and picks the
**last file** (one file only). `parseTasks()` regex-extracts checkbox lines
`- [ ] \`PG-XXX-NNN\` keyword`. `findSheetRow` later matches the plan's KEYWORD
(slugified) against `选题登记表`, since the sheet is keyword-indexed, not PG-id-indexed.

**Downstream (autopilot, per cycle in `gg-seo-autopilot.mjs`):**
1. `--scan --limit 1` (publish leg): `syncOracle()` hard-resets `~/oracle` to
   `origin/main` → `claimable()` gate (draft exists + `phase2Passed` via manifest
   `overall==='pass'` + valid slug + not already live) → worktree → `gg-md-to-oracle-ts`
   converts the staged md to `oracle/data/articles/<slug>.ts` → `register-index` →
   `illustrate()` (best-effort hero+inline SVG) → `npm run build` gate → commit +
   force-push branch `seo/auto/<date>-<pgId>` → `gh pr create --repo xdawayer/oracle` →
   `status=pushed-preview`.
2. `publish_if_pending()` (verify+merge gate): if a `pushed-preview`/`verified-preview`
   exists, spawn `claude -p "$(cat seo-autopilot-tick.prompt.md)"` (tick.sh:90), which
   polls the Vercel preview, runs codex (advisory), Playwright-MCP renders the
   bypass-secret preview URL, runs a 3-subagent panel; on PASS → `--mark-verified` →
   `--merge` (`gh pr merge --repo xdawayer/oracle` → prod **www.astrologywiki.com**),
   appends ops publish-log, Google index submit, Feishu 已发布.
3. else `--next-unauthored` → `--author --limit 1`: bridge → gbrain RAG →
   entity-passport → render → orchestrator (Sonnet) → phase2 (3-attempt feedback loop)
   → multi-party review (Codex+Opus) → on the park boundary, an agentic rescue spawns a
   nested `claude -p ... --dangerously-skip-permissions`.

Loop is continuous-serial up to `MAX_CYCLES` (default 50), under a PID-liveness mutex
`/tmp/gg-seo-autopilot.lock`; launchd re-fires every 1500 s (25 min, RunAtLoad=false).

**Phase-2 gate** (the binary publish gate, `_phase2-validate.mjs`): structureCheck
(SC1-SC11 + H1/H2 counts + word range + wikilink format) AND author/content red lines
RL1-RL13. `OVERALL:PASS` requires zero structure findings AND every RL `pass===true`.
PASS writes `_staging/<page_id>-<tag>.md` + `.manifest.json`; FAIL exits 11, writes
nothing. The publish leg only re-reads the manifest flag, it does not re-validate.

**Archive:** post-deploy, `gg-archive-to-vault.mjs` copies published articles into the
gengrowth-wiki Obsidian vault as enriched OFM notes for gbrain RAG (`--site/--site-host/
--url-path` knobs).

---

## 2. The two-site picture: where each is fully wired vs half-built

### astrologywiki / oracle — FULLY WIRED, end-to-end
- Upstream Sheets pipeline (FLOW_MVP workbook `1CkjOC…`), plan markdown (`PG-WC/HOUSE/
  AURA/…`), author personas (`elena-vane / julian-thorne / aditi-sharma / marcus-orion`),
  oracle red-lines (RL1-RL13 astrology profile), Definition/Pillar templates.
- Convert/publish/deploy: `gg-md-to-oracle-ts` → `oracle/data/articles/<slug>.ts` →
  register-index → `gg-publish-to-oracle.sh` (commit, human-gated push) /
  `gg-deploy-oracle.sh` (build + vercel) → **www.astrologywiki.com** `/{en,zh}/wiki/<slug>`.
- Illustration cron-integrated (best-effort, never blocks text). 110 live articles all
  illustrated (memory, 2026-06-10).
- This is the only site the autopilot can publish.

### gengrowth.ai — HALF-BUILT (validation/authoring only; no publish path)
- WIRED (drafting/validation): `GG_SITE=gengrowth` swaps the EN red-line module
  (`red-lines.gengrowth.mjs`: drops RL1/2/6/9, replaces RL8→B2B attribution-required and
  RL12→citation-integrity, RL4 drift ceiling 2→4, hyphen-insensitive), the H2 spec
  (`buildGengrowthH2Specs`, 11 B2B sections), and the template (Definition → `guide.prompt.md`,
  "GenGrowth Team" byline). `configSnapshotPath()` isolates gengrowth config under
  `.gg-cache/sites/gengrowth/`. Unit-tested at the path + red-line level.
- NOT WIRED (everything downstream of validation):
  - **No publish path.** No analogue of `gg-md-to-oracle-ts` for gengrowth. The
    gengrowth.ai blog renders from a Supabase `blog_posts` table (HTML strings,
    `lib/blog.ts`), populated only by a manual `supabase/seed-blog.sql`. No draft→post
    bridge exists in flow-mvp. Per "done means live," gengrowth can never reach done.
  - **No site-aware author routing.** `KNOWN_AUTHOR_IDS` = the 4 astrology personas; a
    gengrowth author override is rejected; unknown cluster_domains fall back to
    `marcus-orion` (an astrology persona), not park.
  - **No per-site workbook.** `resolveWorkbookId()` has no `GG_SHEETS_GENGROWTH_WORKBOOK_ID`;
    upstream always reads the oracle workbook.
  - **SC-GEO citability built but NOT wired** — no production script imports
    `checkScGeo`; weights/threshold are explicitly un-calibrated.

### Isolation quality
- The config-snapshot PATH layer is correctly isolated via `activeSite()`
  (DEFAULT_SITE='oracle', KNOWN_SITES={'gengrowth'}; unknown/empty/'oracle' → oracle).
- **Split-brain risk:** the behavior selectors in `_phase2-validate.mjs` (L35, L520) and
  `_render-aura-shared.mjs` (L314) use raw `process.env.GG_SITE === 'gengrowth'`, bypassing
  `activeSite()`. `GG_SITE=GenGrowth` (or trailing space) gets the gengrowth snapshot path
  but oracle red-lines/templates — a silent mismatch.

---

## 3. Operating model: autopilot's real role vs main-LLM authoring

Per the **only `status: canonical` doc** (`docs/FLOW-content-production-to-vault.md`,
date 2026-06-16, file mtime Jun 17 00:12), the model is:

> 本机生成不稳定的硬约束：autopilot 的 orchestrator 嵌套 `claude` CLI 在本机 ~40% 卡死。
> **撰写一律由主 LLM（Claude）/ workflow 子代理直接产出草稿**，不走 autopilot 生成。

- **AUTHORING** is done by the **main LLM / workflow subagents**, hand-running per-article
  (self-run phase2 to PASS → Codex audit → convert → illustrate → staggered deploy →
  Chrome+GSC acceptance → vault archive). NOT by the autopilot, because the nested
  `claude` CLI inside the orchestrator hangs ~40% on this machine.
- **PUBLISH** (verify+merge of pushed previews) is the autopilot's remaining intended
  role — its own plist header says "LLM is only spent when a preview needs verify+merge."

**Why the cron was deliberately disabled (~06-12):** the live tick on disk (header dated
2026-06-05) still authors inside cron via the nested `claude -p` orchestrator + agentic
rescue (`--dangerously-skip-permissions`) — the exact ~40%-hang path the canonical doc
bans. The headless `claude -p` verify+merge gate also dies with 401 when the CLI login
token expires (the #1 publish-stall cause). So the cron was unloaded to stop unattended
runs from (a) hanging on the flaky author path and (b) stalling silently on token expiry,
pending the unexecuted `docs/plans/2026-06-13-oauth-cli-worker-autopilot-plan.md` (make
the gate deterministic, retire `claude -p "$(cat prompt)"` from unattended mode, replace
agentic rescue with deterministic repair). That plan is `status: draft` and NOT executed —
the deterministic gate does not yet exist in code.

**Live state verified today (2026-06-17):**
- launchd job is NOT loaded (`launchctl list | grep seo` empty) — reload is a deliberate
  go-live action.
- `GG_SITE` is set nowhere (plist has no EnvironmentVariables; tick.sh, autopilot.mjs,
  `_gg.env` all lack it) → cron runs the oracle profile unconditionally.
- oracle repo: branch main, clean, 0 ahead / 0 behind → `syncOracle` hard-reset is a
  no-op today.
- **A working `claude` CLI now EXISTS** at `/opt/homebrew/bin/claude` (v2.1.178, installed
  Jun 17 00:26 today; `--version` rc=0). This reverses subsystem-1's "claude not installed"
  reading, which predated the install. The hard 127/not-found blocker is gone; the ~40%
  hang risk on the nested author path remains a soft concern.

### The decisive contamination finding (live, not hypothetical)
- `latestPlan()` reads ONLY the last-sorted plan file. That is now
  `2026-06-16-W25-gengrowth-blog-output-plan.md` (sorts after `2026-05-27-W22`). W22
  astrology is no longer consulted (and is 120/125 done anyway).
- `parseTasks` regex `^\s*-\s*\[( |x)\]\s*\`?(PG-[A-Z]+-\d+)\`?` DOES match the W25
  backtick lines (`- [ ] \`PG-WLS-001\` …`). So 31 gengrowth B2B tasks are live in the queue.
- These tasks are NOT in `.autopilot-claims.json` → treated as fresh.
- **Passing gengrowth drafts already exist in `_staging/`**: `PG-WLS-001-claude-v8.md`
  with `"overall": "pass"`, plus PG-WLS-002/003/004 and PG-ART-001/002/003.
- The publish leg's `claimable()` (draft exists + phase2Passed + valid slug + not live)
  is therefore satisfied for `PG-WLS-001` immediately.
- The publish/convert/deploy half has ZERO `GG_SITE` branch: `gh pr create --repo
  xdawayer/oracle`, merge to `www.astrologywiki.com`, write to `oracle/data/articles`.

**Net: a full-loop reload would, on its very first publish cycle, convert the B2B "white
label keyword research" draft into an oracle article and merge it to
www.astrologywiki.com — a gengrowth SaaS-SEO post shipped to the astrology site.**

---

## 4. Cron options (exactly one recommended)

See the `cron_options` array in the structured output for the machine-readable list with
risks. In short:

- **A. Reload the full loop as-is — DO NOT.** Cross-site contamination is live: ships
  gengrowth drafts to astrologywiki on the first cycle. Also resurrects the ~40%-hang
  author path the canonical doc bans.
- **B. Publish-only, but FIRST repoint `latestPlan` away from the gengrowth plan
  (RECOMMENDED).** Move/rename the W25 gengrowth plan out of `PLAN_GLOB_DIR` (or filter
  the glob to astrology plans), set `GG_AUTHOR_AGENTIC_RESCUE=0`, confirm `claude` login
  is fresh, then reload for oracle-only verify+merge of the remaining astrology backlog.
  Honors the canonical publish-only model and removes the contamination vector. Note: the
  publish gate still uses `claude -p "$(cat prompt)"` (the 06-13 plan's deterministic
  gate is not built), so monitor for token-401 / hang.
- **C. Leave the cron OFF; keep main-LLM/manual authoring + manual publish.** Zero
  contamination risk, fully matches canonical guidance, but no unattended coverage. Safe
  fallback if B's preconditions can't be met now.
- **D. Add a separate GG_SITE=gengrowth lane — DO NOT yet.** The gengrowth publish path,
  workbook, and author routing do not exist; this is net-new build, not a config flip.

---

## 5. Gaps blocking a safe two-site cron

1. `latestPlan()` picks the alphabetically-last plan and reads only one file; with the
   W25 gengrowth plan present it routes gengrowth tasks into the oracle publish path.
   No site/prefix routing in `parseTasks` (PG-WLS treated like PG-WC).
2. No gengrowth publish path at all: no md→post converter, no Supabase `blog_posts`
   writer, no gengrowth target repo/domain in the autopilot.
3. No `GG_SHEETS_GENGROWTH_WORKBOOK_ID` in `resolveWorkbookId()`; gengrowth upstream
   would read the oracle workbook.
4. Author routing is astrology-only (4 personas); unknown gengrowth domains fall back to
   `marcus-orion` instead of parking.
5. `GG_SITE` split-brain: behavior selectors use raw `=== 'gengrowth'` (bypassing
   `activeSite()`), so a mis-cased/space env half-switches the profile.
6. The deterministic publish gate (06-13 plan) is unbuilt; the cron still spawns
   `claude -p "$(cat seo-autopilot-tick.prompt.md)"`, which can 401 on token expiry or
   hang (no timeout wrapper on the publish-gate spawn, unlike the author rescue).
7. SC-GEO citability (the gengrowth differentiator) is built but unwired and
   un-calibrated.
8. Config snapshot is stale (mtime 2026-06-03) and the cron never runs `gg-config-sync`.
9. Path drift: deploy scripts default to `/Users/wzb/…` and some sync scripts to
   `/Users/lynne/…`; correct operation on this machine relies on env overrides
   (`GG_ORACLE_DIR` etc.).
