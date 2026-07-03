#!/bin/bash
# gg-ledger-reconcile-tick.sh — launchd entry for the daily ledger reconcile (阶段 4).
#
# Runs at 09:05 (just after index-monitor's 09:00 so sitemap/index-tracking are fresh):
#   drainPending WAL → reconcile-published (ledger↔GitHub/live) → reconcile-status
#   (选题登记表↔sitemap, both sites) → plan-box sweep → Feishu summary on drift.
#
# ledger = 唯一权威；把三处账本拉到"落后 ≤24h"。幂等、best-effort、只在有漂移时通知。

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 重放 outbox 里发送失败的积压通知（fail-closed 补发闭环；无积压零开销）。
node "$SCRIPT_DIR/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true

LOG_DIR="$HOME/gengrowth-agents/cron-sync/ledger_reconcile"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="/tmp/gg-ledger-reconcile.lock"
TIMEOUT="${GG_LEDGER_RECONCILE_TIMEOUT:-900}"

# PID-liveness 互斥：上一轮还活着就跳过；死锁自愈。
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous reconcile (pid $lock_pid) still active" >> "$LOG"
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

TO_BIN="$(command -v gtimeout || command -v timeout || true)"
echo "$(date '+%F %T') ledger-reconcile start" >> "$LOG"
if [ -n "$TO_BIN" ]; then
  "$TO_BIN" "$TIMEOUT" node "$SCRIPT_DIR/gg-ledger-reconcile.mjs" >> "$LOG" 2>&1
  rc=$?
else
  node "$SCRIPT_DIR/gg-ledger-reconcile.mjs" >> "$LOG" 2>&1
  rc=$?
fi
if [ "$rc" = "124" ]; then
  echo "$(date '+%F %T') ledger-reconcile TIMEOUT after ${TIMEOUT}s" >> "$LOG"
fi
echo "$(date '+%F %T') ledger-reconcile done rc=$rc" >> "$LOG"
node "$SCRIPT_DIR/gg-notify.mjs" heartbeat com.gengrowth.ledger-reconcile >/dev/null 2>&1 || true  # 阶段5 lane 心跳
exit 0
