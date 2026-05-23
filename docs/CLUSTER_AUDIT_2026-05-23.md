---
title: 主题集群表 4 路验收报告（v1 算法首跑）
date: 2026-05-23
type: audit
status: live
upstream: spec/upstream-canon/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md
related:
  - docs/KEYWORD_MINE_AUDIT.md
  - tools/scripts/gg-cluster-init.mjs
---

# 主题集群表 4 路验收（cluster-init v1，89 集群 / 475 词）

**审查对象：** `gg-cluster-init.mjs --min-size 3 --write --rebuild` 输出（写入 [flow-mvp 主题集群表](https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit)）

**审查者（4 路并行）：**
- **Codex GPT-5.2**（独立第三方模型）
- **SEO 内容策略 subagent**
- **数据科学/聚类算法 subagent**
- **占星产品 PM subagent**

---

## 一、整体打分

| Reviewer | 分数 | 一句结论 |
|---|---|---|
| Codex GPT-5.2 | **6/10** | 草稿可用，但必须先"合并去碎片 + 拆垃圾桶 + 删泛簇"，否则误导选题 |
| 算法专家 | **3.3/10**（分组 5 / 命名 3 / 孤词 2）| 二级分裂没设 min-size 兜底是硬 bug，1 词集群 25 个 |
| SEO 策略 | （定性）粒度过细 | 89 → ~35-45 publishable units 为理想 |
| 业务 PM | （定性）方向需调 | 砍 vedic 重投入，主轴 aura/node/transits/HSP/past life |

---

## 二、4 路共识：3 大算法缺陷

### 🐛 缺陷 #1：二级分裂未继承 MIN_CLUSTER_SIZE
- **证据：** c-064 ~ c-088 共 25 个 1 词集群，但 CLI 传的是 `--min-size 3`
- **根因：** `splitLargeClusters()` 调 `findClusterSeeds(words)` 后用全局 MIN，但二级分裂时 freq=1 的 bigram 配上贪心匹配也能产 1 词桶
- **修法：** 子桶 `size < MIN_CLUSTER_SIZE` 时全部 merge 回 `${name} (其它)` 兜底桶

### 🐛 缺陷 #2：母词虹吸（c-001 装 50 词）
- **证据：** c-001 "astrology (其它)" 50 词，含 `north node in astrology / square aspect astrology / 9th house in astrology` 等本应归其他簇的词
- **根因：** `assignClusters` first-match-wins，seed 排序按 freq，astrology unigram 频次最高排第一被先匹中
- **修法：** 改"所有 bigram 跑完，选最长匹配"，bigram 全无匹配才 fallback unigram

### 🐛 缺陷 #3：cluster_name 不可读
- **证据：** `birth (1)/(2)/(3)`、`seek birth`、`com natal`、`vedic astrology / astrology birth`、`(其它)` 后缀
- **修法：** 三层处理
  - brand token 识别 → `[astro-seek] ...` / `[cafe-astrology] ...`
  - cluster 内重跑 trigram，覆盖 ≥40% 成员的 trigram 取代 raw seed
  - 剥离 NAMING_NOISE（calculator/chart/meaning/sign/free/online 等）

---

## 三、4 路共识：6 个家族应合并

| 家族 | 散落集群 | 合并后形态 |
|---|---|---|
| **Aura family** | c-003/004/012/021/025/030/031/033/036/038/041/042/063 | Pillar + 8 颜色子页 + quiz 模块 |
| **Birth Chart family** | c-007/008/016/017/040/044/046/047 | 工具页防御 pillar + Vedic/Sidereal/Tropical/Starseed/Twin Flame 变体 |
| **Lunar Nodes family** | c-002/014/053/064/065 | North + South Node pillar + 12 sign 子页 = 24 篇 |
| **Vedic family** | c-009/010/020/023 | Vedic Astrology Complete Guide |
| **Nakshatra family** | c-005/006/057/071/073/074/078 + c-089 部分 | 27 Nakshatras Index + 27 子页 |
| **Houses family** | c-022/026/027/029/058 | Astrological Houses pillar + 12 house 子页 |

---

## 四、4 路共识：P0 / 应砍

