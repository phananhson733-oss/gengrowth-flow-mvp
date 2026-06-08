---
title: keyword-sheet v3.3 迁移报告（方案 §5）
date: 2026-06-08
type: migration-report
author: wzb
target: 关键词主表 @ 线上原表 1CkjOC (gengrowth-flow-mvp)
method: 只读读取线上表 + 公式产出统计（_v33-report.mjs）
---

# keyword-sheet v3.3 迁移报告

> 对应迁移方案 `2026-06-05-keyword-sheet-v3.3-migration-collaboration` §5「迁移报告」要求：
> 无关/暂缓/集群必需计数 + P0 问题 + 争议清单。数据为只读读取线上表实时产出。

## 1. schema 落地
- 表头列数 **29**；N 列 = **竞争建议**（DR过滤→竞争建议，只建议不删）。
- V–AC = 生产准入_自动 / 手动生产准入 / 生产准入 / 生产状态 / page_id / 发布URL / 备注 / cluster_id。
- 全表 #ERROR 单元格：**0** ✅。
- cluster_id（AC）非空 **162**；备注（AB）非空 **8**（v3.1 数据零丢失搬移）。

## 2. 准入 / 分桶 / 竞争建议 计数
- **生产准入（X）**：可生产 452 / 暂缓 164 / 无关 9
- **分桶_自动（O）**：快速胜利 392 / 长尾词 174 / 战略词 50 / ❌无关 9
- **竞争建议（N）**：✅可做 459 / ⏸暂缓 124 / 待填 42
- 矛盾校验（O=❌无关 但 X=可生产）：**0** ✅
- **生产候选视图**：452 行；主表 X∈{可生产,集群必需}：452（精确相等 ✅）

## 3. P0 / P1 集群进生产候选覆盖
| 优先级 | 集群 | 集群词 | 可进候选 | 结论 |
|---|---|---|---|---|
| P0 | aura_colors_1a（Aura Colors & Meanings） | 15 | 13 | ✅ |
| P0 | houses_life_areas（Astrology Houses as Life Areas） | 23 | 17 | ✅ |
| P1 | lunar_nodes_path（Lunar Nodes & Life Purpose） | 12 | 12 | ✅ |
| P1 | vedic_astrology_basics（Vedic Astrology Basics） | 34 | 22 | ✅ |
| P1 | chakra_healing_basics（Chakras & Energy Healing） | 3 | 2 | ✅ |
| P1 | healing_placements（Healing Placements (Chiron & 12th)） | 0 | 0 | ⚪ 0集群词 |
| P1 | transit_events（Planetary Transits & Major Cycles） | 5 | 5 | ✅ |
| P1 | hsp_empath_guide（HSP & Empath Self-Discovery） | 0 | 0 | ⚪ 0集群词 |
| P1 | vedic_mahadashas（Vedic Mahadashas & Life Timing） | 0 | 0 | ⚪ 0集群词 |
| P1 | solar_return_reading（Solar Return & Personal Year Chart） | 0 | 0 | ⚪ 0集群词 |
| P1 | journal_prompts_writing（Journal Prompts & Self-Reflection Writing） | 0 | 0 | ⚪ 0集群词 |
| P1 | black_moon_lilith（Black Moon Lilith & Asteroid Lilith） | 0 | 0 | ⚪ 0集群词 |
| P1 | rising_sign_profiles（Rising Sign Profiles 上升星座画像） | 0 | 0 | ⚪ 0集群词 |

- **P0**：2/2 集群均有词进生产候选 ✅（§5 核心准入达标）。
- **P1 中 7 个集群 0 集群词**（healing_placements、hsp_empath_guide、vedic_mahadashas、solar_return_reading、journal_prompts_writing、black_moon_lilith、rising_sign_profiles）：主表无关键词带其 cluster_id（AC 的 162 个 cluster_id 只覆盖 v3.1 那批老集群；这些较新集群的词从未回标）。**非迁移 bug**（迁移忠实保留了旧 cluster_id），是预存的「新集群关键词未回标 cluster_id」编辑缺口（与 front-half-queue 记录的 68 未归集群同源）。B1 修复后 gg-queue-build 的集群表 matcher 仍可兜底归集这些词。

## 4. 问题清单
### 4.1 N=待填 默认暂缓（缺 DR 数据）
- N=待填 共 **42** 行（全部默认 V=暂缓，因 J/DR 列空算不出竞争建议）。
- 其中属 P0/P1/Pillar 的 **11** 条（缺数据被挡在生产候选外，建议补 DR 或人工标 W=集群必需）：
  - vedic astrology birth chart calculator online（vedic_astrology_basics，P1）
  - free vedic birth chart calculator online（vedic_astrology_basics，P1）
  - vedic birth chart calculator online（vedic_astrology_basics，P1）
  - free online vedic birth chart calculator（vedic_astrology_basics，P1）
  - online vedic birth chart calculator（vedic_astrology_basics，P1）
  - online vedic astrology birth chart calculator（vedic_astrology_basics，P1）
  - vedic birth chart calculator free online（vedic_astrology_basics，P1）
  - astro-seek vedic birth chart calculator（vedic_astrology_basics，P1）
  - vedic astrology birth chart calculator free（vedic_astrology_basics，P1）
  - free vedic birth chart calculator（vedic_astrology_basics，P1）
  - astrosage vedic birth chart calculator（vedic_astrology_basics，P1）
- **无 P0 受影响** ✅。

### 4.2 回填预览（page_id/状态 → Z/Y）
- 选题登记表→主表命中 **168** 行；Z 当前空 **168** / Y 当前空 **168**。
- B2 只读审计结论：命中行 Z/Y 全空 → 回填纯新增、0 覆盖、安全。

