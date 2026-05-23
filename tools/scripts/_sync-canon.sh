#!/usr/bin/env bash
# _sync-canon.sh — one-way mirror from gengrowth-wiki into spec/upstream-canon/
#
# Usage:
#   tools/scripts/_sync-canon.sh            # do the sync
#   tools/scripts/_sync-canon.sh --dry-run  # show what would change, write nothing
#
# Env overrides:
#   GG_WIKI_ROOT=/path/to/gengrowth-wiki tools/scripts/_sync-canon.sh
#
# Exits non-zero if WIKI_ROOT is missing or any source file is absent.

set -euo pipefail

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

WIKI_ROOT="${GG_WIKI_ROOT:-/Users/wzb/gengrowth-wiki}"

# Resolve repo root relative to this script (works regardless of CWD).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
DEST_DIR="${REPO_ROOT}/spec/upstream-canon"

# Wiki source paths (relative to WIKI_ROOT). Each file is copied to
# DEST_DIR/<basename>. Keep this list authoritative — if you add a new
# upstream canon doc, add it here.
SPEC_FILES=(
  "docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md"
  "docs/03-marketing/01-strategy/keyword-research-overview.md"
  "docs/03-marketing/03-seo/keyword-research-sop.md"
  "docs/03-marketing/03-seo/keyword-sheet-setup.gs"
  "docs/03-marketing/03-seo/day0-diagnosis-sop.md"
  "docs/03-marketing/03-seo/seed-client-growth-experiment-template.md"
)

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Try --help" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Portable sha256: prefer shasum (always on macOS), fall back to sha256sum.
sha256_of() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "MISSING"
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    sha256sum "$path" | awk '{print $1}'
  fi
}

# Portable byte size.
size_of() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "-"
    return 0
  fi
  if stat -f%z "$path" >/dev/null 2>&1; then
    stat -f%z "$path"
  else
    stat -c%s "$path"
  fi
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

if [[ ! -d "$WIKI_ROOT" ]]; then
  echo "ERROR: WIKI_ROOT does not exist: $WIKI_ROOT" >&2
  echo "Set GG_WIKI_ROOT or clone gengrowth-wiki to that path." >&2
  exit 1
fi

missing=()
for rel in "${SPEC_FILES[@]}"; do
  if [[ ! -f "${WIKI_ROOT}/${rel}" ]]; then
    missing+=("${WIKI_ROOT}/${rel}")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "ERROR: ${#missing[@]} source file(s) missing under WIKI_ROOT:" >&2
  for m in "${missing[@]}"; do echo "  - $m" >&2; done
  exit 1
fi

# Dry-run must be read-only — only create DEST_DIR when we will actually write.
if (( DRY_RUN == 0 )); then
  mkdir -p "$DEST_DIR"
fi

if ! command -v rsync >/dev/null 2>&1; then
  echo "ERROR: rsync is required but not installed." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

if (( DRY_RUN )); then
  echo "DRY RUN — no files will be written."
fi
echo "WIKI_ROOT : $WIKI_ROOT"
echo "DEST_DIR  : $DEST_DIR"
echo

# Collect rows for the summary table.
declare -a rows=()

for rel in "${SPEC_FILES[@]}"; do
  src="${WIKI_ROOT}/${rel}"
  base="$(basename "$rel")"
  dst="${DEST_DIR}/${base}"

  before_sha="$(sha256_of "$dst")"

  # Skip rsync entirely in dry-run — it would otherwise touch DEST_DIR's
  # mtime even with --dry-run on some platforms, and DEST_DIR may not even
  # exist (we deliberately don't `mkdir -p` it in dry-run mode). The status
  # table below only needs the before/after shas, which we compute from
  # source vs current dest.
  if (( DRY_RUN == 0 )); then
    rsync_flags=(-a --checksum)
    # Keep rsync quiet here; we render our own table below.
    rsync "${rsync_flags[@]}" "$src" "$dst"
  fi

  if (( DRY_RUN )); then
    # In dry-run, after_sha = before_sha for existing files; for missing
    # destinations, compute the source sha to predict "new".
    if [[ "$before_sha" == "MISSING" ]]; then
      after_sha="$(sha256_of "$src")"
      status="new (would write)"
    else
      src_sha="$(sha256_of "$src")"
      if [[ "$src_sha" == "$before_sha" ]]; then
        status="unchanged"
      else
        status="updated (would write)"
      fi
      after_sha="$src_sha"
    fi
    size_bytes="$(size_of "$src")"
  else
    after_sha="$(sha256_of "$dst")"
    if [[ "$before_sha" == "MISSING" ]]; then
      status="new"
    elif [[ "$before_sha" == "$after_sha" ]]; then
      status="unchanged"
    else
      status="updated"
    fi
    size_bytes="$(size_of "$dst")"
  fi

  rows+=("${base}|${status}|${size_bytes}")
done

# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

printf '%-58s  %-22s  %10s\n' "FILE" "STATUS" "SIZE(B)"
printf '%-58s  %-22s  %10s\n' \
  "----------------------------------------------------------" \
  "----------------------" \
  "----------"
for row in "${rows[@]}"; do
  IFS='|' read -r f s b <<<"$row"
  printf '%-58s  %-22s  %10s\n' "$f" "$s" "$b"
done

echo
if (( DRY_RUN )); then
  echo "Dry run complete. Re-run without --dry-run to apply."
else
  echo "Sync complete. ${#SPEC_FILES[@]} file(s) mirrored to ${DEST_DIR}."
fi
