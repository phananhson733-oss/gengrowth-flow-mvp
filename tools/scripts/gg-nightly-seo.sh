#!/bin/bash
# gg-nightly-seo.sh — nightly autonomous SEO authoring + publishing for astrologywiki (Lane B).
#
# Fired by the single SEO launchd owner during the approved Asia/Shanghai window.
# For each UNCHECKED "- [ ] PG-XXX <keyword>" item in the proven items snapshot, it:
#   ensure search_volume → --author (Opus orchestrator) → one-row publish scan → preview gate.
# Clean articles merge to prod automatically; anything the codex fact-gate or links-seo gate
# rejects PARKS at needs_human and fires a Lark notify (the safety net — full-auto never ships
# wrong facts). Idempotent: skips items already live or already needs_human-parked.
#
# Anti-contamination: the launcher supplies a canonical author plan and a distinct immutable
# queue snapshot. Authoring rechecks canonical ownership; publishing uses only a one-row plan.
#
# Manual verification must invoke the single owner with explicit canonical plan, proven snapshot,
# expected SHA/identity, and attested manifest bindings; direct unbound execution fails closed.
set -uo pipefail

FLOW="${GG_NIGHTLY_FLOW:-$HOME/gengrowth-flow-mvp}"
PLAN="${GG_SEO_PLAN:-}"
ITEMS_PLAN="${GG_NIGHTLY_ITEMS_PLAN:-}"
ITEMS_SHA256="${GG_NIGHTLY_ITEMS_SHA256:-}"
ITEMS_IDENTITY="${GG_NIGHTLY_ITEMS_IDENTITY:-}"
ITEMS_DIR_IDENTITY="${GG_NIGHTLY_ITEMS_DIR_IDENTITY:-}"
ATTESTED_MANIFEST="${GG_NIGHTLY_ATTESTED_MANIFEST:-}"
ATTESTED_MANIFEST_SHA256="${GG_NIGHTLY_ATTESTED_MANIFEST_SHA256:-}"
ATTESTED_MANIFEST_IDENTITY="${GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY:-}"
VALIDATOR_NODE="${GG_NIGHTLY_VALIDATOR_NODE:-}"
CLAIMS="${GG_NIGHTLY_CLAIMS:-$HOME/gengrowth-ops/inbox/06-tasks/tasks/.autopilot-claims.json}"
LOG="${GG_NIGHTLY_LOG:-$HOME/Library/Logs/gg-nightly-seo.log}"
LOCK="${GG_NIGHTLY_LOCK:-/tmp/gg-nightly-seo.lock}"
MAX="${GG_NIGHTLY_MAX:-6}"          # cap articles per night (bounds cost + risk)
SITE="https://www.astrologywiki.com"

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
echo ""
echo "===== nightly-seo run $(date '+%F %T %Z') (max=$MAX) ====="

# single-flight lock (DIRECTORY, like the other gg locks)
if ! mkdir "$LOCK" 2>/dev/null; then echo "another nightly/publish run holds $LOCK — exit"; exit 0; fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

# full cron env (a bare cron inherits neither _gg.env nor the plist env)
export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# The interactive ~/oracle checkout may contain uncommitted product work.  When
# launchd pins a clean publishing baseline, preserve it across the shared env
# file so syncOracle() never resets the interactive checkout.
AUTOMATION_ORACLE_DIR="${GG_AUTOMATION_ORACLE_DIR:-}"
set -a; . "$HOME/.config/gg/_gg.env" 2>/dev/null || true; set +a
[ -n "$AUTOMATION_ORACLE_DIR" ] && export GG_ORACLE_DIR="$AUTOMATION_ORACLE_DIR"
export GG_SEO_PLAN="$PLAN"
export GG_NIGHTLY_ITEMS_PLAN="$ITEMS_PLAN"
export GG_AUTOPILOT_PLAN="$PLAN"
export GG_NIGHTLY_ITEMS_SHA256="$ITEMS_SHA256"
export GG_NIGHTLY_ITEMS_IDENTITY="$ITEMS_IDENTITY"
export GG_NIGHTLY_ITEMS_DIR_IDENTITY="$ITEMS_DIR_IDENTITY"
export GG_NIGHTLY_ATTESTED_MANIFEST="$ATTESTED_MANIFEST"
export GG_NIGHTLY_ATTESTED_MANIFEST_SHA256="$ATTESTED_MANIFEST_SHA256"
export GG_NIGHTLY_ATTESTED_MANIFEST_IDENTITY="$ATTESTED_MANIFEST_IDENTITY"
unset GG_AUTOPILOT_MODE        # publish-only mode would refuse to author
unset GG_SITE                  # oracle/astrology default; do NOT set to gengrowth
export GG_CODEX_BIN="$FLOW/tools/scripts/gg-codex-pr-review.mjs"   # plist env on the other lanes

