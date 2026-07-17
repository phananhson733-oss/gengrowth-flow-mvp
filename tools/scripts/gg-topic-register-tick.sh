#!/bin/bash
# gg-topic-register-tick.sh — Codex automation wrapper for Sheet topic registration.
#
# Safe default:
#   - loads the shared local gg environment
#   - runs gg-topic-register.mjs across configured products
#   - defaults to dry-run; only writes Sheets/task plans/Feishu when
#     GG_TOPIC_REGISTER_APPLY=1 is explicitly set
#   - writes a daily log under cron-sync/topic_register
#
# Useful knobs for Codex automation:
#   GG_TOPIC_REGISTER_PRODUCTS="all"          # astrologywiki | gengrowth | all
#   GG_TOPIC_REGISTER_LIMIT=10
#   GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE=0
#   GG_TOPIC_REGISTER_LLM="claude"            # claude | codex | hermes | none
#   GG_TOPIC_REGISTER_LLM=claude              # invokes text-only worker: claude -p --model claude-opus-4-7
#   GG_TOPIC_REGISTER_LLM_TIMEOUT_MS=240000   # per preprocessor LLM call timeout
#   GG_TOPIC_REGISTER_DISCOVER_EVIDENCE=""     # default: 1 when LLM is enabled, else 0
#   GG_TOPIC_REGISTER_SEARCH_PROVIDERS="google,duckduckgo"
#                                               # google requires CSE env; duckduckgo is no-API fallback; add bing explicitly only for diagnostics
#   GG_TOPIC_REGISTER_SEARCH_TIMEOUT_MS=8000    # per search-provider request timeout
#   GG_TOPIC_REGISTER_GOOGLE_CSE_KEY=""         # optional Google Custom Search JSON API key
#   GG_TOPIC_REGISTER_GOOGLE_CSE_CX=""          # optional Programmable Search Engine id
#   GG_TOPIC_REGISTER_ALLOW_PREPROCESSOR_FALLBACK=1
#                                               # v2 failure falls back to v1 Friction + Content_Angle
#   GG_TOPIC_REGISTER_APPLY=0                 # 1 = add --apply
#   GG_TOPIC_REGISTER_OVERWRITE=0
#   GG_TOPIC_REGISTER_TAXONOMY_ONLY=0          # repair option fields only; do not write v2 preprocessor columns
#   GG_TOPIC_REGISTER_NO_NOTIFY=0
#   GG_TOPIC_REGISTER_REPAIR_PAGE_IDS=""       # comma-separated PG-* ids to reassign
#   GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY=0    # only repair existing semantic fields; never generate/audit/reassign
#   GG_TOPIC_REGISTER_REQUIRE_RUN=0             # 1 = lock skip is a temporary failure (exit 75)
#   GG_TOPIC_REGISTER_RESULT_FILE=""            # optional atomic pure-JSON result artifact
#   GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS=5  # bounded grace before pid-less lock/claim recovery
#   GG_TOPIC_REGISTER_REPAIR_KEYWORDS=""       # comma-separated target keywords to reassign
#   GG_TOPIC_REGISTER_REASSIGN_EXISTING=0      # ignore existing page_id/cluster_id for repair
#   GG_TOPIC_REGISTER_TIMEOUT=900
#   GG_TOPIC_REGISTER_RUN_BUDGET_MS=""          # default: outer timeout minus 60s, passed to Node for graceful summary
#
# Learned operating contract:
#   - Periodic runs audit the full configured Sheet before generating. If any
#     existing topic row has missing required fields, repair those rows first;
#     only generate new page_ids when no existing incomplete rows remain.
#   - Do not use manual Codex/websearch output as production evidence. Search must
#     enter the deterministic run through a script-callable provider and cache.
#   - Bing is opt-in only (`GG_TOPIC_REGISTER_SEARCH_PROVIDERS=...,bing`) because
#     it produced weak/irrelevant trend SERPs in live runs; prefer Google CSE when
#     configured, otherwise DuckDuckGo HTML fallback.
#   - `claude` is a pure text-only worker (`claude -p --model claude-opus-4-7`):
#     prompt on stdin, SHEET_FIELDS on stdout, no Bash/Edit/Write/MCP side effects.
#     Node owns Sheet/task/Feishu writes, parsing, retries, and safety gates.
#   - Keep `GG_TOPIC_REGISTER_LLM_TIMEOUT_MS` bounded; failed/invalid LLM rows are
#     recorded per row instead of aborting the whole product run.
#   - For cleanup/repair reruns after a successful notification, use
#     `GG_TOPIC_REGISTER_NO_NOTIFY=1` to avoid duplicate Feishu noise.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$HOME/.npm-global/bin:$HOME/.local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${GG_TOPIC_REGISTER_LOG_DIR:-$HOME/gengrowth-agents/cron-sync/topic_register}"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
LOCK="${GG_TOPIC_REGISTER_LOCK:-/tmp/gg-topic-register.lock}"
GG_ENV_FILE="${GG_TOPIC_REGISTER_ENV_FILE:-$HOME/.config/gg/_gg.env}"

