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
- **Author lane** — `com.gengrowth.seo-author` (every 2h): the ONLY lane that authors. Writes drafts
  into `_staging`; the publish lanes pick them up. Decoupled, small-batch, hard-timeboxed,
  parks-on-fail. Driver `gg-seo-author-tick.sh` → `gg-seo-autopilot.mjs --author`. See below.
- **Operating mode**: Lane A + Lane B run `GG_AUTOPILOT_MODE=publish-only` (never author in cron);
  authoring is isolated in the separate author lane above. This replaces the old publish-only→full
  flip — authoring failures can never touch the publish path.

## Author lane (`com.gengrowth.seo-author`) — separate, decoupled authoring

Authoring is the riskiest leg (a headless `claude -p` can run for minutes / hang), so it lives in its
OWN launchd job instead of flipping the publish lane to `full`. It ONLY writes drafts into `_staging`
(`gg-seo-author-tick.sh` → `gg-seo-autopilot.mjs --author --limit N`); the publish-only lanes pick
them up and publish. Small batch, hard-timeboxed, parks-on-fail with a Feishu @PM/@Ops alert.

- **Interval** `StartInterval=7200` (2h). **Knobs**: `GG_AUTHOR_BATCH` (default 1, clamped 1..10),
  `GG_AUTHOR_TICK_TIMEOUT` (default 1800s hard wall-clock cap). `RunAtLoad=false` — loading never
  instantly authors; kickstart the first fire by hand.
- **Logs**: `~/gengrowth-agents/cron-sync/seo_author/<date>.log`.
- **Install / enable** (supervise the first article):
  ```bash
  cp ~/gengrowth-flow-mvp/tools/scripts/com.gengrowth.seo-author.plist ~/Library/LaunchAgents/
  launchctl enable    gui/$(id -u)/com.gengrowth.seo-author
  launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.seo-author.plist
  launchctl kickstart gui/$(id -u)/com.gengrowth.seo-author    # watch the first article
  ```
- **Stop** (attended — see the operator-stop limitation below):
  ```bash
  launchctl bootout gui/$(id -u)/com.gengrowth.seo-author
  ```

**Orphan cleanup**: workers are spawned detached (own session). The orchestrator traps SIGTERM/INT/HUP
and group-SIGKILLs its in-flight workers before exiting, so a gtimeout cap-hit (the automatic
unattended path) reaps cleanly — verified control-vs-fix with real gtimeout, on every spawn path incl.
prompt-read-fail. The tick does NOT reap groups itself (a prior bash-reap was do-not-enable'd twice for
PGID-reuse risk).

**KNOWN LIMITATION — operator-stop (accepted 2026-06-18)**: on a MANUAL `launchctl bootout` / stop,
launchd SIGTERMs only the bash wrapper (whose trap can't forward TERM to node mid-foreground-command),
then SIGKILLs the job group — so the orchestrator can die by uncatchable SIGKILL before its handler
runs, briefly orphaning detached workers. Rare (only mid-authoring), self-limiting (a worker finishes
in minutes), and attended (the operator who stopped it is present). If a stop ever leaves strays:
`pkill -f gg-llm-orchestrator` (plus any leftover `claude`/`codex` worker). Revisit with a per-worker
self-timeout only if it ever actually bites.

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
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.seo-author.plist
# stop: launchctl bootout gui/$(id -u)/com.gengrowth.seo-autopilot   (also: …/gengrowth-publish, …/seo-author)
```
If a job was `launchctl disable`'d (not just bootout), `launchctl enable gui/$(id -u)/<label>` FIRST,
else bootstrap throws errno-5 (EIO).

## Open follow-ups (not yet done)

- **Task 10 — acceptance**: 3 real previews must pass `gg-preview-gate.mjs → merge` with no manual
  intervention before deleting the deprecated `seo-autopilot-tick.prompt.md`. Needs live content.
- **Task 11 — authoring on this machine**: done via the separate `com.gengrowth.seo-author` lane
  (above) instead of a publish-only→full flip — decoupled, small-batch, leased, parks-on-fail. The
  publish lanes stay `publish-only`. Remaining: a soak period to confirm the 2h cadence + batch size.
- **Task 12 — Lane A active improvements**: only the guardrail invariants are locked so far.
