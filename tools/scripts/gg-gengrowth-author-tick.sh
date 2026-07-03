#!/bin/bash
# gg-gengrowth-author-tick.sh — AUTHORING lane for gengrowth.ai blog (阶段 3 · 杀"漏写").
#
# WHY (审计根因 = LLM_CONVENTION): gengrowth blog articles were AUTHORED BY HAND (a human ran a
# workflow), while astrologywiki has a cron author lane. That asymmetry is exactly the "漏写"
# failure mode — a step that only happens if a person remembers. This tick makes gengrowth
# authoring a DETERMINISTIC lane, mirroring com.gengrowth.seo-author (astrology):
#   · reuse the SAME author engine (gg-seo-autopilot.mjs --author), which is site-agnostic where it
#     matters — brief source (workbook id env), phase2 contract (GG_SITE=gengrowth), CTA, and the
#     claude -p worker cwd-isolation are all switchable via env (verified 2026-07-03).
#   · ONLY authors drafts into flow-mvp/_staging; the existing hourly gg-gengrowth-publish lane
#     (Lane A) picks up ready drafts and upserts them to Supabase. Fully decoupled from publishing.
#
# PUBLISH HANDOFF (the one gengrowth-specific step): the author engine emits `_staging/<PID>-en.md`
# (+ `-en.manifest.json`, phase2 overall=pass), but the gengrowth publisher's scanReady only consumes
# `_staging/PG-<W25>-NNN-<llm>-v8.md` + a sibling manifest with overall=pass. phase2's `--tag` only
# sets the OUTPUT FILENAME (content is identical for any tag), so a byte COPY of the passing `-en`
# pair → the `-<winner>-v8` names is provably equivalent to re-validating, and — unlike re-running
# phase2 — CANNOT silently strand an authored draft on a missing render fixture (which would re-create
# the very "漏" this lane exists to kill). Verified: the copied pair is reported READY by the publisher.
#
# ANTI-CONTAMINATION is CODE, not convention: this tick pins GG_AUTOPILOT_PLAN to the gengrowth W25
# plan and the gengrowth workbook; the astrology autopilot's latestPlan() EXCLUDES gengrowth plans and
# its publish leg is hardcoded to xdawayer/oracle, and the gengrowth publisher is prefix-gated to
# W25_PREFIXES (DRAFT_RE). This tick NEVER touches the oracle repo. A gengrowth draft cannot reach
# astrologywiki, nor an astrology draft gengrowth.
#
# DISABLED until the Phase-5 lane watchdog is in place (whole-flow remediation, 2026-07-03). Install:
#   cp tools/scripts/com.gengrowth.gengrowth-author.plist ~/Library/LaunchAgents/
#   launchctl enable    gui/$(id -u)/com.gengrowth.gengrowth-author
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.gengrowth-author.plist
#   launchctl kickstart gui/$(id -u)/com.gengrowth.gengrowth-author   # watch the FIRST article
# Stop:  launchctl bootout gui/$(id -u)/com.gengrowth.gengrowth-author
#
# Knobs: GG_GENGROWTH_AUTHOR_BATCH (default 2, max articles per fire), GG_GENGROWTH_AUTHOR_TIMEOUT
# (default 1800s per-article hard cap), GG_WINNER_LLM (default claude → `<PID>-claude-v8` handoff tag).
set -uo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLOW="$(cd "$SCRIPT_DIR/../.." && pwd)"
OPS="$HOME/gengrowth-ops/inbox/06-tasks/tasks"
PLAN_NAME="2026-06-16-W25-gengrowth-blog-output-plan.md"
PLAN="$OPS/$PLAN_NAME"
LOCK="/tmp/gg-gengrowth-author.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/gengrowth_author"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"
NOTIFY="$SCRIPT_DIR/gg-notify.mjs"
CLAIMS="$OPS/.autopilot-claims.json"

