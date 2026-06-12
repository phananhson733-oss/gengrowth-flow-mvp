#!/bin/bash
# W23 MAHADASHA cluster: mahadasha pillar + rahu/ketu/saturn(shani)/venus spokes.
# / famous), EN then ZH. render (idempotent) -> generate (Opus 4.8 xhigh) ->
# validate (--allow-missing-serp: no SERP scraper, RL3 skipped). Live untouched;
# output -> _staging/. Logs to /tmp/w23-mahadasha.log. Mirrors _run-w22-transits.sh.
set -u
cd /Users/wzb/gengrowth-flow-mvp
LOG=/tmp/w23-mahadasha.log
: > "$LOG"
BATCH=".gg-cache/batches/w23-mahadasha.json"
OVR=".gg-cache/overrides/w23-mahadasha.json"

# page_id|row|langs
JOBS=(
  "PG-MAHADASHA-001|1|en,zh"
  "PG-MAHADASHA-003|2|en,zh"
  "PG-MAHADASHA-002|3|en,zh"
  "PG-MAHADASHA-004|4|en,zh"
  "PG-MAHADASHA-006|5|en,zh"
)

run_lang () {
  local pid="$1" row="$2" lang="$3"
  local prompt tag outdir
  if [ "$lang" = "zh" ]; then
    prompt=".gg-cache/prompts/${pid}.v8.zh-prompt.md"; tag="zh"; outdir="_staging/zh-demo"; mkdir -p "$outdir"
  else
    prompt=".gg-cache/prompts/${pid}.v8-prompt.md"; tag="en"; outdir="_staging"
  fi
  echo "===== $pid [$lang] =====" >> "$LOG"
  node tools/scripts/gg-render-batch.mjs --batch "$BATCH" --row "$row" --language "$lang" --overrides "$OVR" >> "$LOG" 2>&1
  if [ ! -f "$prompt" ]; then echo "RENDER-FAIL: no prompt $prompt" >> "$LOG"; echo "$pid|$lang|RENDER-FAIL"; return; fi
  node tools/scripts/gg-llm-orchestrator.mjs --prompt "$prompt" --page-id "$pid" --models claude --out-dir "$outdir" >> "$LOG" 2>&1
  local raw="${outdir}/${pid}-claude-v8.md"
  if [ ! -f "$raw" ]; then echo "GEN-FAIL: no $raw" >> "$LOG"; echo "$pid|$lang|GEN-FAIL"; return; fi
  local langflag=""; [ "$lang" = "zh" ] && langflag="--language zh"
  local verdict
  verdict=$(node tools/scripts/_phase2-validate.mjs --source "$raw" --tag "$tag" --page-id "$pid" --prompt-version v8 --allow-missing-serp $langflag 2>&1 | tee -a "$LOG" | grep -E 'OVERALL|word count' | tr '\n' ' ')
  echo "$pid|$lang|$verdict"
}

echo "W23-MAHADASHA BATCH START $(date)" | tee -a "$LOG"
: > /tmp/w23-mahadasha-results.txt
for job in "${JOBS[@]}"; do
  IFS='|' read -r pid row langs <<< "$job"
  IFS=',' read -ra LS <<< "$langs"
  for L in "${LS[@]}"; do
    run_lang "$pid" "$row" "$L" | tee -a /tmp/w23-mahadasha-results.txt
  done
done
echo "W23-MAHADASHA BATCH DONE $(date)" | tee -a "$LOG"
