#!/bin/bash
# One-off v4.4 day1 batch regenerator. NOT a committed tool — drives
# render -> generate (Opus) -> validate for the 10 day1 pages, EN then ZH.
# orange EN is intentionally skipped (kept as the accepted 1200-word draft).
# Logs to /tmp/v44-batch.log. Live untouched; validated output -> _staging/<page>-<lang>.md
set -u
cd /Users/wzb/gengrowth-flow-mvp
LOG=/tmp/v44-batch.log
: > "$LOG"
REG=".gg-cache/batches/20260526T105228-选题登记表-rows-2-52.json"
SUP=".gg-cache/batches/20260522T193000-aura-related-supplement.json"
OVR_DAY1=".gg-cache/overrides-day1.json"
OVR_AURA=".gg-cache/overrides/aura-related-batch.json"

# page_id|batch|row|overrides|langs   (langs csv; orange = zh only)
JOBS=(
  "page_orange_aura_meaning|$SUP|1|$OVR_AURA|en,zh"
  "PG-HOUSE-001|$REG|11|$OVR_DAY1|en,zh"
  "PG-HOUSE-002|$REG|12|$OVR_DAY1|en,zh"
  "PG-HOUSE-003|$REG|13|$OVR_DAY1|en,zh"
  "PG-HOUSE-004|$REG|14|$OVR_DAY1|en,zh"
  "PG-HOUSE-005|$REG|15|$OVR_DAY1|en,zh"
  "PG-NODE-001|$REG|24|$OVR_DAY1|en,zh"
  "PG-NODE-002|$REG|25|$OVR_DAY1|en,zh"
  "PG-NODE-003|$REG|26|$OVR_DAY1|en,zh"
)

run_lang () {
  local pid="$1" batch="$2" row="$3" ovr="$4" lang="$5"
  local prompt langflag tag
  if [ "$lang" = "zh" ]; then
    prompt=".gg-cache/prompts/${pid}.v8.zh-prompt.md"; langflag="--language zh"; tag="zh"
  else
    prompt=".gg-cache/prompts/${pid}.v8-prompt.md"; langflag=""; tag="en"
  fi
  echo "===== $pid [$lang] =====" >> "$LOG"
  node tools/scripts/gg-render-batch.mjs --batch "$batch" --row "$row" --language "$lang" --overrides "$ovr" >> "$LOG" 2>&1
  if [ ! -f "$prompt" ]; then echo "RENDER-FAIL: no prompt $prompt" >> "$LOG"; echo "$pid|$lang|RENDER-FAIL" ; return; fi
  # EN -> _staging/, ZH -> _staging/zh-demo/ so the ZH pass never clobbers the EN draft.
  local outdir="_staging"
  if [ "$lang" = "zh" ]; then outdir="_staging/zh-demo"; mkdir -p "$outdir"; fi
  node tools/scripts/gg-llm-orchestrator.mjs --prompt "$prompt" --page-id "$pid" --models claude --out-dir "$outdir" >> "$LOG" 2>&1
  local raw="${outdir}/${pid}-claude-v8.md"
  if [ ! -f "$raw" ]; then echo "GEN-FAIL: no $raw" >> "$LOG"; echo "$pid|$lang|GEN-FAIL"; return; fi
  local verdict
  verdict=$(node tools/scripts/_phase2-validate.mjs --source "$raw" --tag "$tag" --page-id "$pid" --prompt-version v8 $langflag 2>&1 | tee -a "$LOG" | grep -E 'OVERALL|word count' | tr '\n' ' ')
  echo "$pid|$lang|$verdict"
}

echo "BATCH START $(date)" | tee -a "$LOG"
for job in "${JOBS[@]}"; do
  IFS='|' read -r pid batch row ovr langs <<< "$job"
  IFS=',' read -ra LS <<< "$langs"
  for L in "${LS[@]}"; do
    run_lang "$pid" "$batch" "$row" "$ovr" "$L" | tee -a /tmp/v44-batch-results.txt
  done
done
echo "BATCH DONE $(date)" | tee -a "$LOG"
