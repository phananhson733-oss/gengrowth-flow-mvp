#!/usr/bin/env bash
# gg-publish-to-wiki.sh — cp phase2-PASS staging articles from flow-mvp/_staging/
# into two wiki destinations:
#   (1) 内容资产/astrologywiki/<batch-dir>/             [产品权威源]
#   (2) wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-<batch-dir>/   [个人 Obsidian 副本]
#
# Iterates an explicit (page_id × llm × version) matrix. For each tuple,
# expects _staging/<page_id>-<llm>-<version>.{md,manifest.json}. Publishes
# only when manifest.phase2_checks.overall == "pass". Other states skipped.
#
# Slug is derived from page_id (stable across versions), NOT frontmatter slug
# (frontmatter slug is target-keyword-derived and can drift for Pillar pages).
#   page_aura_colors_pillar → aura-colors-pillar
#   page_blue_aura_meaning  → blue-aura-meaning
#
# Usage:
#   tools/scripts/gg-publish-to-wiki.sh                              # defaults
#   tools/scripts/gg-publish-to-wiki.sh --dry-run
#   tools/scripts/gg-publish-to-wiki.sh --llms "claude codex"
#   tools/scripts/gg-publish-to-wiki.sh --pages "page_blue_aura_meaning"
#   tools/scripts/gg-publish-to-wiki.sh --batch-dir v8-drafts-2026-05-22-claude
#   tools/scripts/gg-publish-to-wiki.sh --wiki /alt/path/to/gengrowth-wiki
#
# Destination filename: <YYYY-MM-DD>-<slug>-<llm>.md   (date from frontmatter)
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

WIKI="/Users/wzb/gengrowth-wiki"
BATCH_DIR="v8-drafts-2026-05-22-claude"
VERSION="v8"
PAGES_DEFAULT="page_aura_colors_pillar page_blue_aura_meaning page_yellow_aura_meaning page_purple_aura_meaning page_white_aura_meaning page_red_aura_meaning"
LLMS_DEFAULT="claude codex"   # gemini phase2 FAIL → skipped automatically too
PAGES=""
LLMS=""
DRY_RUN=0
LANGUAGE="en"   # bilingual-v9: en (default) | zh

while [ $# -gt 0 ]; do
  case "$1" in
    --wiki) WIKI="$2"; shift 2 ;;
    --batch-dir) BATCH_DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --pages) PAGES="$2"; shift 2 ;;
    --llms) LLMS="$2"; shift 2 ;;
    --language) LANGUAGE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

case "$LANGUAGE" in en|zh) ;; *) echo "invalid --language $LANGUAGE — expected en|zh" >&2; exit 2 ;; esac

PAGES="${PAGES:-$PAGES_DEFAULT}"
LLMS="${LLMS:-$LLMS_DEFAULT}"

# bilingual-v9: ZH source is _staging/zh-demo/<page>-<llm>-<v>.md (phase2 writes
# there when fixture.language='zh'). EN source unchanged at _staging/<>.md.
# ZH destination dirs get a -zh suffix so EN and ZH batches don't collide.
if [ "$LANGUAGE" = "zh" ]; then
  STAGING="$REPO/_staging/zh-demo"
  PROD_DEST="$WIKI/内容资产/astrologywiki/${BATCH_DIR}-zh"
  OBS_DEST="$WIKI/wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-${BATCH_DIR}-zh"
else
  STAGING="$REPO/_staging"
  PROD_DEST="$WIKI/内容资产/astrologywiki/$BATCH_DIR"
  OBS_DEST="$WIKI/wzb-obsidian/LLM-Wiki/Writing/AstrologyWiki-$BATCH_DIR"
fi

[ -d "$WIKI" ] || { echo "wiki repo not found: $WIKI" >&2; exit 2; }
[ -d "$STAGING" ] || { echo "staging dir not found: $STAGING" >&2; exit 2; }

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$PROD_DEST" "$OBS_DEST"
fi

echo "Publishing PASS staging articles"
echo "  language: $LANGUAGE"
echo "  source  : $STAGING"
echo "  prod    : $PROD_DEST"
echo "  obs     : $OBS_DEST"
echo "  matrix  : $(echo $PAGES | wc -w | tr -d ' ') pages × $(echo $LLMS | wc -w | tr -d ' ') llms × $VERSION"
echo "  dry-run : $([ $DRY_RUN -eq 1 ] && echo yes || echo no)"
echo

# Derive slug from page_id: strip "page_" prefix, replace "_" with "-".
page_id_to_slug() {
  local pid="$1"
  echo "${pid#page_}" | tr '_' '-'
}

published=0
skipped_fail=0
skipped_missing=0
errors=0

for pid in $PAGES; do
  slug=$(page_id_to_slug "$pid")
  for llm in $LLMS; do
    base="${pid}-${llm}-${VERSION}"
    src_md="$STAGING/${base}.md"
    mf="$STAGING/${base}.manifest.json"

    if [ ! -f "$src_md" ] || [ ! -f "$mf" ]; then
      echo "  ⚠ missing: $base (md or manifest absent)" >&2
      skipped_missing=$((skipped_missing+1))
      continue
    fi

    if ! grep -qE '"overall":\s*"pass"' "$mf"; then
      echo "  ⏭  skip (not phase2 pass): $base"
      skipped_fail=$((skipped_fail+1))
      continue
    fi

    date=$(awk -F': *' '/^date:/ {print $2; exit}' "$src_md" | tr -d '\r')
    if [ -z "$date" ]; then
      echo "  ✗ no date in frontmatter: $base" >&2
      errors=$((errors+1))
      continue
    fi

    out_name="${date}-${slug}-${llm}.md"
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "  → ${out_name}  [from ${base}.md]"
    else
      cp "$src_md" "$PROD_DEST/$out_name"
      cp "$src_md" "$OBS_DEST/$out_name"
      echo "  ✓ ${out_name}"
    fi
    published=$((published+1))
  done
done

echo
echo "summary: published=$published skipped_fail=$skipped_fail skipped_missing=$skipped_missing errors=$errors"
[ "$errors" -eq 0 ]
