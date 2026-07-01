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
  if [ "$ALLOW_FALLBACK" = "1" ]; then
    CMD+=(--allow-preprocessor-fallback)
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

log_skip_json() {
  local reason="$1"
  local active_pid="${2:-}"
  local dry_run="true"
  if [ "$APPLY" = "1" ]; then
    dry_run="false"
  fi
  {
    printf '{\n'
    printf '  "ok": true,\n'
    printf '  "dry_run": %s,\n' "$dry_run"
    printf '  "skipped": true,\n'
    printf '  "reason": "%s",\n' "$reason"
    if [ -n "$active_pid" ]; then
      printf '  "active_pid": "%s",\n' "$active_pid"
    fi
    printf '  "summaries": []\n'
    printf '}\n'
  } >> "$LOG"
}

if [ "${1:-}" = "--print-command" ]; then
  print_cmd
  exit 0
fi

if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    echo "$(date '+%F %T') skip — previous topic-register run (pid $lock_pid) still active" >> "$LOG"
    log_skip_json "lock_active" "$lock_pid"
    exit 0
  fi
  rm -rf "$LOCK" 2>/dev/null
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost mutex race" >> "$LOG"
  log_skip_json "lock_race"
  exit 0
fi
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

mode="dry-run"
if [ "$APPLY" = "1" ]; then
  mode="apply"
fi

echo "$(date '+%F %T') topic-register start (pid $$, mode $mode, products $PRODUCTS, limit $LIMIT)" >> "$LOG"

(
  echo "$(date '+%F %T') command: $(print_cmd)"
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 30 "$TIMEOUT" "${CMD[@]}"
  else
    "${CMD[@]}"
  fi
) >> "$LOG" 2>&1
rc=$?

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
