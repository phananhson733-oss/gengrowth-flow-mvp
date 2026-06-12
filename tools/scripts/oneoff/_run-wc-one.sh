#!/bin/bash
# Single-article driver for the WC batch: write-one-publish-one cadence.
# Usage: _run-wc-one.sh PG-WC-00N
# Does prep (obsidian-rag astro entity + entity-passport football kw + render both)
# then generate EN + ZH (sonnet-4-6, skip if draft >3KB exists) then phase2-validate.
# Idempotent/resumable. Live untouched; drafts -> _staging/ + _staging/zh-demo/.
set -u
cd /Users/wzb/gengrowth-flow-mvp
PID="${1:?usage: _run-wc-one.sh PG-WC-00N}"
LOG=/tmp/wc-${PID}.log
BATCH=".gg-cache/batches/wc.json"
OVR=".gg-cache/overrides/wc.json"

# page_id -> source_row|football_keyword|astro_entity
case "$PID" in
  PG-WC-001) SR=1541; KW="world cup 2026 astrology prediction"; ASTRO="transits";;
  PG-WC-002) SR=1542; KW="mbappe birth chart"; ASTRO="Sagittarius";;
  PG-WC-003) SR=1543; KW="lionel messi zodiac sign"; ASTRO="Cancer";;
  PG-WC-004) SR=1544; KW="cristiano ronaldo zodiac sign"; ASTRO="Aquarius";;
  PG-WC-005) SR=1545; KW="lamine yamal birth chart"; ASTRO="Cancer";;
  PG-WC-006) SR=1546; KW="vinicius jr zodiac sign"; ASTRO="Cancer";;
  PG-WC-007) SR=1547; KW="argentina world cup 2026 astrology"; ASTRO="Saturn";;
  PG-WC-008) SR=1548; KW="zodiac signs as world cup 2026 teams"; ASTRO="zodiac signs";;
  PG-WC-009) SR=1549; KW="best soccer players zodiac sign"; ASTRO="zodiac signs";;
  PG-WC-010) SR=1550; KW="world cup 2026 june astrology"; ASTRO="transits";;
  *) echo "unknown page $PID"; exit 2;;
esac

: > "$LOG"
echo "===== $PID prep $(date +%H:%M:%S) =====" >> "$LOG"
[ -f ".gg-cache/${PID}/obsidian-rag.json" ]   || node tools/scripts/gg-obsidian-rag.mjs --page-id "$PID" --entity "$ASTRO" --target-keyword "$KW" >> "$LOG" 2>&1
[ -f ".gg-cache/${PID}/entity-passport.rag.json" ] || node tools/scripts/gg-entity-passport.mjs --entity "$KW" --page-id "$PID" --emit-rag >> "$LOG" 2>&1
if [ ! -f ".gg-cache/prompts/${PID}.v8-prompt.md" ] || [ ! -f ".gg-cache/prompts/${PID}.v8.zh-prompt.md" ]; then
  node tools/scripts/gg-render-batch.mjs --batch "$BATCH" --row "$SR" --language both --overrides "$OVR" >> "$LOG" 2>&1
fi

gen_one () {
  local lang="$1" prompt tag outdir raw
  if [ "$lang" = "zh" ]; then prompt=".gg-cache/prompts/${PID}.v8.zh-prompt.md"; tag="zh"; outdir="_staging/zh-demo"; mkdir -p "$outdir"
  else prompt=".gg-cache/prompts/${PID}.v8-prompt.md"; tag="en"; outdir="_staging"; fi
  raw="${outdir}/${PID}-claude-v8.md"
  echo "===== $PID [$lang] gen $(date +%H:%M:%S) =====" >> "$LOG"
  if [ -f "$raw" ] && [ "$(wc -c < "$raw" | tr -d ' ')" -gt 3000 ]; then echo "$PID|$lang|GEN-SKIP(exists)";
  else node tools/scripts/gg-llm-orchestrator.mjs --prompt "$prompt" --page-id "$PID" --models claude --out-dir "$outdir" >> "$LOG" 2>&1; fi
  if [ ! -f "$raw" ]; then echo "$PID|$lang|GEN-FAIL"; return; fi
  local lf=""; [ "$lang" = "zh" ] && lf="--language zh"
  local v; v=$(node tools/scripts/_phase2-validate.mjs --source "$raw" --tag "$tag" --page-id "$PID" --prompt-version v8 --allow-missing-serp $lf 2>&1 | tee -a "$LOG" | grep -E 'OVERALL|word count' | tr '\n' ' ')
  echo "$PID|$lang|${v:-NO-VERDICT}"
}

echo "WC-ONE $PID START $(date)" | tee -a "$LOG"
gen_one en
gen_one zh
echo "WC-ONE $PID DONE $(date)" | tee -a "$LOG"