### 🎯 P0 该上（多人提及）
1. **Aura 全系列**（流量盘已有，扩词）
2. **North + South Node by sign**（12 模板批量）
3. **Birth Chart Calculator**（工具页防御）
4. **HSP（c-015）**（差异化 anchor）
5. **Past Life（c-035）**（高情感卷入，配工具）
6. **Solar Return（c-037）**（生日触发邮件）
7. **Full Moon Ritual（c-043）**（newsletter 主承接）
8. **Pisces Transits 2026（c-011）**（时效窗口）
9. **Sextile/Trine/Square/Opposition**（c-001 子集，aspect 词典 4 篇）

### 🚫 应砍（多人提及）
- **c-040/047/055 astro-seek 系列** — 给竞品做 SEO
- **c-088 reading** — 与 Keen/Kasamba 正面冲突
- **c-077 dosha quiz** — 阿育吠陀偏题
- **c-062 life coach/prediction** — 引流质量差
- **c-045 persephone** — 神话查询不绑产品
- **c-049/080/085 颜色精神含义** — 与占星弱关联
- **c-068 / c-066 / c-034 ophiuchus 等猎奇** — 留存差
- **c-052 astrocartography** — 工具实现成本高词量小

---

## 五、3 处分歧

| 议题 | SEO 视角 | PM 视角 | 折中 |
|---|---|---|---|
| **Nakshatra 投入度** | 做 27 个模板（蓝海低竞争）| 降级（印度向 us_share=低）| 保留模板做"长尾广覆盖"，cta 不绑欧美产品 |
| **Chakra (c-013)** | 列入 pillar 候选 | 砍（被 yogajournal 碾压）| 做 chakra × astrology 交叉切入小切口 |
| **Vedic 投入度** | 列入 Complete Guide pillar | 降级让位欧美主轴 | 先英语版欧美向，后做印度 hreflang |

---

## 六、立即可落地：3 个算法修补（无新依赖，~30 分钟）

| # | 修补 | 改动量 | 预期效果 |
|---|---|---|---|
| 1 | `splitLargeClusters` 子桶 `< MIN_CLUSTER_SIZE` 回流 "(其它)" | 5 行 | 消灭 25 个 1 词集群 → 89 → ~65 |
| 2 | `assignClusters` 最长 bigram 优先 + 全跑完 bigram 才 fallback unigram | ~15 行 | 拆 c-001 母词虹吸（50 词砍半）|
| 3 | NAMING_NOISE + BRAND_PATTERNS + trigram 优选命名 | ~35 行 | "seek birth" → "[astro-seek] birth chart calculator" |

**修后预计综合分：3.3 → 6.5-7/10**

---

## 七、本审计结论（落地路径）

**Phase 1（已完成 2026-05-23）：** 3 个算法修补落地 + 重跑

**Phase 2（待人工接手，30-60 分钟）：** 在 [主题集群表](https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit) 合并 6 家族 + 砍 9 个 noise + 填业务字段（track/jtbd/content_angle/cta/priority）

**Phase 3（可选未来，3-4h）：** 算法升级到 embedding 聚类（text-embedding-3-small + HDBSCAN/agglomerative）→ 预计综合分 8.5+/10

---

## 八、参考

- 4 路 reviewer 完整输出归档在 conversation log
- Codex thread ID: 019e549c-2329-7623-9550-7a343535a546
- 集群 dump 文件（一次性）：原存 /tmp/clusters-full-dump.md，归档时已清理

---

## 九、Phase 2 落地：6 家族合并结果（2026-05-23）

按 §三 共识做的 6 家族合并已落 sheet：**53 集群 → 24 publishable units**（-55%，475 词 100% 覆盖）。

### 6 家族定义（SSOT — 未来重跑 cluster-init 后再做合并的参照）

| family_id | name | 包含的 v2 cluster_name |
|---|---|---|
| **fam-aura** | 🌈 Aura Family（pillar + 8 colors + quiz/test/reading）| aura (其它) / aura color (其它) / green aura / purple aura / orange aura / red aura / white aura / blue aura / yellow aura / aura reading / color aura quiz / aura color test |
| **fam-birth-chart** | 📋 Birth Chart Calculator Family | [astro-seek] birth (1) / [chani] birth (2) / birth (3) / astrology birth / [astro-seek] astro seek birth / astrological birth / starseed birth / [astro.com] astro com natal / natal |
| **fam-lunar-nodes** | 🌗 Lunar Nodes Family（North + South Node）| north node (其它) / south node |
| **fam-vedic** | 🕉 Vedic Astrology Family | vedic astrology (其它) / [astro-seek] vedic birth / vedic astrology birth / vedic / sidereal astrology |
| **fam-nakshatra** | ⭐ 27 Nakshatras Family | nakshatra (1) / nakshatra (2) |
| **fam-houses** | 🏛 Astrological Houses Family | house / rising houses / 8th house / mars 12th house / 8th house astrology |

