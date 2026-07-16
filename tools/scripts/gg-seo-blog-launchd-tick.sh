#!/usr/bin/env bash
# macOS LaunchAgent entrypoint: run the deterministic nightly workflow, then
# let the lightweight repair hook decide whether a one-shot Agent is required.

set -euo pipefail

export HOME="${HOME:-/Users/awayer_mini}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="Asia/Shanghai"

FLOW="${GG_SEO_LAUNCHD_FLOW:-$HOME/gengrowth-flow-mvp}"
ENV_FILE="${GG_ENV_FILE:-$HOME/.config/gg/_gg.env}"
ORACLE_BASELINE="${GG_AUTOMATION_ORACLE_DIR:-$HOME/oracle-autopilot}"
LOCK="${GG_SEO_LAUNCHD_LOCK:-/tmp/gg-seo-blog-launchd.lock}"
LOG="${GG_SEO_LAUNCHD_LOG:-$HOME/Library/Logs/gg-seo-blog-launchd.out.log}"
ERR_LOG="${GG_SEO_LAUNCHD_ERR_LOG:-$HOME/Library/Logs/gg-seo-blog-launchd.err.log}"
NIGHTLY="${GG_SEO_NIGHTLY_BIN:-$FLOW/tools/scripts/gg-nightly-seo.sh}"
REPAIR_HOOK="${GG_SEO_REPAIR_HOOK_BIN:-$FLOW/tools/scripts/gg-seo-repair-hook.mjs}"
RECONCILE="${GG_SEO_RECONCILE_BIN:-$FLOW/tools/scripts/gg-ledger-reconcile.mjs}"
BATCH_SUMMARY="${GG_SEO_BATCH_SUMMARY_BIN:-$FLOW/tools/scripts/gg-batch-summary.mjs}"
NIGHTLY_LOG="${GG_SEO_NIGHTLY_LOG:-$HOME/Library/Logs/gg-nightly-seo.log}"
OPS="${GG_OPS_DIR:-$HOME/gengrowth-ops}"
PLAN="${GG_SEO_PLAN:-$OPS/inbox/06-tasks/tasks/2026-05-27-W22-blog-output-plan.md}"
CLAIMS="${GG_SEO_CLAIMS:-$OPS/inbox/06-tasks/tasks/.autopilot-claims.json}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$ERR_LOG")"
exec >>"$LOG" 2>>"$ERR_LOG"

echo "===== seo-blog launchd tick $(date '+%F %T %Z') ====="

if [[ "${GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW:-0}" != "1" ]]; then
  now_hm="$(date +%H%M)"
  if [[ "$now_hm" < "1830" || "$now_hm" > "2130" ]]; then
    echo "outside approved SEO start window (18:30-21:30); skip"
    exit 0
  fi
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another SEO launchd run holds $LOCK; skip"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# Preserve the dedicated unattended baseline even when the shared environment
# file contains an interactive Oracle checkout.
PINNED_ORACLE="$ORACLE_BASELINE"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
ORACLE_BASELINE="$PINNED_ORACLE"
export GG_AUTOMATION_ORACLE_DIR="$ORACLE_BASELINE"
export GG_ORACLE_DIR="$ORACLE_BASELINE"

[[ -x "$NIGHTLY" ]] || { echo "nightly wrapper unavailable: $NIGHTLY"; exit 1; }
[[ -f "$REPAIR_HOOK" ]] || { echo "repair hook unavailable: $REPAIR_HOOK"; exit 1; }
[[ -f "$RECONCILE" ]] || { echo "ledger reconcile unavailable: $RECONCILE"; exit 1; }
[[ -f "$BATCH_SUMMARY" ]] || { echo "batch summary unavailable: $BATCH_SUMMARY"; exit 1; }
[[ -d "$ORACLE_BASELINE/.git" ]] || { echo "clean Oracle baseline unavailable: $ORACLE_BASELINE"; exit 1; }
[[ -f "$PLAN" ]] || { echo "pinned SEO plan unavailable: $PLAN"; exit 1; }
[[ -f "$CLAIMS" ]] || { echo "SEO claims ledger unavailable: $CLAIMS"; exit 1; }
if [[ "$PLAN" != /* ]]; then
  PLAN="$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")"
fi

if [[ "${GG_SEO_SKIP_LEGACY_CHECK:-0}" != "1" ]]; then
  uid="$(id -u)"
  legacy_labels=(
    com.gengrowth.seo-nightly
    com.gengrowth.seo-author
    com.gengrowth.seo-autopilot
    com.gengrowth.seo-author-kicker
    com.gengrowth.flow-driver
    com.gengrowth.lane-watchdog
    com.gengrowth.ledger-reconcile
    com.gengrowth.index-monitor
  )

  for label in "${legacy_labels[@]}"; do
    if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
      echo "legacy executor remains loaded: $label; fail closed"
      exit 1
    fi
  done

  legacy_pattern='gg-nightly-seo\.sh|gg-seo-author-tick\.sh|gg-seo-autopilot-tick\.sh|gg-flow-driver-tick\.sh|gg-lane-watchdog-tick\.sh|gg-ledger-reconcile-tick\.sh|gg-index-monitor-tick\.sh'
  if legacy_processes="$(pgrep -fal "$legacy_pattern")"; then
    echo "legacy SEO process remains active; fail closed"
    echo "$legacy_processes"
    exit 1
  fi
fi

RUN_START="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
RUN_ID="seo-blog-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
LOG_OFFSET=0
if [[ -f "$NIGHTLY_LOG" ]]; then
  LOG_OFFSET="$(wc -c < "$NIGHTLY_LOG" | tr -d ' ')"
fi

echo "single-executor preflight passed; starting deterministic SEO nightly"
set +e
bash "$NIGHTLY"
NIGHTLY_RC=$?
set -e

echo "nightly exit=$NIGHTLY_RC; running conditional repair selector"
set +e
node "$REPAIR_HOOK" \
  --run-id "$RUN_ID" \
  --run-start "$RUN_START" \
  --run-exit "$NIGHTLY_RC" \
  --log-file "$NIGHTLY_LOG" \
  --log-offset "$LOG_OFFSET" \
  --claims "$CLAIMS" \
  --plan "$PLAN"
HOOK_RC=$?
set -e

if [[ "$HOOK_RC" -ne 0 ]]; then
  echo "repair hook failed; skip reconcile and terminal summary"
  echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC $(date '+%F %T %Z') ====="
  exit "$HOOK_RC"
fi

echo "repair hook complete; running ledger reconcile"
set +e
node "$RECONCILE"
RECONCILE_RC=$?
set -e

if [[ "$RECONCILE_RC" -ne 0 ]]; then
  echo "ledger reconcile failed; skip terminal summary"
  echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC reconcile=$RECONCILE_RC $(date '+%F %T %Z') ====="
  exit "$RECONCILE_RC"
fi

echo "ledger reconcile complete; emitting one terminal batch summary"
set +e
node "$BATCH_SUMMARY" \
  --since "$RUN_START" \
  --site astrologywiki \
  --plan "$PLAN" \
  --run-id "$RUN_ID"
SUMMARY_RC=$?
set -e

# exit 2 is the documented silent empty/in-flight-only terminal window.
FINAL_RC="$SUMMARY_RC"
if [[ "$SUMMARY_RC" -eq 2 ]]; then FINAL_RC=0; fi

echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC reconcile=$RECONCILE_RC summary=$SUMMARY_RC $(date '+%F %T %Z') ====="
exit "$FINAL_RC"
