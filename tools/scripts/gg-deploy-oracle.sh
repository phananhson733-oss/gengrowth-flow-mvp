#!/usr/bin/env bash
# gg-deploy-oracle.sh — automate Pipeline Stage 16 (oracle build + Vercel deploy).
#
# Usage:
#   bash tools/scripts/gg-deploy-oracle.sh \
#       [--articles "slug1,slug2"] [--from-wiki <batch-dir>] \
#       [--dry-run] [--preview|--prod] [--no-build] [--allow-dirty]
#
# Flags (defaults in brackets):
#   --articles    Comma-separated slugs to convert (only with --from-wiki)
#   --from-wiki   Batch dir name under astrologywiki/ to source MD from
#   --preview     Deploy as preview URL  [default]
#   --prod        Deploy to production (must be explicit)
#   --no-build    Skip `npm run build` step
#   --dry-run     Print everything, run nothing
#   --allow-dirty Proceed even if oracle git tree is dirty (warn-and-confirm)

set -euo pipefail

# Paths are env-overridable so the script runs on any operator's machine.
# Defaults preserve the original wzb layout; set GG_ORACLE_DIR / GG_WIKI_BASE /
# GG_FLOW_REPO (e.g. in ~/.config/gg/_gg.env) to relocate.
ORACLE_DIR="${GG_ORACLE_DIR:-/Users/wzb/Code/oracle}"
WIKI_BASE="${GG_WIKI_BASE:-/Users/wzb/gengrowth-wiki/内容资产/astrologywiki}"
FLOW_REPO="${GG_FLOW_REPO:-/Users/wzb/gengrowth-flow-mvp}"
MD_TO_TS="${FLOW_REPO}/tools/scripts/gg-md-to-oracle-ts.mjs"

MODE="preview"
DRY_RUN=0
NO_BUILD=0
ALLOW_DIRTY=0
ARTICLES=""
FROM_WIKI=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --articles)    ARTICLES="${2:-}"; shift 2 ;;
    --from-wiki)   FROM_WIKI="${2:-}"; shift 2 ;;
    --preview)     MODE="preview"; shift ;;
    --prod)        MODE="prod"; shift ;;
    --no-build)    NO_BUILD=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    -h|--help)     sed -n '2,18p' "$0"; exit 0 ;;
    *)             echo "❌ unknown arg: $1" >&2; exit 2 ;;
  esac
done

log()  { echo "🔄 $*"; }
ok()   { echo "✅ $*"; }
fail() { echo "❌ $*" >&2; exit 1; }
run()  {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [dry-run] $*"
  else
    eval "$@"
  fi
}

# ── 1. Dependency validation ────────────────────────────────────────────────
log "validating dependencies"

[[ -d "$ORACLE_DIR" ]] || fail "oracle dir not found: $ORACLE_DIR"
[[ -f "$ORACLE_DIR/package.json" ]] || fail "oracle missing package.json"

if ! grep -q '"build"' "$ORACLE_DIR/package.json"; then
  fail "oracle/package.json has no \"build\" script"
fi
ok "oracle/package.json has build script"

if [[ ! -d "$ORACLE_DIR/.vercel" && ! -f "$ORACLE_DIR/vercel.json" ]]; then
  fail "oracle missing Vercel config (.vercel/ or vercel.json)"
fi
ok "oracle has Vercel config"

command -v vercel >/dev/null 2>&1 || fail "vercel CLI not installed (npm i -g vercel)"
command -v node >/dev/null 2>&1 || fail "node not installed"
ok "vercel + node available"

if [[ -n "$FROM_WIKI" ]]; then
  [[ -d "$WIKI_BASE/$FROM_WIKI" ]] || fail "wiki batch dir not found: $WIKI_BASE/$FROM_WIKI"
  [[ -f "$MD_TO_TS" ]] || fail "md-to-ts converter missing: $MD_TO_TS"
  ok "wiki batch + converter present"
fi

if [[ -n "$ARTICLES" && -z "$FROM_WIKI" ]]; then
  fail "--articles requires --from-wiki <batch-dir>"
fi

# ── 2. Git cleanliness check ────────────────────────────────────────────────
if [[ -d "$ORACLE_DIR/.git" ]]; then
  DIRTY=$(git -C "$ORACLE_DIR" status --porcelain 2>/dev/null || true)
  if [[ -n "$DIRTY" ]]; then
    if [[ "$ALLOW_DIRTY" -eq 1 ]]; then
      echo "⚠️  oracle tree dirty; --allow-dirty passed, continuing"
    elif [[ "$DRY_RUN" -eq 1 ]]; then
      echo "⚠️  [dry-run] oracle tree dirty (would block without --allow-dirty)"
    else
      echo "$DIRTY" | head -10 >&2
      fail "oracle git tree dirty; commit or pass --allow-dirty"
    fi
  else
    ok "oracle git tree clean"
  fi
