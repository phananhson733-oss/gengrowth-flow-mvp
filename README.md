# gengrowth-flow-mvp

Half-automated SEO/GEO content pipeline for astrologywiki.com.

Pipeline: Phase 0 RAG (entity-passport + friction-mine + SERP cache + Obsidian RAG)
→ Phase 1 prompt render → human LLM (Claude / GPT) → Phase 2 binary checks
(structure + RL1-RL6) → `_staging/` publish-ready artifacts.

## Layout

- `tools/scripts/gg-*.mjs` — pipeline tools (pure Node, zero npm deps)
- `tools/scripts/lib/` — shared helpers + prompt templates + red-line checks
- `tools/scripts/__tests__/` — smoke tests
- `docs/spec/` — design docs (PRDs, RACI, SOP, plan versions)
- `_staging/` — example zero-waiver articles (v7 prompt × B'.3 SERP cache)
- `CLAUDE.md` — project routing for Claude Code skill invocation
- `AGENTS.md` — chat record + author attribution conventions

## Quick verify

```bash
# Re-run Phase 2 on the bundled example article.
node tools/scripts/_phase2-publish-blue-aura.mjs \
  _staging/page_blue_aura_meaning-claude-v7-rl3-real.md verify-roundtrip
```

Expect 6/6 PASS (structure + RL1-RL6, zero waivers).

## Carved from

Carved from `xdawayer/gengrowth-wiki` on $(date +%Y-%m-%d) to separate the
MVP toolchain from the Obsidian content vault. The wiki repo retains the
content + auto-backup workflow; this repo isolates the codebase.
