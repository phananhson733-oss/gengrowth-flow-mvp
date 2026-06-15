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
  if [ -z "$lock_pid" ]; then
    # No pid file = a legacy mkdir-lock from an older wrapper still finishing, or a
    # pid not yet written. Treat as ACTIVE (never steal) — wait for it to release.
    echo "$(date '+%F %T') skip — lock present (legacy/no-pid), previous run still active" >> "$LOG"
    exit 0
  fi
  if kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous run (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale lock (pid $lock_pid dead) — taking over" >> "$LOG"
  rm -rf "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"
  exit 0
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') loop start (pid $$, max $MAX_CYCLES cycles)" >> "$LOG"

# ── cluster_id sync (D4, 2026-06-09) ────────────────────────────────────────
# keywords_included(主题集群表) → 关键词主表 cluster_id(AC) 同步：additive/幂等/不覆盖
# （只填 AC 空行的精确唯一命中；冲突/模糊/孤儿词只报告不写）。每次 fire 跑一次，写独立
# 日志（含漏检报告：疑似漏配 / 集群表对不上主表的词 / 仍未归类计数）。NON-FATAL：同步出错
# 绝不阻断内容线。手动看：node tools/scripts/gg-cluster-sync.mjs（dry-run 出报告）。
CLUSTER_SYNC_LOG="$LOG_DIR/cluster-sync-$(date +%Y-%m-%d).log"
(
  echo "$(date '+%F %T') ── cluster-sync tick (pid $$) ──"
  set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
  node "$SCRIPT_DIR/gg-cluster-sync.mjs" --apply
) >> "$CLUSTER_SYNC_LOG" 2>&1 || echo "$(date '+%F %T') cluster-sync failed (non-fatal, see cluster-sync log)" >> "$LOG"

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
  # Anti-刷屏 (2026-06-12): the continuous loop can park a whole plan batch
  # back-to-back off ONE shared root cause (e.g. 选题登记表 missing every row of a
  # new daily batch → 10 needs_human alerts in ~70s). Only the FIRST park of this
  # run alerts immediately; the rest accumulate into one roll-up sent at loop end.
  local PARK DONE
  PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
  DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
  if [ -n "$PARK" ]; then
    PARK_COUNT=$((PARK_COUNT + 1))
    if [ "$PARK_COUNT" -eq 1 ]; then
      GG_LARK_NOTIFY_AT_PM=1 GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot 写稿暂停（needs_human）：$PARK"
    else
      PARK_REST="${PARK_REST}${PARK}"$'\n'
    fi
  fi
  if [ -n "$DONE" ]; then
    "$SCRIPT_DIR/gg-lark-notify.sh" "✍️ SEO autopilot 写好一篇：$DONE— 立即发布中"
    # IMMEDIATE PUBLISH: claim+convert+preview the just-written draft, then verify+merge.
    node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1
    publish_if_pending || echo "$(date '+%F %T') authored but no preview to publish (scan/convert gate?)" >> "$LOG"
  fi
  return 0  # an author attempt (success or park) = progress; keep looping
}

# ── continuous serial loop ──────────────────────────────────────────────────
# Park-alert roll-up state (mutated by run_one_cycle, which runs in this shell).
PARK_COUNT=0
PARK_REST=""
cycle=0
while [ "$cycle" -lt "$MAX_CYCLES" ]; do
  cycle=$((cycle + 1))
  echo "$(date '+%F %T') ── cycle $cycle/$MAX_CYCLES ──" >> "$LOG"
  if ! run_one_cycle; then
    worked=$((cycle - 1))
    echo "$(date '+%F %T') queue drained — idle after $worked working cycle(s); exiting loop" >> "$LOG"
    # Day-complete notice (@马博洋): only if this run actually DID work then drained
    # (worked≥1), AND no needs_human parks remain (a park = not fully complete; the
    # park alert already @'d 王志彪+马博洋). A tick that starts already-idle (worked=0) stays
    # quiet, so the PM isn't re-pinged every idle poll.
    if [ "$worked" -ge 1 ]; then
      parks=$(node "$AUTO" --status 2>/dev/null | grep -c '"needs_human"')
      if [ "$parks" -eq 0 ]; then
        pub=$(grep -cE '^\| 2026' "$HOME/gengrowth-ops/inbox/06-tasks/seo-autopilot-publish-log.md" 2>/dev/null)
        GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "✅ SEO autopilot：本批计划内容已全部写完并上线（发布登记表累计 ${pub:-?} 篇），队列已清空。"
      else
        echo "$(date '+%F %T') drained with $parks park(s) — not sending day-complete (parks need a human)" >> "$LOG"
      fi
    fi
    break
  fi
done
if [ "$cycle" -ge "$MAX_CYCLES" ]; then
  echo "$(date '+%F %T') hit MAX_CYCLES=$MAX_CYCLES — exiting; launchd re-fire continues the backlog" >> "$LOG"
fi

# Roll-up for parks 2..N of this run (first one already alerted in-cycle). One
# message instead of N keeps the group readable when a whole batch shares one
# root cause; the per-page detail still lands in $LOG and the claims ledger.
if [ "$PARK_COUNT" -gt 1 ]; then
  echo "$(date '+%F %T') sending park roll-up ($PARK_COUNT parks this run)" >> "$LOG"
  GG_LARK_NOTIFY_AT_PM=1 GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot 本轮共暂停 ${PARK_COUNT} 篇（needs_human）。首篇已单独通报，其余 $((PARK_COUNT - 1)) 篇合并通报（防刷屏）：
${PARK_REST}处理提示：若原因均为「no row … in 选题登记表」，说明计划里新加的一批选题还没登记进 选题登记表 — 补齐登记行后，清掉 .autopilot-claims.json 里对应 needs_human 条目即可恢复写作。"
fi

echo "$(date '+%F %T') loop end" >> "$LOG"
