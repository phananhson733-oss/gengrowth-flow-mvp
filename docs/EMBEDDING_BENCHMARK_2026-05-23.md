---
title: Ollama Embedding Model Benchmark — astrology SEO clustering
date: 2026-05-23
type: benchmark
---

# Embedding Benchmark — 2026-05-23

**Setup**: 3 models × 475 keywords (R=快速胜利+📌长尾)
**Threshold**: cosine distance 0.35
**Algorithm**: average-linkage agglomerative, pure JS
**Backend**: ollama @ http://localhost:11434 (local, $0 cost)

## 1. Full corpus (475 words)

| Model | Clusters | Assigned | Unassigned | Singletons (filtered) | Wall (s) | Embed (s) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `nomic-embed-text` | 43 | 442 | 33 | 33 | 0.2 | 0.06 |
| `mxbai-embed-large` | 45 | 454 | 21 | 21 | 0.2 | 0.07 |
| `qwen3-embedding:8b` | 25 | 462 | 13 | 13 | 47.2 | 46.74 |

## 2. ind-002 heterogeneous bucket (38 words)

**Goal**: split the astrology "其它" bucket into ≥3 semantic sub-clusters. Token-mode is at ceiling (1 cluster only).

| Model | Sub-clusters | Assigned | Unassigned | Wall (s) |
| --- | ---: | ---: | ---: | ---: |
| `nomic-embed-text` | 5 | 37 | 1 | 0.0 |
| `mxbai-embed-large` | 2 | 33 | 5 | 0.0 |
| `qwen3-embedding:8b` | 1 | 38 | 0 | 0.1 |

## 3. Recommendation

Selected winner: **`nomic-embed-text`** (score=71.4 = coverage=46.5 anti-noise=-2.1 ind002=25.0 speed=2).

All models ranked by score:
- `nomic-embed-text`: **71.4**  (coverage=46.5 anti-noise=-2.1 ind002=25.0 speed=2)
- `mxbai-embed-large`: **58.5**  (coverage=47.8 anti-noise=-1.3 ind002=10.0 speed=2)
- `qwen3-embedding:8b`: **52.8**  (coverage=48.6 anti-noise=-0.8 ind002=5.0 speed=0)

Run real re-cluster: `node tools/scripts/gg-cluster-init.mjs --algo embedding --embed-backend ollama --embed-model nomic-embed-text --rebuild --write`

## 4. 3-way 决策记录（2026-05-23 补 qwen3）

第一轮（mxbai vs nomic 双模型）已记入早期版本；本轮补 qwen3-embedding:8b 后的对照：

| 维度 | nomic | mxbai | qwen3 |
|---|---|---|---|
| 速度 | 0.2s | 0.2s | **47.2s** (235× 慢) |
| 全集覆盖 | 93% | 95.6% | 97.3% |
| ind-002 sub-split | **5** | 2 | 1（过度聚合） |
| 模型大小 | 137M | 335M | 4.7GB (Q4) |

**Winner 仍是 nomic**：scoring v2 给出 71.4 > 58.5 > 52.8。

**qwen3 不取的原因**：
- 47s 单次 embedding 在生产 batch（500+ 词、每周跑）= 4 分钟，对 ops 节奏不友好
- 把 ind-002 拼成 1 个 sub-cluster（不分），代表它把异质化的词强行 normalize 成"同类"，对人工 review 没增量信息
- 速度 + 过度聚合两个 cost > 4% 覆盖率提升的收益

**mxbai 仍可作为生产 fallback**：之前 selective write-sheet 用的就是 mxbai（41 行高置信归类）。沿用历史选择；未来如果 ind-002 sub-split 不重要（例如人工已分类完），可考虑切 mxbai 拿那 +4% 覆盖。

**qwen3 用途**：当前对生产无价值。如果未来出现"必须高语义精度但可慢"的 batch 任务（例如月度大规模重聚类），可以切 qwen3 一次。
