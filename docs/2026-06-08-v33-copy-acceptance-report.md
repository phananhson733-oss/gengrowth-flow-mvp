---
title: v3.3 迁移副本 验收报告
date: 2026-06-08
type: qa-acceptance-report
author: wzb
target: 关键词主表 @ 副本 1UaTxBQNdgeSomL6qlNJZMSRxovsSL5SasyWmuO5ny7M (gengrowth-flow-mvp)
verdict: ACCEPTED_WITH_CONCERNS
method: Sheets API 只读硬核对 + Chrome 线上肉眼 + codex 对抗式二审
---

# v3.3 迁移副本 验收报告

**结论:副本数据层 = 通过(ACCEPTED)。下游工具链 + 生产 cutover 前置 = 待办(CONCERNS)。**

迁移本身(schema + 公式 + 视图 + 回填)在副本上干净、自洽、可用。挡在"整件事完成"前面的不是迁移,而是 (a) 下游脚本读不到 AC 的 cluster_id,(b) 回填脚本对线上原表无覆盖保护。

## A. 副本数据层验收(全部 PASS)

| 项 | 期望 | 实测 | 结论 |
|---|---|---|---|
| 表头列数 | 29 | 29 | ✅ |
| N 列 | 竞争建议 | 竞争建议(值 ⏸暂缓/✅可做) | ✅ |
| V–AC | 生产准入_自动/手动/生产准入/生产状态/page_id/发布URL/备注/cluster_id | 一致 | ✅ |
| 全表 #ERROR 扫描 | 0 | 0(N/O/V/X 各 0) | ✅ |
| X 生产准入分布 | — | 可生产 452 / 暂缓 164 / 无关 9 | ✅ |
| 生产候选视图 | = X∈{可生产,集群必需} | 452 = 452 精确相等 | ✅ |
| 高DR(DR差值>30) | 不误删 Pillar | 124 总,122 进桶,2 为真负向词 | ✅ |
| P0 集群覆盖 | 每个 ≥1 进候选 | aura_colors_1a 13/15、houses_life_areas 17/23 | ✅ |
| cluster_id 保全 | 162 搬到 AC | AC 非空 162 | ✅ |
| 备注保全 | 8 搬到 AB | AB 非空 8 | ✅ |
| 回填 Z/Y | 从选题登记表 | Z 168 / Y 168(已发布119/已建卡49) | ✅ |
| W 下拉 | 可生产/暂缓/集群必需/无关 | 一致 | ✅ |
| Y 下拉 | 未开始/已建卡/已发布/已合并/暂停 | 一致 | ✅ |
| V 下拉 | 无(公式列) | 无 | ✅ |
| 条件格式 | 主表有规则 | 68 条 | ✅ |

线上肉眼(Chrome):标题确认"v3.3 迁移副本";关键词主表 N=竞争建议、O 无 ❌跳过、H/K 列条件格式配色正常;生产候选 tab 存在且公式正确、452 候选词全 N=✅可做。

## B. 发现的问题

### B1 [HIGH] 下游脚本读不到 AC 的 cluster_id(数据模型分叉)
迁移把 cluster_id 保留在 **AC(第29列)**,但:
- `gg-sheet-pull.mjs:310` fetchTab 读 `A:AB`(注释自称"28列覆盖 v3.3")→ 漏 AC。`gg-queue-build` 经此读表,`idx.cluster_id` 恒为 null,162 个人工确认的 cluster_id 全失效,退回子串 matcher 兜底(可能把词归错集群)。而 `gg-queue-build.mjs:234` 本意是"主表 cluster_id 人工值优先"——读漏让这条意图落空。
- `gg-keyword-promote.mjs:318` 读 `A1:AB1` 解析 cluster_id 列 → 找不到 → 跳过回填,还打印误导信息"可能已迁 v3.3,cluster_id 不在主表"。

根因:这两个脚本(连同注释/smoke 测试)按 **canonical 模型(v3.3 丢弃主表 cluster_id)** 写;但实际迁移按 **flow-mvp 模型(cluster_id 保留到 AC)** 做。两套模型对不上 = 半身在 A 半身在 B。
**注意:线上原表已是 v3.3,此 bug 对原表同样生效**——现在跑 queue-build/promote 就已经读漏。

### B2 [HIGH · 仅生产 cutover 相关] 回填脚本无覆盖保护
`_v33-backfill.mjs:110-111` 对命中行**无条件**写 Z/Y,不检查线上原表是否已有人工值。副本上 Y/Z 本空所以无害;但对原表 apply 前,**必须先跑只读冲突审计**(命中行里 Y/Z 已有值且 ≠ 计算值的清单),安全策略应"默认只填空、冲突仅报告、显式 --force 才覆盖"。(codex P1)

### B3 [MEDIUM] 11 个 P1 calculator 词因缺 DR 数据被默认暂缓
`N=待填` 共 42 行(全默认 V=暂缓),其中 11 个是 vedic_astrology_basics(P1)的 "vedic birth chart calculator" 变体。非迁移 bug——这些词 J/DR 列空,竞争建议算不出,公式正确地默认暂缓。补救=人工标 W=集群必需(已知待办)或补 DR 数据。无 P0 受影响。

### B4 [LOW] runbook 承诺但脚本未做的文案 token 替换
配置 A27/A28 注释仍写"❌跳过"(线上肉眼可见),R 列条件格式 token、P 下拉末值同理未改。O 公式产出已是 ❌无关(数据正确),纯文案不一致。(codex P3)

### B5 [LOW] 两处公式脆弱点(codex P2)
- 生产候选视图正则 `可生产|集群必需` 未锚定 → 未来 W 出现"不可生产"会子串误命中。建议 `^(可生产|集群必需)$`。
- `X=IF(W<>"",W,V)` + W 非严格下拉 → 手输垃圾值会覆盖自动准入。建议 W 用 TRIM+白名单。
当前 W 全空,均为潜在风险非现行错误。

## C. 待办(按优先级)
1. **B1 修下游读 AC**:gg-sheet-pull `A:AB→A:AC`、gg-keyword-promote `A1:AB1→A1:AC1`,改注释 + 补 smoke 测试(header 含 AC→clusterColFromHeader 返回 AC)。属数据模型决策,需用户确认走 A(保留并用 cluster_id)。
2. **B2 回填前冲突审计**:对原表 cutover 前先只读审计 Y/Z 冲突 + 留快照回滚件,经明确放行再 `--apply`(见 [[feedback-no-overwrite-prod-sheet]])。
3. **B3 W=集群必需 人工标**(SEO/运营)。
4. **B4/B5 文案与公式加固**(可选,低优先)。
5. §5 迁移报告(无关/暂缓/集群必需计数 + 争议清单)、§4 创始人争议流程(需人工)。

---
*验收脚本(只读):tools/scripts/_v33-verify-s6.mjs、_v33-verify-accept2.mjs、_v33-verify-tianpian.mjs。原始需求见 docs/2026-06-07-v33-live-migration-plan.md §5/§6。*
