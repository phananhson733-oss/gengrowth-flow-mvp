#!/usr/bin/env bash
# macOS LaunchAgent entrypoint: run one fire-scoped nightly workflow, drain repair,
# reconcile ledgers, then emit exactly one terminal batch summary.

set -euo pipefail

export HOME="${HOME:-/Users/awayer_mini}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="Asia/Shanghai"

ENV_FILE="${GG_ENV_FILE:-$HOME/.config/gg/_gg.env}"
readonly PINNED_ORACLE="${GG_AUTOMATION_ORACLE_DIR:-$HOME/oracle-autopilot}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

export GG_WRITEBACK_LOCK_DIR="${GG_WRITEBACK_LOCK_DIR:-${GG_FLOW_STATE_DIR:-$HOME/gengrowth-agents/flow-state}/writeback-ledger.lock}"

FLOW="${GG_SEO_LAUNCHD_FLOW:-$HOME/gengrowth-flow-mvp}"
ORACLE_BASELINE="$PINNED_ORACLE"
LOCK="${GG_SEO_LAUNCHD_LOCK:-/tmp/gg-seo-blog-launchd.lock}"
LOG="${GG_SEO_LAUNCHD_LOG:-$HOME/Library/Logs/gg-seo-blog-launchd.out.log}"
ERR_LOG="${GG_SEO_LAUNCHD_ERR_LOG:-$HOME/Library/Logs/gg-seo-blog-launchd.err.log}"
NIGHTLY="${GG_SEO_NIGHTLY_BIN:-$FLOW/tools/scripts/gg-nightly-seo.sh}"
BRIEF_PREFLIGHT="${GG_SEO_BRIEF_PREFLIGHT_BIN:-$FLOW/tools/scripts/gg-seo-brief-preflight.mjs}"
REPAIR_HOOK="${GG_SEO_REPAIR_HOOK_BIN:-$FLOW/tools/scripts/gg-seo-repair-hook.mjs}"
REPAIR_CONTROLLER="${GG_SEO_REPAIR_CONTROLLER_BIN:-$FLOW/tools/scripts/gg-seo-repair-controller.mjs}"
RECONCILE="${GG_SEO_RECONCILE_BIN:-$FLOW/tools/scripts/gg-ledger-reconcile.mjs}"
READINESS="${GG_SEO_READINESS_BIN:-$FLOW/tools/scripts/gg-seo-readiness.mjs}"
BATCH_SUMMARY="${GG_SEO_BATCH_SUMMARY_BIN:-$FLOW/tools/scripts/gg-batch-summary.mjs}"
CLUSTER_LINKER="${GG_CLUSTER_LINKER_BIN:-$FLOW/tools/scripts/gg-cluster-internal-links.mjs}"
INDEX_MONITOR="${GG_INDEX_MONITOR_BIN:-$FLOW/tools/scripts/gg-index-monitor.mjs}"
SEO_AUTOPILOT="${GG_SEO_AUTOPILOT_BIN:-$FLOW/tools/scripts/gg-seo-autopilot.mjs}"
NIGHTLY_LOG="${GG_SEO_NIGHTLY_LOG:-$HOME/Library/Logs/gg-nightly-seo.log}"
OPS="${GG_OPS_DIR:-$HOME/gengrowth-ops}"
CLUSTER_LINKS_ENABLED="${GG_CLUSTER_LINKS_ENABLED:-1}"
CLUSTER_LINK_INPUT_DIR="${GG_CLUSTER_LINK_INPUT_DIR:-$FLOW/.gg-cache/cluster-links}"
PUBLISH_LOG="${GG_SEO_AUTOPILOT_PUBLISH_LOG:-$OPS/inbox-maboyang/06-tasks/seo-autopilot-publish-log.md}"
PLAN="${GG_SEO_PLAN:-$OPS/inbox-maboyang/06-tasks/tasks/2026-05-27-W22-blog-output-plan.md}"
CANONICAL_CLAIMS="$OPS/inbox-maboyang/06-tasks/tasks/.autopilot-claims.json"
CLAIMS="$CANONICAL_CLAIMS"
INHERITED_SEO_CLAIMS="${GG_SEO_CLAIMS:-}"
INHERITED_NIGHTLY_CLAIMS="${GG_NIGHTLY_CLAIMS:-}"
INHERITED_AUTOPILOT_CLAIMS="${GG_AUTOPILOT_CLAIMS:-}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$ERR_LOG")"
exec >>"$LOG" 2>>"$ERR_LOG"

