#!/bin/bash
# gg-recap-performance-tick.sh — daily GSC/GA4 recap metrics and action-list job.
#
# Per product:
#   - reads index-tracking + 结果复盘表
#   - fills only exact D14/D30/D60 performance snapshot columns for indexed URLs
#   - writes a Markdown optimization task list
#
# This wrapper intentionally does not author, publish, deploy, or submit URLs.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/recap_performance"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="/tmp/gg-recap-performance.lock"
TIMEOUT="${GG_RECAP_PERFORMANCE_TIMEOUT:-900}"

if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous recap performance run (pid $lock_pid) still active" >> "$LOG"
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

node "$SCRIPT_DIR/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true
echo "$(date '+%F %T') recap performance start (pid $$)" >> "$LOG"

(
  set -a
  . "$HOME/.config/gg/_gg.env" 2>/dev/null
  set +a

  run_rc=0
  products="${GG_RECAP_PERFORMANCE_PRODUCTS:-astrologywiki gengrowth}"
  for product in $products; do
    case "$product" in
      astrologywiki|astrology)
        wb="${GG_SHEETS_ASTROLOGY_WORKBOOK_ID:-${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}}"
        site="${GG_GSC_ASTROLOGY_SITE:-sc-domain:astrologywiki.com}"
        ga4="${GG_GA4_ASTROLOGY_PROPERTY:-${GG_GA4_PROPERTY:-${GG_GA4_PROPERTY_ID:+properties/$GG_GA4_PROPERTY_ID}}}"
        site_name="AstrologyWiki"
        ;;
      gengrowth|gengrowth-ai)
        wb="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
        site="${GG_GSC_GENGROWTH_SITE:-sc-domain:gengrowth.ai}"
        ga4="${GG_GA4_GENGROWTH_PROPERTY:-${GG_GA4_PROPERTY:-${GG_GA4_PROPERTY_ID:+properties/$GG_GA4_PROPERTY_ID}}}"
        site_name="GenGrowth"
        ;;
      *)
        echo "$(date '+%F %T') recap performance: unknown product '$product' (skip)"
        continue
        ;;
    esac

    if [ -z "$wb" ]; then
      echo "$(date '+%F %T') recap performance: no workbook for product '$product' (skip)"
      continue
    fi

    echo "$(date '+%F %T') ── recap-performance product=$product wb=…${wb: -6} site=$site ga4=${ga4:-none} ──"
    CMD=(node "$SCRIPT_DIR/gg-recap-performance.mjs" --write-sheet --write-report --write-recommendations --workbook "$wb" --site "$site" --site-name "$site_name")
    if [ "${GG_RECAP_PERFORMANCE_VERIFY_ZERO:-0}" = "1" ]; then
      CMD+=(--verify-zero-metrics)
    fi
    if [ -n "$ga4" ]; then
      CMD+=(--ga4-property "$ga4")
    fi

    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout "$TIMEOUT" "${CMD[@]}" || run_rc=$?
    else
      "${CMD[@]}" || run_rc=$?
    fi
  done
  exit "$run_rc"
) >> "$LOG" 2>&1
rc=$?

case "$rc" in
  0)
    echo "$(date '+%F %T') recap performance ok" >> "$LOG"
    recap_notify_payload="$(
      awk '
        /recap performance start/ { body=""; reports=""; product=""; next }
        /recap-performance product=astrologywiki/ { product="AstrologyWiki"; next }
        /recap-performance product=gengrowth/ { product="GenGrowth"; next }
        /wrote report:/ {
          report=$0
          sub(/^.*wrote report: /, "", report)
          if (report != "") reports = reports report "\n"
          next
        }
        /recap-performance: rows=/ {
          line=$0
          sub(/^.*recap-performance: /, "", line)
          if (product != "") body = body product "：" line "\n"
          next
        }
        END { printf "%s\n__REPORTS__\n%s", body, reports }
      ' "$LOG"
    )"
    recap_notify_body="${recap_notify_payload%%$'\n__REPORTS__'*}"
    recap_notify_reports="${recap_notify_payload#*$'\n__REPORTS__'$'\n'}"
    if [ -z "$recap_notify_body" ]; then
      recap_notify_body="详见日志：$LOG"
    fi
    if [ -z "$recap_notify_reports" ] || [ "$recap_notify_reports" = "$recap_notify_payload" ]; then
      recap_notify_reports="详见日志：$LOG"
    fi
    node "$SCRIPT_DIR/gg-notify.mjs" recap_performance_ok \
      --date "$(date '+%F')" \
      --body "$recap_notify_body" \
      --reports "$recap_notify_reports" \
      --log "$LOG" \
      --window_note "仅在 D14/D30/D60 节点日抓取已收录 URL 的快照；非节点日与已填节点保留原值。" >> "$LOG" 2>&1
    ;;
  2|124)
    echo "$(date '+%F %T') recap performance partial/timeout rc=$rc" >> "$LOG"
    node "$SCRIPT_DIR/gg-notify.mjs" index_tick_fail --site flow --rc "$rc" --log "$LOG" --hint "复盘数据部分失败或超时。" >> "$LOG" 2>&1
    ;;
  *)
    echo "$(date '+%F %T') recap performance failed rc=$rc" >> "$LOG"
    node "$SCRIPT_DIR/gg-notify.mjs" index_tick_fail --site flow --rc "$rc" --log "$LOG" --hint "请检查 GSC/GA4 OAuth、Sheets writer SA 与 workbook 配置。" >> "$LOG" 2>&1
    ;;
esac

node "$SCRIPT_DIR/gg-notify.mjs" heartbeat com.gengrowth.recap-performance >/dev/null 2>&1 || true
exit "$rc"
