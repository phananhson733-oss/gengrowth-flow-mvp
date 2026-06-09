---
title: 集群表 keywords_included 措辞对齐清单
date: 2026-06-09
type: ops-checklist
author: xdawayer
tags:
  - seo
  - ops
  - cluster
---

# 集群表 keywords_included 措辞对齐清单（2026-06-09）

## 背景

`gg-cluster-sync.mjs`（接进 autopilot tick，每跳自动跑）会把 **主题集群表 `keywords_included`** 里精确唯一命中关键词主表的词，自动回填到主表 `cluster_id`(AC)。但"措辞对不上主表"的词（孤儿词）会被漏检报告点名、**不自动写**。本清单是 2026-06-09 一次全量盘点。

- **机器已自动处理（11 个）**：见下方"已完成"，无需运营动作。
- **待运营处理（16 个孤儿词 + 7 个疑似漏配）**：见下方两节，按提示把 `keywords_included` 措辞对齐主表后，**下一跳 autopilot 自动归位**。

> 自查命令（只读，出当前报告）：`node tools/scripts/gg-cluster-sync.mjs`
> 日志：`~/gengrowth-agents/cron-sync/seo_autopilot/cluster-sync-YYYY-MM-DD.log`

---

## ✅ 已完成（机器已改 keywords_included + 已同步，仅备查）

| 集群 | 原写法 → 改后 |
|---|---|
| hsp_empath_guide | `signs you're a highly sensitive person (NEW)` → 去掉 `(NEW)` |
| vedic_mahadashas | `ketu mahadasha (NEW)` / `venus mahadasha (NEW)` → 去掉 `(NEW)` |
| astrology_basics_terms | `sextile` / `square` / `trine` / `descendant` → 各加 ` astrology` |
| houses_life_areas | `9th house` → `9th house astrology` |
| nakshatras_27_stars | `rohini` / `pushya` → 各加 ` nakshatra` |
| transit_events | `saturn return pisces` → `saturn return in pisces` |
| chakra_healing_basics | `solar plexus affirmations` → `solar plexus chakra affirmations` |
| mythology_deities | `persephone` → `persephone goddess` |

第一批 11 个 token 中 4 个当场写入主表 cluster_id（`saturn return in pisces`、`ketu mahadasha`、`venus mahadasha`、`signs you're a highly sensitive person`）；第二批 2 个（上表末两行）再写 1 个（`solar plexus chakra affirmations`）。其余对应的主表词原本已归类，仅做集群表措辞对齐。

---

## 🟡 待确认：措辞像漂移，但需人工判断（10 个）

把 `keywords_included` 里的"现写法"改成"建议主表写法"即可被自动接住；**但下列匹配置信度不高，请先确认语义是否一致，不要盲改**。

| 集群 | 现写法（孤儿） | 建议改成 | 备注 |
|---|---|---|---|
| astrocartography_map | `astrocartography` | `free astrocartography chart` | 或保留并在主表新增 `astrocartography` 头词 |
| astrology_basics_terms | `ic` | （脚本误判过 `malefic`，**勿采纳**） | `ic`=Imum Coeli 真术语；多半主表缺词，或应为 `ic astrology` |
| black_moon_lilith | `lilith sign` | — | 该集群已含 `black moon lilith sign`，`lilith sign` 要么删（冗余）要么作独立词加进主表 |
| black_moon_lilith | `lilith in birth chart` | `lilith birth chart calculator` | 仅 60% 词相似，意图可能不同 |
| chakra_healing_basics | `solar plexus affirmations` | `solar plexus chakra affirmations` | 75% 相似，较可信 |
| journal_prompts_writing | `self reflection journal prompts` | （勿塌缩成 `journal prompts`） | 大概率是独立长尾，建议主表新增 |
| mythology_deities | `persephone` | `persephone goddess` | 较可信 |
| rising_sign_profiles | `ascendant woman` | `leo ascendant woman`？ | 泛词 vs 狮子座专属，需定位 |
| rising_sign_profiles | `rising houses` | `leo rising houses`？ | 同上 |
| synastry_compatibility | `relationship astrology calculator` | `vedic astrology calculator` | 仅 50% 相似，存疑 |

## 🔵 待决策：主表确实没有相近词，决定是否新增（6 个）

主表无对应关键词，若值得做内容就加进关键词主表，否则可从 `keywords_included` 移除以保持集群表干净。

`lilith astrology` · `house meanings` · `eros` · `psyche` · `rising sign` · `synastry aspects`

---

## 🔁 疑似漏配（主表有词、但只模糊命中集群，7 个）

下列主表关键词只"模糊"命中集群，精确没中。若确认归属正确，把**主表的写法**补进对应集群 `keywords_included` → 下一跳自动归位；若是误配则忽略。

| 主表行 | 主表关键词 | 疑似集群 |
|---|---|---|
| 191 | `astro seek astrocartography` | astrocartography_map |
| 235 | `astro seek solar return` | solar_return_reading |
| 602 | `astrology terms` | astrology_basics_terms |
| 613 | `mrigashira nakshatra rashi` | nakshatras_27_stars |
| 614 | `revati nakshatra rasi` | nakshatras_27_stars |
| 615 | `mahadasha` | vedic_mahadashas |
| 625 | `moon journaling` | journal_prompts_writing |

---

## 当前线上状态（2026-06-09 改后）

`synced=0(已同步) · conflicts=0 · fuzzy=7 · orphans=16 · unclustered=411`

> `unclustered=411` 是主表里既无精确也无模糊命中的关键词，需人工扩 `keywords_included` 或新建集群——与本清单的孤儿词是两回事。