cd "$FLOW" || { echo "no $FLOW"; exit 1; }
case "$PLAN" in
  /*) ;;
  *) echo "canonical plan must be an absolute path"; exit 1 ;;
esac
case "$ITEMS_PLAN" in
  /*) ;;
  *) echo "nightly items plan must be an absolute path"; exit 1 ;;
esac
case "$ATTESTED_MANIFEST" in
  /*) ;;
  *) echo "attested manifest must be an absolute path"; exit 1 ;;
esac
[ "$PLAN" != "$ITEMS_PLAN" ] || { echo "canonical and nightly items plans must be distinct"; exit 1; }
[ "$PLAN" != "$ATTESTED_MANIFEST" ] || { echo "canonical plan and attested manifest must be distinct"; exit 1; }
[ "$ITEMS_PLAN" != "$ATTESTED_MANIFEST" ] || { echo "nightly items plan and attested manifest must be distinct"; exit 1; }
[ -f "$PLAN" ] && [ ! -L "$PLAN" ] || { echo "canonical plan must be a regular non-symlink file"; exit 1; }
[[ "$ITEMS_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "nightly items SHA is invalid"; exit 1; }
[[ "$ATTESTED_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "attested manifest SHA is invalid"; exit 1; }
[ -n "$ITEMS_IDENTITY" ] || { echo "nightly items identity is required"; exit 1; }
[ -n "$ITEMS_DIR_IDENTITY" ] || { echo "nightly items directory identity is required"; exit 1; }
[ -n "$ATTESTED_MANIFEST_IDENTITY" ] || { echo "attested manifest identity is required"; exit 1; }
[ -x "$VALIDATOR_NODE" ] || { echo "bound validator node is unavailable"; exit 1; }

lstat_identity() {
  if [ "$(uname -s)" = "Darwin" ]; then
    stat -f '%d:%i' "$1" 2>/dev/null
  else
    stat -c '%d:%i' "$1" 2>/dev/null
  fi
}

file_digest() {
  local output
  output="$(shasum -a 256 "$1" 2>/dev/null)" || return 1
  printf '%s\n' "${output%% *}"
}

bound_file_is_valid() {
  local path="$1"
  local identity="$2"
  local digest="$3"
  [ -f "$path" ] && [ ! -L "$path" ] \
    && [ "$(lstat_identity "$path" 2>/dev/null || true)" = "$identity" ] \
    && [ "$(file_digest "$path" 2>/dev/null || true)" = "$digest" ]
}

bound_parent_dir_is_valid() {
  local items_dir manifest_dir
  items_dir="$(dirname "$ITEMS_PLAN")"
  manifest_dir="$(dirname "$ATTESTED_MANIFEST")"
  [ "$items_dir" = "$manifest_dir" ] \
    && [ -d "$items_dir" ] && [ ! -L "$items_dir" ] \
    && [ "$(lstat_identity "$items_dir" 2>/dev/null || true)" = "$ITEMS_DIR_IDENTITY" ]
}

attested_bundle_is_valid() {
  bound_parent_dir_is_valid \
    && bound_file_is_valid "$ITEMS_PLAN" "$ITEMS_IDENTITY" "$ITEMS_SHA256" \
    && bound_file_is_valid "$ATTESTED_MANIFEST" "$ATTESTED_MANIFEST_IDENTITY" "$ATTESTED_MANIFEST_SHA256"
}

if ! attested_bundle_is_valid; then
  echo "nightly attested snapshot binding failed before business work"
  exit 1
fi

ITEMS="$($VALIDATOR_NODE -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const [manifestPath, planPath, expectedSha] = process.argv.slice(1);
  const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
  const idPattern = /^PG-[A-Z0-9]+-\d+$/;
  try {
    const planText = readFileSync(planPath, "utf8");
    const digest = createHash("sha256").update(planText).digest("hex");
    if (digest !== expectedSha) throw new Error();
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!exactKeys(manifest, ["version", "plan_sha256", "requested_page_ids", "rows"])
      || manifest.version !== 1 || manifest.plan_sha256 !== expectedSha
      || !Array.isArray(manifest.requested_page_ids) || !Array.isArray(manifest.rows)) throw new Error();
    const ids = manifest.requested_page_ids;
    if (ids.some((id) => typeof id !== "string" || !idPattern.test(id))
      || new Set(ids).size !== ids.length
      || JSON.stringify(ids) !== JSON.stringify([...ids].sort())
      || manifest.rows.length !== ids.length) throw new Error();
    const lines = planText.split(/\r?\n/);
    for (let index = 0; index < manifest.rows.length; index += 1) {
      const row = manifest.rows[index];
      if (!exactKeys(row, ["page_id", "raw_line", "keyword"])
        || row.page_id !== ids[index] || typeof row.raw_line !== "string"
        || typeof row.keyword !== "string" || /[\r\n]/.test(row.raw_line)
        || lines.filter((line) => line === row.raw_line).length !== 1) throw new Error();
      const match = row.raw_line.match(/^- \[ \] (`?)(PG-[A-Z0-9]+-\d+)\1(?=\s|$)(.*)$/);
      const tokens = row.raw_line.match(/\bPG-[A-Za-z0-9-]+/g) || [];
      if (!match || match[2] !== row.page_id || tokens.length !== 1 || tokens[0] !== row.page_id) throw new Error();
      const keyword = match[3].replace(/\s*->.*$/, "").replace(/`/g, "").replace(/\s*\(.*$/, "").trim();
      if (keyword !== row.keyword) throw new Error();
      process.stdout.write(`${row.page_id}\t${Buffer.from(row.keyword).toString("base64")}\t${Buffer.from(row.raw_line).toString("base64")}\n`);
    }
  } catch {
    process.stderr.write("attested queue validation failed\n");
    process.exit(1);
  }
' "$ATTESTED_MANIFEST" "$ITEMS_PLAN" "$ITEMS_SHA256")"
QUEUE_RC=$?
if [ "$QUEUE_RC" -ne 0 ]; then
  echo "nightly attested queue could not be read"
  exit 1
fi
if ! attested_bundle_is_valid; then
  echo "nightly attested snapshot changed while reading queue"
  exit 1
fi

# 重放 outbox 里发送失败的积压通知（绑定校验完成后才允许业务调用）。
node "$FLOW/tools/scripts/gg-notify.mjs" replay-outbox >/dev/null 2>&1 || true

# 先恢复明确属于工具/桥接层的临时 authoring park；持久化 CAP/backoff 防止无限重试。
node "$FLOW/tools/scripts/gg-seo-autopilot.mjs" --auto-retry-parks || true

if [ -z "$ITEMS" ]; then echo "no unchecked items in plan — nothing to do"; exit 0; fi

n=0
decode_base64() {
  "$VALIDATOR_NODE" -e 'process.stdout.write(Buffer.from(process.argv[1], "base64"))' "$1"
}

attested_raw_row_is_current() {
  [ -f "$PLAN" ] && [ ! -L "$PLAN" ] \
    && [ "$(grep -Fxc -- "$raw_line" "$PLAN" 2>/dev/null || true)" = "1" ]
}

while IFS=$'\t' read -r pid kw_base64 raw_line_base64; do
  [ -z "${pid:-}" ] && continue
  if [ "$n" -ge "$MAX" ]; then echo "reached MAX=$MAX — stopping (remaining items wait for tomorrow)"; break; fi
  kw="$(decode_base64 "$kw_base64")" || { echo "$pid: attested keyword decode failed"; exit 1; }
  raw_line="$(decode_base64 "$raw_line_base64")" || { echo "$pid: attested row decode failed"; exit 1; }
  if ! attested_raw_row_is_current; then
    echo "$pid: canonical raw row no longer matches attested snapshot — skip until next preflight"
    continue
  fi
  echo ""
  echo "--- $pid :: $kw ---"
  [ -z "$kw" ] && { echo "no keyword, skip"; continue; }

  # skip if already live (slug derived the same way the autopilot derives it)
  slug="$(echo "$kw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before live check — skip until next preflight"; continue; fi
  if curl -s "$SITE/sitemap.xml" | grep -q "/en/wiki/$slug<"; then echo "already live as /$slug — skip"; continue; fi

  # skip if already parked needs_human (a human must clear it; don't re-burn the LLM)
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before park check — skip until next preflight"; continue; fi
  parked="$(node -e "try{const c=require('$CLAIMS');const k=Object.keys(c).find(x=>x.includes('$pid'));process.stdout.write(k&&c[k].status==='needs_human'?'1':'')}catch(e){}" 2>/dev/null)"
  if [ "$parked" = "1" ]; then echo "$pid is needs_human-parked — skip (awaiting human fix)"; continue; fi

  n=$((n + 1))

  # 0. brief hygiene: fill empty search_volume so render doesn't fail-closed
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before brief hygiene — skip until next preflight"; continue; fi
  node tools/scripts/gg-ensure-search-volume.mjs --keyword "$kw" || true

  # 1. author (Opus orchestrator). Leaves _staging/<pid>-en.md on PASS; parks on failure.
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before author — skip until next preflight"; continue; fi
  GG_AUTOPILOT_PLAN="$ITEMS_PLAN" node tools/scripts/gg-seo-autopilot.mjs --author --task "$pid" --limit 1 || true
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed after author — skip until next preflight"; continue; fi
  if [ ! -f "_staging/${pid}-en.md" ]; then echo "$pid: no passing en draft (author parked) — skip publish"; continue; fi

  # 2. publish scan via a one-row plan (avoids doScan's plain-order claim → no cross-site sweep)
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before publish plan — skip until next preflight"; continue; fi
  oneplan="/tmp/nightly-plan-$pid.md"
  printf '# nightly targeted publish\n\n%s\n' "$raw_line" > "$oneplan"
  scanlog="/tmp/nightly-scan-$pid.log"
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before publish scan — skip until next preflight"; continue; fi
  GG_AUTOPILOT_PLAN="$oneplan" node tools/scripts/gg-seo-autopilot.mjs --limit 1 >"$scanlog" 2>&1 || true
  cat "$scanlog"
  branch="$(grep -oE 'seo/auto/[0-9]{4}-[0-9]{2}-[0-9]{2}-'"$pid" "$scanlog" | head -1)"
  if [ -z "$branch" ]; then echo "$pid: publish scan produced no branch — skip gate"; continue; fi

  # 3. preview gate: wait → verify → 3-dim review → codex fact gate → merge (or PARK)
  # 例行 gate park 默认不即时通知（wzb: 只发成功/彻底停止）——park 记进 ledger，publish lane 的
  # auto-retry 会对永久 park 去重发一次终态通知、对 transient 重试到 CAP 才升级。GG_NOTIFY_ON_PARK=1 恢复即时。
  if ! attested_raw_row_is_current; then echo "$pid: canonical raw row changed before preview gate — skip until next preflight"; continue; fi
  node tools/scripts/gg-preview-gate.mjs --branch "$branch" \
    && echo "$pid: MERGED → live" \
    || echo "$pid: gate parked (codex/links/verify) — needs_human (通知交 auto-retry 终态去重)"
done <<< "$ITEMS"

echo ""
echo "===== nightly-seo done: attempted=$n $(date '+%F %T %Z') ====="
node "$FLOW/tools/scripts/gg-notify.mjs" heartbeat com.gengrowth.seo-nightly >/dev/null 2>&1 || true  # 阶段5 lane 心跳
