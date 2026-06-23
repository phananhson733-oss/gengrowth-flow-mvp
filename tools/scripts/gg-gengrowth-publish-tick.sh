#!/bin/bash
# gg-gengrowth-publish-tick.sh — launchd entry for LANE A (gengrowth.ai publish ticker).
#
# Publish-only: scans ready gengrowth drafts and upserts the not-yet-live ones to the
# gengrowth.ai blog (Supabase blog_posts) via gg-gengrowth-publish.mjs --apply. Idempotent;
# live posts are skipped. Fetches the service_role key per-run via the supabase CLI (never
# stored on disk). Fail-safe: missing auth / no work / errors never crash — just log + alert.
#
# INSTALL (run yourself):
#   cp tools/scripts/com.gengrowth.gengrowth-publish.plist ~/Library/LaunchAgents/
#   launchctl load -S Background -w ~/Library/LaunchAgents/com.gengrowth.gengrowth-publish.plist
# STOP:
#   launchctl unload ~/Library/LaunchAgents/com.gengrowth.gengrowth-publish.plist

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="/tmp/gg-gengrowth-publish.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/gengrowth-publish"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
SB_PROJECT_REF="qeeocwurjslqppjxlsbk"
export SB_URL="https://${SB_PROJECT_REF}.supabase.co"

# ── PID-liveness mutex (same pattern as the SEO autopilot) ───────────────────
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous run (pid $lock_pid) still active" >> "$LOG"; exit 0
  fi
  rm -rf "$LOCK" 2>/dev/null
fi
mkdir "$LOCK" 2>/dev/null || { echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"; exit 0; }
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') gengrowth-publish tick start (pid $$)" >> "$LOG"
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a

# Fetch the service_role key via the authenticated supabase CLI (not stored on disk).
SB_KEY="$(supabase projects api-keys --project-ref "$SB_PROJECT_REF" -o json 2>/dev/null | node "$SCRIPT_DIR/oneoff/_emit-sb-key.mjs" 2>/dev/null)"
if [ -z "$SB_KEY" ]; then
  echo "$(date '+%F %T') SB_KEY unavailable (supabase session expired?) — skipping this tick" >> "$LOG"
  GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ gengrowth 发布 ticker：supabase 会话取不到 service_role，本轮跳过。重登：supabase login" >/dev/null 2>&1 || true
  exit 0
fi
export SB_KEY

# Serial cadence (parity with Lane B): publish at most N per hourly tick so a backlog
# drip-feeds instead of dumping all at once. Override via GG_GENGROWTH_PUBLISH_LIMIT.
node "$SCRIPT_DIR/gg-gengrowth-publish.mjs" --apply --limit "${GG_GENGROWTH_PUBLISH_LIMIT:-1}" >> "$LOG" 2>&1
echo "$(date '+%F %T') gengrowth-publish tick end (rc=$?)" >> "$LOG"
