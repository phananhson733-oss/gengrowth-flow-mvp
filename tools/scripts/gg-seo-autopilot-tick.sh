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

# --dangerously-skip-permissions: required for unattended autonomy. The autopilot
# only touches its own preview branches + the publish pipeline; it merges to prod
# ONLY after codex + chrome verification pass (the gate lives in the prompt).
claude -p "$(cat "$PROMPT_FILE")" \
  --dangerously-skip-permissions \
  >> "$LOG" 2>&1

echo "$(date '+%F %T') tick end (exit $?)" >> "$LOG"