### 4.3 争议清单（同一关键词命中多个 page_id）
共 **42** 条，回填按「Target 优先 > Associated；已发布 > 其它」折叠：
- 9th house astrology：候选[PG-HOUSE-001, PG-HOUSE-004] → 选 **PG-HOUSE-004**（target）
- 12th house astrology：候选[PG-HOUSE-001, PG-HOUSE-003] → 选 **PG-HOUSE-003**（target）
- solar return：候选[PG-SOLAR-001, PG-SOLAR-002] → 选 **PG-SOLAR-002**（target）
- saturn in pisces：候选[PG-TRANS-001, PG-TRANS-002] → 选 **PG-TRANS-002**（target）
- root chakra meaning：候选[PG-CHAKRA-001, PG-CHAKRA-004] → 选 **PG-CHAKRA-004**（target）
- vedic astrology birth chart：候选[PG-VEDIC-002, PG-VEDIC-004] → 选 **PG-VEDIC-002**（target）
- 11th house：候选[PG-HOUSE-001, PG-HOUSE-005] → 选 **PG-HOUSE-005**（target）
- north node in scorpio：候选[PG-NODE-001, PG-NODE-002] → 选 **PG-NODE-002**（target）
- north node in taurus：候选[PG-NODE-001, PG-NODE-003] → 选 **PG-NODE-003**（target）
- vedic birth chart calculator online free：候选[PG-VEDIC-003, PG-VEDIC-004] → 选 **PG-VEDIC-003**（target）
- ashlesha nakshatra：候选[PG-NAKSH-001, PG-NAKSH-002] → 选 **PG-NAKSH-002**（target）
- rohini nakshatra：候选[PG-NAKSH-001, PG-NAKSH-003] → 选 **PG-NAKSH-003**（target）
- pushya nakshatra：候选[PG-NAKSH-001, PG-NAKSH-004] → 选 **PG-NAKSH-004**（target）
- anuradha nakshatra：候选[PG-NAKSH-001, PG-NAKSH-005] → 选 **PG-NAKSH-005**（target）
- bharani nakshatra：候选[PG-NAKSH-001, PG-NAKSH-006] → 选 **PG-NAKSH-006**（target）
- 8th house meaning：候选[PG-HOUSE-001, PG-HOUSE-002] → 选 **PG-HOUSE-002**（target）
- sextile astrology：候选[PG-TERM-001, PG-TERM-002] → 选 **PG-TERM-002**（target）
- black lilith：候选[PG-LILITH-001, PG-LILITH-002] → 选 **PG-LILITH-002**（target）
- rahu mahadasha：候选[PG-MAHADASHA-001, PG-MAHADASHA-003] → 选 **PG-MAHADASHA-003**（target）
- ic astrology：候选[PG-TERM-001, PG-TERM-006] → 选 **PG-TERM-006**（target）
- full moon energy：候选[PG-MOON-001, PG-MOON-002] → 选 **PG-MOON-002**（target）
- ketu mahadasha：候选[PG-MAHADASHA-001, PG-MAHADASHA-002] → 选 **PG-MAHADASHA-002**（target）
- natal chart transits：候选[PG-TRANS-001, PG-TRANS-003] → 选 **PG-TRANS-003**（target）
- descendant astrology：候选[PG-TERM-001, PG-TERM-005] → 选 **PG-TERM-005**（target）
- highly sensitive person vs autism：候选[PG-EMPATH-001, PG-EMPATH-003] → 选 **PG-EMPATH-003**（target）
- chakra test：候选[PG-CHAKRA-001, PG-CHAKRA-002, PG-CHAKRA-003] → 选 **PG-CHAKRA-003**（target）
- square astrology：候选[PG-TERM-001, PG-TERM-004] → 选 **PG-TERM-004**（target）
- chiron in 12th house：候选[PG-HEAL-001, PG-HEAL-002, PG-HEAL-004] → 选 **PG-HEAL-002**（target）
- shani mahadasha：候选[PG-MAHADASHA-001, PG-MAHADASHA-005] → 选 **PG-MAHADASHA-005**（target）
- mars in 12th house：候选[PG-HEAL-001, PG-HEAL-003] → 选 **PG-HEAL-003**（target）

…另 12 条（全部 via=target，即选「该词作 Target 的页」，另一候选为 Pillar 把它列为 Associated）。

## 5. 残留 / 待办（截至 2026-06-08）
- **回填原表**：B2 审计 0 冲突，安全；按「不覆盖原件」约定待用户明确放行后 `_v33-backfill.mjs --workbook 1CkjOC… --apply`。
- **B3 W=集群必需 人工标**：4.1 列出的缺 DR 的 P1 calculator 词（SEO/运营判断）。
- **B4 文案 token**：配置 A27/A28 注释、R 列条件格式、P 下拉末值仍写「❌跳过」（O 公式产出已「❌无关」，纯文案不一致）。
- **B5 公式加固**：生产候选正则 `可生产|集群必需`→`^(可生产|集群必需)$`；X=IF(W<>"",W,V) 建议 W 用 TRIM+白名单（W 全空，暂无实害）。
- **§4 创始人争议流程**：方案该节空白，需创始人/方案作者定义。
- 已完成：schema 迁移+上线+验证；下游读 AC（B1，commit 4d66dbb）；B2 审计脚本（commit 79643cc）。

---
*生成器：tools/scripts/_v33-report.mjs（只读）。配套：验收报告 docs/2026-06-08-v33-copy-acceptance-report.md、执行计划 docs/2026-06-07-v33-live-migration-plan.md。*
