#!/bin/bash
# gg-seo-author-tick.sh — SEPARATE authoring lane for the SEO autopilot.
#
# WHY a separate lane (2026-06-18, wzb's design): cron authoring is the riskiest part (a headless
# `claude -p` writing for minutes can hang). Rather than flip the publish cron's GG_AUTOPILOT_MODE
# to `full`, authoring lives in its OWN launchd job: small batch, hard-timeboxed, parks-on-fail with
# a human fallback, fully DECOUPLED from publishing. This tick ONLY authors (writes drafts to
# flow-mvp/_staging); the separate publish-only `seo-autopilot` lane picks up the ready drafts and
# publishes them. Authoring failures never touch the publish path.
#
# ORPHAN CLEANUP (orchestrator SIGTERM handler, 2026-06-18 after four /review cycles): the LLM
# workers are spawned detached by gg-llm-orchestrator.mjs (own session). On a gtimeout cap-hit,
# gtimeout (no --foreground) SIGTERMs the WHOLE wrapper process group, which INCLUDES the
# execFileSync'd orchestrator. The orchestrator traps SIGTERM/INT/HUP and killTree's its in-flight
# detached worker groups (process.kill(-worker.pid)) BEFORE exiting, so no worker leaks. Verified
# with REAL gtimeout (control-vs-fix): WITHOUT the handler the detached worker leaks; WITH it the
# worker is killed. The cleanup invariant holds on EVERY orchestrator spawn path incl. the
# prompt-read-fail branch (round-4 fix). This tick deliberately does NOT reap process groups itself
# (a prior bash-reap was do-not-enable'd twice — PGID reuse over the inter-fire window could SIGKILL
# an innocent recycled group, e.g. a live Claude Code session, comm=claude).
#
# KNOWN LIMITATION (operator-stop, accepted 2026-06-18): the orchestrator cleanup only fires if it
# RECEIVES the signal. The automatic unattended path (gtimeout cap-hit) is proven clean. But on a
# MANUAL `launchctl bootout` / stop, launchd SIGTERMs only the bash wrapper — whose trap just removes
# the lock (bash defers a trap during a foreground command, so it can't forward TERM to node) — then
# SIGKILLs the job group, so the orchestrator can die by uncatchable SIGKILL before its handler runs,
# briefly orphaning its detached workers. This is rare (only mid-authoring), self-limiting (a worker
# finishes in minutes), and attended (the operator who issued the stop is present and can
# `pkill -f gg-llm-orchestrator`). Accepted as-is; revisit with a per-worker self-timeout if it bites.
#
# ENABLED 2026-06-18 (gate passed round-4 /review, ship-after-fixes → Fix #1 landed; Fix #2 documented
# above). RunAtLoad is FALSE, so loading does NOT instantly author — kickstart the first fire by hand
# and watch one article, then it fires on StartInterval.
# Install:
#   cp tools/scripts/com.gengrowth.seo-author.plist ~/Library/LaunchAgents/
#   launchctl enable    gui/$(id -u)/com.gengrowth.seo-author
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.seo-author.plist
#   launchctl kickstart gui/$(id -u)/com.gengrowth.seo-author    # watch the FIRST article
# Stop:
#   launchctl bootout gui/$(id -u)/com.gengrowth.seo-author
#
# Knobs: GG_AUTHOR_BATCH (default 1), GG_AUTHOR_TICK_TIMEOUT (default 1800s hard wall-clock cap).

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 重放 outbox 里发送失败的积压通知（fail-closed 的补发闭环；无积压时零开销）。
node "$SCRIPT_DIR/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true
LOCK="/tmp/gg-seo-author.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/seo_author"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"
BATCH="${GG_AUTHOR_BATCH:-1}"
TICK_TIMEOUT="${GG_AUTHOR_TICK_TIMEOUT:-3600}"
# Validate numeric + clamp (env-controlled, but guard against option-injection / chaos config:
# a non-numeric or leading-'-' value would corrupt the gtimeout/--limit args).
case "$BATCH" in ''|*[!0-9]*) BATCH=1 ;; esac
case "$TICK_TIMEOUT" in ''|*[!0-9]*) TICK_TIMEOUT=1800 ;; esac
[ "$BATCH" -ge 1 ] 2>/dev/null || BATCH=1; [ "$BATCH" -le 10 ] 2>/dev/null || BATCH=10
[ "$TICK_TIMEOUT" -ge 60 ] 2>/dev/null || TICK_TIMEOUT=1800

# ── PID-liveness mutex (macOS has no flock) ─────────────────────────────────
# A previous authoring fire is "active" only if its pid is alive AND its start-time matches what we
# stored — so a RECYCLED pid (OS reused the dead fire's pid for an unrelated process) can't wedge
# authoring into a silent permanent skip. A dead/recycled lock → steal it.
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  lock_start="$(cat "$LOCK/start" 2>/dev/null)"
  cur_start=""
  [ -n "$lock_pid" ] && cur_start="$(ps -o lstart= -p "$lock_pid" 2>/dev/null | tr -s ' ')"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null && [ -n "$lock_start" ] && [ "$cur_start" = "$lock_start" ]; then
    echo "$(date '+%F %T') skip — previous authoring fire (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale author lock (pid ${lock_pid:-?} dead/recycled) — taking over" >> "$LOG"
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

