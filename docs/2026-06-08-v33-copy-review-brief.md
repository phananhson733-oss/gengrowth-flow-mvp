---
title: v3.3 副本评审简报（给 SEO ops + CEO）
date: 2026-06-08
type: review-brief
author: wzb
copy_url: https://docs.google.com/spreadsheets/d/1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M/edit
---

# v3.3 副本评审简报

> 这是 keyword-sheet v3.1→v3.3 迁移的**副本**（非线上原表）。线上原表已迁 v3.3，
> 但**数据回填尚未对原表执行** —— 等本次评审通过后再回填。请对着副本核对，确认无误后回话。

**副本链接**：https://docs.google.com/spreadsheets/d/1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M/edit
（需 owner 在副本「共享」里把你们邮箱加为查看者/编辑者才能打开）

**配套报告**（同目录）：
- 验收报告 `docs/2026-06-08-v33-copy-acceptance-report.md`（技术验收，全 PASS）
- 迁移报告 `docs/2026-06-08-v33-migration-report.md`（§5 计数 + 争议清单）

## 这次迁移改了什么（一句话）
把"DR/KD 高就删词"的旧逻辑（❌跳过）换成"只给竞争建议不删"（N 列 竞争建议），
新增 V–X 三段生产准入（自动判定 + 人工可覆盖）+ Y 生产状态 + Z page_id，
并新增「生产候选」视图自动汇总可生产的词。cluster_id 保留在 AC 列。

## SEO ops 请核对
1. **生产候选视图**：452 个可生产词，抽查 10 个是否合理（不该有明显垃圾词/负向词）。
2. **7 个新集群主表 0 关键词**（mahadasha / empath / lilith / solar-return / healing / journal / rising-sign）：
   这些集群有页面但主表没词带它们的 cluster_id（历史未回标）。是否需要补标？
3. **11 个 P1 calculator 词被默认暂缓**（缺 DR 数据，见迁移报告 §4.1）：
   如 "vedic birth chart calculator" 系列。要进生产候选需在 **W 列手动标「集群必需」** 或补 DR 数据。
4. **争议清单 42 条**（迁移报告 §4.3）：同一关键词命中多个 page_id，回填默认选"该词作 Target 的页"。
   抽查几条确认归属对（如 "9th house astrology" → PG-HOUSE-004 而非 Pillar 的 PG-HOUSE-001）。

## CEO 请核对
1. **P0 集群覆盖 2/2 ✅**：aura_colors_1a、houses_life_areas 都有词可进生产，节奏不被卡。
2. **生产准入分布**：可生产 452 / 暂缓 164 / 无关 9 —— 产能盘子是否符合预期。
3. **§4 创始人争议处理流程**：方案这节是空白，需你定义"当自动判定和人工判断冲突时谁拍板、怎么记录"。
4. **回填 go/no-go**：通过后我会对线上原表回填 168 行 page_id/状态（已审计 0 冲突、纯新增不覆盖）。

## 注意：副本里的测试数据
副本「选题登记表」**行 1515–1530**（约 16 行：aura colors / nakshatra / trine / houses 等）
是迁移期间跑工具链演练（gg-queue-build --write）写入的**测试行**，不是真实队列，评审时请忽略。
（可请 owner/我清除后再看，保持干净。）

---
*技术问题找 wzb；本简报对应 commit 链 4d66dbb(B1) / 79643cc(B2) / 6badfcf(§5报告)。*
