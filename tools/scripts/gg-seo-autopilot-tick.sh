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

# NOTE: flow-mvp (_staging drafts) and gengrowth-ops (task plan) are BOTH kept
# current by their obsidian-git plugins (autoPullInterval=1 → pull every ~1 min,
# pullBeforePush=true), so the tick does NOT pull them itself — that would be
# redundant and risk fighting the plugin for .git/index.lock.

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
  # 3) No preview pending → spend this tick AUTHORING the next unwritten plan task.
  #    Deterministic chain (bridge→RAG→render→orchestrator→phase2); the orchestrator
  #    spends the Opus $, every other stage is glue. --author self-gates (cheap exit
  #    if nothing needs authoring) and PARKS needs_human on any stage failure, so a
  #    broken task is skipped next tick instead of re-burning an LLM call. The fresh
  #    draft is claimed + published by the NEXT tick's --scan above — one heavy LLM
  #    op per tick (verify OR author, never both). Authoring needs Sheets creds.
  if [ -n "$(node "$AUTO" --next-unauthored 2>/dev/null)" ]; then
    echo "$(date '+%F %T') no preview → authoring next unwritten task" >> "$LOG"
    ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
      export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
      node "$AUTO" --author --limit 1 ) >> "$LOG" 2>&1
  else
    echo "$(date '+%F %T') no preview, nothing to author — idle" >> "$LOG"
  fi
fi

echo "$(date '+%F %T') tick end" >> "$LOG"