echo "$(date '+%F %T') author tick start (pid $$, batch $BATCH, cap ${TICK_TIMEOUT}s)" >> "$LOG"

# Preflight — fail fast on a broken host (missing dirs/bins) with a Feishu alert, before spending
# any LLM budget. --skip-live-cli: the live claude smoke is slow/flaky unattended.
(
  set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  node "$SCRIPT_DIR/gg-autopilot-preflight.mjs" --skip-live-cli >> "$LOG" 2>&1
) || {
  # 统一事件层（NOTIFY-CONTRACT.md）：@ 策略由事件表决定（preflight_fail → OPS），不再散装 AT env。
  node "$SCRIPT_DIR/gg-notify.mjs" preflight_fail --lane seo-author --log "$LOG"
  exit 2
}

# ── author one small batch, HARD-timeboxed ──────────────────────────────────
# gtimeout is the wall-clock cap on the whole fire. On cap-hit (no --foreground) it SIGTERMs the
# whole process group incl. the execFileSync'd orchestrator, which traps SIGTERM and kills its
# detached worker groups before exiting (see ORPHAN CLEANUP note) — so this tick never kills groups.
# NOTE: GG_AUTOPILOT_MODE must NOT be publish-only here (the driver refuses --author in publish-only),
# so it's unset; this lane never publishes (no --scan/--merge anywhere in this script).
AOUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  unset GG_AUTOPILOT_MODE
  export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
  # gbrain (~/.local/bin, RAG) + codex (~/.npm-global/bin, multi-party review) on PATH for authoring.
  export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
  # Multi-party review is best-effort. Keep Codex on a short leash so one slow critic
  # cannot stall the whole author lane and block the next article from starting.
  export GG_REVIEW_CODEX_TIMEOUT_MS="${GG_REVIEW_CODEX_TIMEOUT_MS:-60000}"
  export GG_REVIEW_OPUS_TIMEOUT_MS="${GG_REVIEW_OPUS_TIMEOUT_MS:-420000}"
  export GG_REVIEW_REVISER_TIMEOUT_MS="${GG_REVIEW_REVISER_TIMEOUT_MS:-420000}"
  gtimeout "$TICK_TIMEOUT" node "$AUTO" --author --limit "$BATCH" ) 2>&1 )
_rc=$?
printf '%s\n' "$AOUT" >> "$LOG"
if [ "$_rc" -ne 0 ]; then
  # Capped/killed (rc=124) or errored — the fire is INCOMPLETE. Do NOT parse AOUT for AUTHORED/PARK:
  # a half-written _staging draft must never be announced as ready, or the publish lane would pick up
  # a half-baked article. (Workers are reaped by the orchestrator's SIGTERM handler on a gtimeout
  # cap-hit, or by its in-flight watchdog if it outlives the signal; see ORPHAN CLEANUP header note.)
  echo "$(date '+%F %T') author fire rc=$_rc (cap/err) — incomplete; not announcing (worker groups killed by the orchestrator SIGTERM handler)" >> "$LOG"
  [ "$_rc" -eq 124 ] && node "$SCRIPT_DIR/gg-notify.mjs" lane_timeout --lane seo-author --seconds "$TICK_TIMEOUT"
else
  # Clean exit only: Feishu on a fresh park (needs a human) or a freshly-authored draft. The
  # publish-only lane picks up an authored draft on its next fire and publishes it.
  PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
  DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
  if [ -n "$PARK" ]; then
    # 统一事件层（parked → PM+OPS，由事件表决定）。驱动器输出形如「PARK(author) PG-XXX: 原因」，
    # 解析出结构化 pid/reason；解析不出 pid 时整段作 reason（契约允许）。该行不含 slug，故不传。
    PARK_PID=$(printf '%s\n' "$PARK" | grep -oE 'PG-[A-Z0-9-]+' | head -1)
    PARK_REASON=$(printf '%s\n' "$PARK" | sed -E 's/^PARK\(author\) //; s/^PG-[A-Z0-9-]+:[[:space:]]*//')
    # 例行 authoring park 默认不即时通知（wzb 指令：只发成功/彻底停止，别老发中间态）——park 已记进
    # ledger，publish lane 的 auto-retry 会对永久 park 去重发一次终态通知。GG_NOTIFY_ON_PARK=1 恢复即时。
    [ "$GG_NOTIFY_ON_PARK" = "1" ] && node "$SCRIPT_DIR/gg-notify.mjs" parked --site astrologywiki --pid "$PARK_PID" --reason "$PARK_REASON" || true
  fi
  if [ -n "$DONE" ]; then
    # authored（草稿写好、待发布）是**中间态**（还没上线）——默认不通知（wzb: 只发成功/彻底停止）。
    # 真正上线由 publish lane 发 published(✅已发布上线) 成功通知。GG_NOTIFY_ON_PARK=1 恢复中间态通知。
    [ "$GG_NOTIFY_ON_PARK" = "1" ] && node "$SCRIPT_DIR/gg-notify.mjs" authored --site astrologywiki --detail "${DONE}— 待 publish lane 发布" || true
  fi
fi

echo "$(date '+%F %T') author tick end (rc=$_rc)" >> "$LOG"
node "$SCRIPT_DIR/gg-notify.mjs" heartbeat com.gengrowth.seo-author >/dev/null 2>&1 || true  # 阶段5 lane 心跳
