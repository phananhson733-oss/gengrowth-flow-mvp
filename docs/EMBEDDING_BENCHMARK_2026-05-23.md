---
title: Ollama Embedding Model Benchmark — astrology SEO clustering
date: 2026-05-23
type: benchmark
---

# Embedding Benchmark — 2026-05-23

**Setup**: 1 models × 475 keywords (R=⚡快速胜利+📌长尾)
**Threshold**: cosine distance 0.35
**Algorithm**: average-linkage agglomerative, pure JS
**Backend**: ollama @ http://localhost:11434 (local, $0 cost)

## 1. Full corpus (475 words)

| Model | Clusters | Assigned | Unassigned | Singletons (filtered) | Wall (s) | Embed (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `nomic-embed-text` | 43 | 442 | 33 | 33 | 2.1 | 1.91 |

## 2. ind-002 heterogeneous bucket (50 words)

**Goal**: split the astrology "其它" bucket into ≥3 semantic sub-clusters. Token-mode is at ceiling (1 cluster only).

| Model | Sub-clusters | Assigned | Unassigned | Wall (s) |
| --- | ---: | ---: | ---: | ---: |
| `nomic-embed-text` | 7 | 49 | 1 | 0.0 |

## 3. Recommendation

Selected winner: **`nomic-embed-text`** (highest ind-002 split × full assignment rate).

Run real re-cluster: `node tools/scripts/gg-cluster-init.mjs --algo embedding --embed-backend ollama --embed-model nomic-embed-text --rebuild --write`
