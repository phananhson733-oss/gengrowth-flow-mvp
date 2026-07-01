#!/bin/bash
# gg-index-monitor-tick.sh — launchd entry point for Phase 1 index monitoring.
#
# Lightweight daily job, run PER PRODUCT (astrologywiki + gengrowth by default):
#   - syncs live EN wiki/blog URLs from the site sitemap into index-tracking
#   - syncs the full indexable URL inventory into url-inventory for coverage gap review
#   - processes human-marked 已修复 rows by refreshing sitemap and timestamps
#   - refreshes the sitemap through the official Search Console Sitemaps API
#   - checks due URLs with Search Console URL Inspection
#   - writes final human-facing status into 结果复盘表
#   - keeps 主题集群表.page_assets in step with 已发布 rows
#   - writes the Phase 2 request-indexing-queue for human-confirmed Computer Use
#   - sends Feishu alerts for overdue/problem URLs
#
# Each product writes to ITS OWN canonical workbook via an explicit --workbook
# (astrologywiki → 1CkjOC…, gengrowth → its own book) — NOT the legacy 1dejq and NOT
# a single shared book. --workbook overrides resolveWorkbookId(), which otherwise
# stays pinned to GG_SHEETS_FLOW_MVP_WORKBOOK_ID (the astrologywiki canonical book).
#
# It intentionally does not author, publish, merge, or click Request Indexing unattended.

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

  run_rc=0
  products="${GG_INDEX_MONITOR_PRODUCTS:-astrologywiki gengrowth}"
  for product in $products; do
    case "$product" in
      astrologywiki|astrology)
        wb="${GG_SHEETS_ASTROLOGY_WORKBOOK_ID:-${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}}"
        site="${GG_GSC_ASTROLOGY_SITE:-sc-domain:astrologywiki.com}"
        sm="${GG_ASTROLOGY_SITEMAP_URL:-https://www.astrologywiki.com/sitemap.xml}"
        ;;
      gengrowth|gengrowth-ai)
        wb="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
        site="${GG_GSC_GENGROWTH_SITE:-sc-domain:gengrowth.ai}"
        sm="${GG_GENGROWTH_SITEMAP_URL:-https://www.gengrowth.ai/sitemap.xml}"
        ;;
      *)
        echo "$(date '+%F %T') index monitor: unknown product '$product' (skip)" >> "$LOG"
        continue
        ;;
    esac
    if [ -z "$wb" ]; then
      echo "$(date '+%F %T') index monitor: no workbook for product '$product' (skip)" >> "$LOG"
      continue
    fi
    echo "$(date '+%F %T') ── index-monitor product=$product wb=…${wb: -6} site=$site ──" >> "$LOG"
    WB=(--workbook "$wb" --site "$site" --sitemap-url "$sm")

    node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-published --write-sheet "${WB[@]}" || run_rc=$?
    node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-url-inventory --write-sheet "${WB[@]}" || run_rc=$?
    node "$SCRIPT_DIR/gg-index-monitor.mjs" --process-fixed --write-sheet --notify "${WB[@]}" || run_rc=$?
    node "$SCRIPT_DIR/gg-index-monitor.mjs" --submit-sitemap --notify "${WB[@]}" || run_rc=$?

    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout "$TIMEOUT" node "$SCRIPT_DIR/gg-index-monitor.mjs" --check-due --write-sheet --require-gsc-auth --limit "$LIMIT" "${WB[@]}" || run_rc=$?
    else
      node "$SCRIPT_DIR/gg-index-monitor.mjs" --check-due --write-sheet --require-gsc-auth --limit "$LIMIT" "${WB[@]}" || run_rc=$?
    fi

    node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-recap --write-sheet "${WB[@]}" || run_rc=$?
    # keep 主题集群表.page_assets in step with 已发布 rows (append-only, idempotent, non-fatal)
    node "$SCRIPT_DIR/gg-cluster-page-assets-sync.mjs" --apply --workbook "$wb" || echo "$(date '+%F %T') cluster-page-assets sync failed product=$product (non-fatal)" >> "$LOG"
    node "$SCRIPT_DIR/gg-index-monitor.mjs" --sync-request-queue --write-sheet --notify "${WB[@]}" || run_rc=$?
  done
  exit "$run_rc"
) >> "$LOG" 2>&1
rc=$?

case "$rc" in
  0)
    echo "$(date '+%F %T') index monitor ok" >> "$LOG"
    ;;
  2|124)
    echo "$(date '+%F %T') index monitor partial/timeout rc=$rc" >> "$LOG"
    GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ 索引监控部分失败或超时（rc=${rc}）。请查看 ${LOG}"
    ;;
  *)
    echo "$(date '+%F %T') index monitor failed rc=$rc" >> "$LOG"
    GG_LARK_NOTIFY_AT_OPS=1 "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ 索引监控运行失败（rc=${rc}）。请查看 ${LOG}；常见原因是 GSC reader SA 权限不足，需要在 Search Console 为 reader SA 添加 Full user。"
    ;;
esac

exit "$rc"
