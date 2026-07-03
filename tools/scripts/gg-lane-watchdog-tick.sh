#!/bin/bash
# gg-lane-watchdog-tick.sh — launchd entry for the lane keepalive watchdog (阶段 5).
#
# 每 30min 跑：对 lanes-manifest 里每条 lane 检查 launchd 是否加载 + 最后活动是否超 maxGap，
# 违规发 lane_stale（去重）。杀"静默死亡"（审计：两 lane 被 disabled 3 天无人知）。
# 只读诊断；GG_WATCHDOG_AUTOHEAL=1 时对未加载的 lane 尝试 re-bootstrap。

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 重放 outbox 积压通知（fail-closed 补发闭环；无积压零开销）。
node "$SCRIPT_DIR/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true

LOG_DIR="$HOME/gengrowth-agents/cron-sync/lane_watchdog"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="/tmp/gg-lane-watchdog.lock"

# PID-liveness 互斥：上一轮还活着就跳过；死锁自愈。
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous watchdog (pid $lock_pid) still active" >> "$LOG"
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
if [ -n "$TO_BIN" ]; then
  "$TO_BIN" 120 node "$SCRIPT_DIR/gg-lane-watchdog.mjs" >> "$LOG" 2>&1
  rc=$?
else
  node "$SCRIPT_DIR/gg-lane-watchdog.mjs" >> "$LOG" 2>&1
  rc=$?
fi
echo "$(date '+%F %T') watchdog done rc=$rc" >> "$LOG"
exit 0
