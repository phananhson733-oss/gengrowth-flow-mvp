#!/bin/bash
# One-off W22 6/12 World Cup 2026 batch (PG-WC-001..010), EN then ZH.
# Per page: obsidian-rag + entity-passport(--emit-rag) -> render(both) ->
# generate(sonnet-4-6 via --models claude) -> phase2-validate(--allow-missing-serp).
# Idempotent/resumable: skips RAG/render/gen steps whose outputs already exist.
# Live untouched; drafts -> _staging/ (EN) + _staging/zh-demo/ (ZH).
# Logs: /tmp/wc-run.log  Results: /tmp/wc-results.txt
set -u
cd /Users/wzb/gengrowth-flow-mvp
LOG=/tmp/wc-run.log
RES=/tmp/wc-results.txt
BATCH=".gg-cache/batches/wc.json"
OVR=".gg-cache/overrides/wc.json"

# page_id|source_row|football_keyword|astro_entity
#   football_keyword -> entity-passport (scrape player/topic facts)
#   astro_entity     -> obsidian-rag (gengrowth-wiki vault is rich in astrology;
#                       AND-token matcher needs a clean astro term, not the kw).
#   gbrain is unusable on this box (macOS 26.3 PGLite WASM bug), so obsidian-rag.
JOBS=(
  "PG-WC-001|1541|world cup 2026 astrology prediction|transits"
  "PG-WC-002|1542|mbappe birth chart|Sagittarius"
  "PG-WC-003|1543|lionel messi zodiac sign|Cancer"
  "PG-WC-004|1544|cristiano ronaldo zodiac sign|Aquarius"
  "PG-WC-005|1545|lamine yamal birth chart|Cancer"
  "PG-WC-006|1546|vinicius jr zodiac sign|Cancer"
  "PG-WC-007|1547|argentina world cup 2026 astrology|Saturn"
  "PG-WC-008|1548|zodiac signs as world cup 2026 teams|zodiac signs"
  "PG-WC-009|1549|best soccer players zodiac sign|zodiac signs"
  "PG-WC-010|1550|world cup 2026 june astrology|transits"
)

prep () {
  local pid="$1" sr="$2" kw="$3" astro="$4"
  if [ ! -f ".gg-cache/${pid}/obsidian-rag.json" ]; then
    node tools/scripts/gg-obsidian-rag.mjs --page-id "$pid" --entity "$astro" --target-keyword "$kw" >> "$LOG" 2>&1
  fi
  if [ ! -f ".gg-cache/${pid}/entity-passport.rag.json" ]; then
    node tools/scripts/gg-entity-passport.mjs --entity "$kw" --page-id "$pid" --emit-rag >> "$LOG" 2>&1
  fi
  if [ ! -f ".gg-cache/prompts/${pid}.v8-prompt.md" ] || [ ! -f ".gg-cache/prompts/${pid}.v8.zh-prompt.md" ]; then
    node tools/scripts/gg-render-batch.mjs --batch "$BATCH" --row "$sr" --language both --overrides "$OVR" >> "$LOG" 2>&1
  fi
}

run_lang () {
  local pid="$1" lang="$2" prompt tag outdir raw
  if [ "$lang" = "zh" ]; then
    prompt=".gg-cache/prompts/${pid}.v8.zh-prompt.md"; tag="zh"; outdir="_staging/zh-demo"; mkdir -p "$outdir"
  else
    prompt=".gg-cache/prompts/${pid}.v8-prompt.md"; tag="en"; outdir="_staging"
  fi
  raw="${outdir}/${pid}-claude-v8.md"
  echo "===== $pid [$lang] $(date +%H:%M:%S) =====" >> "$LOG"
  if [ ! -f "$prompt" ]; then echo "$pid|$lang|RENDER-FAIL(no prompt)"; return; fi
  # resume: skip generation if a non-trivial draft already exists (>3KB)
  if [ -f "$raw" ] && [ "$(wc -c < "$raw" | tr -d ' ')" -gt 3000 ]; then
    echo "$pid|$lang|GEN-SKIP(exists)"
  else
    node tools/scripts/gg-llm-orchestrator.mjs --prompt "$prompt" --page-id "$pid" --models claude --out-dir "$outdir" >> "$LOG" 2>&1
  fi
  if [ ! -f "$raw" ]; then echo "$pid|$lang|GEN-FAIL(no $raw)"; return; fi
  local langflag=""; [ "$lang" = "zh" ] && langflag="--language zh"
  local verdict
  verdict=$(node tools/scripts/_phase2-validate.mjs --source "$raw" --tag "$tag" --page-id "$pid" --prompt-version v8 --allow-missing-serp $langflag 2>&1 | tee -a "$LOG" | grep -E 'OVERALL|word count' | tr '\n' ' ')
  echo "$pid|$lang|${verdict:-NO-VERDICT}"
}

echo "WC BATCH START $(date)" | tee -a "$LOG"
: > "$RES"
for job in "${JOBS[@]}"; do
  IFS='|' read -r pid sr kw astro <<< "$job"
  prep "$pid" "$sr" "$kw" "$astro"
  for L in en zh; do
    run_lang "$pid" "$L" | tee -a "$RES"
  done
done
echo "WC BATCH DONE $(date)" | tee -a "$LOG"