fi

# ── 3. MD → TS conversion ──────────────────────────────────────────────────
if [[ -n "$FROM_WIKI" ]]; then
  log "converting MD → TS from $FROM_WIKI"
  SRC_DIR="$WIKI_BASE/$FROM_WIKI"
  if [[ -n "$ARTICLES" ]]; then
    SLUGS=$(echo "$ARTICLES" | tr ',' ' ')
  else
    SLUGS=$(find "$SRC_DIR" -maxdepth 1 -name '*.md' -not -name 'README.md' \
      -exec basename {} .md \; | sed 's/-[a-z]*$//' | sort -u | tr '\n' ' ')
  fi
  echo "    slugs: $SLUGS"
  for slug in $SLUGS; do
    SRC=$(find "$SRC_DIR" -maxdepth 1 -name "${slug}-*.md" | head -1)
    [[ -n "$SRC" ]] || { echo "    ⚠️  no md for slug=$slug in $SRC_DIR"; continue; }
    OUT="$ORACLE_DIR/data/articles/${slug}.ts"
    run "node '$MD_TO_TS' --source '$SRC' --slug '$slug' --out '$OUT'"
  done
  ok "conversion stage complete"
else
  log "no --from-wiki passed; skipping MD→TS conversion"
fi

# ── 4. npm install (only if lockfile changed) ───────────────────────────────
if [[ -d "$ORACLE_DIR/.git" ]]; then
  if git -C "$ORACLE_DIR" status --porcelain package-lock.json 2>/dev/null | grep -q .; then
    log "package-lock.json changed → npm install"
    run "cd '$ORACLE_DIR' && npm install"
  else
    ok "package-lock unchanged; skipping npm install"
  fi
fi

# ── 5. Build ────────────────────────────────────────────────────────────────
if [[ "$NO_BUILD" -eq 1 ]]; then
  log "--no-build passed; skipping npm run build"
else
  log "running npm run build"
  BUILD_START=$(date +%s)
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "    [dry-run] cd '$ORACLE_DIR' && npm run build"
  else
    (cd "$ORACLE_DIR" && npm run build) || fail "build failed"
  fi
  BUILD_END=$(date +%s)
  ok "build complete (${BUILD_START}s → ${BUILD_END}s)"
fi

# ── 6. Capture previous deployment for rollback ─────────────────────────────
log "fetching previous deployment ID (for rollback reference)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "    [dry-run] vercel ls --cwd '$ORACLE_DIR' | head -3"
  PREV_DEPLOY="<dry-run-skipped>"
else
  PREV_DEPLOY=$(vercel ls --cwd "$ORACLE_DIR" 2>/dev/null \
    | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1 || true)
  PREV_DEPLOY="${PREV_DEPLOY:-<none>}"
fi
echo "    previous: $PREV_DEPLOY"
echo "    rollback cmd (if needed): vercel rollback $PREV_DEPLOY --cwd $ORACLE_DIR"

# ── 7. Deploy ───────────────────────────────────────────────────────────────
log "deploying to Vercel ($MODE)"
if [[ "$MODE" == "prod" ]]; then
  DEPLOY_CMD="vercel deploy --prod --cwd '$ORACLE_DIR'"
else
  DEPLOY_CMD="vercel deploy --cwd '$ORACLE_DIR'"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "    [dry-run] $DEPLOY_CMD"
  DEPLOY_URL="<dry-run-no-url>"
else
  DEPLOY_URL=$(eval "$DEPLOY_CMD" 2>&1 | tee /dev/stderr \
    | grep -oE 'https://[a-z0-9.-]+\.vercel\.app' | tail -1 || true)
  [[ -n "$DEPLOY_URL" ]] || fail "could not parse deployment URL from vercel output"
fi

ok "deploy complete"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   mode:     $MODE"
echo "   URL:      $DEPLOY_URL"
echo "   previous: $PREV_DEPLOY"
echo "   rollback: vercel rollback $PREV_DEPLOY --cwd $ORACLE_DIR"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [[ "$MODE" == "preview" ]]; then
  echo "ℹ️  preview only — re-run with --prod to promote (no auto-promote)"
fi
