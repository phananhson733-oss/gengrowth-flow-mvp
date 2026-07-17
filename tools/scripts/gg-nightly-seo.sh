#!/bin/bash
# gg-nightly-seo.sh — nightly autonomous SEO authoring + publishing for astrologywiki (Lane B).
#
# Fired by the single SEO launchd owner during the approved Asia/Shanghai window.
# For each UNCHECKED "- [ ] PG-XXX <keyword>" item in the proven items snapshot, it:
#   ensure search_volume → --author (Opus orchestrator) → one-row publish scan → preview gate.
# Clean articles merge to prod automatically; anything the codex fact-gate or links-seo gate
# rejects PARKS at needs_human and fires a Lark notify (the safety net — full-auto never ships
# wrong facts). Idempotent: skips items already live or already needs_human-parked.
#
# Anti-contamination: the launcher supplies a canonical author plan and a distinct immutable
# queue snapshot. Authoring rechecks canonical ownership; publishing uses only a one-row plan.
#
# Manual run:  GG_NIGHTLY_MAX=2 bash tools/scripts/gg-nightly-seo.sh
# Disable cron: launchctl bootout gui/$(id -u)/com.gengrowth.seo-nightly
set -uo pipefail

FLOW="${GG_NIGHTLY_FLOW:-$HOME/gengrowth-flow-mvp}"
PLAN="${GG_SEO_PLAN:-}"
ITEMS_PLAN="${GG_NIGHTLY_ITEMS_PLAN:-}"
CLAIMS="${GG_NIGHTLY_CLAIMS:-$HOME/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json}"
LOG="${GG_NIGHTLY_LOG:-$HOME/Library/Logs/gg-nightly-seo.log}"
LOCK="${GG_NIGHTLY_LOCK:-/tmp/gg-nightly-seo.lock}"
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
# The interactive ~/oracle checkout may contain uncommitted product work.  When
# launchd pins a clean publishing baseline, preserve it across the shared env
# file so syncOracle() never resets the interactive checkout.
AUTOMATION_ORACLE_DIR="${GG_AUTOMATION_ORACLE_DIR:-}"
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null || true; set +a
[ -n "$AUTOMATION_ORACLE_DIR" ] && export GG_ORACLE_DIR="$AUTOMATION_ORACLE_DIR"
export GG_SEO_PLAN="$PLAN"
export GG_NIGHTLY_ITEMS_PLAN="$ITEMS_PLAN"
export GG_AUTOPILOT_PLAN="$PLAN"

# 重放 outbox 里发送失败的积压通知（fail-closed 的补发闭环；无积压时零开销）。
node "$FLOW/tools/scripts/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true
unset GG_AUTOPILOT_MODE        # publish-only mode would refuse to author
unset GG_SITE                  # oracle/astrology default; do NOT set to gengrowth
export GG_CODEX_BIN="$FLOW/tools/scripts/gg-codex-pr-review.mjs"   # plist env on the other lanes

cd "$FLOW" || { echo "no $FLOW"; exit 1; }
case "$PLAN" in
  /*) ;;
  *) echo "canonical plan must be an absolute path"; exit 1 ;;
esac
case "$ITEMS_PLAN" in
  /*) ;;
  *) echo "nightly items plan must be an absolute path"; exit 1 ;;
esac
[ "$PLAN" != "$ITEMS_PLAN" ] || { echo "canonical and nightly items plans must be distinct"; exit 1; }
[ -f "$PLAN" ] || { echo "canonical plan not found: $PLAN"; exit 1; }
[ -f "$ITEMS_PLAN" ] || { echo "nightly items plan not found: $ITEMS_PLAN"; exit 1; }

# 先恢复明确属于工具/桥接层的临时 authoring park；持久化 CAP/backoff 防止无限重试。
node "$FLOW/tools/scripts/gg-seo-autopilot.mjs" --auto-retry-parks || true

# Collect unchecked plan items: "- [ ] `PG-XXX-NN` keyword..."  →  "PG-XXX-NN<TAB>keyword"
ITEMS="$(grep -nE '^- \[ \] *`?PG-[A-Z0-9]+-[0-9]+`?([[:space:]]|$)' "$ITEMS_PLAN" \
  | sed -E 's/^[0-9]+:- \[ \] *`?(PG-[A-Z0-9]+-[0-9]+)`? *(.*)$/\1\t\2/' \
  | sed -E 's/[[:space:]]*->.*$//; s/`//g')"

if [ -z "$ITEMS" ]; then echo "no unchecked items in plan — nothing to do"; exit 0; fi

n=0
canonical_plan_owns_unchecked_pid() {
  local pid="$1"
  local matches line_count token_count token_value
  matches="$(grep -E "^- \\[ \\] *\`?${pid}\`?([[:space:]]|$)" "$PLAN" || true)"
  line_count="$(printf '%s\n' "$matches" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$line_count" = "1" ] || return 1
  token_count="$(printf '%s\n' "$matches" | grep -oE 'PG-[A-Za-z0-9-]+' | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$token_count" = "1" ] || return 1
  token_value="$(printf '%s\n' "$matches" | grep -oE 'PG-[A-Za-z0-9-]+' || true)"
  [ "$token_value" = "$pid" ]
}

while IFS=$'\t' read -r pid kw; do
  [ -z "${pid:-}" ] && continue
  if [ "$n" -ge "$MAX" ]; then echo "reached MAX=$MAX — stopping (remaining items wait for tomorrow)"; break; fi
  if ! canonical_plan_owns_unchecked_pid "$pid"; then
    echo "$pid: no longer canonical unchecked — skip"
    continue
  fi
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
  GG_AUTOPILOT_PLAN="$PLAN" node tools/scripts/gg-seo-autopilot.mjs --author --task "$pid" --limit 1 || true
  if [ ! -f "_staging/${pid}-en.md" ]; then echo "$pid: no passing en draft (author parked) — skip publish"; continue; fi

  # 2. publish scan via a one-row plan (avoids doScan's plain-order claim → no cross-site sweep)
  oneplan="/tmp/nightly-plan-$pid.md"
  printf '# nightly targeted publish\n\n- [ ] %s %s\n' "$pid" "$kw" > "$oneplan"
  scanlog="/tmp/nightly-scan-$pid.log"
  GG_AUTOPILOT_PLAN="$oneplan" node tools/scripts/gg-seo-autopilot.mjs --limit 1 >"$scanlog" 2>&1 || true
  cat "$scanlog"
  branch="$(grep -oE 'seo/auto/[0-9]{4}-[0-9]{2}-[0-9]{2}-'"$pid" "$scanlog" | head -1)"
  if [ -z "$branch" ]; then echo "$pid: publish scan produced no branch — skip gate"; continue; fi

  # 3. preview gate: wait → verify → 3-dim review → codex fact gate → merge (or PARK)
  # 例行 gate park 默认不即时通知（wzb: 只发成功/彻底停止）——park 记进 ledger，publish lane 的
  # auto-retry 会对永久 park 去重发一次终态通知、对 transient 重试到 CAP 才升级。GG_NOTIFY_ON_PARK=1 恢复即时。
  node tools/scripts/gg-preview-gate.mjs --branch "$branch" \
    && echo "$pid: MERGED → live" \
    || echo "$pid: gate parked (codex/links/verify) — needs_human (通知交 auto-retry 终态去重)"
done <<< "$ITEMS"

echo ""
echo "===== nightly-seo done: attempted=$n $(date '+%F %T %Z') ====="
node "$FLOW/tools/scripts/gg-notify.mjs" heartbeat com.gengrowth.seo-nightly >/dev/null 2>&1 || true  # 阶段5 lane 心跳
