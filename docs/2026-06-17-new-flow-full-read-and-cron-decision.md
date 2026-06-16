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

---

## Codex 二次意见（gpt-5.5 xhigh，只读，对抗式复核）

Codex 独立读了 `gg-seo-autopilot-tick.sh` / `gg-seo-autopilot.mjs` / `lib/site-profile.mjs` /
`docs/FLOW-content-production-to-vault.md`，带 file:line 核验综合结论。**确认**了大部分，并
**纠正了两处会影响决策的过度断言**。

### Codex 确认（与综合一致）
- tick 是 **full author+publish loop**，不是 publish-only（`tick.sh:100-143`、`:31-33`、`:153-176`，MAX_CYCLES=50）。
- publish-gate 的 `claude -p "$(cat ...)"` **没有 timeout wrapper**（`tick.sh:83-94`）→ token 过期会 401、或无限挂起静默卡死。
- `latestPlan()` 只取排序最后的 `*blog-output-plan*.md`（`autopilot.mjs:184-190`），W25 gengrowth plan 排最后。
- publish 路径硬编码 oracle / xdawayer/oracle / www.astrologywiki.com（`autopilot.mjs:63-65,1090,1127,1148-1150`）。
- `GG_SITE` split-brain 真实：`activeSite()` 归一化（`site-profile.mjs:31-34`），但 `_phase2-validate.mjs:35,520-522` 和 `_render-aura-shared.mjs:312-314` 用裸 `process.env.GG_SITE==='gengrowth'`。

### Codex 纠正（综合的两处错误）
1. **"第一轮 --scan 就会把现有 gengrowth 草稿合并上线 astrologywiki" — 过度断言。** `claimable()/phase2Passed()`
   只认 `_staging/<pgId>-en.md` + `<pgId>-en.manifest.json`（`autopilot.mjs:281-289,382-383`）；磁盘上的
   gengrowth 草稿是 `PG-WLS-001-claude-v8.md`（无 `-en.md` 变体）→ **第一轮 scan 会跳过**。污染**真实但延后**：
   一旦 loop 自己的 author leg 把 PG-WLS 写成 `-en.md`，`--scan` 走 plan-task→`claimable()` 且**不调用** `findSheetRow()`
   （`autopilot.mjs:1002-1015`），passing 的 B2B "white label" 稿就会被转换并 PR/merge 到 astrologywiki。
2. **".autopilot-claims.json 空/未初始化" — 错。** ledger 在 `~/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json`（~55KB），
   不在 repo 根；目前无 PG-WLS/PG-ART 条目、无 pushed/verified-preview 条目。
- 另：author orchestrator/rescue **有** execFileSync timeout（`:478-481,:977-981`）；只有 publish-gate 的 claude -p 无界。
- 另：`--status` **非只读** —— 会 reconcile 已 merge 的 PR 并 `saveClaims()`（`:1264-1268`），"只是看看"也会改 ledger。

### Codex 最终裁决：**LEAVE DISABLED（先别重载）**
当前脚本**没有 publish-only 模式**，tick 无条件跑 `--scan → claude-p verify/merge → --author` 整个环 ——
正撞 canonical runbook 禁止的本机 autopilot 撰写路径（`FLOW-content-production-to-vault.md:18-19`）。
安全的 publish-only 重载**需要先改代码，不是配置开关**：

1. 加真正的 publish-only 硬门（如 `GG_AUTOPILOT_MODE=publish-only`：publish_if_pending 后即 idle，永不调 `--author`）。
2. 给 publish-gate 的 `claude -p` 包 `gtimeout ~1800s`（`tick.sh:90-93`）。
3. plan 选择加 `GG_AUTOPILOT_PLAN` override 或 astrology-only 过滤，别让 `latestPlan` 选中 W25 gengrowth plan。
4. reload 前置检查：launchctl 未加载、ledger 无 pushed/verified-preview、`~/oracle` clean、`claude --version` + `gh auth status` 均绿。
5. 跑 smoke：`gg-seo-autopilot.smoke` + `lib-site-profile.smoke`。

**在这个确定性门建好之前，综合里的 Option B 无法靠配置实现 → 实际塌缩为 Option C（保持关闭 / 主-LLM 手动撰写+发布）。**

### Codex 补充的、综合漏掉的风险
- 空 `authorId` 不被 author-known gate 拦（`gg-md-to-oracle-ts.mjs:438-445` vs `autopilot.mjs:1045-1048`）→ gengrowth 稿能绕过 persona 守卫。
- `checkPlanBox()/appendPublishLog()` 在 merge 后仍调 `latestPlan()`（`:1202-1207,1259`）→ 合并旧 W22 astrology 分支可能更新错的（W25 gengrowth）plan 文件。
- preview 验收 prompt 是 astrology-specific（`tick.prompt.md:33-36`，Reviewer A 审占星事实、CTA=astrologywiki），不适用 gengrowth.ai。

---

## 最终决定（2026-06-17）

**不重载 `com.gengrowth.seo-autopilot`，保持 disabled。** 这覆盖了本会话早先"重新加载+修自启"的选择 ——
全解读 + Codex 复核后证明：当前脚本只有 full-loop、没有 publish-only 模式，直接重载会(1)复活被 canonical
runbook 禁止的 ~40% 卡死撰写路径、(2)在后续周期把 W25 gengrowth B2B 稿误发到 astrologywiki、(3)publish-gate
无 timeout 会 401/挂死静默卡线。

**gengrowth.ai（第二站点）现状：撰写/校验层已接（`GG_SITE=gengrowth`），但发布层是半成品 —— 没有
draft→Supabase blog_posts 桥、没有 per-site workbook、没有站点感知作者路由、SC-GEO 未接未校准。
cron 当前完全无法把 gengrowth 发上线。**

下一步两条路（见 cron_options B/C）：要么投入做上面 5 项代码改造再开 publish-only；要么保持手动，等
`docs/plans/2026-06-13-oauth-cli-worker-autopilot-plan.md`（确定性 verify/merge worker）落地。
