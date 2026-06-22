---
title: Cowork → Mac autopilot bridge — setup & architecture
date: 2026-06-22
type: runbook
status: active
tags:
  - autopilot
  - cowork
  - bridge
  - seo
  - cron
---

# Cowork → Mac autopilot bridge

One-time setup for the `cowork-seo-supervisor` Cowork scheduled task to drive this Mac's
launchd SEO autopilot. Created 2026-06-22.

## Why a bridge (the constraint)

The Cowork scheduled task runs in a **Linux sandbox** with only the `gengrowth-flow-mvp`
folder mounted. It **can**: compute the UTC+8 date, read the Google Sheet SSOT via the
Drive connector, crawl `astrologywiki.com` / `gengrowth.ai`, drive Chrome (GSC), and write
files into the synced repo. It **cannot**: reach `~/oracle`, `~/gengrowth-ops`, `gh`,
`codex`, `launchctl`, or `~/.config/gg/_gg.env` — so it cannot author/build/merge/deploy.

So the work is split:

| Layer | Runtime | Does |
|---|---|---|
| **Supervisor** (new) | Cowork scheduled task, hourly 14:00–22:00 UTC+8 | detect pending/stuck work from the Sheet + live sites, submit newly-live URLs to GSC『请求编入索引』, **signal** the Mac to publish, write an hourly status report |
| **Engine** (existing) | Mac launchd `com.gengrowth.seo-autopilot` / `seo-author` | the real author → phase2/3-subagent/codex/Chrome gate → convert → register → build → PR → merge → deploy |
| **Bridge** (new) | `com.gengrowth.cowork-bridge` (Mac, every 5 min) | turn a Cowork *kick request* into `launchctl kickstart` of the engine |

Propagation needs no manual git: the Cowork folder is file-synced to `~/gengrowth-flow-mvp`
and obsidian-git (`autoPullInterval=1`) commits/pulls within ~1 min. (Verified 2026-06-22:
a file written from Cowork was auto-committed here as a "vault backup" within the minute.)

## One-time install on this Mac (`awayer_mini`)

```bash
# 1. the watcher is already in the repo (tools/scripts/gg-cowork-bridge-watcher.sh); make sure it's +x
chmod +x ~/gengrowth-flow-mvp/tools/scripts/gg-cowork-bridge-watcher.sh

# 2. smoke-test it by hand (no kick, just logs what it would do)
GG_BRIDGE_DRYRUN=1 bash ~/gengrowth-flow-mvp/tools/scripts/gg-cowork-bridge-watcher.sh
cat ~/gengrowth-agents/cron-sync/cowork_bridge/$(date +%F).log

# 3. install the launchd listener (GUI domain — required so it can kickstart the autopilot)
cp ~/gengrowth-flow-mvp/tools/scripts/com.gengrowth.cowork-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gengrowth.cowork-bridge.plist
launchctl enable    gui/$(id -u)/com.gengrowth.cowork-bridge
launchctl kickstart -k gui/$(id -u)/com.gengrowth.cowork-bridge   # fire once now

# stop / remove
# launchctl bootout gui/$(id -u)/com.gengrowth.cowork-bridge
```

If `$HOME` is not `/Users/awayer_mini`, edit the two absolute paths in the plist first.

## Prerequisites for the engine to actually run (already true as of 2026-06-22)

- `com.gengrowth.seo-autopilot` loaded in `gui/$(id -u)` (publish lane). `seo-author` loaded
  if you want the bridge's `author-and-publish` action to write new drafts.
- `node ~/gengrowth-flow-mvp/tools/scripts/gg-autopilot-preflight.mjs --skip-live-cli` → `ok:true`.
- Mac powered on with the Claude app open during 14:00–22:00 (Cowork scheduled tasks only run
  while the app is open; a missed slot runs on next launch).

## GSC submission

Article-page indexing is **not** API-automatable (Indexing API accepts but won't index
articles — see `FLOW-content-production-to-vault.md` 阶段6). The supervisor therefore does
GSC『请求编入索引』through **Chrome** (Claude-in-Chrome) on the live URL, capped at the
**~10/day** quota and deduped via `.gg-bridge/gsc/submitted-<date>.json`. Requires Chrome
with the extension connected and you logged into Search Console for `astrologywiki.com`. If
Chrome isn't reachable at run time, those URLs are listed in the day's report for a manual
click instead.

## Where to look

- Bridge watcher log: `~/gengrowth-agents/cron-sync/cowork_bridge/<date>.log`
- Autopilot log: `~/gengrowth-agents/cron-sync/seo_autopilot/<date>.log`
- Supervisor reports: `~/gengrowth-flow-mvp/.gg-bridge/reports/<date>.md`
- Kick requests / acks: `~/gengrowth-flow-mvp/.gg-bridge/{requests,acks}/`
