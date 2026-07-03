#!/bin/bash
# gg-index-repair-resubmit-tick.sh — deterministic fixed-row repair workflow.
#
# This wrapper only processes rows that humans marked as 已修复, syncs the
# recap sheet, and refreshes the assisted request-indexing queue. It does not
# run URL Inspection scans or unattended Request Indexing clicks.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/index_repair_resubmit"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="/tmp/gg-index-repair-resubmit.lock"

if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous index repair-resubmit run (pid $lock_pid) still active" >> "$LOG"
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

echo "$(date '+%F %T') index repair-resubmit start (pid $$)" >> "$LOG"

(
  set -a
  . "$HOME/.config/gg/_gg.env" 2>/dev/null
  set +a

  products="${GG_INDEX_MONITOR_PRODUCTS:-astrologywiki gengrowth}"
  echo "$(date '+%F %T') products: $products"

  run_rc=0
  for product in $products; do
    product_rc=0
    sitemap_url=""

    case "$product" in
      astrologywiki|astrology)
        export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_ASTROLOGY_WORKBOOK_ID:-${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}}"
        export GG_GSC_SITE="${GG_GSC_ASTROLOGY_SITE:-${GG_GSC_SITE:-sc-domain:astrologywiki.com}}"
        sitemap_url="${GG_ASTROLOGY_SITEMAP_URL:-https://www.astrologywiki.com/sitemap.xml}"
        ;;
      gengrowth|gengrowth-ai)
        export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
        export GG_GSC_SITE="${GG_GSC_GENGROWTH_SITE:-sc-domain:gengrowth.ai}"
        sitemap_url="${GG_GENGROWTH_SITEMAP_URL:-https://www.gengrowth.ai/sitemap.xml}"
        ;;
      *)
        upper_product="$(printf '%s' "$product" | tr '[:lower:]-' '[:upper:]_')"
        workbook_var="GG_SHEETS_${upper_product}_WORKBOOK_ID"
        site_var="GG_GSC_${upper_product}_SITE"
        sitemap_var="GG_${upper_product}_SITEMAP_URL"
        export GG_SHEETS_WORKBOOK_ID="${!workbook_var:-$GG_SHEETS_WORKBOOK_ID}"
        export GG_GSC_SITE="${!site_var:-$GG_GSC_SITE}"
        sitemap_url="${!sitemap_var:-}"
        if [ -z "$sitemap_url" ]; then
          echo "$(date '+%F %T') product=$product unsupported: missing $sitemap_var"
          product_rc=1
        fi
        ;;
    esac

    echo "$(date '+%F %T') product=$product start"

    if [ "$product_rc" -eq 0 ] && [ -z "$GG_SHEETS_WORKBOOK_ID" ]; then
      echo "$(date '+%F %T') product=$product failed: GG_SHEETS_WORKBOOK_ID is empty"
      product_rc=1
    fi

    if [ "$product_rc" -eq 0 ]; then
      node "$SCRIPT_DIR/gg-index-monitor.mjs" --process-fixed --write-sheet --notify --workbook "$GG_SHEETS_WORKBOOK_ID" --site "$GG_GSC_SITE" --sitemap-url "$sitemap_url" || product_rc=$?
      node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-recap --write-sheet --workbook "$GG_SHEETS_WORKBOOK_ID" --site "$GG_GSC_SITE" --sitemap-url "$sitemap_url" || product_rc=$?
      node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-request-queue --write-sheet --workbook "$GG_SHEETS_WORKBOOK_ID" --site "$GG_GSC_SITE" --sitemap-url "$sitemap_url" || product_rc=$?
    fi

    echo "$(date '+%F %T') product=$product done rc=$product_rc"
    if [ "$product_rc" -ne 0 ] && [ "$run_rc" -eq 0 ]; then
      run_rc="$product_rc"
    fi
  done

  exit "$run_rc"
) >> "$LOG" 2>&1
rc=$?

# 统一事件层（NOTIFY-CONTRACT.md）：index_tick_fail 事件（hint=修复重提），@ 策略（OPS）
# 由事件表决定，不再散装 AT env；触发条件（rc 非 0）保持原位原语义。
case "$rc" in
  0)
    echo "$(date '+%F %T') index repair-resubmit ok" >> "$LOG"
    ;;
  *)
    echo "$(date '+%F %T') index repair-resubmit failed rc=$rc" >> "$LOG"
    node "$SCRIPT_DIR/gg-notify.mjs" index_tick_fail --site flow --rc "$rc" --log "$LOG" --hint "修复重提 lane。" >> "$LOG" 2>&1
    ;;
esac

exit "$rc"
