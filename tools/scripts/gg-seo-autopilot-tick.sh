#!/bin/bash
# gg-seo-autopilot-tick.sh — launchd entry point for the SEO autopilot (full loop).
#
# CONTINUOUS SERIAL model (2026-06-05): one author+publish cycle takes ≫25 min
# (Sonnet 4.6 xhigh write + phase2 retries + Codex/Opus review + verify gate), so a
# fixed 25-min tick was pointless — intermediate fires just hit the mutex and skipped,
# and a finished cycle waited up to ~25 min for the next boundary. Instead this script
# now LOOPS: it processes tasks back-to-back (publish a pending preview, else author
# the next task and immediately publish it) with NO inter-task wait, until the queue
# drains (nothing to publish AND nothing to author), then exits. launchd just re-fires
# periodically to restart the loop when new tasks appear or after a crash.
#
# Each cycle does at most one heavy op (publish OR author+publish). A task that PARKS
# (needs_human) is skipped on the next cycle, so one bad task never stalls the line.
#
# Single-instance: a PID-liveness mutex (macOS has no flock). A loop can legitimately
# run for hours, so the lock is NOT age-based — a re-fire only takes over if the
# recorded PID is actually dead (crash recovery), else it skips.
# Install: see com.gengrowth.seo-autopilot.plist.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/seo-autopilot-tick.prompt.md"
LOCK="/tmp/gg-seo-autopilot.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/seo_autopilot"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"

# Safety backstop on cycles per launchd fire (the PID mutex, not this, is the real
# concurrency guard). High enough to drain a normal backlog in one continuous run.
MAX_CYCLES="${GG_AUTOPILOT_MAX_CYCLES:-50}"

# ── PID-liveness mutex ──────────────────────────────────────────────────────
# A previous run still alive (its pid responds to kill -0) → skip. A dead pid
# (crash) → steal the lock and take over. This lets one fire loop for hours
# without a concurrent fire stealing the lock on an age heuristic.
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous run (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale lock (pid '${lock_pid:-?}' not alive) — taking over" >> "$LOG"
  rm -rf "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"
  exit 0
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') loop start (pid $$, max $MAX_CYCLES cycles)" >> "$LOG"

# NOTE: flow-mvp (_staging drafts) and gengrowth-ops (task plan) are BOTH kept
# current by their obsidian-git plugins (autoPullInterval=1), so the loop does NOT
# pull them itself — that would be redundant and risk fighting the plugin for the
# .git/index.lock.

# publish_if_pending — if a preview is pending (pushed/verified), run the headless
# verify+merge gate (codex best-effort + chrome + 3-subagent panel) which merges to
# prod. Returns 0 if it ran the gate, 1 if there was nothing to publish.
publish_if_pending() {
  node "$AUTO" --status 2>/dev/null | grep -Eq '"(pushed-preview|verified-preview)"' || return 1
  echo "$(date '+%F %T') preview pending → running verify+merge gate" >> "$LOG"
  # --dangerously-skip-permissions: unattended autonomy. The driver only merges
  # after the ledger is marked verified by the codex + chrome preview gate.
  # --mcp-config: headless `claude -p` does NOT auto-load the user-scoped playwright
  # MCP; load it explicitly so the chrome preview verification works.
  claude -p "$(cat "$PROMPT_FILE")" \
    --mcp-config "$SCRIPT_DIR/autopilot-mcp.json" \
    --allowedTools "Bash Skill Task Agent Read Grep mcp__playwright__browser_navigate mcp__playwright__browser_snapshot mcp__playwright__browser_console_messages mcp__playwright__browser_evaluate mcp__playwright__browser_close" \
    --dangerously-skip-permissions </dev/null >> "$LOG" 2>&1
  return 0
}

# run_one_cycle — do ONE unit of work. Returns 0 if it did something (published or
# attempted an author, incl. a park — keep looping to the next task), 1 if there was
# nothing pending and nothing to author (queue drained → idle, stop looping).
run_one_cycle() {
  # a) claim any ready draft → oracle preview branch + PR (deterministic, cheap).
  node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1

  # b) publish a pending preview if one exists (verify + merge to prod).
  if publish_if_pending; then return 0; fi

  # c) else author the next unwritten plan task, then IMMEDIATELY publish it.
  local NEXT
  NEXT="$(node "$AUTO" --next-unauthored 2>/dev/null)"
  if [ -z "$NEXT" ]; then
    return 1  # nothing to publish, nothing to author → idle
  fi

  echo "$(date '+%F %T') authoring next unwritten task" >> "$LOG"
  local AOUT
  AOUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
    export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
    # gbrain (~/.local/bin, RAG) + codex (~/.npm-global/bin, multi-party review).
    export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
    node "$AUTO" --author --limit 1 ) 2>&1 )
  printf '%s\n' "$AOUT" >> "$LOG"

  # Feishu alert on a fresh park (needs a human) or a freshly-authored draft.
  local PARK DONE
  PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
  DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
  [ -n "$PARK" ] && "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot 写稿暂停（needs_human）：$PARK"
  if [ -n "$DONE" ]; then
    "$SCRIPT_DIR/gg-lark-notify.sh" "✍️ SEO autopilot 写好一篇：$DONE— 立即发布中"
    # IMMEDIATE PUBLISH: claim+convert+preview the just-written draft, then verify+merge.
    node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1
    publish_if_pending || echo "$(date '+%F %T') authored but no preview to publish (scan/convert gate?)" >> "$LOG"
  fi
  return 0  # an author attempt (success or park) = progress; keep looping
}

# ── continuous serial loop ──────────────────────────────────────────────────
cycle=0
while [ "$cycle" -lt "$MAX_CYCLES" ]; do
  cycle=$((cycle + 1))
  echo "$(date '+%F %T') ── cycle $cycle/$MAX_CYCLES ──" >> "$LOG"
  if ! run_one_cycle; then
    echo "$(date '+%F %T') queue drained — idle after $((cycle - 1)) working cycle(s); exiting loop" >> "$LOG"
    break
  fi
done
if [ "$cycle" -ge "$MAX_CYCLES" ]; then
  echo "$(date '+%F %T') hit MAX_CYCLES=$MAX_CYCLES — exiting; launchd re-fire continues the backlog" >> "$LOG"
fi

echo "$(date '+%F %T') loop end" >> "$LOG"
