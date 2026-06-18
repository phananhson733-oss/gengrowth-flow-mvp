#!/bin/bash
# gg-seo-author-tick.sh — SEPARATE authoring lane for the SEO autopilot.
#
# WHY a separate lane (2026-06-18, wzb's design): cron authoring is the riskiest part (a headless
# `claude -p` writing for minutes can hang). Rather than flip the publish cron's GG_AUTOPILOT_MODE
# to `full`, authoring lives in its OWN launchd job: small batch, hard-timeboxed, recoverable,
# parks-on-fail with a human fallback, and fully DECOUPLED from publishing. This tick ONLY authors
# (writes drafts to flow-mvp/_staging); the separate publish-only `seo-autopilot` lane picks up the
# ready drafts and publishes them. Authoring failures never touch the publish path.
#
# Install (DISABLED until you explicitly enable — do NOT auto-run):
#   cp tools/scripts/com.gengrowth.seo-author.plist ~/Library/LaunchAgents/
#   launchctl enable    gui/$(id -u)/com.gengrowth.seo-author
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.seo-author.plist
# Stop:
#   launchctl bootout gui/$(id -u)/com.gengrowth.seo-author
#
# Knobs: GG_AUTHOR_BATCH (default 1), GG_AUTHOR_TICK_TIMEOUT (default 1800s hard wall-clock cap).

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="/tmp/gg-seo-author.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/seo_author"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"
BATCH="${GG_AUTHOR_BATCH:-1}"
TICK_TIMEOUT="${GG_AUTHOR_TICK_TIMEOUT:-1800}"

# ── PID-liveness mutex (macOS has no flock) ─────────────────────────────────
# A previous authoring fire still alive (pid responds to kill -0) → skip. A dead pid (crash) →
# steal the lock AND reap any orphaned detached orchestrator children it left behind (the
# orchestrator double-forks/detaches for its CPU watchdog, so a force-killed fire can leave live
# `node gg-llm-orchestrator.mjs` / `--author` processes that bootout never reaped).
STALE_TAKEOVER=0
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous authoring fire (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale author lock (pid ${lock_pid:-?} dead) — taking over + reaping orphans" >> "$LOG"
  STALE_TAKEOVER=1
  rm -rf "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost author mutex race" >> "$LOG"
  exit 0
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

# Reap orphaned authoring children ONLY when we took over a dead fire's lock (so we never kill a
# human's manual orchestrator run during normal operation). Scoped to the exact script paths —
# never a broad `pkill claude` (that would kill an interactive Claude Code session).
if [ "$STALE_TAKEOVER" = "1" ]; then
  pkill -f "$SCRIPT_DIR/gg-llm-orchestrator.mjs" 2>/dev/null && echo "$(date '+%F %T') reaped orphan orchestrator(s)" >> "$LOG"
  pkill -f "$AUTO --author" 2>/dev/null
fi

echo "$(date '+%F %T') author tick start (pid $$, batch $BATCH, cap ${TICK_TIMEOUT}s)" >> "$LOG"

# Preflight — fail fast on a broken host (missing dirs/bins) with a Feishu alert, before spending
# any LLM budget. --skip-live-cli: the live claude smoke is slow/flaky unattended.
(
  set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  node "$SCRIPT_DIR/gg-autopilot-preflight.mjs" --skip-live-cli >> "$LOG" 2>&1
) || {
  GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO author lane preflight failed on Mac mini — env broken (see $LOG). Skipping this fire."
  exit 2
}

# ── author one small batch, HARD-timeboxed ──────────────────────────────────
# gtimeout bounds the whole authoring fire; the orchestrator's own CPU watchdog + per-stage
# timeouts (GG_AUTHOR_ORCH_TIMEOUT_MS) bound individual LLM calls inside it. NOTE: GG_AUTOPILOT_MODE
# must NOT be publish-only here (the driver refuses --author in publish-only) — this lane runs it
# unset so authoring is allowed; it never publishes (no --scan/--merge in this script).
AOUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  unset GG_AUTOPILOT_MODE
  export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
  # gbrain (~/.local/bin, RAG) + codex (~/.npm-global/bin, multi-party review) on PATH for authoring.
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  gtimeout "$TICK_TIMEOUT" node "$AUTO" --author --limit "$BATCH" ) 2>&1 )
_rc=$?
printf '%s\n' "$AOUT" >> "$LOG"
if [ "$_rc" -eq 124 ]; then
  echo "$(date '+%F %T') author fire hit ${TICK_TIMEOUT}s wall-clock cap — killed; next fire reaps orphans" >> "$LOG"
  GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO author lane：撰写超 ${TICK_TIMEOUT}s 被硬杀，本炮放弃（下炮会清孤儿重试）。"
fi

# Feishu on a fresh park (needs a human) or a freshly-authored draft. The publish-only lane will
# pick up an authored draft on its next fire and publish it.
PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
if [ -n "$PARK" ]; then
  GG_LARK_NOTIFY_AT_PM=1 GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO author lane 写稿暂停（needs_human）：$PARK"
fi
if [ -n "$DONE" ]; then
  "$SCRIPT_DIR/gg-lark-notify.sh" "✍️ SEO author lane 写好一篇：$DONE— 待 publish lane 发布"
fi

echo "$(date '+%F %T') author tick end (rc=$_rc)" >> "$LOG"
