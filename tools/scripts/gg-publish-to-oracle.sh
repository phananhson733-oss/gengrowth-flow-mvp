#!/usr/bin/env bash
# gg-publish-to-oracle.sh — publish PASS staging articles straight into the
# oracle repo, committing locally but NEVER pushing.
#
# This is the bot-friendly downstream path that skips the wiki (stage 14):
#   _staging/<page>-<llm>-<ver>.md  →  oracle/data/articles/<slug>.ts
#   → register in index.ts → git commit in oracle  (STOP — push is the gate)
#
# The git push that triggers Vercel auto-deploy is left for a human to run
# (the requires_human gate). This script prints the exact push command.
#
# Usage:
#   GG_ORACLE_DIR=~/oracle bash tools/scripts/gg-publish-to-oracle.sh \
#     --pages "page_blue_aura_meaning page_green_aura_meaning" \
#     --winner-llm claude [--version v8] [--dry-run] [--no-commit] [--allow-fail]
#
# Env:
#   GG_ORACLE_DIR  oracle repo root        [default /Users/wzb/Code/oracle]
#   GG_FLOW_REPO   flow-mvp repo root       [default: derived from this script]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOW_REPO="${GG_FLOW_REPO:-$(dirname "$(dirname "$SCRIPT_DIR")")}"
ORACLE_DIR="${GG_ORACLE_DIR:-/Users/wzb/Code/oracle}"
ARTICLES_DIR="$ORACLE_DIR/data/articles"
MD_TO_TS="$SCRIPT_DIR/gg-md-to-oracle-ts.mjs"
REGISTER="$SCRIPT_DIR/gg-oracle-register-index.mjs"

LLM=""
VERSION="v8"
PAGES=""
DRY_RUN=0
NO_COMMIT=0
ALLOW_FAIL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pages)      PAGES="${2:-}"; shift 2 ;;
    --winner-llm) LLM="${2:-}"; shift 2 ;;
    --version)    VERSION="${2:-}"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --no-commit)  NO_COMMIT=1; shift ;;
    --allow-fail) ALLOW_FAIL=1; shift ;;
    -h|--help)    sed -n '2,21p' "$0"; exit 0 ;;
    *)            echo "❌ unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { echo "🔄 $*"; }
ok()   { echo "✅ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }

[[ -n "$PAGES" ]] || fail "--pages required (space-separated page_ids)"
[[ -n "$LLM" ]]   || fail "--winner-llm required"
[[ -d "$ARTICLES_DIR" ]] || fail "oracle articles dir not found: $ARTICLES_DIR"
command -v node >/dev/null 2>&1 || fail "node not installed"

slug_of() { echo "${1#page_}" | tr '_' '-'; }

CONVERTED=()
for page in $PAGES; do
  slug="$(slug_of "$page")"
  src="$FLOW_REPO/_staging/${page}-${LLM}-${VERSION}.md"
  manifest="$FLOW_REPO/_staging/${page}-${LLM}-${VERSION}.manifest.json"
  out="$ARTICLES_DIR/${slug}.ts"

  [[ -f "$src" ]] || fail "staging md not found: $src"

  # PASS guard — mirror the pipeline invariant that only phase2-pass articles
  # are published. Skip with --allow-fail for debugging.
  if [[ "$ALLOW_FAIL" -eq 0 ]]; then
    if [[ ! -f "$manifest" ]] || ! grep -q '"overall"[: ]*"pass"' "$manifest"; then
      fail "phase2 not PASS for $page (no passing manifest: $manifest). Use --allow-fail to override."
    fi
  fi

  log "convert  $page → $slug.ts"
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [dry-run] node $MD_TO_TS --source $src --slug $slug --out $out"
    echo "    [dry-run] node $REGISTER --oracle-articles-dir $ARTICLES_DIR --slug $slug"
  else
    node "$MD_TO_TS" --source "$src" --slug "$slug" --out "$out" >/dev/null
    node "$REGISTER" --oracle-articles-dir "$ARTICLES_DIR" --slug "$slug"
  fi
  CONVERTED+=("$slug")
done

ok "converted ${#CONVERTED[@]} article(s): ${CONVERTED[*]}"

if [[ "$DRY_RUN" -eq 1 || "$NO_COMMIT" -eq 1 ]]; then
  log "skipping git commit ($([[ "$DRY_RUN" -eq 1 ]] && echo dry-run || echo --no-commit))"
  exit 0
fi

# ── git commit in oracle (NO push — that is the human gate) ─────────────────
git -C "$ORACLE_DIR" add data/articles
if git -C "$ORACLE_DIR" diff --cached --quiet; then
  ok "no changes to commit (articles identical to current oracle)"
  exit 0
fi
MSG="feat(articles): publish ${CONVERTED[*]} (${LLM} ${VERSION}) from flow-mvp _staging"
git -C "$ORACLE_DIR" commit -q -m "$MSG"
ok "committed to oracle (local only)"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
git -C "$ORACLE_DIR" show --stat --oneline HEAD | head -20
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚦 HUMAN GATE — review above, then deploy with:"
echo "     git -C $ORACLE_DIR push origin main   # Vercel auto-builds on push"
