#!/usr/bin/env bash
# macOS LaunchAgent entrypoint for the full GenGrowth SEO Blog workflow.
# Scheduling/ownership lives here; the persisted Codex Automation prompt owns the workflow.

set -euo pipefail

export HOME="${HOME:-/Users/awayer_mini}"
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export TZ="Asia/Shanghai"

FLOW="$HOME/gengrowth-flow-mvp"
AUTOMATION="$HOME/.codex/automations/gengrowth-seo-blog/automation.toml"
CODEX_BIN="${GG_CODEX_BIN:-$HOME/.local/bin/codex}"
# Keep unattended publishing off the interactive ~/oracle worktree.  That tree
# may legitimately hold uncommitted product work; this baseline is a clean clone
# of the same remote used only for sync + per-article publish worktrees.
ORACLE_BASELINE="${GG_AUTOMATION_ORACLE_DIR:-$HOME/oracle-autopilot}"
LOCK="/tmp/gg-seo-blog-launchd.lock"
LOG="$HOME/Library/Logs/gg-seo-blog-launchd.out.log"
ERR_LOG="$HOME/Library/Logs/gg-seo-blog-launchd.err.log"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>>"$ERR_LOG"

echo "===== seo-blog launchd tick $(date '+%F %T %Z') ====="

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
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

[[ -x "$CODEX_BIN" ]] || { echo "codex executable unavailable: $CODEX_BIN"; exit 1; }
[[ -f "$AUTOMATION" ]] || { echo "persisted automation unavailable: $AUTOMATION"; exit 1; }
[[ -x "$FLOW/tools/scripts/gg-nightly-seo.sh" ]] || { echo "nightly wrapper unavailable"; exit 1; }
[[ -d "$ORACLE_BASELINE/.git" ]] || { echo "clean Oracle baseline unavailable: $ORACLE_BASELINE"; exit 1; }
export GG_AUTOMATION_ORACLE_DIR="$ORACLE_BASELINE"
export GG_ORACLE_DIR="$ORACLE_BASELINE"

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

echo "single-executor preflight passed; starting persisted Codex SEO automation prompt"
python3 - "$AUTOMATION" <<'PY' | "$CODEX_BIN" exec \
  --sandbox danger-full-access \
  -C "$FLOW" \
  --add-dir "$HOME/gengrowth-ops" \
  --add-dir "$HOME/gengrowth-wiki" \
  --add-dir "$HOME/oracle-autopilot" \
  -
import sys
import tomllib

with open(sys.argv[1], 'rb') as automation_file:
    print(tomllib.load(automation_file)['prompt'])
PY

echo "===== seo-blog launchd tick complete $(date '+%F %T %Z') ====="