# ── PID-liveness mutex (macOS has no flock; same robust pattern as gg-seo-author-tick) ──
# Active only if the stored pid is alive AND its start-time matches — a RECYCLED pid can't wedge
# authoring into a permanent silent skip. A dead/recycled lock → steal it.
if [ -d "$LOCK" ]; then
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null)"
  lock_start="$(cat "$LOCK/start" 2>/dev/null)"
  cur_start=""
  [ -n "$lock_pid" ] && cur_start="$(ps -o lstart= -p "$lock_pid" 2>/dev/null | tr -s ' ')"
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null && [ -n "$lock_start" ] && [ "$cur_start" = "$lock_start" ]; then
    echo "$(date '+%F %T') skip — previous gengrowth authoring fire (pid $lock_pid) still active" >> "$LOG"
    exit 0
  fi
  echo "$(date '+%F %T') stale gengrowth author lock (pid ${lock_pid:-?} dead/recycled) — taking over" >> "$LOG"
  rm -rf "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — lost gengrowth author mutex race" >> "$LOG"
  exit 0
fi
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT INT TERM
echo "$$" > "$LOCK/pid"
ps -o lstart= -p $$ 2>/dev/null | tr -s ' ' > "$LOCK/start"

# full cron env (a bare cron inherits neither _gg.env nor the plist env). Source BEFORE reading the
# knobs so GG_GENGROWTH_AUTHOR_BATCH/TIMEOUT set in _gg.env actually take effect (else they'd be
# read here with only plist/caller env visible → silently ignored).
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null || true; set +a

# per-item hard cap DEFAULT 3600s: the author chain = orchestrator (≤30min) + multi-party review
# (~10-15min), and phase2 writes the passing -en.md BEFORE review runs. A cap below that sum SIGKILLs
# during review — see the rc-independent handoff below (a passing -en.md is salvaged regardless of rc,
# so a low cap only loses the review polish, never strands the draft). Overridable via _gg.env.
BATCH="${GG_GENGROWTH_AUTHOR_BATCH:-2}"
TICK_TIMEOUT="${GG_GENGROWTH_AUTHOR_TIMEOUT:-3600}"
# Validate numeric + clamp (env-controlled; guard against option-injection / chaos config).
case "$BATCH" in ''|*[!0-9]*) BATCH=2 ;; esac
case "$TICK_TIMEOUT" in ''|*[!0-9]*) TICK_TIMEOUT=3600 ;; esac
[ "$BATCH" -ge 1 ] 2>/dev/null || BATCH=1; [ "$BATCH" -le 10 ] 2>/dev/null || BATCH=10
[ "$TICK_TIMEOUT" -ge 60 ] 2>/dev/null || TICK_TIMEOUT=3600

echo "" >> "$LOG"
echo "$(date '+%F %T') gengrowth author tick start (pid $$, batch $BATCH, per-item cap ${TICK_TIMEOUT}s)" >> "$LOG"

# 重放 outbox 里发送失败的积压通知（fail-closed 的补发闭环；无积压时零开销）。
node "$NOTIFY" replay-outbox >/dev/null 2>&1 || true

[ -f "$PLAN" ] || { echo "$(date '+%F %T') gengrowth plan not found: $PLAN — nothing to do" >> "$LOG"; exit 0; }

# gtimeout (coreutils) is REQUIRED — it's the per-item wall-clock cap. If absent, every fire would
# author with no cap (or fail rc=127 → no draft → silent no-op). Fail loud instead of silently idling.
if ! command -v gtimeout >/dev/null 2>&1; then
  echo "$(date '+%F %T') gtimeout not on PATH — cannot cap authoring; skipping fire" >> "$LOG"
  node "$NOTIFY" preflight_fail --lane gengrowth-author --log "$LOG" >/dev/null 2>&1 || true
  exit 2
fi

# Preflight — fail fast on a broken host before spending LLM budget (skip the slow live CLI smoke).
if ! node "$SCRIPT_DIR/gg-autopilot-preflight.mjs" --skip-live-cli >> "$LOG" 2>&1; then
  node "$NOTIFY" preflight_fail --lane gengrowth-author --log "$LOG"
  exit 2
fi