OVERRIDE_NAMES=(
  GG_TOPIC_REGISTER_PRODUCTS
  GG_TOPIC_REGISTER_LIMIT
  GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE
  GG_TOPIC_REGISTER_LLM
  GG_TOPIC_REGISTER_LLM_TIMEOUT_MS
  GG_TOPIC_REGISTER_DISCOVER_EVIDENCE
  GG_TOPIC_REGISTER_SEARCH_PROVIDERS
  GG_TOPIC_REGISTER_SEARCH_TIMEOUT_MS
  GG_TOPIC_REGISTER_GOOGLE_CSE_KEY
  GG_TOPIC_REGISTER_GOOGLE_CSE_CX
  GG_TOPIC_REGISTER_ALLOW_PREPROCESSOR_FALLBACK
  GG_TOPIC_REGISTER_APPLY
  GG_TOPIC_REGISTER_OVERWRITE
  GG_TOPIC_REGISTER_TAXONOMY_ONLY
  GG_TOPIC_REGISTER_NO_NOTIFY
  GG_TOPIC_REGISTER_REPAIR_PAGE_IDS
  GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY
  GG_TOPIC_REGISTER_REQUIRE_RUN
  GG_TOPIC_REGISTER_RESULT_FILE
  GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS
  GG_TOPIC_REGISTER_REPAIR_KEYWORDS
  GG_TOPIC_REGISTER_REASSIGN_EXISTING
  GG_TOPIC_REGISTER_TIMEOUT
  GG_TOPIC_REGISTER_RUN_BUDGET_MS
)
EXPLICIT_OVERRIDE_NAMES=()
EXPLICIT_OVERRIDE_VALUES=()
for name in "${OVERRIDE_NAMES[@]}"; do
  if [ "${!name+x}" = "x" ]; then
    EXPLICIT_OVERRIDE_NAMES+=("$name")
    EXPLICIT_OVERRIDE_VALUES+=("${!name}")
  fi
done

if [ -f "$GG_ENV_FILE" ]; then
  set -a
  . "$GG_ENV_FILE" 2>/dev/null
  set +a
fi
for i in "${!EXPLICIT_OVERRIDE_NAMES[@]}"; do
  name="${EXPLICIT_OVERRIDE_NAMES[$i]}"
  printf -v "$name" '%s' "${EXPLICIT_OVERRIDE_VALUES[$i]}"
  export "$name"
done

PRODUCTS="${GG_TOPIC_REGISTER_PRODUCTS:-all}"
LIMIT="${GG_TOPIC_REGISTER_LIMIT:-10}"
INCLUDE_INCOMPLETE="${GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE:-0}"
LLM="${GG_TOPIC_REGISTER_LLM:-claude}"
export GG_TOPIC_REGISTER_LLM_TIMEOUT_MS="${GG_TOPIC_REGISTER_LLM_TIMEOUT_MS:-120000}"
DISCOVER_EVIDENCE="${GG_TOPIC_REGISTER_DISCOVER_EVIDENCE:-}"
if [ -z "$DISCOVER_EVIDENCE" ]; then
  DISCOVER_EVIDENCE="1"
  if [ -z "$LLM" ] || [ "$LLM" = "0" ] || [ "$LLM" = "none" ]; then
    DISCOVER_EVIDENCE="0"
  fi
