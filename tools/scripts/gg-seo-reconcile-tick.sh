#!/usr/bin/env bash

set -euo pipefail

export HOME="${HOME:-/Users/awayer_mini}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="Asia/Shanghai"

ENV_FILE="${GG_ENV_FILE:-$HOME/.config/gg/_gg.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

FLOW="${GG_SEO_RECONCILE_FLOW:-$HOME/gengrowth-flow-mvp}"
LOCK="${GG_SEO_RECONCILE_LOCK:-/tmp/gg-seo-reconcile.lock}"
LOG="${GG_SEO_RECONCILE_LOG:-$HOME/Library/Logs/gg-seo-reconcile.out.log}"
ERR_LOG="${GG_SEO_RECONCILE_ERR_LOG:-$HOME/Library/Logs/gg-seo-reconcile.err.log}"
CONTROLLER="${GG_SEO_REPAIR_CONTROLLER_BIN:-$FLOW/tools/scripts/gg-seo-repair-controller.mjs}"
RECONCILE="${GG_SEO_RECONCILE_BIN:-$FLOW/tools/scripts/gg-ledger-reconcile.mjs}"
READINESS="${GG_SEO_READINESS_BIN:-$FLOW/tools/scripts/gg-seo-readiness.mjs}"
OPS="${GG_OPS_DIR:-$HOME/gengrowth-ops}"
PLAN="${GG_SEO_PLAN:-$OPS/inbox/06-tasks/tasks/2026-05-27-W22-blog-output-plan.md}"
SITE="${GG_SEO_SITE:-astrologywiki}"
LEASE_SECONDS="${GG_SEO_RECONCILE_LEASE_SECONDS:-600}"
BUDGET_SECONDS="${GG_SEO_REPAIR_BUDGET_SECONDS:-240}"

mkdir -p "$(dirname "$LOG")" "$(dirname "$ERR_LOG")"
exec >>"$LOG" 2>>"$ERR_LOG"

[[ -f "$CONTROLLER" ]] || { echo "controller unavailable: $CONTROLLER"; exit 1; }
[[ -f "$RECONCILE" ]] || { echo "reconcile unavailable: $RECONCILE"; exit 1; }
[[ -f "$READINESS" ]] || { echo "readiness unavailable: $READINESS"; exit 1; }
[[ -f "$PLAN" ]] || { echo "plan unavailable: $PLAN"; exit 1; }
if [[ "$PLAN" != /* ]]; then
  PLAN="$(cd "$(dirname "$PLAN")" && pwd -P)/$(basename "$PLAN")"
fi

TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
NOW_EPOCH="$(date +%s)"
EXPIRES_EPOCH="$((NOW_EPOCH + LEASE_SECONDS))"

pid_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

read_owner() {
  node -e '
    const fs = require("node:fs");
    try {
      const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      process.stdout.write([o.pid || "", o.token || "", Date.parse(o.expiresAt || 0) || 0].join("\t"));
    } catch {}
  ' "$LOCK/owner.json"
}

acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    :
  else
    IFS=$'\t' read -r owner_pid owner_token owner_expires_ms <<<"$(read_owner)"
    owner_expires="$(( ${owner_expires_ms:-0} / 1000 ))"
    if pid_alive "${owner_pid:-}" && [[ "$owner_expires" -gt "$NOW_EPOCH" ]]; then
      echo "busy: live unexpired owner pid=$owner_pid token=$owner_token"
      return 1
    fi
    stale="${LOCK}.stale-${NOW_EPOCH}-$$-${TOKEN}"
    if ! mv "$LOCK" "$stale" 2>/dev/null; then
      echo "busy: lock changed during recovery"
      return 1
    fi
    mkdir "$LOCK"
  fi
  node -e '
    const fs = require("node:fs");
    const [path, token, expires, pid] = process.argv.slice(1);
    fs.writeFileSync(path, JSON.stringify({
      pid: Number(pid),
      token,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Number(expires) * 1000).toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });
  ' "$LOCK/owner.json" "$TOKEN" "$EXPIRES_EPOCH" "$$"
}

release_lock() {
  [[ -d "$LOCK" ]] || return 0
  current_token="$(node -e '
    const fs = require("node:fs");
    try { process.stdout.write(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).token || ""); } catch {}
  ' "$LOCK/owner.json")"
  if [[ "$current_token" == "$TOKEN" ]]; then
    rm -f "$LOCK/owner.json"
    rmdir "$LOCK" 2>/dev/null || true
  fi
}

if ! acquire_lock; then exit 0; fi
trap release_lock EXIT

RUN_ID="seo-reconcile-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
NOW_HM="${GG_SEO_RECONCILE_NOW_HM:-$(date +%H%M)}"
controller_rc=0

if (( 10#$NOW_HM >= 1830 && 10#$NOW_HM <= 2200 )); then
  set +e
  node "$CONTROLLER" drain --budget-seconds "$BUDGET_SECONDS"
  controller_rc=$?
  set -e
fi

set +e
STRICT_JSON="$(GG_LARK_NOTIFY_SILENCE="${GG_SEO_RECONCILE_TERMINAL_NOTIFY_SILENCE:-0}" node "$RECONCILE" --strict --json)"
reconcile_rc=$?
set -e
if [[ -z "$STRICT_JSON" ]]; then
  STRICT_JSON='{"ok":false,"pendingWritebackAfter":1,"droppedWritebackAfter":1,"droppedWritebackEvidence":[{"pageId":"UNKNOWN","state":"unknown","stuckSteps":["sheet","plan","archive"],"attempts":0,"firstAt":null,"lastError":"strict reconcile produced no JSON"}],"sheetFlipsAfter":1,"planUncheckedAfter":1,"activeRepairAfter":1,"expiredLeasesAfter":1,"eligibleNeedsHumanAfter":1,"errors":["strict reconcile produced no JSON"]}'
fi
printf '%s\n' "$STRICT_JSON"

set +e
GG_LARK_NOTIFY_SILENCE=1 GG_SEO_STRICT_RESULT_JSON="$STRICT_JSON" \
  node "$READINESS" --site "$SITE" --plan "$PLAN" --run-id "$RUN_ID" --json
readiness_rc=$?
set -e
if [[ "$controller_rc" -ne 0 ]]; then exit "$controller_rc"; fi
if [[ "$reconcile_rc" -ne 0 ]]; then exit "$reconcile_rc"; fi
exit "$readiness_rc"
