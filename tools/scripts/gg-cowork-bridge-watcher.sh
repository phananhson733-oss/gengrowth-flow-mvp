#!/bin/bash
# gg-cowork-bridge-watcher.sh — Mac-side half of the Cowork→Mac autopilot bridge.
#
# WHY: the Cowork scheduled task ("cowork-seo-supervisor") runs in a Linux sandbox
# that CANNOT reach this Mac's ~/oracle, gh, launchctl, or ~/.config/gg secrets. It
# therefore cannot author/publish itself. Instead, when it detects pending/stuck work
# it drops a small JSON *kick request* into  <repo>/.gg-bridge/requests/  inside the
# selected (Cowork-synced) gengrowth-flow-mvp folder. Cowork file-sync + this repo's
# obsidian-git (autoPullInterval=1) propagate that file to ~/gengrowth-flow-mvp here.
#
# THIS script is the Mac listener: launchd fires it every few minutes; it picks up any
# FRESH, not-yet-acked request and kicks the real launchd autopilot (publish lane, and
# the author lane when the request asks for authoring), then writes an ack JSON back so
# the next Cowork run can report what happened. It NEVER authors/publishes by itself —
# it only kickstarts the existing, trusted launchd jobs (deterministic-driver boundary).
#
# Install: see docs/2026-06-22-cowork-bridge-setup.md (loads com.gengrowth.cowork-bridge.plist).
# Manual run / dry-run:
#   bash ~/gengrowth-flow-mvp/tools/scripts/gg-cowork-bridge-watcher.sh            # process one
#   GG_BRIDGE_DRYRUN=1 bash ~/.../gg-cowork-bridge-watcher.sh                      # no kick, just log
#
# Exit: 0 = ok (kicked or nothing to do), 2 = env/structure error. Always non-fatal to
# the content line: a bad request is acked as "skipped", never crashes the autopilot.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${GG_FLOW_REPO:-$HOME/gengrowth-flow-mvp}"
BRIDGE_DIR="$REPO/.gg-bridge"
REQ_DIR="$BRIDGE_DIR/requests"
ACK_DIR="$BRIDGE_DIR/acks"
STATE="$BRIDGE_DIR/.last-processed"          # epoch seconds of the newest request we've handled
LOG_DIR="$HOME/gengrowth-agents/cron-sync/cowork_bridge"
LOCK="/tmp/gg-cowork-bridge.lock"
# How fresh a request must be to act on (ignore stale leftovers). Default 2h.
FRESH_SECS="${GG_BRIDGE_FRESH_SECS:-7200}"
# launchd labels (match the existing seo autopilot install).
LABEL_PUBLISH="com.gengrowth.seo-autopilot"
LABEL_AUTHOR="com.gengrowth.seo-author"

mkdir -p "$REQ_DIR" "$ACK_DIR" "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
log(){ echo "$(date '+%F %T') $*" >> "$LOG"; }

# Source machine env (best-effort) so launchctl sees the right GUI domain / vars.
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
UID_NUM="$(id -u)"

# ── single-instance PID-liveness mutex (macOS has no flock) ──────────────────
if [ -d "$LOCK" ]; then
  lp="$(cat "$LOCK/pid" 2>/dev/null)"
  if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then log "skip — prev run pid $lp alive"; exit 0; fi
  rm -rf "$LOCK" 2>/dev/null
fi
mkdir "$LOCK" 2>/dev/null || { log "skip — lost mutex race"; exit 0; }
echo "$$" > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

[ -d "$REQ_DIR" ] || { log "no requests dir yet ($REQ_DIR) — nothing to do"; exit 0; }

# Newest request file by mtime.
REQ="$(ls -t "$REQ_DIR"/kick-*.json 2>/dev/null | head -1)"
[ -z "$REQ" ] && { log "no kick requests pending"; exit 0; }

now="$(date +%s)"
req_mtime="$(stat -f %m "$REQ" 2>/dev/null || stat -c %Y "$REQ" 2>/dev/null)"
last="$(cat "$STATE" 2>/dev/null || echo 0)"