echo "===== seo-blog launchd tick $(date '+%F %T %Z') ====="

for inherited_claims in \
  "$INHERITED_SEO_CLAIMS" \
  "$INHERITED_NIGHTLY_CLAIMS" \
  "$INHERITED_AUTOPILOT_CLAIMS"; do
  if [[ -n "$inherited_claims" && "$inherited_claims" != "$CLAIMS" ]]; then
    echo "SEO claims path mismatch: every claims override must equal canonical $CANONICAL_CLAIMS"
    exit 1
  fi
done
export GG_SEO_CLAIMS="$CLAIMS"
export GG_NIGHTLY_CLAIMS="$CLAIMS"
export GG_AUTOPILOT_CLAIMS="$CLAIMS"

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
SNAPSHOT_DIR=""
NIGHTLY_ITEMS_PLAN=""
ATTESTED_MANIFEST=""
SNAPSHOT_DIR_IDENTITY=""
SNAPSHOT_FILE_IDENTITY=""
ATTESTED_MANIFEST_IDENTITY=""
SNAPSHOT_DIGEST=""
ATTESTED_MANIFEST_DIGEST=""

lstat_identity() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    stat -f '%d:%i' "$1" 2>/dev/null
  else
    stat -c '%d:%i' "$1" 2>/dev/null
  fi
}

owned_snapshot_dir_is_current() {
  [[ -n "$SNAPSHOT_DIR" && -n "$SNAPSHOT_DIR_IDENTITY" \
    && -d "$SNAPSHOT_DIR" && ! -L "$SNAPSHOT_DIR" ]] \
    && [[ "$(lstat_identity "$SNAPSHOT_DIR" 2>/dev/null || true)" == "$SNAPSHOT_DIR_IDENTITY" ]]
}

owned_regular_file_is_current() {
  local path="$1"
  local identity="$2"
  [[ -n "$path" && -n "$identity" && -f "$path" && ! -L "$path" ]] \
    && [[ "$(lstat_identity "$path" 2>/dev/null || true)" == "$identity" ]]
}

cleanup_owned_snapshot_and_lock() {
  local cleanup_safe=1
  if [[ -n "$SNAPSHOT_DIR" ]]; then
    if ! owned_snapshot_dir_is_current; then
      echo "snapshot cleanup ownership unknown: directory identity changed; evidence retained"
      cleanup_safe=0
    fi
    if [[ -n "$NIGHTLY_ITEMS_PLAN" \
      && "$NIGHTLY_ITEMS_PLAN" == "$SNAPSHOT_DIR/active-plan.md" ]]; then
      if ! owned_regular_file_is_current "$NIGHTLY_ITEMS_PLAN" "$SNAPSHOT_FILE_IDENTITY"; then
        echo "snapshot cleanup ownership unknown: plan identity changed; evidence retained"
        cleanup_safe=0
      fi
    else
      cleanup_safe=0
    fi
    if [[ -n "$ATTESTED_MANIFEST" && ( -e "$ATTESTED_MANIFEST" || -L "$ATTESTED_MANIFEST" ) ]]; then
      if [[ "$ATTESTED_MANIFEST" != "$SNAPSHOT_DIR/attested-manifest.json" ]] \
        || ! owned_regular_file_is_current "$ATTESTED_MANIFEST" "$ATTESTED_MANIFEST_IDENTITY"; then
        echo "snapshot cleanup ownership unknown: manifest identity changed; evidence retained"
        cleanup_safe=0
      fi
    elif [[ -n "$ATTESTED_MANIFEST_IDENTITY" ]]; then
      echo "snapshot cleanup ownership unknown: manifest disappeared; evidence retained"
      cleanup_safe=0
    fi
    if [[ "$cleanup_safe" -eq 1 ]] && owned_snapshot_dir_is_current; then
      if [[ -n "$ATTESTED_MANIFEST_IDENTITY" ]]; then
        rm -f "$ATTESTED_MANIFEST" 2>/dev/null || cleanup_safe=0
      fi
      if [[ "$cleanup_safe" -eq 1 ]] \
        && owned_snapshot_dir_is_current \
        && owned_regular_file_is_current "$NIGHTLY_ITEMS_PLAN" "$SNAPSHOT_FILE_IDENTITY"; then
        rm -f "$NIGHTLY_ITEMS_PLAN" 2>/dev/null || cleanup_safe=0
      fi
      if [[ "$cleanup_safe" -eq 1 ]] && owned_snapshot_dir_is_current; then
        rmdir "$SNAPSHOT_DIR" 2>/dev/null || true
      fi
    fi
  fi
  rmdir "$LOCK" 2>/dev/null || true
}
trap cleanup_owned_snapshot_and_lock EXIT

