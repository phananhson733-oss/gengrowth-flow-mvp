#!/bin/bash
# gg-flow-driver-tick.sh — overlay driver lane（P1.6）。**默认安全**：默认 dry-run(只打印计划)，只有
# GG_FLOW_DRIVER_APPLY=1 才 --apply(接侧效：archive 记 sidecar / fix→重过门→可能 merge)。搭配 plist
# RunAtLoad=false + 人工灰度。跑完把 driver 的 FLOW_DRIVER_SUMMARY 行(仅有终态时有)relay 一条飞书；
# 无终态 → 静默不发(符合"只发终态一条汇总")。
#
# 灰度(见 com.gengrowth.flow-driver.plist 头注)：load 后先 dry-run 观察一轮 → 确认计划无误 →
# 在 ~/.config/gg/_gg.env 加 GG_FLOW_DRIVER_APPLY=1 → kickstart 上线。
#
# Knobs: GG_FLOW_DRIVER_APPLY(=1 接侧效,默认 dry-run) · GG_FLOW_DRIVER_MAX_FIX(默1)/MAX_ARCHIVE(默5) ·
#        GG_FLOW_DRIVER_TICK_TIMEOUT(默1800s) · GG_FLOW_DRIVER_LOCK(默 /tmp/gg-flow-driver.lock)。

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCK="${GG_FLOW_DRIVER_LOCK:-/tmp/gg-flow-driver.lock}"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/flow_driver"; mkdir -p "$LOG_DIR" 2>/dev/null
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
TICK_TIMEOUT="${GG_FLOW_DRIVER_TICK_TIMEOUT:-1800}"
case "$TICK_TIMEOUT" in ''|*[!0-9]*) TICK_TIMEOUT=1800 ;; esac
[ "$TICK_TIMEOUT" -ge 30 ] 2>/dev/null || TICK_TIMEOUT=1800

# mkdir 互斥 + pid/lstart identity cookie + stale-takeover(仿 author tick,防并发 + PID 复用)
if [ -d "$LOCK" ]; then
  lp="$(cat "$LOCK/pid" 2>/dev/null)"; ls_="$(cat "$LOCK/start" 2>/dev/null)"
  cs=""; [ -n "$lp" ] && cs="$(ps -o lstart= -p "$lp" 2>/dev/null | tr -s ' ')"
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null && [ -n "$ls_" ] && [ "$cs" = "$ls_" ]; then
    echo "$(date '+%F %T') skip — prev flow-driver fire (pid $lp) active" >> "$LOG"; exit 0
  fi
  echo "$(date '+%F %T') stale flow-driver lock (pid ${lp:-?}) — taking over" >> "$LOG"
  rm -rf "$LOCK" 2>/dev/null
fi
mkdir "$LOCK" 2>/dev/null || { echo "$(date '+%F %T') skip — lost flow-driver mutex" >> "$LOG"; exit 0; }
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
echo "$$" > "$LOCK/pid"; ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' > "$LOCK/start"

APPLY_FLAG=""; [ "$GG_FLOW_DRIVER_APPLY" = "1" ] && APPLY_FLAG="--apply"
echo "$(date '+%F %T') flow-driver tick start (pid $$, ${APPLY_FLAG:-dry-run})" >> "$LOG"

# _gg.env 里是 30 个 bare KEY=(无 export)——必须 set -a 才对子进程可见(gh/codex 密钥)。
OUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  gtimeout "$TICK_TIMEOUT" node "$SCRIPT_DIR/gg-flow-driver.mjs" $APPLY_FLAG ) 2>&1 )
printf '%s\n' "$OUT" >> "$LOG"

# relay 一条终态汇总(仅 --apply 且有 fixed/archived/fixFailed 时 driver 才打 FLOW_DRIVER_SUMMARY);
# 无该行 → 静默不发。
SUMMARY=$(printf '%s\n' "$OUT" | sed -n 's/^FLOW_DRIVER_SUMMARY: //p' | head -1)
if [ -n "$SUMMARY" ] && [ -x "$SCRIPT_DIR/gg-lark-notify.sh" ]; then
  "$SCRIPT_DIR/gg-lark-notify.sh" "$SUMMARY" >> "$LOG" 2>&1 || true
fi
exit 0