fi
ALLOW_FALLBACK="${GG_TOPIC_REGISTER_ALLOW_PREPROCESSOR_FALLBACK:-1}"
APPLY="${GG_TOPIC_REGISTER_APPLY:-0}"
OVERWRITE="${GG_TOPIC_REGISTER_OVERWRITE:-0}"
TAXONOMY_ONLY="${GG_TOPIC_REGISTER_TAXONOMY_ONLY:-0}"
NO_NOTIFY="${GG_TOPIC_REGISTER_NO_NOTIFY:-0}"
REPAIR_PAGE_IDS="${GG_TOPIC_REGISTER_REPAIR_PAGE_IDS:-}"
SEMANTIC_REPAIR_ONLY="${GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY:-0}"
REQUIRE_RUN="${GG_TOPIC_REGISTER_REQUIRE_RUN:-0}"
RESULT_FILE="${GG_TOPIC_REGISTER_RESULT_FILE:-}"
LOCK_INIT_GRACE_SECONDS="${GG_TOPIC_REGISTER_LOCK_INIT_GRACE_SECONDS:-5}"
case "$LOCK_INIT_GRACE_SECONDS" in
  ''|*[!0-9]*) LOCK_INIT_GRACE_SECONDS=5 ;;
esac
REPAIR_KEYWORDS="${GG_TOPIC_REGISTER_REPAIR_KEYWORDS:-}"
REASSIGN_EXISTING="${GG_TOPIC_REGISTER_REASSIGN_EXISTING:-0}"
TIMEOUT="${GG_TOPIC_REGISTER_TIMEOUT:-900}"
RUN_BUDGET_MS="${GG_TOPIC_REGISTER_RUN_BUDGET_MS:-}"
if [ -z "$RUN_BUDGET_MS" ] && [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
  if [ "$TIMEOUT" -gt 75 ]; then
    RUN_BUDGET_MS=$(( (TIMEOUT - 60) * 1000 ))
  elif [ "$TIMEOUT" -gt 15 ]; then
    RUN_BUDGET_MS=$(( (TIMEOUT - 10) * 1000 ))
  else
    RUN_BUDGET_MS=$(( TIMEOUT * 1000 ))
  fi
fi

build_cmd() {
  CMD=(node "$SCRIPT_DIR/gg-topic-register.mjs" --product "$PRODUCTS" --limit "$LIMIT")

  if [ "$INCLUDE_INCOMPLETE" = "1" ]; then
    CMD+=(--include-incomplete)
  fi
  if [ -n "$LLM" ] && [ "$LLM" != "0" ] && [ "$LLM" != "none" ]; then
    CMD+=(--llm "$LLM")
  fi
  if [ "$DISCOVER_EVIDENCE" = "1" ]; then
    CMD+=(--discover-evidence)
  fi
  # v1 fallback 默认开（gg-topic-register.mjs 默认 v2 失败即回落 v1）；
  # 仅在显式关闭时传 --no-preprocessor-fallback。
  if [ "$ALLOW_FALLBACK" != "1" ]; then
    CMD+=(--no-preprocessor-fallback)
  fi
  if [ "$APPLY" = "1" ]; then
    CMD+=(--apply)
  fi
  if [ "$OVERWRITE" = "1" ]; then
    CMD+=(--overwrite)
  fi
  if [ "$TAXONOMY_ONLY" = "1" ]; then
    CMD+=(--taxonomy-only)
  fi
  if [ "$NO_NOTIFY" = "1" ]; then
    CMD+=(--no-notify)
  fi
  if [ -n "$REPAIR_PAGE_IDS" ]; then
    CMD+=(--repair-page-ids "$REPAIR_PAGE_IDS")
  fi
  if [ "$SEMANTIC_REPAIR_ONLY" = "1" ]; then
    CMD+=(--semantic-repair-only)
  fi
  if [ -n "$REPAIR_KEYWORDS" ]; then
    CMD+=(--repair-keywords "$REPAIR_KEYWORDS")
  fi
  if [ "$REASSIGN_EXISTING" = "1" ]; then
    CMD+=(--reassign-existing)
  fi
  if [ -n "$RUN_BUDGET_MS" ] && [ "$RUN_BUDGET_MS" != "0" ]; then
    CMD+=(--run-budget-ms "$RUN_BUDGET_MS")
  fi
}

print_cmd() {
  local first=1
  for arg in "${CMD[@]}"; do
    if [ "$first" = "1" ]; then
      printf '%s' "$arg"
      first=0
    else
      printf ' %s' "$arg"
    fi
  done
  printf '\n'
}

build_cmd

write_result() {
  local json="$1"
  if [ -n "$RESULT_FILE" ]; then
    mkdir -p "$(dirname "$RESULT_FILE")"
    local tmp_result="${RESULT_FILE}.tmp.$$"
    printf '%s\n' "$json" > "$tmp_result"
    mv "$tmp_result" "$RESULT_FILE"
  fi
}

log_skip_json() {
  local reason="$1"
  local active_pid="${2:-}"
  local ok="true"
  if [ "$REQUIRE_RUN" = "1" ]; then ok="false"; fi
  local json
  if [ -n "$active_pid" ]; then
    json="$(printf '{"ok":%s,"skipped": true,"reason":"%s","active_pid":"%s"}' "$ok" "$reason" "$active_pid")"
  else
    json="$(printf '{"ok":%s,"skipped": true,"reason":"%s"}' "$ok" "$reason")"
  fi
  printf '%s\n' "$json" >> "$LOG"
  write_result "$json"
}

skip_lock_conflict() {
  local current_pid
  current_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if pid_is_live "$current_pid"; then
    echo "$(date '+%F %T') skip — previous topic-register run (pid $current_pid) still active" >> "$LOG"
    log_skip_json "lock_active" "$current_pid"
  else
    echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"
    log_skip_json "lock_race"
  fi
  if [ "$REQUIRE_RUN" = "1" ]; then exit 75; fi
  exit 0
}

fail_lock_race() {
  echo "$(date '+%F %T') skip — lock ownership could not be proven" >> "$LOG"
  log_skip_json "lock_race"
  if [ "$REQUIRE_RUN" = "1" ]; then exit 75; fi
  exit 0
}

pid_is_live() {
  local candidate_pid="$1"
  case "$candidate_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$candidate_pid" -le 0 ]; then
    return 1
  fi
  kill -0 "$candidate_pid" 2>/dev/null
}

