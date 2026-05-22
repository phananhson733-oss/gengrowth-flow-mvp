#!/usr/bin/env bash
# gg-supplement-page.sh — one-shot orchestration for steps 2-10 of
# docs/PIPELINE.md ("补一篇新文章" runbook). Wraps the existing mjs / sh
# tools into a single command so the manual fanout is one invocation.
#
# Pipeline phases:
#   prepare  — RAG (entity-passport + obsidian-rag) + synth batch + render prompt
#              stops at prompt write; user runs LLMs separately
#   finish   — phase2-validate + publish-to-wiki + md→oracle-ts + refresh-existing
#              assumes user has already written _staging/<page>-{claude,codex}-v8.md
#
# Step 1 (brief override) is NOT automated — see gg-brief-init.mjs.
# Step 5 (LLM generation) is NOT automated — runs in Claude Code main session
#   via codex MCP / Agent fanout against .gg-cache/prompts/<page_id>.v8-prompt.md.
# Step 10.1-10.3 (oracle index.ts + ARTICLE_SLUGS_EN_ONLY + TBD_LINK_RULES)
#   need manual edits — script prints a checklist at end.
# Step 11-12 (codex review + commit + push + deploy verify) are NOT automated.
#
# Usage:
#   tools/scripts/gg-supplement-page.sh prepare \
#     --pages "page_X page_Y" \
#     --overrides .gg-cache/overrides/X.json \
#     [--llm claude codex]                       # whitespace-separated
#
#   tools/scripts/gg-supplement-page.sh finish \
#     --pages "page_X page_Y" \
#     [--llms "claude codex"] \
#     [--winner-map "page_X:codex,page_Y:claude"] \
#     [--skip-wiki-publish] \
#     [--skip-refresh-existing] \
#     [--oracle-articles-dir /path]
#
set -u
# pipefail propagates non-zero exit codes through pipes (cmd | tail), so
# subprocess failures aren't swallowed by the tail/grep used for output
# trimming below. Without this, a failed phase2-validate-batch.sh would
# still let "FINISH PHASE DONE" print as if everything passed.
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO"

PHASE="${1:-}"
shift || true

case "$PHASE" in
  prepare|finish|both) ;;
  -h|--help|help|"")
    sed -n '2,32p' "$0"
    exit 0 ;;
  *)
    echo "unknown phase: $PHASE (use prepare|finish|both)" >&2
    exit 2 ;;
esac

PAGES=""
OVERRIDES=""
LLMS="claude codex"
VAULT_DIR=""
WINNER_MAP=""
SKIP_RAG=0
SKIP_WIKI=0
SKIP_REFRESH=0
ORACLE_DIR="/Users/wzb/Code/oracle/data/articles"
VERSION="v8"

while [ $# -gt 0 ]; do
  case "$1" in
    --pages) PAGES="$2"; shift 2 ;;
    --overrides) OVERRIDES="$2"; shift 2 ;;
    --llms) LLMS="$2"; shift 2 ;;
    --vault-dir) VAULT_DIR="$2"; shift 2 ;;
    --winner-map) WINNER_MAP="$2"; shift 2 ;;
    --skip-rag) SKIP_RAG=1; shift ;;
    --skip-wiki-publish) SKIP_WIKI=1; shift ;;
    --skip-refresh-existing) SKIP_REFRESH=1; shift ;;
    --oracle-articles-dir) ORACLE_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$PAGES" ]; then
  echo "missing --pages" >&2; exit 2
fi

PAGE_COUNT=$(echo "$PAGES" | tr ' ' '\n' | grep -c .)

