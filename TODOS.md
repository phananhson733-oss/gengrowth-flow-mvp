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

## Writing-pipeline gap closure (vs SOP v4.3 / 创作清单 v4.0) — follow-ups

These are the deliberately-deferred remainders of the 2026-05-26 gap-closure
(commit 956f1e1). The closed items are in Completed below.

### Authority/credential parity on pillar + ZH templates
**Priority:** P2
The founders-allowlist (`{{authority_allowlist}}`), T2 external-link TBD rule, and
credential-integration relaxation landed in `definition.prompt.md` (EN) only.
`pillar.prompt.md` + `definition.prompt.zh.md` + `pillar.prompt.zh.md` still carry
the old blanket no-naming / no-first-person rules. Mirror the EN changes there.

### External-link TBD → real URL resolution step
**Priority:** P2
RL12 only enforces the `[[<TBD-external-link: source | title | reason>]]` placeholder
discipline. Nothing yet resolves those placeholders into real `target="_blank"`
Wikipedia/NASA URLs at publish time (parallel to the internal-link resolution).

### RL12(d) allowlist extension for legitimate historical figures
**Priority:** P3
RL12(d) WARNs on any attributed name not in the per-author allowlist. Legit
historical figures (Kepler, Ptolemy, Jung) will WARN until added. Kept as WARN
(non-blocking) on purpose — escalating to FAIL would hard-block legit mentions.
Extend `authority-allowlist.json` as real names surface in drafts.

### Image / visual SEO (§6) — still unimplemented
**Priority:** P3
WebP / alt-text / kebab-case filename / ≤200KB — zero pipeline support. A separate
subsystem; out of this round's scope (option B).

### Variable pre-processor (§0) + SERP-gap automation
**Priority:** P3
No `变量预处理器` step; `content_angle` is hand-filled, not derived from a SERP
top-5 title-gap analysis. RL3 only does plagiarism overlap, not gap validation.

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
- **Batch EN Definition render crash** (P0, 956f1e1) — `definition.prompt.md`'s 4
  `{{author_*}}` placeholders were unfilled in the batch replacement map →
  `process.exit(1)` on every batch EN Definition render (untested: the smoke test
  skipped `renderAuraPrompt`). Fixed via `authorPromptCapsule` + `buildReplacements`;
  added a real-template render test asserting zero residual placeholders.
- **Journal_Prompts reconnected** (P2, 956f1e1) — sheet col 20 now injected into
  both render paths via `journalPromptsBlock` + composeCfg passthrough.
- **RL9–RL12 + SC1/SC2** (956f1e1) — atom-label leak (FAIL), de-personalization
  EN+ZH (FAIL), weak verbs (WARN), citation/external-link hallucination guard
  (FAIL+WARN), bolded-definition structure (FAIL), internal-link tier (WARN). All
  aligned to current templates; codex-reviewed for false positives.
- **Named-founder authority + external links** (956f1e1) — `authority-allowlist.json`
  (4 curated domains) + template relaxation to name allowlisted founders + T2
  external-link TBD placeholders; `_phase2-validate` accepts external TBD.
- **Credential integration** (956f1e1) — `definition.prompt.md` first-person ban
  relaxed to one in-body credential sentence (v4.3 §1).