path_identity() {
  stat -f '%d:%i' "$1" 2>/dev/null || stat -c '%d:%i' "$1" 2>/dev/null
}

path_is_past_init_grace() {
  local target="$1"
  local mtime
  local now
  local age
  mtime="$(stat -f '%m' "$target" 2>/dev/null || stat -c '%Y' "$target" 2>/dev/null)" || return 1
  now="$(date +%s)" || return 1
  case "$mtime" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "$mtime" -gt "$now" ]; then
    return 1
  fi
  age=$((now - mtime))
  [ "$age" -ge "$LOCK_INIT_GRACE_SECONDS" ]
}

publish_owner_pid() {
  local owner_dir="$1"
  local pid_tmp="$owner_dir/.pid.$$"
  local published_pid
  if [ -e "$pid_tmp" ] || [ -L "$pid_tmp" ]; then
    return 1
  fi
  if ! (umask 077 && printf '%s\n' "$$" > "$pid_tmp"); then
    return 1
  fi
  if ! mv "$pid_tmp" "$owner_dir/pid" 2>/dev/null; then
    return 1
  fi
  published_pid="$(cat "$owner_dir/pid" 2>/dev/null)"
  [ "$published_pid" = "$$" ]
}

release_reclaim_claim() {
  local claim_dir="$1"
  local claim_pid
  local claim_identity
  local moved_identity
  local claim_quarantine="${LOCK}.reclaim-release.$$"
  claim_pid="$(cat "$claim_dir/pid" 2>/dev/null)"
  if [ "$claim_pid" != "$$" ]; then
    return
  fi
  claim_identity="$(path_identity "$claim_dir")"
  if [ -z "$claim_identity" ]; then
    return
  fi
  if [ -e "$claim_quarantine" ] || [ -L "$claim_quarantine" ]; then
    return
  fi
  if mv "$claim_dir" "$claim_quarantine" 2>/dev/null; then
    claim_pid="$(cat "$claim_quarantine/pid" 2>/dev/null)"
    moved_identity="$(path_identity "$claim_quarantine")"
    if [ "$claim_pid" = "$$" ] && [ "$moved_identity" = "$claim_identity" ]; then
      rm -rf "$claim_quarantine" 2>/dev/null
    elif [ ! -e "$claim_dir" ] && [ ! -L "$claim_dir" ]; then
      mv "$claim_quarantine" "$claim_dir" 2>/dev/null
    fi
  fi
}

