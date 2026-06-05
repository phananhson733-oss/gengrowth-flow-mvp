#!/bin/bash
# gg-seo-autopilot-tick.sh — launchd entry point for the SEO autopilot (full loop).
# Fires every ~25 min. Each tick does ONE heavy op (never both):
#   • scan (cheap) claims a ready draft → oracle preview branch + PR; then if a
#     preview is pending, a headless claude pass verifies (codex + chrome) + merges
#     to prod. — the PUBLISH half.
#   • else, if a plan task has no draft yet, --author runs the deterministic
#     authoring chain (bridge→RAG→render→orchestrator→phase2) so the NEXT tick's
#     scan can publish it. — the AUTHORING half (the orchestrator spends the Opus $).
# One task per tick = the 20–30 min stagger. Find task → Sheet → LLM author →
# verify → publish, all on this machine, unattended.
#
# Single-instance: a mkdir mutex (macOS has no flock) prevents overlapping ticks.
# Install: see com.gengrowth.seo-autopilot.plist (NOT auto-loaded).

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROMPT_FILE="$SCRIPT_DIR/seo-autopilot-tick.prompt.md"
LOCK="/tmp/gg-seo-autopilot.lock"
LOG_DIR="$HOME/gengrowth-agents/cron-sync/seo_autopilot"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"

# mutex: a tick can run long (verify waits on Vercel); skip if one is in flight.
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "$(date '+%F %T') skip — previous tick still running" >> "$LOG"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

echo "$(date '+%F %T') tick start" >> "$LOG"

# NOTE: flow-mvp (_staging drafts) and gengrowth-ops (task plan) are BOTH kept
# current by their obsidian-git plugins (autoPullInterval=1 → pull every ~1 min,
# pullBeforePush=true), so the tick does NOT pull them itself — that would be
# redundant and risk fighting the plugin for .git/index.lock.

AUTO="$SCRIPT_DIR/gg-seo-autopilot.mjs"

# publish_if_pending — if a preview is pending (pushed/verified), run the headless
# verify+merge gate (codex best-effort + chrome + 3-subagent panel) which merges to
# prod. Returns 0 if it ran the gate, 1 if there was nothing to publish. Reused both
# after the opening scan AND right after authoring, so a freshly-written draft is
# published in the SAME tick instead of waiting for the next one.
publish_if_pending() {
  node "$AUTO" --status 2>/dev/null | grep -Eq '"(pushed-preview|verified-preview)"' || return 1
  echo "$(date '+%F %T') preview pending → running verify+merge gate" >> "$LOG"
  # --dangerously-skip-permissions: unattended autonomy. The driver only merges
  # after the ledger is marked verified by the codex + chrome preview gate.
  # --mcp-config: headless `claude -p` does NOT auto-load the user-scoped
  # playwright MCP; load it explicitly so the chrome preview verification works.
  # </dev/null: prompt is passed as an arg, so skip the 3s stdin wait.
  claude -p "$(cat "$PROMPT_FILE")" \
    --mcp-config "$SCRIPT_DIR/autopilot-mcp.json" \
    --allowedTools "Bash Skill Task Agent Read Grep mcp__playwright__browser_navigate mcp__playwright__browser_snapshot mcp__playwright__browser_console_messages mcp__playwright__browser_evaluate mcp__playwright__browser_close" \
    --dangerously-skip-permissions </dev/null >> "$LOG" 2>&1
  return 0
}

# 1) Deterministic pass (no LLM cost on idle ticks): sync oracle, claim one ready
#    task, convert, build-gate, push a preview branch + PR — or stand down.
node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1

# 2) Publish a pending preview if there is one (verify + merge to prod).
if publish_if_pending; then
  : # published this tick
else
  # 3) No preview pending → AUTHOR the next unwritten plan task, then IMMEDIATELY
  #    publish it in this same tick (write→publish, no waiting for the next tick).
  #    Deterministic chain (bridge→RAG→render→orchestrator→phase2); the orchestrator
  #    spends the Opus $, every other stage is glue. --author self-gates (cheap exit
  #    if nothing needs authoring) and PARKS needs_human on any stage failure, so a
  #    broken task is skipped next tick instead of re-burning an LLM call. Sheets creds.
  if [ -n "$(node "$AUTO" --next-unauthored 2>/dev/null)" ]; then
    echo "$(date '+%F %T') no preview → authoring next unwritten task" >> "$LOG"
    AOUT=$( ( set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null; set +a
      export GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_FLOW_MVP_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}"
      # gbrain (~/.local/bin, RAG) + codex (~/.npm-global/bin, multi-party review);
      # claude/node are in /opt/homebrew/bin (already on PATH from the top export).
      export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"
      node "$AUTO" --author --limit 1 ) 2>&1 )
    printf '%s\n' "$AOUT" >> "$LOG"
    # Feishu alert (via lark-cli REST — reliable) on a fresh park (needs a human)
    # or a freshly-authored draft (progress). Best-effort, never blocks the tick.
    PARK=$(printf '%s\n' "$AOUT" | grep -oE 'PARK\(author\) .*' | head -1)
    DONE=$(printf '%s\n' "$AOUT" | grep -oE 'AUTHORED PG-[A-Z0-9-]+ [^—]*' | head -1)
    [ -n "$PARK" ] && "$SCRIPT_DIR/gg-lark-notify.sh" "⚠️ SEO autopilot 写稿暂停（needs_human）：$PARK"
    if [ -n "$DONE" ]; then
      "$SCRIPT_DIR/gg-lark-notify.sh" "✍️ SEO autopilot 写好一篇：$DONE— 立即发布中"
      # IMMEDIATE PUBLISH: claim+convert+preview the just-written draft, then run the
      # verify+merge gate on it NOW — no waiting for the next scheduled tick.
      node "$AUTO" --scan --limit 1 >> "$LOG" 2>&1
      publish_if_pending || echo "$(date '+%F %T') authored but no preview to publish (scan/convert gate?)" >> "$LOG"
    fi
  else
    echo "$(date '+%F %T') no preview, nothing to author — idle" >> "$LOG"
  fi
fi

echo "$(date '+%F %T') tick end" >> "$LOG"
