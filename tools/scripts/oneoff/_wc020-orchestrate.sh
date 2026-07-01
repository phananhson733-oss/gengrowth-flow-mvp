#!/usr/bin/env bash
# Serial staggered deploy of WC-020 batch articles #2-#5 to astrologywiki.com.
# Each step: stagger-sleep -> _wc-deploy-one.sh (reset origin/main, convert, build GATE,
# commit) -> push wc016-deploy:main -> poll sitemap until the slug appears.
# A build/push failure stops the whole run (so a bad article never auto-publishes).
# Order: diaz -> pulisic -> wissa -> england(hub). pulisic ships before wissa because
# the wissa article internally links the (now-live) pulisic chart.
set -uo pipefail
FLOW=/Users/wzb/gengrowth-flow-mvp
WT=/Users/wzb/Code/oracle-wc-deploy

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

deploy_one PG-WC-022 luis-diaz-birth-chart 720            || exit 1
deploy_one PG-WC-024 christian-pulisic-birth-chart 1020   || exit 1
deploy_one PG-WC-023 yoane-wissa-birth-chart 1020         || exit 1
deploy_one PG-WC-025 england-world-cup-2026-astrology 1020 || exit 1

echo "==================================================================="
echo "=== ALL 4 REMAINING DEPLOYS DONE $(date '+%H:%M:%S') ==="
echo "=== Full batch: rodriguez(live) + diaz + pulisic + wissa + england ==="
