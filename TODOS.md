# TODOS

Tracked work, grouped by component then priority (P0 highest → P4). Completed
items move to the bottom section with the version that shipped them.

## Publish path (oracle / wiki)

### C2 — author byline reaching the published oracle article
**Priority:** P1
**Noticed on:** feat/author-personas-mvp (pre-landing review, adversarial subagent)

**Corrected after investigation:** the publish-ready staging file IS written with
`title`/`slug` — by `_phase2-validate.mjs` (the batch validator), not by
content-draft's byline-only block. The real gap was that `_phase2-validate.mjs`
emitted no `author_id`, so the oracle always fell back to the house byline.

**Done (writer side):** `_phase2-validate.mjs` now emits `author_id` +
`author_display_name` into the publish frontmatter, sourced from `--author <id>` CLI
or `fixture.author_id`. The oracle (`gg-md-to-oracle-ts.resolveAuthorMeta`) reads
`author_id` (C1 fix) so a byline supplied this way publishes correctly.

**Done (producer auto-routing):** author now resolves at pull time. `gg-sheet-pull`
fetches the cluster tab, joins `cluster_id` → `primary_entity`, runs `resolveAuthor`
(override → author.map → blank) and stamps `author`/`author_source`/`cluster_domain`
into the batch fixture. `gg-render-batch.composeCfg` carries `author_id` into cfg;
`renderAuraPrompt` writes `author_id` + `banned_tokens` (+ display/version) into the
fixture sidecar; `_phase2-validate` reads both — so the byline publishes AND batch-path
RL7 is now enforced (no longer silently N/A). End-to-end chain closed; `--author`
remains as a manual override.

**Still to verify at T9 (live):** the cluster join key — `gg-sheet-pull` and
`gg-sheet-to-brief` join on `primary_entity` (a concrete entity like "Chiron"),
while `author.map.<domain>` keys are coarse (aura/houses/vedic/basics). Confirm the
real sheet's `primary_entity` values match the author.map keys, or add a coarse
`cluster_domain` column / per-entity author.map rows.

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