recover_abandoned_reclaim_claim() {
  local claim_dir="$1"
  local observed_pid
  local observed_identity
  local moved_pid
  local moved_identity
  local claim_quarantine="${LOCK}.reclaim-stale.$$"
  if [ ! -d "$claim_dir" ] || [ -L "$claim_dir" ]; then
    return 1
  fi
  observed_identity="$(path_identity "$claim_dir")"
  if [ -z "$observed_identity" ]; then
    return 1
  fi
  observed_pid="$(cat "$claim_dir/pid" 2>/dev/null)"
  if pid_is_live "$observed_pid"; then
    return 1
  fi
  if [ -z "$observed_pid" ] && ! path_is_past_init_grace "$claim_dir"; then
    return 1
  fi
  if [ -e "$claim_quarantine" ] || [ -L "$claim_quarantine" ]; then
    return 1
  fi
  if ! mv "$claim_dir" "$claim_quarantine" 2>/dev/null; then
    return 1
  fi
  moved_identity="$(path_identity "$claim_quarantine")"
  moved_pid="$(cat "$claim_quarantine/pid" 2>/dev/null)"
  if [ "$moved_identity" != "$observed_identity" ] || [ "$moved_pid" != "$observed_pid" ] || pid_is_live "$moved_pid"; then
    if [ ! -e "$claim_dir" ] && [ ! -L "$claim_dir" ]; then
      mv "$claim_quarantine" "$claim_dir" 2>/dev/null
    fi
    return 1
  fi
  if [ -z "$moved_pid" ] && ! path_is_past_init_grace "$claim_quarantine"; then
    if [ ! -e "$claim_dir" ] && [ ! -L "$claim_dir" ]; then
      mv "$claim_quarantine" "$claim_dir" 2>/dev/null
    fi
    return 1
  fi
  rm -rf "$claim_quarantine" 2>/dev/null
}

acquire_reclaim_claim() {
  local claim_dir="$1"
  if ! mkdir "$claim_dir" 2>/dev/null; then
    if ! recover_abandoned_reclaim_claim "$claim_dir"; then
      return 1
    fi
    if ! mkdir "$claim_dir" 2>/dev/null; then
      return 1
    fi
  fi
  publish_owner_pid "$claim_dir"
}

OWNED_LOCK_IDENTITY=""

verify_owned_lock() {
  local current_pid
  local current_identity
  current_identity="$(path_identity "$LOCK")"
  current_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  [ -n "$OWNED_LOCK_IDENTITY" ] &&
    [ "$current_identity" = "$OWNED_LOCK_IDENTITY" ] &&
    [ "$current_pid" = "$$" ] &&
    [ ! -e "$LOCK/.reclaim" ] &&
    [ ! -L "$LOCK/.reclaim" ]
}

cleanup_owned_lock() {
  local current_pid
  local current_identity
  local moved_identity
  local owned_quarantine="${LOCK}.release.$$"
  if [ -z "$OWNED_LOCK_IDENTITY" ]; then
    return
  fi
  current_identity="$(path_identity "$LOCK")"
  current_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ "$current_pid" != "$$" ] || [ "$current_identity" != "$OWNED_LOCK_IDENTITY" ]; then
    return
  fi
  if [ -e "$LOCK/.reclaim" ] || [ -L "$LOCK/.reclaim" ]; then
    return
  fi
  if [ -e "$owned_quarantine" ] || [ -L "$owned_quarantine" ]; then
    return
  fi
  if mv "$LOCK" "$owned_quarantine" 2>/dev/null; then
    current_pid="$(cat "$owned_quarantine/pid" 2>/dev/null)"
    moved_identity="$(path_identity "$owned_quarantine")"
    if [ "$current_pid" = "$$" ] && [ "$moved_identity" = "$OWNED_LOCK_IDENTITY" ]; then
      rm -rf "$owned_quarantine" 2>/dev/null
    elif [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ]; then
      mv "$owned_quarantine" "$LOCK" 2>/dev/null
    fi
  fi
}