run_prepare() {
  if [ -z "$OVERRIDES" ]; then
    echo "prepare requires --overrides" >&2; exit 2
  fi
  if [ ! -f "$OVERRIDES" ]; then
    echo "overrides not found: $OVERRIDES" >&2; exit 2
  fi

  # ─── 1. RAG (entity-passport + obsidian-rag) ──────────────────
  if [ "$SKIP_RAG" -eq 0 ]; then
    echo "[prepare 1/4] RAG cache (entity-passport + obsidian-rag) for $PAGE_COUNT pages…"
    for pid in $PAGES; do
      # Extract entity from overrides JSON.
      entity=$(node -e "const o=require('$OVERRIDES'); process.stdout.write((o['$pid']||{}).entity||'')")
      if [ -z "$entity" ]; then
        echo "  ✗ overrides[$pid].entity missing" >&2; exit 1
      fi
      tk=$(node -e "const o=require('$OVERRIDES'); process.stdout.write((o['$pid']||{}).target_keyword||'')")

      # Skip cache if already present (idempotent).
      if [ -f ".gg-cache/$pid/entity-passport.rag.json" ]; then
        echo "  ⏭  $pid entity-passport already cached"
      else
        node tools/scripts/gg-entity-passport.mjs --entity "$entity" --page-id "$pid" --emit-rag >/dev/null 2>&1 &
      fi
    done
    wait
    for pid in $PAGES; do
      entity=$(node -e "const o=require('$OVERRIDES'); process.stdout.write((o['$pid']||{}).entity||'')")
      tk=$(node -e "const o=require('$OVERRIDES'); process.stdout.write((o['$pid']||{}).target_keyword||'')")
      if [ -f ".gg-cache/$pid/obsidian-rag.json" ]; then
        echo "  ⏭  $pid obsidian-rag already cached"
      else
        vault_flag=""
        if [ -n "$VAULT_DIR" ]; then vault_flag="--vault-dir $VAULT_DIR"; fi
        node tools/scripts/gg-obsidian-rag.mjs --page-id "$pid" --entity "$entity" --target-keyword "$tk" $vault_flag >/dev/null 2>&1 &
      fi
    done
    wait

    # Sanity check — every page should now have both caches.
    rag_missing=0
    for pid in $PAGES; do
      for f in entity-passport.rag.json obsidian-rag.json; do
        if [ ! -f ".gg-cache/$pid/$f" ]; then
          echo "  ✗ $pid missing $f" >&2
          rag_missing=$((rag_missing+1))
        fi
      done
    done
    if [ "$rag_missing" -gt 0 ]; then
      echo "RAG cache incomplete — see errors above" >&2; exit 1
    fi
    echo "  ✓ RAG cache ready for $PAGE_COUNT pages"
  else
    echo "[prepare 1/4] --skip-rag — assuming caches present"
  fi

  # ─── 2. synth batch fixture ───────────────────────────────────
  BATCH_FILE=".gg-cache/batches/$(date +%Y%m%dT%H%M%S)-supplement.json"
  echo "[prepare 2/4] synth batch fixture → $BATCH_FILE"
  node tools/scripts/gg-batch-synth.mjs --pages "$PAGES" --overrides "$OVERRIDES" --out "$BATCH_FILE" || exit 1

  # ─── 3. render v8 prompt ──────────────────────────────────────
  echo "[prepare 3/4] dry-run render to verify cfg…"
  node tools/scripts/gg-render-batch.mjs --batch "$BATCH_FILE" --overrides "$OVERRIDES" --dry-run >/dev/null 2>&1
  if [ $? -ne 0 ]; then
    echo "  ✗ dry-run render failed — check overrides cfg fields" >&2; exit 1
  fi
  echo "[prepare 4/4] write v8 prompts to .gg-cache/prompts/…"
  node tools/scripts/gg-render-batch.mjs --batch "$BATCH_FILE" --overrides "$OVERRIDES" --continue-on-error 2>&1 | tail -$((PAGE_COUNT+2))

  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "PREPARE PHASE DONE — next steps:"
  echo
  echo "  1. Generate LLM outputs (run in Claude Code main session):"
  for pid in $PAGES; do
    for llm in $LLMS; do
      echo "     $llm  ←  .gg-cache/prompts/$pid.v8-prompt.md → _staging/$pid-$llm-v$VERSION.md"
    done
  done
  echo "     (use codex MCP for codex; Agent / paste-test for claude)"
  echo
  echo "  2. Then run: tools/scripts/gg-supplement-page.sh finish --pages \"$PAGES\""
}

