#!/usr/bin/env bash
# Serial staggered deploy of the 6/21 batch articles #2-#5 to astrologywiki.com.
# #1 (PG-WC-026 spain, today's match) is deployed manually first; this orchestrates the rest.
# Each step: stagger-sleep -> _wc-deploy-one.sh (reset origin/main, convert, build GATE, commit)
# -> push wc016-deploy:main -> poll sitemap until the slug appears.
# A build/push failure stops the whole run (so a bad article never auto-publishes).
# Order: cunha -> chiron-in-taurus -> toy-story-5 -> scotland-brazil(last; it cross-links the
# now-live cunha chart, and is a forward-looking June 24 preview so least time-sensitive today).
set -uo pipefail
FLOW=/Users/wzb/gengrowth-flow-mvp
WT=/Users/wzb/Code/oracle-wc-deploy
# gemini-web is down → ship text + inline infographics (no hero); heroes backfilled later.
export GG_SKIP_HERO=1

deploy_one() {
  local PID="$1" SLUG="$2" WAIT="$3"
  echo "==================================================================="
  echo "=== [$PID $SLUG] stagger sleep ${WAIT}s ==="
  sleep "$WAIT"
  echo "=== [$PID $SLUG] deploy start $(date '+%H:%M:%S') ==="
  if ! timeout 760 bash "$FLOW/tools/scripts/oneoff/_wc-deploy-one.sh" "$PID" "$SLUG"; then
    echo "!!! [$PID] DEPLOY/BUILD FAILED — STOPPING ORCHESTRATOR (no push)"
    return 1
  fi
  cd "$WT" || return 1
  if ! git push origin wc016-deploy:main; then
    echo "!!! [$PID] PUSH FAILED — STOPPING"
    return 1
  fi
  echo "=== [$PID] pushed $(date '+%H:%M:%S'); verifying sitemap ==="
  node --input-type=module -e '
    const slug = process.argv[1];
    for (let i = 0; i < 14; i++) {
      const sm = await fetch("https://www.astrologywiki.com/sitemap.xml", { cache: "no-store" }).then(r => r.text()).catch(() => "");
      const enIn = sm.includes(`/en/wiki/${slug}`);
      const zhIn = sm.includes(`/zh/wiki/${slug}`);
      console.log(`  verify ${slug} try ${i + 1}: EN=${enIn ? "YES" : "no"} ZH=${zhIn ? "YES" : "no"}`);
      if (enIn && zhIn) { console.log(`  ${slug} LIVE (sitemap EN+ZH)`); process.exit(0); }
      await new Promise(r => setTimeout(r, 30000));
    }
    console.log(`  ${slug} NOT-CONFIRMED after ~7min (CDN cache may lag; check manually)`);
    process.exit(0);
  ' "$SLUG"
  return 0
}

# 027 cunha already deployed manually (pushed). Orchestrate the remaining 3, ~13min apart.
deploy_one PG-TRANS-011 chiron-in-taurus-2026-astrology 120   || exit 1
deploy_one PG-MYTH-006 toy-story-5-zodiac-signs 780           || exit 1
deploy_one PG-WC-028 scotland-brazil-world-cup-astrology 780  || exit 1

echo "==================================================================="
echo "=== ALL 3 REMAINING DEPLOYS DONE $(date '+%H:%M:%S') ==="
echo "=== Full 6/21 batch: spain + cunha (manual) + chiron-taurus + toy-story-5 + scotland-brazil ==="