# ── gengrowth authoring context (all env, no core-code assumptions) ──────────
export GG_SITE=gengrowth                                              # phase2 → gengrowth B2B contract
export GG_SHEETS_FLOW_MVP_WORKBOOK_ID="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-}"  # brief source = gengrowth workbook
export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-}"           # (belt: some paths read the legacy var)
export GG_AUTOPILOT_PLAN="$PLAN_NAME"                                 # PIN — latestPlan() auto-select EXCLUDES gengrowth
unset  GG_AUTOPILOT_MODE                                              # publish-only would refuse --author
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"           # gbrain (RAG) + codex (review)
export GG_REVIEW_CODEX_TIMEOUT_MS="${GG_REVIEW_CODEX_TIMEOUT_MS:-60000}"
export GG_REVIEW_OPUS_TIMEOUT_MS="${GG_REVIEW_OPUS_TIMEOUT_MS:-420000}"
export GG_REVIEW_REVISER_TIMEOUT_MS="${GG_REVIEW_REVISER_TIMEOUT_MS:-420000}"

if [ -z "${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-}" ]; then
  echo "$(date '+%F %T') GG_SHEETS_GENGROWTH_WORKBOOK_ID unset in _gg.env — cannot pull gengrowth briefs; skip" >> "$LOG"
  node "$NOTIFY" preflight_fail --lane gengrowth-author --log "$LOG" >/dev/null 2>&1 || true
  exit 2
fi

WINNER="${GG_WINNER_LLM:-claude}"
TAG="${WINNER}-v8"                                                    # publisher consumes <PID>-<llm>-v8.md

# Collect unchecked plan items: "- [ ] `PG-<W25>-NN` keyword..."  →  "PG-<W25>-NN<TAB>keyword"
ITEMS="$(grep -nE '^- \[ \] *`?PG-[A-Z]+-[0-9]+' "$PLAN" \
  | sed -E 's/^[0-9]+:- \[ \] *`?(PG-[A-Z]+-[0-9]+)`? *(.*)$/\1\t\2/' \
  | sed -E 's/[[:space:]]*->.*$//; s/`//g')"
if [ -z "$ITEMS" ]; then echo "$(date '+%F %T') no unchecked gengrowth items — nothing to author" >> "$LOG"; exit 0; fi

# node helpers (node is always present; avoids coreutils dependency for these checks).
# manifest overall=pass?  usage: manifest_pass <manifest.json>
manifest_pass() {
  node -e 'try{process.exit(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))?.phase2_checks?.overall==="pass"?0:1)}catch(e){process.exit(1)}' "$1" 2>/dev/null
}
# -en.md is a COMPLETE, non-truncated draft (frontmatter open + slug + non-trivial body). Guards the
# sub-ms window where a SIGKILL mid-write leaves a truncated md next to a stale passing manifest.
draft_sane() {
  node -e 'try{const t=require("fs").readFileSync(process.argv[1],"utf8");process.exit(t.startsWith("---\n")&&/^slug:\s*\S/m.test(t)&&t.length>400?0:1)}catch(e){process.exit(1)}' "$1" 2>/dev/null
}
# PID already has a claim in the ledger (done / needs_human / in-flight) → --author --task will no-op.
has_claim() {
  node -e 'try{const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(Object.keys(c).some(x=>x.includes(process.argv[2]))?0:1)}catch(e){process.exit(1)}' "$CLAIMS" "$1" 2>/dev/null
}