if [ "${1:-}" = "--print-command" ]; then
  print_cmd
  exit 0
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  if [ ! -d "$LOCK" ]; then
    skip_lock_conflict
  fi

  lock_identity="$(path_identity "$LOCK")"
  if [ -z "$lock_identity" ]; then
    skip_lock_conflict
  fi
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if pid_is_live "$lock_pid"; then
    skip_lock_conflict
  fi
  if [ -z "$lock_pid" ] && ! path_is_past_init_grace "$LOCK"; then
    skip_lock_conflict
  fi

  current_identity="$(path_identity "$LOCK")"
  current_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ "$current_identity" != "$lock_identity" ] || [ "$current_pid" != "$lock_pid" ]; then
    skip_lock_conflict
  fi

  reclaim_claim="$LOCK/.reclaim"
  if ! acquire_reclaim_claim "$reclaim_claim"; then
    skip_lock_conflict
  fi

  current_identity="$(path_identity "$LOCK")"
  current_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  claim_pid="$(cat "$reclaim_claim/pid" 2>/dev/null)"
  if [ "$current_identity" != "$lock_identity" ] || [ "$current_pid" != "$lock_pid" ] || [ "$claim_pid" != "$$" ]; then
    release_reclaim_claim "$reclaim_claim"
    skip_lock_conflict
  fi
  if pid_is_live "$current_pid"; then
    release_reclaim_claim "$reclaim_claim"
    skip_lock_conflict
  fi

  stale_quarantine="${LOCK}.stale.$$"
  if [ -e "$stale_quarantine" ] || [ -L "$stale_quarantine" ]; then
    release_reclaim_claim "$reclaim_claim"
    skip_lock_conflict
  fi
  if ! mv "$LOCK" "$stale_quarantine" 2>/dev/null; then
    skip_lock_conflict
  fi

  moved_pid="$(cat "$stale_quarantine/pid" 2>/dev/null)"
  moved_identity="$(path_identity "$stale_quarantine")"
  claim_pid="$(cat "$stale_quarantine/.reclaim/pid" 2>/dev/null)"
  if [ "$moved_identity" != "$lock_identity" ] || [ "$moved_pid" != "$lock_pid" ] || [ "$claim_pid" != "$$" ]; then
    if [ ! -e "$LOCK" ] && [ ! -L "$LOCK" ]; then
      mv "$stale_quarantine" "$LOCK" 2>/dev/null
    fi
    skip_lock_conflict
  fi
  rm -rf "$stale_quarantine" 2>/dev/null

  if ! mkdir "$LOCK" 2>/dev/null; then
    skip_lock_conflict
  fi
fi
if ! publish_owner_pid "$LOCK"; then
  fail_lock_race
fi
OWNED_LOCK_IDENTITY="$(path_identity "$LOCK")"
if ! verify_owned_lock; then
  fail_lock_race
fi
trap 'cleanup_owned_lock' EXIT

mode="dry-run"
if [ "$APPLY" = "1" ]; then
  mode="apply"
fi

echo "$(date '+%F %T') topic-register start (pid $$, mode $mode, products $PRODUCTS, limit $LIMIT)" >> "$LOG"

echo "$(date '+%F %T') command: $(print_cmd)" >> "$LOG"
if ! verify_owned_lock; then
  fail_lock_race
fi
if command -v gtimeout >/dev/null 2>&1; then
  RUN_JSON="$(gtimeout -k 30 "$TIMEOUT" "${CMD[@]}" 2>> "$LOG")"
  rc=$?
else
  RUN_JSON="$("${CMD[@]}" 2>> "$LOG")"
  rc=$?
fi
printf '%s\n' "$RUN_JSON" >> "$LOG"
write_result "$RUN_JSON"

case "$rc" in
  0)
    echo "$(date '+%F %T') topic-register ok" >> "$LOG"
    ;;
  124)
    echo "$(date '+%F %T') topic-register timeout rc=$rc" >> "$LOG"
    ;;
  *)
    echo "$(date '+%F %T') topic-register failed rc=$rc" >> "$LOG"
    ;;
esac

exit "$rc"
