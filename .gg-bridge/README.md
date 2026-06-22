# .gg-bridge — Cowork ⇄ Mac autopilot bridge

Signal channel between the **Cowork scheduled task** `cowork-seo-supervisor` (runs in a
Linux sandbox, can read Google Sheets + crawl the live sites, but cannot reach this Mac's
`~/oracle` / `gh` / `launchctl` / secrets) and the **Mac launchd autopilot**
(`com.gengrowth.seo-autopilot` / `com.gengrowth.seo-author`, which actually authors,
builds, merges and deploys).

Propagation is automatic: the Cowork folder is file-synced to `~/gengrowth-flow-mvp`, and
this repo's obsidian-git (`autoPullInterval=1`) commits/pulls within ~1 min. No manual git.

## Files (all written by one side, read by the other)

| Path | Writer | Reader | Purpose |
|---|---|---|---|
| `requests/kick-<UTC8date>-<HHMM>.json` | Cowork | Mac watcher | "please kick the autopilot — work is pending/stuck" |
| `acks/ack-<ts>.json` | Mac watcher | Cowork | "kicked these launchd jobs at <time>" |
| `gsc/submitted-<UTC8date>.json` | Cowork | Cowork | per-day GSC『请求编入索引』ledger (dedupe + ~10/day quota) |
| `reports/<UTC8date>.md` | Cowork | human | hourly supervisor status (live/pending/GSC/stuck) |

## kick request shape

```json
{
  "requestedAt": "2026-06-22T14:00:00+08:00",
  "requestedBy": "cowork-seo-supervisor",
  "utc8Date": "2026-06-22",
  "action": "publish-pending",            // or "author-and-publish"
  "reason": "3 planned slugs not live; 1 preview stuck in needs_human",
  "pendingSlugs": ["saturn-return-meaning", "..."],
  "pendingPgIds": ["PG-...-0NN"],
  "note": "free text"
}
```

The Mac watcher (`tools/scripts/gg-cowork-bridge-watcher.sh`, fired every 5 min by
`com.gengrowth.cowork-bridge.plist`) acts on the **newest, fresh, not-yet-acked** request
only — `action: author-and-publish` kicks the author lane too; anything else just kicks the
publish lane. It only `launchctl kickstart`s the existing trusted jobs — it never authors or
publishes by itself. Stale (>2h) requests are acked as `skipped-stale`.

See `docs/2026-06-22-cowork-bridge-setup.md` for one-time install.