n=0
while IFS=$'\t' read -r pid kw; do
  [ -z "${pid:-}" ] && continue
  if [ "$n" -ge "$BATCH" ]; then echo "$(date '+%F %T') reached BATCH=$BATCH — remaining items wait for next fire" >> "$LOG"; break; fi
  kw="$(echo "$kw" | sed -E 's/[[:space:]]*\(.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//')"

  READY_MD="$FLOW/_staging/${pid}-${TAG}.md"
  READY_MANIFEST="$FLOW/_staging/${pid}-${TAG}.manifest.json"
  EN_MD="$FLOW/_staging/${pid}-en.md"
  EN_MANIFEST="$FLOW/_staging/${pid}-en.manifest.json"

  # Idempotency (code, not the mutable plan checkbox) — both skips are BEFORE n++, so a skipped item
  # never consumes the BATCH budget (else parked/live head items starve authorable items below them).
  # (1) a publish-ready draft already exists (already-authored/already-live; publish lane is the
  #     durable check). (2) the PID already has a claim (done/needs_human/in-flight) → --author --task
  #     would no-op anyway. Only genuinely fresh items reach authoring.
  if [ -f "$READY_MD" ] && manifest_pass "$READY_MANIFEST"; then
    echo "$(date '+%F %T') $pid ($kw): already has a publish-ready draft — skip (no budget spent)" >> "$LOG"
    continue
  fi
  if has_claim "$pid"; then
    echo "$(date '+%F %T') $pid ($kw): already has a claim (parked/in-flight/done) — skip (no budget spent)" >> "$LOG"
    continue
  fi

  n=$((n + 1))
  echo "$(date '+%F %T') --- $pid :: $kw (item $n/$BATCH) ---" >> "$LOG"

  # brief hygiene: fill empty search_volume so render doesn't fail-closed
  node "$SCRIPT_DIR/gg-ensure-search-volume.mjs" --keyword "$kw" >> "$LOG" 2>&1 || true

  # author (Opus orchestrator, cwd-isolated worker). Leaves _staging/<pid>-en.md on PASS; parks on fail.
  AOUT="$(gtimeout "$TICK_TIMEOUT" node "$AUTO" --author --task "$pid" --limit 1 2>&1)"; _rc=$?
  printf '%s\n' "$AOUT" >> "$LOG"

  # Handoff is FILESYSTEM-driven and INDEPENDENT of rc. phase2 writes the passing -en.md BEFORE the
  # best-effort multi-party review; a cap-hit (rc=124) DURING review must still salvage that valid
  # draft — otherwise the publisher (which only scans <PID>-<llm>-v8.md) never sees it and it is
  # STRANDED forever, re-authored+re-stranded every fire (the exact 漏发 this lane exists to kill).
  # Require manifest_pass AND draft_sane so a kill mid-write can't hand off a truncated md.
  if [ -f "$EN_MD" ] && manifest_pass "$EN_MANIFEST" && draft_sane "$EN_MD"; then
    cp -f "$EN_MD" "$READY_MD"
    cp -f "$EN_MANIFEST" "$READY_MANIFEST"
    cut=""; [ "$_rc" -eq 124 ] && cut=" (review cut by ${TICK_TIMEOUT}s cap — draft is phase2-passing, shipped as-is)"
    echo "$(date '+%F %T') $pid: AUTHORED + handoff → ${pid}-${TAG}.md${cut} — publish lane will pick up" >> "$LOG"
    node "$NOTIFY" authored --site gengrowth --detail "$pid $kw — 待 gengrowth publish lane 发布" >/dev/null 2>&1 || true
  elif [ "$_rc" -eq 124 ]; then
    # capped with NO passing draft = genuinely incomplete (killed mid-generation). Alert WITH the pid
    # so the strand isn't silent; next fire re-authors (bounded by the higher default cap).
    echo "$(date '+%F %T') $pid: hit ${TICK_TIMEOUT}s cap with no passing draft — incomplete" >> "$LOG"
    node "$NOTIFY" lane_timeout --lane "gengrowth-author ($pid)" --seconds "$TICK_TIMEOUT" >/dev/null 2>&1 || true
  else
    # No passing draft, clean exit = parked (needs_human). Announce a fresh park (@PM+OPS).
    PARK="$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)"
    if [ -n "$PARK" ]; then
      PARK_REASON="$(printf '%s\n' "$PARK" | sed -E 's/^PARK\(author\) //; s/^PG-[A-Z0-9-]+:[[:space:]]*//')"
      node "$NOTIFY" parked --site gengrowth --pid "$pid" --reason "$PARK_REASON" >/dev/null 2>&1 || true
    else
      echo "$(date '+%F %T') $pid: no passing draft and no fresh park (unexpected) — see log" >> "$LOG"
    fi
  fi
done <<< "$ITEMS"

echo "$(date '+%F %T') gengrowth author tick end (attempted=$n)" >> "$LOG"
node "$SCRIPT_DIR/gg-notify.mjs" heartbeat com.gengrowth.gengrowth-author >/dev/null 2>&1 || true  # 阶段5 lane 心跳