# Already handled this (or an equal/newer) request?
if [ -n "$req_mtime" ] && [ "$req_mtime" -le "$last" ]; then
  log "newest request $(basename "$REQ") already processed (mtime $req_mtime <= last $last)"; exit 0
fi
# Too old to act on (stale leftover)?
if [ -n "$req_mtime" ] && [ $((now - req_mtime)) -gt "$FRESH_SECS" ]; then
  log "newest request $(basename "$REQ") is stale ($((now - req_mtime))s > ${FRESH_SECS}s) — acking as skipped"
  echo "$req_mtime" > "$STATE"
  printf '{"ackedAt":"%s","request":"%s","result":"skipped-stale","kicked":[]}\n' \
    "$(date -u +%FT%TZ)" "$(basename "$REQ")" > "$ACK_DIR/ack-$(date +%Y%m%d-%H%M%S).json"
  exit 0
fi

# Parse the requested action (default: publish-pending). 'author-and-publish' also kicks the author lane.
ACTION="$(node -e 'try{const r=require(process.argv[1]);process.stdout.write(String(r.action||"publish-pending"))}catch{process.stdout.write("publish-pending")}' "$REQ" 2>/dev/null || echo publish-pending)"
REASON="$(node -e 'try{const r=require(process.argv[1]);process.stdout.write(String(r.reason||""))}catch{}' "$REQ" 2>/dev/null || echo '')"
log "handling $(basename "$REQ") action=$ACTION reason=\"$REASON\""

kicked=()
kick(){ # $1 = launchd label
  local label="$1"
  if [ "${GG_BRIDGE_DRYRUN:-0}" = "1" ]; then log "DRYRUN would kickstart $label"; kicked+=("$label(dryrun)"); return 0; fi
  if launchctl kickstart -k "gui/$UID_NUM/$label" >> "$LOG" 2>&1; then
    log "kickstarted $label"; kicked+=("$label")
  else
    log "kickstart $label failed (job not loaded?) — trying tick fallback"
    if [ "$label" = "$LABEL_PUBLISH" ] && [ -x "$SCRIPT_DIR/gg-seo-autopilot-tick.sh" ]; then
      GG_AUTOPILOT_MODE=publish-only nohup "$SCRIPT_DIR/gg-seo-autopilot-tick.sh" >> "$LOG" 2>&1 &
      log "spawned gg-seo-autopilot-tick.sh (publish-only) as fallback"; kicked+=("$label(tick-fallback)")
    else
      kicked+=("$label(FAILED)")
    fi
  fi
}

case "$ACTION" in
  author-and-publish) kick "$LABEL_AUTHOR"; kick "$LABEL_PUBLISH" ;;
  publish-pending|*)  kick "$LABEL_PUBLISH" ;;
esac

# Mark processed + write ack JSON for the next Cowork supervisor run to read.
echo "$req_mtime" > "$STATE"
KICKED_JSON="$(printf '%s\n' "${kicked[@]}" | node -e 'const a=require("fs").readFileSync(0,"utf8").split("\n").filter(Boolean);process.stdout.write(JSON.stringify(a))' 2>/dev/null || echo '[]')"
ACK="$ACK_DIR/ack-$(date +%Y%m%d-%H%M%S).json"
printf '{"ackedAt":"%s","request":"%s","action":"%s","result":"kicked","kicked":%s}\n' \
  "$(date -u +%FT%TZ)" "$(basename "$REQ")" "$ACTION" "$KICKED_JSON" > "$ACK"
log "ack written $ACK kicked=$KICKED_JSON"

# Keep the bridge dirs from growing unbounded: retain ~200 newest requests/acks.
ls -t "$REQ_DIR"/kick-*.json 2>/dev/null | tail -n +201 | xargs -I{} rm -f {} 2>/dev/null || true
ls -t "$ACK_DIR"/ack-*.json  2>/dev/null | tail -n +201 | xargs -I{} rm -f {} 2>/dev/null || true
exit 0
