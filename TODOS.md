# TODOS

Tracked work, grouped by component then priority (P0 highest → P4). Completed
items move to the bottom section with the version that shipped them.

## Publish path (oracle / wiki)

### C2 — staging→oracle publish path does not carry title/slug frontmatter
**Priority:** P1
**Noticed on:** feat/author-personas-mvp (pre-landing review, adversarial subagent)

With the new content-draft templates the LLM emits no YAML frontmatter (output
starts at `# H1`), and Phase 2 never builds SEO frontmatter. `buildAuthorFrontmatter`
(`gg-content-draft.mjs`) prepends a byline-only block (`author_id`, `cluster_id`, …)
with no `title`/`slug`/`target_keyword`. But `convertOne` in `gg-md-to-oracle-ts.mjs`
requires `fm.title` and `fm.slug` (throws `no title`/`no slug`). So a new-template
authored draft cannot be converted for publish as-is.

This is partly pre-existing (true on `main` too for new-template drafts) and the
publish path is not exercised until the T9 live eval. Decide before T9: either
(a) have `buildAuthorFrontmatter` merge the SEO frontmatter (title/slug/keywords
from the brief/page row) into the same block, or (b) add a pre-oracle frontmatter
assembly step. Verify against the real operator data flow (where title/slug come
from today).

## Red lines (RL7 / RL8)

### RL7 multi-word banned tokens evade detection across line wraps
**Priority:** P2
`checkRL7` scans `body.split('\n')` per line, so a multi-word token
(e.g. `proven by science`, `according to a study`) split across two lines is never
matched. Run multi-word token regexes against the whole prose body, then derive
line numbers.

### RL7 target_keyword exemption is article-wide
**Priority:** P2
`checkRL7` skips a banned token entirely if `targetKeyword.includes(token)` — a
crafted/long keyword string can exempt a token everywhere in the article. Scope the
exemption to whole-word match with a length + word-count cap on `target_keyword`.

### RL8 intensifier-negation residual false-negative
**Priority:** P3
`"there is no doubt that research shows ..."` still reads as in-clause negation and
is accepted. Known limitation (chosen over risking false-positives on honest
disclaimers). Revisit only if it shows up in real drafts.

## Bilingual (ZH) parity

### ZH RL7 not implemented; ZH red lines untested
**Priority:** P2
`checkRL7Zh` is a TODO — Chinese articles currently have no per-author banned-token
enforcement (the persona voice firewall is EN-only while the pipeline publishes ZH).
Also `checkRL8Zh` (and `checkRL1Zh`/`checkRL2Zh`/`checkRL6Zh`) have zero direct
tests. Add a ZH red-lines smoke suite mirroring the EN RL8 suite, then implement
`checkRL7Zh`.

## Maintainability

### gg-content-draft.mjs exceeds the 800-line file cap
**Priority:** P3
2002 lines (2.5× cap). Extract self-contained seams: CTA resolution, prompt
rendering helpers, RAG block builders, Phase 2 red-lines dispatch wiring.

### gg-md-to-oracle-ts.readPersonaFrontmatter duplicates loader.mjs
**Priority:** P3
Hand-rolled scalar YAML parser duplicates `lib/author-personas/loader.mjs`
(the documented single source of truth). Switch `resolveAuthorMeta` to call
`loadPersona(id)` once the loader contract is stable.

### getAllConfig staleness is silent
**Priority:** P3
`_config.mjs` `getAllConfig()` returns `{}` on a missing/unreadable snapshot, so a
freshly added `author.map.<domain>` row won't route (every auto-routed page
hard-blocks) until `gg-config-sync` re-runs, with no warning the snapshot is older
than the sheet. Add a snapshot-staleness warning.

## Completed
