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
# ⚠️ NOT YET ENABLED — pending a re-/review of the orphan-reap fix. The original lane failed /review
# (do-not-enable, 2026-06-18). Fixed: the orchestrator now records each DETACHED worker's PGID to a
# pidfile (GG_AUTHOR_WORKER_PIDFILE) and this tick reaps those PGID groups INLINE on a gtimeout
# cap-hit AND on stale-takeover (precise kill -- -<pgid>, never `pkill claude`), plus a start-time
# mutex guard against PID reuse. Re-review before enabling.
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
# Validate numeric + clamp (env-controlled, but guard against option-injection / chaos config:
# a non-numeric or leading-'-' value would corrupt the gtimeout/--limit args).
case "$BATCH" in ''|*[!0-9]*) BATCH=1 ;; esac
case "$TICK_TIMEOUT" in ''|*[!0-9]*) TICK_TIMEOUT=1800 ;; esac
[ "$BATCH" -ge 1 ] 2>/dev/null || BATCH=1; [ "$BATCH" -le 10 ] 2>/dev/null || BATCH=10
[ "$TICK_TIMEOUT" -ge 60 ] 2>/dev/null || TICK_TIMEOUT=1800

# Stable path (OUTSIDE the lock dir, which the trap removes) so a dead fire's leaked worker PGIDs
# survive for the next fire's stale-takeover reap. The orchestrator appends each detached worker's
# PGID here (gated on GG_AUTHOR_WORKER_PIDFILE, set only in the author subshell below).
WORKER_PIDFILE="/tmp/gg-seo-author.workers.pgids"

# reap_worker_pgids — kill the orchestrator's DETACHED LLM-worker process GROUPS by their recorded
# PGID. Precise (never name-matching), so it can't hit an interactive Claude Code session or a
# human's manual run. Guards: skip our own pgroup, only-if-alive, and a comm check against PID reuse.
reap_worker_pgids() {
  [ -f "$WORKER_PIDFILE" ] || return 0
  local pgid comm mygrp sig
  mygrp="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  for sig in TERM KILL; do
    while read -r pgid; do
      case "$pgid" in ''|*[!0-9]*) continue ;; esac
      [ "$pgid" = "$$" ] && continue
      [ -n "$mygrp" ] && [ "$pgid" = "$mygrp" ] && continue     # NEVER kill our own process group
      kill -0 "$pgid" 2>/dev/null || continue                  # already dead
      comm="$(ps -o comm= -p "$pgid" 2>/dev/null)"
      case "$comm" in *claude*|*codex*|*gemini*|*node*) ;; *) continue ;; esac  # PID-reuse sanity guard
      kill -"$sig" "-$pgid" 2>/dev/null && echo "$(date '+%F %T') reap $sig pgroup $pgid ($comm)" >> "$LOG"
    done < "$WORKER_PIDFILE"
    [ "$sig" = "TERM" ] && sleep 2
  done
  : > "$WORKER_PIDFILE"
}

# ── PID-liveness mutex (macOS has no flock) ─────────────────────────────────
# A previous authoring fire still alive (same pid AND same start-time) → skip. A dead/recycled pid →
# steal the lock AND reap (by recorded PGID) any detached orchestrator workers it left behind (the
# orchestrator detaches LLM workers for its CPU watchdog, so a force-killed fire leaves live worker
# groups that launchd bootout never reaps).
STALE_TAKEOVER=0
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  lock_start="$(cat "$LOCK/start" 2>/dev/null)"
  cur_start=""
  [ -n "$lock_pid" ] && cur_start="$(ps -o lstart= -p "$lock_pid" 2>/dev/null | tr -s ' ')"
  # "Active" requires the pid alive AND its start-time matching what we stored — so a RECYCLED pid
  # (OS reused the dead fire's pid for an unrelated process) can't wedge authoring into a silent stall.
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null && [ -n "$lock_start" ] && [ "$cur_start" = "$lock_start" ]; then
    echo "$(date '+%F %T') skip — previous authoring fire (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale author lock (pid ${lock_pid:-?} dead/recycled) — taking over" >> "$LOG"
  STALE_TAKEOVER=1
  rm -rf "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost author mutex race" >> "$LOG"
  exit 0
fi
# trap BEFORE the pid write + on INT/TERM too, so a signal between mkdir and pid-write still cleans up.
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
echo "$$" > "$LOCK/pid"
ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' > "$LOCK/start"   # identity cookie vs PID reuse

# Reap a dead fire's orphans ONLY on stale-takeover (so we never touch a human's manual run during
# normal operation): kill the detached LLM-worker GROUPS by recorded PGID (the real fix), then the
# cheap node wrapper shells by exact script path — never a bare `pkill claude`.
if [ "$STALE_TAKEOVER" = "1" ]; then
  reap_worker_pgids
  pkill -f "$SCRIPT_DIR/gg-llm-orchestrator.mjs" 2>/dev/null
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
: > "$WORKER_PIDFILE"   # fresh per fire; the orchestrator appends each detached worker PGID here
AOUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  unset GG_AUTOPILOT_MODE
  export GG_AUTHOR_WORKER_PIDFILE="$WORKER_PIDFILE"   # → orchestrator records worker PGIDs for reaping
  export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
  # gbrain (~/.local/bin, RAG) + codex (~/.npm-global/bin, multi-party review) on PATH for authoring.
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  gtimeout "$TICK_TIMEOUT" node "$AUTO" --author --limit "$BATCH" ) 2>&1 )
_rc=$?
printf '%s\n' "$AOUT" >> "$LOG"
if [ "$_rc" -ne 0 ]; then
  # Capped/killed (rc=124) or errored — the fire is INCOMPLETE. (1) Reap the orchestrator's DETACHED
  # LLM-worker groups INLINE NOW (gtimeout only SIGTERMs the direct --author child; the detached
  # workers survive it). (2) Do NOT parse AOUT for AUTHORED/PARK — a half-written _staging draft must
  # never be announced as ready, or the publish lane would pick up a half-baked article.
  echo "$(date '+%F %T') author fire rc=$_rc (cap/err) — incomplete; reaping orphan worker groups inline" >> "$LOG"
  reap_worker_pgids
  pkill -f "$SCRIPT_DIR/gg-llm-orchestrator.mjs" 2>/dev/null
  [ "$_rc" -eq 124 ] && GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO author lane：撰写超 ${TICK_TIMEOUT}s 被硬杀，孤儿已就地清理，本炮放弃。"
else
  # Clean exit only: Feishu on a fresh park (needs a human) or a freshly-authored draft. The
  # publish-only lane picks up an authored draft on its next fire and publishes it.
  PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
  DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
  if [ -n "$PARK" ]; then
    GG_LARK_NOTIFY_AT_PM=1 GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO author lane 写稿暂停（needs_human）：$PARK"
  fi
  if [ -n "$DONE" ]; then
    "$SCRIPT_DIR/gg-lark-notify.sh" "✍️ SEO author lane 写好一篇：$DONE— 待 publish lane 发布"
  fi
fi

echo "$(date '+%F %T') author tick end (rc=$_rc)" >> "$LOG"
