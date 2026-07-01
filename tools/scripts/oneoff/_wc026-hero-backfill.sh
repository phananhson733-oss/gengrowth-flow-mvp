#!/usr/bin/env bash
# Hero backfill for the 6/21 batch. The first deploy pass shipped text+inline (no hero) because
# the deploy bash subprocess lacked ~/.bun/bin on PATH so gemini-web hero gen silently failed.
# PATH is now fixed in _wc-deploy-one.sh, so re-running each deploy (WITHOUT GG_SKIP_HERO) adds
# the hero. spain additionally gets its inline back via the corrected-plan override (its
# origin/main plan is the autopilot's buggy June-22 one). Run AFTER the text+inline orchestrator
# fully finishes — the worktree is shared, never run two deploy passes on it concurrently.
set -uo pipefail
FLOW=/Users/wzb/gengrowth-flow-mvp
WT=/Users/wzb/Code/oracle-wc-deploy
# NOTE: GG_SKIP_HERO deliberately UNSET → heroes generate.

backfill() {
  local PID="$1" SLUG="$2"
  echo "==================================================================="
  echo "=== [HERO-BACKFILL $PID $SLUG] start $(date '+%H:%M:%S') ==="
  if ! timeout 760 bash "$FLOW/tools/scripts/oneoff/_wc-deploy-one.sh" "$PID" "$SLUG"; then
    echo "!!! [$PID] backfill deploy/build FAILED — STOPPING (no push)"; return 1
  fi
  cd "$WT" || return 1
  if [ ! -f "public/images/blog/${SLUG}.jpg" ]; then
    echo "!!! [$PID] hero STILL missing after backfill — STOPPING for inspection"; return 1
  fi
  if ! git push origin wc016-deploy:main; then echo "!!! [$PID] PUSH FAILED — STOPPING"; return 1; fi
  echo "=== [$PID] hero live; pushed $(date '+%H:%M:%S') ==="
  node --input-type=module -e '
    const slug = process.argv[1];
    for (let i = 0; i < 10; i++) {
      const s = await fetch(`https://www.astrologywiki.com/images/blog/${slug}.jpg`, { cache: "no-store" }).then(r => r.status).catch(() => 0);
      console.log(`  hero ${slug} try ${i + 1}: HTTP ${s}`);
      if (s === 200) { console.log(`  ${slug} hero LIVE`); process.exit(0); }
      await new Promise(r => setTimeout(r, 20000));
    }
    console.log(`  ${slug} hero not confirmed (CDN lag); check manually`);
  ' "$SLUG"
  return 0
}

# PG-WC-026 spain done separately (808cc0f: corrected plan + hero + inline, pushed).
backfill PG-WC-027 matheus-cunha-birth-chart           || exit 1
backfill PG-TRANS-011 chiron-in-taurus-2026-astrology  || exit 1
backfill PG-MYTH-006 toy-story-5-zodiac-signs          || exit 1
backfill PG-WC-028 scotland-brazil-world-cup-astrology || exit 1

echo "==================================================================="
echo "=== ALL 5 HERO BACKFILLS DONE $(date '+%H:%M:%S') ==="