# Preserve the dedicated unattended baseline even when the shared environment
# file contains an interactive Oracle checkout.
export GG_AUTOMATION_ORACLE_DIR="$ORACLE_BASELINE"
export GG_ORACLE_DIR="$ORACLE_BASELINE"

[[ -x "$NIGHTLY" ]] || { echo "nightly wrapper unavailable: $NIGHTLY"; exit 1; }
[[ -f "$BRIEF_PREFLIGHT" ]] || { echo "SEO brief preflight unavailable: $BRIEF_PREFLIGHT"; exit 1; }
[[ -f "$REPAIR_HOOK" ]] || { echo "repair hook unavailable: $REPAIR_HOOK"; exit 1; }
[[ -f "$REPAIR_CONTROLLER" ]] || { echo "repair controller unavailable: $REPAIR_CONTROLLER"; exit 1; }
[[ -f "$RECONCILE" ]] || { echo "ledger reconcile unavailable: $RECONCILE"; exit 1; }
[[ -f "$READINESS" ]] || { echo "SEO readiness unavailable: $READINESS"; exit 1; }
[[ -f "$BATCH_SUMMARY" ]] || { echo "batch summary unavailable: $BATCH_SUMMARY"; exit 1; }
NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "node runtime unavailable"; exit 1; }
[[ -d "$ORACLE_BASELINE/.git" ]] || { echo "clean Oracle baseline unavailable: $ORACLE_BASELINE"; exit 1; }
[[ -f "$PLAN" ]] || { echo "pinned SEO plan unavailable: $PLAN"; exit 1; }
[[ -f "$CLAIMS" ]] || { echo "SEO claims ledger unavailable: $CLAIMS"; exit 1; }
if [[ "$PLAN" != /* ]]; then
  PLAN="$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")"
fi

flush_writeback_notifications() {
  local notify_rc=0
  set +e
  GG_LARK_NOTIFY_SILENCE=0 node "$RECONCILE" --notify-only --json
  notify_rc=$?
  set -e
  if [[ "$notify_rc" -ne 0 ]]; then
    echo "writeback notification flush failed rc=$notify_rc; durable sidecars retained"
  fi
}

pre_fire_reconcile_allows_repairable_drift() {
  local strict_json="$1"
  node -e '
    const raw = process.argv[1];
    let value;
    try { value = JSON.parse(raw); } catch { process.exit(1); }
    if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
    const counters = [
      "pendingWritebackAfter",
      "droppedWritebackAfter",
      "sheetFlipsAfter",
      "planUncheckedAfter",
      "activeRepairAfter",
      "expiredLeasesAfter",
      "eligibleNeedsHumanAfter",
    ];
    const allowedKeys = new Set([
      "ok",
      ...counters,
      "droppedWritebackEvidence",
      "errors",
    ]);
    const keys = Object.keys(value);
    if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
      process.exit(1);
    }
    if (value.ok !== false) process.exit(1);
    if (!counters.every((field) => Number.isInteger(value[field]) && value[field] >= 0)) {
      process.exit(1);
    }
    const requiredZero = [
      "pendingWritebackAfter",
      "droppedWritebackAfter",
      "sheetFlipsAfter",
      "activeRepairAfter",
      "expiredLeasesAfter",
    ];
    const repairable = ["planUncheckedAfter", "eligibleNeedsHumanAfter"];
    const zero = requiredZero.every((field) => value[field] === 0);
    const hasRepairableDrift = repairable.some((field) => value[field] > 0);
    const validDroppedEvidence = Array.isArray(value.droppedWritebackEvidence)
      && value.droppedWritebackEvidence.length === value.droppedWritebackAfter;
    const noErrors = Array.isArray(value.errors) && value.errors.length === 0;
    process.exit(zero && hasRepairableDrift && validDroppedEvidence && noErrors ? 0 : 1);
  ' "$strict_json"
}

post_fire_reconcile_allows_plan_backlog() {
  local strict_json="$1"
  node -e '
    const raw = process.argv[1];
    let value;
    try { value = JSON.parse(raw); } catch { process.exit(1); }
    if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
    const counters = [
      "pendingWritebackAfter",
      "droppedWritebackAfter",
      "sheetFlipsAfter",
      "planUncheckedAfter",
      "activeRepairAfter",
      "expiredLeasesAfter",
      "eligibleNeedsHumanAfter",
    ];
    const allowedKeys = new Set([
      "ok",
      ...counters,
      "droppedWritebackEvidence",
      "errors",
    ]);
    const keys = Object.keys(value);
    if (keys.length !== allowedKeys.size || keys.some((key) => !allowedKeys.has(key))) {
      process.exit(1);
    }
    if (value.ok !== false) process.exit(1);
    if (!counters.every((field) => Number.isInteger(value[field]) && value[field] >= 0)) {
      process.exit(1);
    }
    const requiredZero = [
      "pendingWritebackAfter",
      "droppedWritebackAfter",
      "sheetFlipsAfter",
      "activeRepairAfter",
      "expiredLeasesAfter",
      "eligibleNeedsHumanAfter",
    ];
    const zero = requiredZero.every((field) => value[field] === 0);
    const validDroppedEvidence = Array.isArray(value.droppedWritebackEvidence)
      && value.droppedWritebackEvidence.length === 0;
    const noErrors = Array.isArray(value.errors) && value.errors.length === 0;
    process.exit(zero && value.planUncheckedAfter > 0 && validDroppedEvidence && noErrors ? 0 : 1);
  ' "$strict_json"
}

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

plan_digest() {
  local digest_output
  digest_output="$(shasum -a 256 "$1" 2>/dev/null)" || return 1
  printf '%s\n' "${digest_output%% *}"
}

snapshot_binding_is_valid() {
  owned_snapshot_dir_is_current \
    && owned_regular_file_is_current "$NIGHTLY_ITEMS_PLAN" "$SNAPSHOT_FILE_IDENTITY" \
    && [[ "$(plan_digest "$NIGHTLY_ITEMS_PLAN" 2>/dev/null || true)" == "$SNAPSHOT_DIGEST" ]]
}

attested_bundle_is_valid() {
  snapshot_binding_is_valid \
    && owned_regular_file_is_current "$ATTESTED_MANIFEST" "$ATTESTED_MANIFEST_IDENTITY" \
    && [[ "$(plan_digest "$ATTESTED_MANIFEST" 2>/dev/null || true)" == "$ATTESTED_MANIFEST_DIGEST" ]]
}

if ! PLAN_DIGEST_BEFORE="$(plan_digest "$PLAN")"; then
  echo "active brief snapshot could not be proven; abort before nightly"
  exit 1
fi
if ! SNAPSHOT_DIR="$(umask 077; mktemp -d "${TMPDIR:-/tmp}/gg-seo-active-plan.XXXXXX")"; then
  echo "active brief snapshot could not be proven; abort before nightly"
  exit 1
fi
SNAPSHOT_DIR_IDENTITY="$(lstat_identity "$SNAPSHOT_DIR" 2>/dev/null || true)"
if [[ -z "$SNAPSHOT_DIR_IDENTITY" || -L "$SNAPSHOT_DIR" ]]; then
  echo "active brief snapshot directory identity could not be proven; abort before nightly"
  exit 1
fi
NIGHTLY_ITEMS_PLAN="$SNAPSHOT_DIR/active-plan.md"
ATTESTED_MANIFEST="$SNAPSHOT_DIR/attested-manifest.json"
if ! cp "$PLAN" "$NIGHTLY_ITEMS_PLAN" || ! chmod 400 "$NIGHTLY_ITEMS_PLAN"; then
  echo "active brief snapshot could not be proven; abort before nightly"
  exit 1
fi
SNAPSHOT_FILE_IDENTITY="$(lstat_identity "$NIGHTLY_ITEMS_PLAN" 2>/dev/null || true)"
if ! PLAN_DIGEST_AFTER="$(plan_digest "$PLAN")" \
  || ! SNAPSHOT_DIGEST="$(plan_digest "$NIGHTLY_ITEMS_PLAN")" \
  || [[ -z "$PLAN_DIGEST_BEFORE" || -z "$SNAPSHOT_FILE_IDENTITY" \
    || "$PLAN_DIGEST_BEFORE" != "$PLAN_DIGEST_AFTER" \
    || "$PLAN_DIGEST_BEFORE" != "$SNAPSHOT_DIGEST" ]] \
  || ! snapshot_binding_is_valid; then
  echo "active brief snapshot could not be proven; abort before nightly"
  exit 1
fi

echo "running active brief Cluster readiness preflight"
set +e
GG_LARK_NOTIFY_SILENCE=1 node "$BRIEF_PREFLIGHT" \
  --plan "$NIGHTLY_ITEMS_PLAN" \
  --attested-manifest "$ATTESTED_MANIFEST" \
  --json
BRIEF_PREFLIGHT_RC=$?
set -e
if [[ -f "$ATTESTED_MANIFEST" && ! -L "$ATTESTED_MANIFEST" ]]; then
  ATTESTED_MANIFEST_IDENTITY="$(lstat_identity "$ATTESTED_MANIFEST" 2>/dev/null || true)"
  ATTESTED_MANIFEST_DIGEST="$(plan_digest "$ATTESTED_MANIFEST" 2>/dev/null || true)"
fi
if ! snapshot_binding_is_valid; then
  echo "active brief snapshot changed during preflight; abort before nightly"
  exit 1
fi
if [[ "$BRIEF_PREFLIGHT_RC" -ne 0 ]]; then
  echo "active brief preflight failed rc=$BRIEF_PREFLIGHT_RC; abort before nightly"
  exit "$BRIEF_PREFLIGHT_RC"
fi
if [[ -z "$ATTESTED_MANIFEST_IDENTITY" || -z "$ATTESTED_MANIFEST_DIGEST" ]] \
  || ! attested_bundle_is_valid; then
  echo "active brief attested manifest could not be proven; abort before nightly"
  exit 1
fi
echo "active brief preflight passed"

RUN_START="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
RUN_ID="seo-blog-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
LOG_OFFSET=0
if [[ -f "$NIGHTLY_LOG" ]]; then
  LOG_OFFSET="$(wc -c < "$NIGHTLY_LOG" | tr -d ' ')"
fi
export GG_SEO_REPAIR_RUN_ID="$RUN_ID"
export GG_SEO_REPAIR_LOG_FILE="$NIGHTLY_LOG"
export GG_SEO_REPAIR_LOG_OFFSET_START="$LOG_OFFSET"
unset GG_SEO_REPAIR_LOG_OFFSET_END

echo "running pre-fire repair drain"
set +e
node "$REPAIR_CONTROLLER" drain --budget-seconds "${GG_SEO_REPAIR_BUDGET_SECONDS:-1500}"
PRE_DRAIN_RC=$?
set -e
if [[ "$PRE_DRAIN_RC" -ne 0 ]]; then
  echo "pre-fire repair drain failed; abort before nightly"
  exit "$PRE_DRAIN_RC"
fi

echo "running pre-fire strict ledger reconcile"
set +e
PRE_STRICT_JSON="$(GG_LARK_NOTIFY_SILENCE=1 node "$RECONCILE" --strict --json)"
PRE_RECONCILE_RC=$?
set -e
printf '%s\n' "$PRE_STRICT_JSON"
flush_writeback_notifications
if [[ "$PRE_RECONCILE_RC" -ne 0 ]]; then
  if [[ "$PRE_RECONCILE_RC" -eq 2 ]] \
    && pre_fire_reconcile_allows_repairable_drift "$PRE_STRICT_JSON"; then
    echo "pre-fire reconcile has repairable plan/needs-human drift; continue"
  else
    echo "pre-fire strict reconcile failed; abort before nightly"
    exit "$PRE_RECONCILE_RC"
  fi
fi

if ! attested_bundle_is_valid; then
  echo "active brief snapshot identity or integrity failed immediately before nightly; abort"
  exit 1
fi

echo "single-executor preflight passed; starting deterministic SEO nightly"
set +e
GG_SEO_PLAN="$PLAN" \
GG_NIGHTLY_ITEMS_PLAN="$NIGHTLY_ITEMS_PLAN" \
GG_NIGHTLY_ITEMS_SHA256="$SNAPSHOT_DIGEST" \
GG_NIGHTLY_ITEMS_IDENTITY="$SNAPSHOT_FILE_IDENTITY" \
GG_NIGHTLY_ITEMS_DIR_IDENTITY="$SNAPSHOT_DIR_IDENTITY" \
GG_NIGHTLY_ATTESTED_MANIFEST="$ATTESTED_MANIFEST" \
GG_NIGHTLY_ATTESTED_MANIFEST_SHA256="$ATTESTED_MANIFEST_DIGEST" \
GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY="$ATTESTED_MANIFEST_IDENTITY" \
GG_NIGHTLY_VALIDATOR_NODE="$NODE_BIN" \
GG_NIGHTLY_CLAIMS="$CLAIMS" \
GG_SEO_CLAIMS="$CLAIMS" \
GG_AUTOPILOT_CLAIMS="$CLAIMS" \
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
  echo "repair hook failed; skip post-drain, reconcile, readiness, and terminal summary"
  echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC $(date '+%F %T %Z') ====="
  exit "$HOOK_RC"
fi

echo "repair hook complete; running post-fire repair drain"
set +e
node "$REPAIR_CONTROLLER" drain --budget-seconds "${GG_SEO_REPAIR_BUDGET_SECONDS:-1500}"
POST_DRAIN_RC=$?
set -e
if [[ "$POST_DRAIN_RC" -ne 0 ]]; then
  echo "post-fire repair drain failed; skip reconcile, readiness, and terminal summary"
  exit "$POST_DRAIN_RC"
fi

echo "post-fire drain complete; running strict ledger reconcile"
set +e
STRICT_JSON="$(GG_LARK_NOTIFY_SILENCE=1 node "$RECONCILE" --strict --json)"
RECONCILE_RC=$?
set -e
printf '%s\n' "$STRICT_JSON"
flush_writeback_notifications

if [[ "$RECONCILE_RC" -ne 0 ]]; then
  if [[ "$RECONCILE_RC" -eq 2 ]] \
    && post_fire_reconcile_allows_plan_backlog "$STRICT_JSON"; then
    echo "post-fire reconcile has future plan backlog; continue"
  else
    echo "strict ledger reconcile failed; skip readiness and terminal summary"
    echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC reconcile=$RECONCILE_RC $(date '+%F %T %Z') ====="
    exit "$RECONCILE_RC"
  fi
fi

if [[ "$CLUSTER_LINKS_ENABLED" == "1" ]]; then
  [[ -f "$CLUSTER_LINKER" ]] || { echo "cluster linker unavailable: $CLUSTER_LINKER"; exit 1; }
  [[ -f "$INDEX_MONITOR" ]] || { echo "index monitor unavailable: $INDEX_MONITOR"; exit 1; }
  [[ -f "$SEO_AUTOPILOT" ]] || { echo "SEO autopilot unavailable: $SEO_AUTOPILOT"; exit 1; }
  CLUSTER_LINK_INPUT="$CLUSTER_LINK_INPUT_DIR/$RUN_ID.json"
  mkdir -p "$CLUSTER_LINK_INPUT_DIR"
  echo "strict reconcile complete; syncing published pages into Result Recap before Cluster link snapshot"
  node "$INDEX_MONITOR" --sync-published --write-sheet
  node "$INDEX_MONITOR" --sync-recap --write-sheet
  echo "strict reconcile complete; building OPS-approved Cluster link snapshot"
  set +e
  GG_FLOW_REPO="$FLOW" GG_OPS_DIR="$OPS" GG_ORACLE_DIR="$ORACLE_BASELINE" \
    node "$CLUSTER_LINKER" \
      --build-input \
      --published-log "$PUBLISH_LOG" \
      --oracle "$ORACLE_BASELINE" \
      --out "$CLUSTER_LINK_INPUT"
  CLUSTER_INPUT_RC=$?
  set -e
  if [[ "$CLUSTER_INPUT_RC" -ne 0 ]]; then
    echo "Cluster link input build failed; skip readiness and terminal summary"
    exit "$CLUSTER_INPUT_RC"
  fi
  echo "Cluster link snapshot ready; creating review-gated Oracle PR when links changed"
  set +e
  GG_FLOW_REPO="$FLOW" GG_OPS_DIR="$OPS" GG_ORACLE_DIR="$ORACLE_BASELINE" \
    node "$SEO_AUTOPILOT" --cluster-link-pr --cluster-link-input "$CLUSTER_LINK_INPUT"
  CLUSTER_PR_RC=$?
  set -e
  if [[ "$CLUSTER_PR_RC" -ne 0 ]]; then
    echo "Cluster link PR stage failed; skip readiness and terminal summary"
    exit "$CLUSTER_PR_RC"
  fi
else
  echo "Cluster link PR stage disabled (set GG_CLUSTER_LINKS_ENABLED=1 after OPS Cluster migration readiness)"
fi

echo "strict reconcile complete; evaluating terminal readiness"
set +e
GG_LARK_NOTIFY_SILENCE=1 GG_SEO_STRICT_RESULT_JSON="$STRICT_JSON" \
  node "$READINESS" \
  --site astrologywiki \
  --plan "$PLAN" \
  --run-id "$RUN_ID" \
  --allow-plan-backlog \
  --json
READINESS_RC=$?
set -e
if [[ "$READINESS_RC" -ne 0 ]]; then
  echo "readiness blocked; skip terminal summary"
  exit "$READINESS_RC"
fi

echo "readiness confirmed; emitting one terminal batch summary"
set +e
node "$BATCH_SUMMARY" \
  --since "$RUN_START" \
  --site astrologywiki \
  --plan "$PLAN" \
  --run-id "$RUN_ID"
SUMMARY_RC=$?
set -e

echo "===== seo-blog launchd tick complete nightly=$NIGHTLY_RC hook=$HOOK_RC reconcile=$RECONCILE_RC readiness=$READINESS_RC summary=$SUMMARY_RC $(date '+%F %T %Z') ====="
exit "$READINESS_RC"
