#!/bin/bash
# gg-nightly-seo.sh — nightly autonomous SEO authoring + publishing for astrologywiki (Lane B).
#
# Fired by com.gengrowth.seo-nightly at 20:00 Asia/Shanghai (machine TZ = Asia/Shanghai).
# For each UNCHECKED "- [ ] PG-XXX <keyword>" item in the pinned astrology plan, it:
#   ensure search_volume → --author (Opus orchestrator) → one-row publish scan → preview gate.
# Clean articles merge to prod automatically; anything the codex fact-gate or links-seo gate
# rejects PARKS at needs_human and fires a Lark notify (the safety net — full-auto never ships
# wrong facts). Idempotent: skips items already live or already needs_human-parked.
# Run end: gg-batch-summary verifies this window's ledger entries live and pushes ONE
# batch_summary notify（统一事件层，契约见 tools/scripts/lib/NOTIFY-CONTRACT.md）.
#
# Anti-contamination: GG_AUTOPILOT_PLAN is PINNED to the astrology W22 plan. latestPlan() would
# otherwise default to the later-dated gengrowth W25 plan and could sweep B2B drafts in _staging/
# onto www.astrologywiki.com (the publish leg is hardcoded to xdawayer/oracle).
#
# Manual run:  GG_NIGHTLY_MAX=2 bash tools/scripts/gg-nightly-seo.sh
# Disable cron: launchctl bootout gui/$(id -u)/com.gengrowth.seo-nightly
set -uo pipefail

FLOW="$HOME/gengrowth-flow-mvp"
OPS="$HOME/gengrowth-ops/inbox/06-tasks/tasks"
PLAN_NAME="2026-05-27-W22-blog-output-plan.md"
PLAN="$OPS/$PLAN_NAME"
CLAIMS="$OPS/.autopilot-claims.json"
LOG="$HOME/Library/Logs/gg-nightly-seo.log"
LOCK="/tmp/gg-nightly-seo.lock"
MAX="${GG_NIGHTLY_MAX:-6}"          # cap articles per night (bounds cost + risk)
SITE="https://www.astrologywiki.com"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo ""
echo "===== nightly-seo run $(date '+%F %T %Z') (max=$MAX) ====="

# single-flight lock (DIRECTORY, like the other gg locks)
if ! mkdir "$LOCK" 2>/dev/null; then echo "another nightly/publish run holds $LOCK — exit"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# full cron env (a bare cron inherits neither _gg.env nor the plist env)
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null || true; set +a

# 重放 outbox 里发送失败的积压通知（fail-closed 的补发闭环；无积压时零开销）。
node "$FLOW/tools/scripts/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true
unset GG_AUTOPILOT_MODE        # publish-only mode would refuse to author
unset GG_SITE                  # oracle/astrology default; do NOT set to gengrowth
export GG_CODEX_BIN="$FLOW/tools/scripts/gg-codex-pr-review.mjs"   # plist env on the other lanes

cd "$FLOW" || { echo "no $FLOW"; exit 1; }
[ -f "$PLAN" ] || { echo "plan not found: $PLAN"; exit 1; }

# 批次窗口起点（开跑前记录）：结束后 gg-batch-summary --since 用它圈定本轮 ledger 条目。
RUN_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Collect unchecked plan items: "- [ ] `PG-XXX-NN` keyword..."  →  "PG-XXX-NN<TAB>keyword"
ITEMS="$(grep -nE '^- \[ \] *`?PG-[A-Z]+-[0-9]+' "$PLAN" \
  | sed -E 's/^[0-9]+:- \[ \] *`?(PG-[A-Z]+-[0-9]+)`? *(.*)$/\1\t\2/' \
  | sed -E 's/[[:space:]]*->.*$//; s/`//g')"

if [ -z "$ITEMS" ]; then echo "no unchecked items in plan — nothing to do"; exit 0; fi

n=0
while IFS=$'\t' read -r pid kw; do
  [ -z "${pid:-}" ] && continue
  if [ "$n" -ge "$MAX" ]; then echo "reached MAX=$MAX — stopping (remaining items wait for tomorrow)"; break; fi
  kw="$(echo "$kw" | sed -E 's/[[:space:]]*\(.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"
  echo ""
  echo "--- $pid :: $kw ---"
  [ -z "$kw" ] && { echo "no keyword, skip"; continue; }

  # skip if already live (slug derived the same way the autopilot derives it)
  slug="$(echo "$kw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  if curl -s "$SITE/sitemap.xml" | grep -q "/en/wiki/$slug<"; then echo "already live as /$slug — skip"; continue; fi

  # skip if already parked needs_human (a human must clear it; don't re-burn the LLM)
  parked="$(node -e "try{const c=require('$CLAIMS');const k=Object.keys(c).find(x=>x.includes('$pid'));process.stdout.write(k&&c[k].status==='needs_human'?'1':'')}catch(e){}" 2>/dev/null)"
  if [ "$parked" = "1" ]; then echo "$pid is needs_human-parked — skip (awaiting human fix)"; continue; fi

  n=$((n + 1))

  # 0. brief hygiene: fill empty search_volume so render doesn't fail-closed
  node tools/scripts/gg-ensure-search-volume.mjs --keyword "$kw" || true

  # 1. author (Opus orchestrator). Leaves _staging/<pid>-en.md on PASS; parks on failure.
  GG_AUTOPILOT_PLAN="$PLAN_NAME" node tools/scripts/gg-seo-autopilot.mjs --author --task "$pid" --limit 1 || true
  if [ ! -f "_staging/${pid}-en.md" ]; then echo "$pid: no passing en draft (author parked) — skip publish"; continue; fi

  # 2. publish scan via a one-row plan (avoids doScan's plain-order claim → no cross-site sweep)
  oneplan="/tmp/nightly-plan-$pid.md"
  printf '# nightly targeted publish\n\n- [ ] %s %s\n' "$pid" "$kw" > "$oneplan"
  scanlog="/tmp/nightly-scan-$pid.log"
  GG_AUTOPILOT_PLAN="$oneplan" node tools/scripts/gg-seo-autopilot.mjs --limit 1 >"$scanlog" 2>&1 || true
  cat "$scanlog"
  branch="$(grep -oE 'seo/auto/[0-9]{4}-[0-9]{2}-[0-9]{2}-'"$pid" "$scanlog" | head -1)"
  if [ -z "$branch" ]; then echo "$pid: publish scan produced no branch — skip gate"; continue; fi

  # 3. preview gate: wait → verify → 3-dim review → codex fact gate → merge (or PARK + Lark notify)
  GG_GATE_NOTIFY_ON_PARK=1 node tools/scripts/gg-preview-gate.mjs --branch "$branch" \
    && echo "$pid: MERGED → live" \
    || echo "$pid: gate parked (codex/links/verify) — needs_human + Lark notify fired"
done <<< "$ITEMS"

# 批次汇总（阶段 1 · 通知统一，契约见 tools/scripts/lib/NOTIFY-CONTRACT.md）：
# 逐篇线上核实本窗口内 done/needs_human 的 ledger 条目并推送一条 batch_summary。
# 全部核实通过不@；部分完成 @OPS；窗口内无条目 exit 2（不发送）。失败不影响 nightly 退出码。
node "$FLOW/tools/scripts/gg-batch-summary.mjs" --since "$RUN_START" --site astrologywiki || true

echo ""
echo "===== nightly-seo done: attempted=$n $(date '+%F %T %Z') ====="
