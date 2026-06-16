---
title: Multi-site publish-only cron — staged plan (astrologywiki + gengrowth.ai)
date: 2026-06-17
type: plan
status: draft
tags: [flow, autopilot, cron, multi-site, gengrowth, astrologywiki]
---

# Multi-site publish-only cron — staged plan

Goal (user, 2026-06-17): 最终把 cron 设置好，让两个站点都跑通自动发布。
- gengrowth.ai → W25 plan (`2026-06-16-W25-gengrowth-blog-output-plan.md`)
- astrologywiki.com → W22 plan (`2026-05-27-W22-blog-output-plan.md`)

## Hard constraints (from the 06-17 full-read + Codex review)
- **Cron = PUBLISH ONLY.** The canonical runbook (`docs/FLOW-content-production-to-vault.md`)
  bans autopilot AUTHORING on this machine (nested `claude` CLI hangs ~40%). Authoring stays
  with the main LLM / workflow / wzb. The cron only publishes already-ready drafts.
- The two sites have **very different publish targets**, so they are **two lanes**, not one path:
  - astrologywiki/oracle: draft → `gg-md-to-oracle-ts` → `oracle/data/articles/<slug>.ts` → PR → Vercel build → merge to prod (preview + verify gate).
  - gengrowth.ai: draft → `gg-md-to-gengrowth-blog.mjs --emit rest` → Supabase `blog_posts` upsert → **live immediately** (no PR/preview/build).
- "done = live" verification must hit the source of truth, not the rendered page
  (gengrowth `blog.ts` falls back to MOCK on empty/error; verify via privileged REST query).

## Current state (2026-06-17)
- ✅ gengrowth publish primitive built + verified: `gg-md-to-gengrowth-blog.mjs` (`--emit rest`/`sql`),
  pillar=`seo_content`, idempotent upsert on (slug,locale). supabase CLI flow 通畅 (2.106:
  `projects api-keys` → service_role → REST 200). All 7 W25 SEO posts + others already LIVE (17 published).
- ✅ oracle publish path exists (the disabled autopilot's `--scan`/publish leg).
- ⚠️ The launchd `com.gengrowth.seo-autopilot` is **disabled** and, as-is, is full-loop +
  oracle-hardcoded + picks the last-sorted plan (would grab the W25 gengrowth plan) + no timeout
  on the publish-gate `claude -p`. Reloading as-is is unsafe (see `2026-06-17-new-flow-full-read-and-cron-decision.md`).

## Lane A — gengrowth.ai (NEW, simple, low-risk)
A small publish-only ticker, independent of the risky oracle autopilot.

1. **`gg-gengrowth-publish.mjs`** (new): scan `_staging/PG-*-<llm>-v8.md` for the gengrowth site
   (page_id prefixes in the W25 plan) whose manifest `overall==='pass'`; for each, call the bridge
   `--emit rest` (idempotent upsert). Optional: skip if already live + content-hash unchanged.
2. **Auth**: fetch service_role per-run via `supabase projects api-keys --project-ref qeeocwurjslqppjxlsbk
   -o json | _emit-sb-key.mjs` → `SB_KEY`. **Reliability risk (unattended)**: the supabase access token
   (from `supabase login`) must be valid + keychain-accessible from launchd. Treat like the Google-cookie
   case: on auth failure, skip + alert (never crash). Decision needed: persist `SUPABASE_ACCESS_TOKEN`
   in `~/.config/gg/_gg.env` for headless use vs rely on the login keychain.
3. **Verify**: REST GET the slug, assert status='published' + content length.
4. **Schedule**: `com.gengrowth.gengrowth-publish.plist` (launchd, ~30–60 min, `RunAtLoad=true`,
   single-instance mutex). Best-effort, fail-safe.

## Lane B — astrologywiki.com (existing autopilot, RISKY — needs safety fixes first)
Do NOT reload as-is. Required before re-enabling (per Codex):
1. `GG_AUTOPILOT_MODE=publish-only` hard gate: after `publish_if_pending`, idle; never call
   `--next-unauthored`/`--author`.
2. Wrap the publish-gate `claude -p "$(cat ...)"` in `gtimeout ~1800s` (tick.sh:90-93).
3. Plan selection: `GG_AUTOPILOT_PLAN` override or astrology-only glob filter so `latestPlan()`
   never picks the W25 gengrowth plan.
4. Pre-reload checks: launchctl not loaded, no pushed/verified-preview in the claims ledger,
   `~/oracle` clean, `claude --version` + `gh auth status` green; add `RunAtLoad`/keep enabled.
5. Run smoke tests; then `launchctl load -w`.
Note: W22 astrology is ~120/125 done — little left to publish, so Lane B is lower urgency.

## Cross-cutting: unattended auth reliability
Two session-bound secrets gate unattended publishing:
- gengrowth: supabase access token (this machine, just logged in).
- (illustration, oracle): Google/Gemini session cookie.
Both expire. The cron must fail-safe + alert (Feishu) on auth loss, never silently stall.

## Suggested order
1. Lane A script `gg-gengrowth-publish.mjs` (manual-run + dry-run first; idempotent).
2. Verify Lane A end-to-end against a fresh draft (or idempotent re-publish).
3. Lane A launchd scheduling (after the unattended-auth decision).
4. Lane B autopilot safety fixes (publish-only + timeout + plan filter) → reload.
