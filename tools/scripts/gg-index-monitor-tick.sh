#!/bin/bash
# gg-index-monitor-tick.sh — launchd entry point for Phase 1 index monitoring.
#
# Lightweight daily job:
#   - reads index-tracking rows from the flow-mvp workbook
#   - checks due URLs with Search Console URL Inspection
#   - writes status updates and sends Feishu alerts for overdue/problem URLs
#
# It intentionally does not author, publish, merge, or request indexing.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/index_monitor"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="/tmp/gg-index-monitor.lock"
LIMIT="${GG_INDEX_MONITOR_LIMIT:-50}"
TIMEOUT="${GG_INDEX_MONITOR_TIMEOUT:-900}"

if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous index monitor run (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  rm -rf "$LOCK" 2>/dev/null
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"
  exit 0
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') index monitor start (pid $$, limit $LIMIT)" >> "$LOG"

(
  set -a
  . "$HOME/.config/gg/_gg.env" 2>/dev/null
  set +a

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$TIMEOUT" node "$SCRIPT_DIR/gg-index-monitor.mjs" --check-due --write-sheet --require-gsc-auth --limit "$LIMIT"
  else
    node "$SCRIPT_DIR/gg-index-monitor.mjs" --check-due --write-sheet --require-gsc-auth --limit "$LIMIT"
  fi
) >> "$LOG" 2>&1
rc=$?

case "$rc" in
  0)
    echo "$(date '+%F %T') index monitor ok" >> "$LOG"
    ;;
  2|124)
    echo "$(date '+%F %T') index monitor partial/timeout rc=$rc" >> "$LOG"
    GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ 索引监控部分失败或超时（rc=$rc）。请查看 $LOG"
    ;;
  *)
    echo "$(date '+%F %T') index monitor failed rc=$rc" >> "$LOG"
    GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ 索引监控运行失败（rc=$rc）。请查看 $LOG；常见原因是 Google OAuth refresh_token 过期，需要运行 node tools/scripts/oauth-init.mjs。"
    ;;
esac

exit "$rc"
