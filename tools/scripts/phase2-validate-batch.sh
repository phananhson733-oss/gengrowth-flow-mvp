#!/usr/bin/env bash
# phase2-validate-batch.sh — loop _phase2-validate.mjs across a set of
# (page_id × llm) staging files and emit a markdown summary.
#
# Validator semantics (single-file run, see _phase2-validate.mjs):
#   exit 0  PASS → staging md + manifest rewritten with phase2_checks.overall=pass
#   exit 11 FAIL → files NOT touched (manifest stays phase2_checks: "pending")
#   other   config error
#
# Usage:
#   tools/scripts/phase2-validate-batch.sh                 # default 6 aura page_ids × 3 llms
#   tools/scripts/phase2-validate-batch.sh --pages "page_blue_aura_meaning page_red_aura_meaning"
#   tools/scripts/phase2-validate-batch.sh --llms  "claude codex"
#   tools/scripts/phase2-validate-batch.sh --version v9 --report /tmp/r.md
#
# Reads:  _staging/<page_id>-<llm>-<version>.md  (+ .manifest.json)
# Writes: --report path (default /tmp/phase2-batch-report.md)
#         per-article logs in --logdir (default /tmp/phase2-logs)
set -u

# Resolve repo root from script location.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO"

DEFAULT_PAGES="page_aura_colors_pillar page_blue_aura_meaning page_yellow_aura_meaning page_purple_aura_meaning page_white_aura_meaning page_red_aura_meaning"
DEFAULT_LLMS="claude codex gemini"
VERSION="v8"
REPORT=/tmp/phase2-batch-report.md
LOGDIR=/tmp/phase2-logs
PAGES_INPUT=""
LLMS_INPUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pages)   PAGES_INPUT="$2"; shift 2 ;;
    --llms)    LLMS_INPUT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --report)  REPORT="$2"; shift 2 ;;
    --logdir)  LOGDIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,21p' "$0"
      exit 0 ;;
    *)
      echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

PAGES="${PAGES_INPUT:-$DEFAULT_PAGES}"
LLMS="${LLMS_INPUT:-$DEFAULT_LLMS}"

mkdir -p "$LOGDIR"
: > "$REPORT"

printf "# Phase 2 validation batch — %s\n\n" "$(date -Iseconds)" >> "$REPORT"
printf "version=%s\n\n" "$VERSION" >> "$REPORT"
printf "| page_id | LLM | result | findings |\n" >> "$REPORT"
printf "|---|---|---|---|\n" >> "$REPORT"

pass=0; fail=0; err=0
for pid in $PAGES; do
  for llm in $LLMS; do
    src="_staging/${pid}-${llm}-${VERSION}.md"
    log="$LOGDIR/${pid}-${llm}.log"
    if [ ! -f "$src" ]; then
      printf "| %s | %s | ❓ MISSING | source file missing |\n" "$pid" "$llm" >> "$REPORT"
      err=$((err+1))
      continue
    fi
    node tools/scripts/_phase2-validate.mjs \
      --source "$src" \
      --tag "${llm}-${VERSION}" \
      --page-id "$pid" \
      --llm-source "$llm" \
      --prompt-version "$VERSION" \
      > "$log" 2>&1
    code=$?
    case $code in
      0)
        stats=$(grep -E '^  ✓ PASS  H1=' "$log" | head -1 | sed 's/^  //')
        printf "| %s | %s | ✅ PASS | %s |\n" "$pid" "$llm" "${stats:-all checks green}" >> "$REPORT"
        pass=$((pass+1))
        ;;
      11)
        findings=$(grep -E '^    - ' "$log" | sed 's/^    - //' | tr '\n' '; ' | sed 's/; $//')
        rlfails=$(grep -E '^  ✗ FAIL' "$log" | sed 's/^  ✗ FAIL  //' | tr '\n' '; ')
        printf "| %s | %s | ❌ FAIL | %s%s |\n" "$pid" "$llm" "${findings:-(no struct findings)}" "${rlfails:+ | RL: $rlfails}" >> "$REPORT"
        fail=$((fail+1))
        ;;
      *)
        last=$(tail -3 "$log" | tr '\n' '; ')
        printf "| %s | %s | ⚠️ ERR(%d) | %s |\n" "$pid" "$llm" "$code" "$last" >> "$REPORT"
        err=$((err+1))
        ;;
    esac
  done
done

total=$((pass+fail+err))
printf "\n## Summary\n\n- pass: %d / %d\n- fail: %d / %d\n- err:  %d / %d\n" \
  "$pass" "$total" "$fail" "$total" "$err" "$total" >> "$REPORT"

echo "REPORT: $REPORT"
echo "summary: pass=$pass fail=$fail err=$err total=$total"
[ "$fail" -eq 0 ] && [ "$err" -eq 0 ]
