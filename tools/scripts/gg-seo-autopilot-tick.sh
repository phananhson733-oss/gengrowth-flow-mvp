#!/bin/bash
# gg-seo-autopilot-tick.sh — launchd entry point for the SEO publish autopilot.
# Fires every ~25 min; runs ONE headless claude pass that scans the ops plan,
# publishes a ready task to an oracle preview branch, verifies (codex + chrome),
# and merges to prod on pass. One task per tick = the 20–30 min publish stagger.
#
# Single-instance: a mkdir mutex (macOS has no flock) prevents overlapping ticks.
# Install: see com.gengrowth.seo-autopilot.plist (NOT auto-loaded).

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/seo-autopilot-tick.prompt.md"
LOCK="/tmp/gg-seo-autopilot.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/seo_autopilot"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"

# mutex: a tick can run long (verify waits on Vercel); skip if one is in flight.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — previous tick still running" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') tick start" >> "$LOG"

# ── 0) pull latest authored content from xdawayer GitHub before scanning ─────
# This machine is the auto-publish node; wzb authors on a separate machine and
# pushes to github.com/xdawayer/{gengrowth-flow-mvp,gengrowth-ops}. Bring the
# drafts (_staging) + the task plan current here first. SAFETY: never force or
# reset (cf. the oracle baseline incident) — every step is log-and-continue, and
# GIT_TERMINAL_PROMPT=0 makes a missing credential fail fast instead of hanging
# an unattended tick.
export GIT_TERMINAL_PROMPT=0
FLOW_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"   # gengrowth-flow-mvp (holds _staging drafts)
OPS_DIR="$HOME/gengrowth-ops"                 # holds inbox/06-tasks/tasks/*blog-output-plan*.md
PLAN_SUBDIR="inbox/06-tasks/tasks"

# Drafts: flow-mvp is also driven by the obsidian-git vault-backup plugin, so a
# concurrent commit may hold .git/index.lock — yield rather than fight it, and
# fast-forward only (a diverged local vault-backup commit defers to a later tick
# / the plugin's own pull).
if [ -e "$FLOW_DIR/.git/index.lock" ]; then
  echo "$(date '+%F %T') flow-mvp sync skipped — git index.lock held (obsidian-git busy)" >> "$LOG"
elif git -C "$FLOW_DIR" fetch --quiet origin 2>>"$LOG" \
     && git -C "$FLOW_DIR" merge --quiet --ff-only origin/main 2>>"$LOG"; then
  echo "$(date '+%F %T') flow-mvp synced @ $(git -C "$FLOW_DIR" rev-parse --short HEAD)" >> "$LOG"
else
  echo "$(date '+%F %T') flow-mvp sync skipped (diverged/locked — not fast-forward)" >> "$LOG"
fi

# Ops plan: this repo carries unrelated local WIP we deliberately don't manage.
# We only care about the task plan, so check out just that subdir from origin —
# leaves the WIP untouched, needs no clean working tree, and the autopilot claims
# ledger (.autopilot-claims.json, untracked) survives.
if git -C "$OPS_DIR" fetch --quiet origin 2>>"$LOG" \
   && git -C "$OPS_DIR" checkout --quiet origin/main -- "$PLAN_SUBDIR" 2>>"$LOG"; then
  echo "$(date '+%F %T') ops plan synced ($PLAN_SUBDIR @ origin/main)" >> "$LOG"
else
  echo "$(date '+%F %T') ops plan sync skipped (fetch/checkout failed)" >> "$LOG"
fi

AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"

# 1) Deterministic pass (no LLM cost on idle ticks): sync oracle, claim one ready
#    task, convert, build-gate, push a preview branch + PR — or stand down.
node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1

# 2) Only spend an LLM tick when there is a preview to verify or a verified
#    preview whose merge needs retry.
if node "$AUTO" --status 2>/dev/null | grep -Eq '"(pushed-preview|verified-preview)"'; then
  echo "$(date '+%F %T') preview pending → running verify+merge tick" >> "$LOG"
  # --dangerously-skip-permissions: unattended autonomy. The driver only merges
  # after the ledger is marked verified by the codex + chrome preview gate.
  # --mcp-config: headless `claude -p` does NOT auto-load the user-scoped
  # playwright MCP; load it explicitly so the chrome preview verification works.
  # </dev/null: prompt is passed as an arg, so skip the 3s stdin wait.
  claude -p "$(cat "$PROMPT_FILE")" \
    --mcp-config "$SCRIPT_DIR/autopilot-mcp.json" \
    --allowedTools "Bash Skill mcp__playwright__browser_navigate mcp__playwright__browser_snapshot mcp__playwright__browser_console_messages mcp__playwright__browser_evaluate mcp__playwright__browser_close" \
    --dangerously-skip-permissions </dev/null >> "$LOG" 2>&1
else
  echo "$(date '+%F %T') no preview to verify — idle/parked, skipping LLM tick" >> "$LOG"
fi

echo "$(date '+%F %T') tick end" >> "$LOG"
