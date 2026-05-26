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

### RL8 intensifier-negation residual false-negative
**Priority:** P3
`"there is no doubt that research shows ..."` still reads as in-clause negation and
is accepted. Known limitation (chosen over risking false-positives on honest
disclaimers). Revisit only if it shows up in real drafts.

## Maintainability

### gg-content-draft.mjs exceeds the 800-line file cap
**Priority:** P3 (partially done)
Was 2002 lines. Extracted the shared utils (lib/content-draft-util.mjs) and the
Phase 0 RAG block builders (lib/content-draft-rag.mjs) → now 1791 lines, with both
groups in cohesive modules and re-exported for back-compat. Still over the 800 cap:
the bulk is the runPhase1 (~343) + runPhase2 (~420) async orchestrators. Getting
under 800 needs splitting those (e.g. a phase1/ phase2 module pair) — a larger
architectural refactor that warrants its own reviewed change rather than a hasty
extraction of the core content pipeline.

## Completed

- **RL7 multi-word cross-line evasion** (P2) — `checkRL7` now scans the whole body so
  a banned phrase wrapped across a line break is caught.
- **RL7 article-wide keyword exemption** (P2) — exemption scoped to whole-word matches
  inside a genuine keyword (length + word-count caps); a crafted bag-of-words keyword
  can no longer exempt the ban list.
- **ZH RL7 + ZH red-line tests** (P2) — `checkRL7Zh` implemented (CJK substring + ASCII
  word-boundary) and wired into `_phase2-validate`; added a 17-test ZH red-lines suite
  (RL1/RL2/RL6/RL7/RL8 ZH, previously zero coverage).
- **gg-md-to-oracle-ts persona-parser dedupe** (P3) — `resolveAuthorMeta` now calls
  `loadPersona` (single source of truth); hand-rolled `readPersonaFrontmatter` removed.
- **getAllConfig staleness warning** (P3) — `_config.getConfigStatus()` added;
  `gg-sheet-pull` warns when the config snapshot is missing/stale so an empty
  author.map surfaces clearly instead of silent downstream hard-blocks.