### 24 publishable units 完整名单

```
6 家族:
  fam-aura            81 词  🌈 Aura Family
  fam-birth-chart     62 词  📋 Birth Chart Calculator Family
  fam-vedic           42 词  🕉 Vedic Astrology Family
  fam-lunar-nodes     35 词  🌗 Lunar Nodes Family
  fam-nakshatra       30 词  ⭐ 27 Nakshatras Family
  fam-houses          26 词  🏛 Astrological Houses Family

18 独立保留:
  ind-001  71 词  (未聚类 — 人工分配)        ← 兜底，需人工归类
  ind-002  50 词  astrology (其它)          ← 异质桶，需 embedding 才能拆
  ind-003  10 词  pisces                   ← 2026 时效骨架
  ind-004   9 词  chakra
  ind-005   9 词  highly sensitive person  ← 差异化 anchor
  ind-006   7 词  transit
  ind-007   7 词  rahu
  ind-008   4 词  black moon lilith
  ind-009   4 词  sign
  ind-010   4 词  past life                ← 高转化候选
  ind-011   3 词  solar return
  ind-012   3 词  saturn
  ind-013   3 词  full moon                ← newsletter 主承接
  ind-014   3 词  persephone
  ind-015   3 词  compatibility
  ind-016   3 词  color
  ind-017   3 词  planets
  ind-018   3 词  ascendant woman
```

### 合并执行方法

一次性脚本（不入仓库）：按 cluster_name 模式匹配，把 family 成员的 keywords_included 合并写入新 cluster_id `fam-X`，content_angle 字段自动填家族描述，其他业务字段（track/jtbd/cta/priority）留空人工填。

未来重跑 `gg-cluster-init.mjs` 后 cluster_name 可能变化，重做合并时按上表"包含的 v2 cluster_name"列匹配最接近的新 name。

### Phase 2 后续待人工动作

1. **填业务字段**（在 sheet 上）：每个 publishable unit 填 `track`（量产线/精修线）、`jtbd`、`content_angle` 细化、`cta_primary`（Newsletter/工具页/星盘页/注册）、`priority`（P0/P1/P2）、`week`
2. **拆 ind-002 astrology (其它) 50 词**：算法无能为力，需人工按子主题（aspects / IC / 9th house / juno / AI astrology / 付费 reading）拆开
3. **归类 ind-001 (未聚类) 71 词**：人工浏览归入合适的 family 或新建独立 cluster
4. **business 决策**（按 PM 视角）：砍 6 个 noise 桶（astro-seek 系列 / dosha / life coach / persephone / 颜色精神含义 / astrocartography）
5. Phase 3 embedding 聚类已上 (`--algo embedding`) — ind-001/ind-002 自动归类工具落地 (`gg-classify-unsorted.mjs`).
   - **2026-05-23 实测（ollama + nomic-embed-text）**：
     - 全集 475 词 → **43 cluster / 442 已分配 / 33 未分配**（vs token 模式 52 cluster / 404 已分配）
     - **ind-002 50 词异质桶 → 7 sub-cluster / 100% 拆开**（token 模式天花板：1 cluster）
     - ind-001 71 兜底词 → **60 自动归类 (84.5%)** + 11 needs_new（包括 typo 如 "mecury"）
     - top 自动归类去向：fam-nakshatra +16 / fam-birth-chart +6 / fam-lunar-nodes +5 / fam-vedic +3
   - **不 --write 覆盖**：保留 Phase 2 手工 6-家族合并的 24 publishable units。Embedding 结果落 `.gg-cache/classify-suggestions/*.json` 供 review.
   - **mxbai-embed-large (335M, MTEB 64.7) + qwen3-embedding:8b (8B, MTEB 70.58 multi)** 拉取卡在 CDN 95%，完成后用 `_benchmark-embedding.mjs` 自动 re-bench。完整结果见 [EMBEDDING_BENCHMARK_2026-05-23.md](./EMBEDDING_BENCHMARK_2026-05-23.md)。
