# spec/upstream-canon/

This directory is a **one-way mirror** of canonical specification documents from
the `gengrowth-wiki` repository. It exists so that audit docs and scripts in
`gengrowth-flow-mvp` can reference a stable, version-controlled snapshot of the
upstream specs without depending on a sibling checkout of the wiki.

## Do not edit files in this directory

Every file here is overwritten on the next sync. If you need to change a spec,
edit it in `gengrowth-wiki` and re-run the sync.

Authoritative source paths (in `gengrowth-wiki`):

| File in this directory | Upstream path |
| --- | --- |
| `2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md` | `docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md` |
| `keyword-research-overview.md` | `docs/03-marketing/01-strategy/keyword-research-overview.md` |
| `keyword-research-sop.md` | `docs/03-marketing/03-seo/keyword-research-sop.md` |
| `keyword-sheet-setup.gs` | `docs/03-marketing/03-seo/keyword-sheet-setup.gs` |
| `day0-diagnosis-sop.md` | `docs/03-marketing/03-seo/day0-diagnosis-sop.md` |
| `seed-client-growth-experiment-template.md` | `docs/03-marketing/03-seo/seed-client-growth-experiment-template.md` |

## Refreshing the mirror

From the repo root:

```bash
# Default: assumes wiki at /Users/wzb/gengrowth-wiki
tools/scripts/_sync-canon.sh

# Preview without writing
tools/scripts/_sync-canon.sh --dry-run

# Custom wiki location
GG_WIKI_ROOT=/path/to/gengrowth-wiki tools/scripts/_sync-canon.sh
```

The script uses `rsync -a --checksum`, prints a per-file `unchanged | updated |
new` summary, and exits non-zero if the wiki or any source file is missing.

## Adding a new mirrored file

Edit the `SPEC_FILES` array in `tools/scripts/_sync-canon.sh`, then re-run the
sync. Update the table above to match.