run_finish() {
  # ─── 5. phase2-validate ───────────────────────────────────────
  echo "[finish 1/4] phase2-validate $PAGE_COUNT page(s) × $(echo $LLMS | wc -w | tr -d ' ') LLM(s)…"
  REPORT_FILE="/tmp/phase2-supplement-$(date +%Y%m%dT%H%M%S).md"
  phase2_log=$(mktemp)
  # phase2-validate-batch.sh exits 0 when every row PASSED, 1 if any row
  # FAILED or hit an internal validator error — both are "ran cleanly" from
  # this orchestrator's point of view. The REPORT file is the source of truth.
  # We ignore the exit code here and inspect the report.
  set +e
  tools/scripts/phase2-validate-batch.sh \
      --pages "$PAGES" --llms "$LLMS" --version "$VERSION" \
      --report "$REPORT_FILE" --logdir "/tmp/phase2-logs-supplement" > "$phase2_log" 2>&1
  phase2_rc=$?
  set -e
  tail -3 "$phase2_log"
  if [ ! -f "$REPORT_FILE" ]; then
    # No report file = the batch script crashed before writing — treat as fatal.
    echo "  ✗ phase2-validate-batch.sh produced no report (rc=$phase2_rc) — see $phase2_log" >&2
    exit 1
  fi
  rm -f "$phase2_log"

  pass_count=$(grep -c '✅ PASS' "$REPORT_FILE" 2>/dev/null || echo 0)
  fail_count=$(grep -c '❌ FAIL' "$REPORT_FILE" 2>/dev/null || echo 0)
  echo "  report: $REPORT_FILE  (pass=$pass_count fail=$fail_count)"

  # Each page must have AT LEAST ONE PASS LLM — otherwise md-to-ts has
  # no winner to pick. Check by counting unique PASS page_ids vs requested.
  pages_with_pass=$(grep '✅ PASS' "$REPORT_FILE" | awk -F'|' '{print $2}' | sed 's/ //g' | sort -u | wc -l | tr -d ' ')
  if [ "$pages_with_pass" -lt "$PAGE_COUNT" ]; then
    echo "  ✗ only $pages_with_pass of $PAGE_COUNT pages have a PASS LLM — fix LLM output before continuing." >&2
    echo "  see report: $REPORT_FILE" >&2
    exit 1
  fi

  # ─── 6. publish to wiki ───────────────────────────────────────
  if [ "$SKIP_WIKI" -eq 0 ]; then
    echo "[finish 2/4] cp PASS articles to wiki (both destinations)…"
    tools/scripts/gg-publish-to-wiki.sh --pages "$PAGES" --llms "$LLMS" 2>&1 | tail -5
  else
    echo "[finish 2/4] --skip-wiki-publish — skipped wiki cp"
  fi

  # ─── 7. md → oracle ts ────────────────────────────────────────
  echo "[finish 3/4] md → oracle .ts for $PAGE_COUNT page(s)…"
  winner_map_flag=""
  if [ -n "$WINNER_MAP" ]; then winner_map_flag="--winner-map $WINNER_MAP"; fi
  # Capture full output then grep — keeps the converter's exit code in $?
  # while still showing the user only the ✓ / ✗ lines.
  ts_log=$(mktemp)
  if ! node tools/scripts/gg-md-to-oracle-ts.mjs --batch --version "$VERSION" \
      --pages "$PAGES" --oracle-articles-dir "$ORACLE_DIR" $winner_map_flag > "$ts_log" 2>&1; then
    grep -E "^✓|^✗" "$ts_log" || true
    echo "  ✗ md→oracle-ts failed — see full log: $ts_log" >&2
    exit 1
  fi
  grep -E "^✓|^✗" "$ts_log" || true
  rm -f "$ts_log"

  # ─── 8. refresh existing oracle articles ──────────────────────
  if [ "$SKIP_REFRESH" -eq 0 ]; then
    echo "[finish 4/4] refresh existing oracle .ts (let new TBD rules propagate)…"
    refresh_log=$(mktemp)
    if ! node tools/scripts/gg-md-to-oracle-ts.mjs --batch --refresh-existing --version "$VERSION" \
        --oracle-articles-dir "$ORACLE_DIR" > "$refresh_log" 2>&1; then
      grep -E "found|^✓|^✗" "$refresh_log" || true
      echo "  ✗ refresh-existing failed — see full log: $refresh_log" >&2
      exit 1
    fi
    grep -E "found|^✓|^✗" "$refresh_log" || true
    rm -f "$refresh_log"
  else
    echo "[finish 4/4] --skip-refresh-existing — skipped re-conversion of existing oracle .ts"
  fi

  # ─── audit ────────────────────────────────────────────────────
  echo
  echo "[audit] TBD_LINK_RULES vs oracle articles:"
  node tools/scripts/gg-md-to-oracle-ts.mjs --audit-links --oracle-articles-dir "$ORACLE_DIR" 2>&1 | tail -10

  echo
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "FINISH PHASE DONE — manual next steps:"
  echo
  echo "  1. Register oracle 4 places (each new page):"
  echo "     - data/articles/index.ts          : add import + push to ARTICLES_EN"
  echo "     - scripts/generate-seo-pages.mjs  : add slug to ARTICLE_SLUGS_EN_ONLY"
  echo "     - flow-mvp gg-md-to-oracle-ts.mjs TBD_LINK_RULES (audit above)"
  echo "     - then re-run with --skip-rag if you needed to update rules"
  echo
  echo "  2. codex review (read-only sandbox):"
  echo "     mcp__codex__codex({ cwd: oracle, prompt: <verify import/sitemap/diff drift> })"
  echo
  echo "  3. commit + push both repos:"
  echo "     - flow-mvp: feat(content): v8 supplement <slug>"
  echo "     - oracle:   feat(wiki): N new articles + relink"
  echo "     gh api repos/xdawayer/oracle/commits/<sha>/status → expect state=success"
}

case "$PHASE" in
  prepare) run_prepare ;;
  finish)  run_finish ;;
  both)    run_prepare && echo && echo "(running finish — assumes LLM outputs already in _staging)" && run_finish ;;
esac
