# gengrowth-flow-mvp

Half-automated SEO/GEO content pipeline for astrologywiki.com.

Pipeline: Phase 0 RAG (entity-passport + friction-mine + SERP cache + Obsidian RAG)
→ Phase 1 prompt render → human LLM (Claude / GPT / Hermes) → Phase 2 binary checks
(structure + RL1-RL6) → `_staging/` publish-ready artifacts.

## Layout

- `tools/scripts/gg-*.mjs` — pipeline tools (pure Node, zero npm deps)
- `tools/scripts/_phase2-validate.mjs` — generalized Phase 2 validator (fixture-driven)
- `tools/scripts/_render-<entity>-v8-test.mjs` — per-entity Phase 1 renderers
- `tools/scripts/_call-hermes.mjs` — 3rd-LLM generation via OpenRouter (Nous Hermes)
- `tools/scripts/lib/` — shared helpers, OAuth (`_reddit-oauth.mjs`), prompt templates, red-line checks
- `tools/scripts/lib/content-draft-templates/` — `definition.prompt.md` (v8 + P-9 + P-10), `pillar.prompt.md` (v8)
- `tools/scripts/__tests__/` — smoke tests (377 passing)
- `docs/spec/` — design docs (PRDs, RACI, SOP, plan versions)
- `_staging/` — publish-ready articles (v8 prompt × B'.3 SERP cache × P-9/P-10 patches)
- `.gg-cache/prompts/<page_id>.v8-fixture.json` — sidecar fixtures (validator auto-loads)
- `CLAUDE.md` — project routing for Claude Code skill invocation
- `AGENTS.md` — chat record + author attribution conventions

## Quick verify

```bash
# Smoke tests + Saturn Return v8 regression
node --test 'tools/scripts/__tests__/*.test.mjs'

# Phase 2 modern path (fixture-driven, 5 flags)
node tools/scripts/_phase2-validate.mjs \
  --source _staging/page_leo_personality-claude-v8.md \
  --tag claude-v8 --page-id page_leo_personality \
  --llm_source claude-opus-4-7 --prompt_version v8
```

Expect 6/6 PASS (structure + RL1-RL6, zero waivers).

## End-to-end batch (1 entity)

```bash
# 1. Phase 0 RAG (web + vault + SERP)
node tools/scripts/gg-entity-passport.mjs --entity "<X>" --page-id page_X --emit-rag
node tools/scripts/gg-obsidian-rag.mjs --page-id page_X --entity "<X>" \
  --vault-dir /path/to/obsidian/vault
# SERP cache: WebSearch or gg-serp-snapshot.mjs → .gg-cache/serp/page_X.json

# 2. Phase 1 prompt render (writes prompt + fixture sidecar)
node tools/scripts/_render-<X>-v8-test.mjs

# 3. LLM generation (manual paste OR scripted)
# Paste .gg-cache/prompts/page_X.v8-prompt.md into Claude/GPT, save output to:
# _staging/page_X-claude-v8.md OR _staging/page_X-chatgpt-v8.md
# OR call Hermes (requires OPENROUTER_API_KEY):
node tools/scripts/_call-hermes.mjs \
  --prompt .gg-cache/prompts/page_X.v8-prompt.md \
  --output _staging/page_X-hermes-v8.md

# 4. Phase 2 validate (fixture auto-loads template/word_range/kw_range/H2 count)
node tools/scripts/_phase2-validate.mjs \
  --source _staging/page_X-<llm>-v8.md \
  --tag <llm>-v8 --page-id page_X \
  --llm_source <llm-id> --prompt_version v8
```

## Templates

- **Definition** (`definition.prompt.md`) — leaf-entity page. 7 H2, 1500-1800 words,
  5-8 keyword count. Validated on 5 entities: blue/purple/yellow aura, saturn return, leo personality.
- **Pillar** (`pillar.prompt.md`) — hub/aggregator page. 9 H2, 2500-3500 words,
  8-12 keyword count. Validated on aura-colors pillar (covers 7 child aura colors).

## Auth scaffolds (waiting on user creds)

- **Hermes via OpenRouter** — see `tools/scripts/_call-hermes.mjs` header for setup
  (5 min). Once `OPENROUTER_API_KEY` is in `~/.config/gg/_gg.env`, runs as a 3rd LLM
  for cross-validation.
- **Reddit OAuth** — see `tools/scripts/lib/_reddit-oauth.mjs` header for setup
  (7 steps, ~5 min). Once creds in `_gg.env`, unblocks B'.2 real friction-mine
  (100 req/min vs anonymous ~5 req/min).

## Production gaps (not yet built)

- **GCP project + 3 SA split** — unblocks GSC live query for data-driven keyword research
- **Sheet integration end-to-end** — Lynne workbook pull → render → LLM → validate → publish loop
- **Canary monitoring** — post-publish health dashboards
- **Pillar template variants for other clusters** — aura-colors done; sign-cluster / planet-cluster pillars not yet templated per cluster

## Carved from

Carved from `xdawayer/gengrowth-wiki` to separate the MVP toolchain from the
Obsidian content vault. The wiki repo retains the content + auto-backup workflow;
this repo isolates the codebase.
