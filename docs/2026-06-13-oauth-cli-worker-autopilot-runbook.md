---
title: OAuth CLI Worker Autopilot Runbook
date: 2026-06-13
updated: 2026-06-18
type: note
tags:
  - seo-autopilot
  - runbook
  - multisite
aliases:
  - OAuth CLI Worker Runbook
  - SEO Autopilot Runbook
---

# OAuth CLI Worker Autopilot Runbook

Operator guide for the SEO autopilot after the 2026-06-18 OAuth-CLI-worker landing
(plan v0.2 — `docs/plans/2026-06-13-oauth-cli-worker-autopilot-plan-v0.2.md`).

## What changed (vs the old loop)

The fragile headless `claude -p "$(cat seo-autopilot-tick.prompt.md)"` publish gate — which let
an unattended agent call `Bash/Edit/Write/MCP`, decide merges, and hang ~40% of the time — is
**retired**. The publish path is now a deterministic Node pipeline:

```
tick → preflight → (scan claims a ready draft → preview) → gg-preview-gate.mjs:
  preview-wait (gh deployments) → chrome verify (Playwright) → 3-dim review panel
  (astrology/schema/links-seo) → optional best-effort codex → mark-verified → merge
```

LLM CLIs (`claude -p`, `codex exec`) remain the **default, cost-saving OAuth writers/reviewers**,
but are now constrained to **text-only workers** (prompt in → Markdown/JSON out). All file writes,
validation, retries, preview verification, PR state, and Feishu notifications are done by Node.

## Topology (this machine = `awayer_mini`)

- **Lane B** — `com.gengrowth.seo-autopilot` (every 25 min): astrologywiki via the `~/oracle` repo
  + Vercel preview + GitHub merge. Driver `gg-seo-autopilot.mjs`, gate `gg-preview-gate.mjs`.
- **Lane A** — `com.gengrowth.gengrowth-publish` (hourly): gengrowth.ai via Supabase REST upsert
  (`gg-gengrowth-publish.mjs`, needs `SUPABASE_ACCESS_TOKEN` in `_gg.env`). Shares the `_staging`
  `PG-<id>-<llm>-v8.md` naming contract — a regression test (`gengrowth-invariants.smoke.test.mjs`)
  locks it so Lane B changes can't silently break Lane A.
- **Operating mode**: both lanes run `GG_AUTOPILOT_MODE=publish-only` (never author in cron). The
  planned end state consolidates authoring back onto this machine (Task 11 cutover, below).

## Paths (do NOT use `/Users/wzb/...` or `~/Code/...` here)

| What | Path |
|---|---|
| flow repo (`GG_FLOW_REPO`) | `~/gengrowth-flow-mvp` |
| oracle repo (`GG_ORACLE_DIR`) | `~/oracle` |
| ops / plans (`GG_OPS_DIR`) | `~/gengrowth-ops` |
| claims ledger | `~/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json` |
| machine env | `~/.config/gg/_gg.env` (sourced by the tick) |
| logs | `~/gengrowth-agents/cron-sync/seo_autopilot/<date>.log` |

## Daily ops

**Preflight (is the env healthy?)**
```bash
set -a; . ~/.config/gg/_gg.env; set +a
node ~/gengrowth-flow-mvp/tools/scripts/gg-autopilot-preflight.mjs            # full (incl. live claude smoke)
node ~/gengrowth-flow-mvp/tools/scripts/gg-autopilot-preflight.mjs --skip-live-cli   # cron-equivalent
```
`ok:true` exit 0 = good. Exit 2 lists missing dirs/bins. The tick runs `--skip-live-cli` at fire
start and skips the fire (with a Feishu @Ops alert) if it fails.

**Inspect in-flight / stuck claims (read-only, never mutates)**
```bash
node ~/gengrowth-flow-mvp/tools/scripts/gg-seo-autopilot.mjs --stale-report
```
Lists `active`/`pushed-preview`/`verified-preview` claims with `stage`, `lockedBy`, `leaseUntil`,
`updatedAt`, and a `stale` flag (lease in the past). A stale `active` claim = a crashed/stuck
publish; `stage` shows where it died. The report does **not** auto-reclaim — you decide.

**Handle a `needs_human` park**
1. `node gg-seo-autopilot.mjs --status` → find the `needs_human` entry + its `error`.
2. Fix the root cause (e.g. add the missing 选题登记表 row, register the author, fix the build).
3. Delete that entry from `.autopilot-claims.json` to let the next scan retry it.

**Force one safe dry-run of the gate** (no merge)
```bash
node gg-preview-gate.mjs --branch <seo/auto/...> --dry-run --json
```

## Knobs (env, all optional)

| Env | Default | Effect |
|---|---|---|
| `GG_AUTOPILOT_MODE` | `full` (plist sets `publish-only`) | `publish-only` never authors |
| `GG_USE_PROMPT_PREVIEW_GATE` | `0` | `1` = hot-rollback to the legacy `claude -p` gate for one run |
| `GG_PREVIEW_GATE_TIMEOUT` | `3600` | wall-clock backstop (s) around the node gate |
| `GG_AUTOPILOT_CLAIM_LEASE_MS` | `1800000` | claim lease length (30 min) |
| `GG_AUTHOR_REPAIR` | on | `0` disables the deterministic author-repair escalation |

## Rollback

If the deterministic gate misbehaves unattended: set `GG_USE_PROMPT_PREVIEW_GATE=1` in
`~/.config/gg/_gg.env` — the next fire falls back to the legacy prompt gate (kept verbatim). For a
permanent revert, `git revert` the gate-wiring commit. Do **not** re-enable an agentic file-editing
rescue without explicit approval (`GG_AUTHOR_REPAIR` is the text-only successor).

## Reload the crons

The launchd jobs may be unloaded. To resume:
```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.seo-autopilot.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.gengrowth-publish.plist
# stop: launchctl bootout gui/$(id -u)/com.gengrowth.seo-autopilot
```

## Open follow-ups (not yet done)

- **Task 10 — acceptance**: 3 real previews must pass `gg-preview-gate.mjs → merge` with no manual
  intervention before deleting the deprecated `seo-autopilot-tick.prompt.md`. Needs live content.
- **Task 11 — cron-authoring cutover**: flip `GG_AUTOPILOT_MODE` `publish-only → full` (authoring
  returns to this machine; wzb stops writing) — the last live change, after a soak period the
  operator picks.
- **Task 12 — Lane A active improvements**: only the guardrail invariants are locked so far.
