---
title: Bootstrap vs SSOT .gs Diff — 2026-05-23
date: 2026-05-23
type: audit
status: fresh
sources:
  - spec/upstream-canon/keyword-sheet-setup.gs (v3.1, 707 lines)
  - tools/scripts/_bootstrap-flow-mvp-workbook.mjs (v0.3, 514 lines)
  - tools/scripts/lib/_workbook-spec.mjs (560 lines)
supersedes: docs/KEYWORD_MINE_AUDIT.md §三 (lines 158-185, 已过期)
---

# Bootstrap vs SSOT .gs Diff — 2026-05-23

## 背景

`docs/KEYWORD_MINE_AUDIT.md` §三（line 158）曾断言「关键词主表公式全缺失、列名错乱、整张表未建」等问题。
那是 bootstrap v0.1 时期的实情。2026-05 完成重写后：

- bootstrap 改为 spec-driven（`_workbook-spec.mjs` 单数据源）
- 13 张 .gs 表 + 7 张运维表全部建立
- J/K/M/N/O/R/S/U 公式 1:1 复刻 v3.1
- 表头三色分类（navy/green/slate）按列精确匹配

本文档为 2026-05-23 重新扫描结果，**作废 KEYWORD_MINE_AUDIT §三 的旧 diff 表**。

---

## 一、Summary Diff（13 .gs 表）

> 列说明：Spec=.gs v3.1；Boot=`_bootstrap-flow-mvp-workbook.mjs` 经由 `_workbook-spec.mjs`；
> ✅ = 1:1 完整；⚠️ = 存在 gap；❌ = 整段缺失

| Sheet | Spec cols | Boot cols | Headers | Formulas | Validation | Cond. Format | Notes / 备注 |
|---|---|---|---|---|---|---|---|
| 配置 | 2 列 + 多区段 | 2 列 + rows | ✅ | n/a | n/a | n/a | ⚠️ `headerColors` 字段拼写不匹配（spec 写 `headerColors`，builder 只读 `headerColorByCol`），A1/B1 深灰不会上色（cosmetic） |
| 关键词主表 | 24 (A-X) | 24 | ✅ | ✅ J/K/M/N/O/R/S/U 全在 | ✅ B/H/L/P/T/V 6 条下拉 | ✅ R/O/P/H/S 全 14 条规则 | 公式 fill-down 已写到 row 1500（spec 是 500，扩容合理） |
| 主题集群表 | 19 | 19 | ✅ | n/a | ✅ C/D/I/O/P/Q/R 7 条 | n/a | 完全对齐 |
| 选题登记表 | 21 | 21 | ✅ | ✅ C2/D2 VLOOKUP | ✅ E/F/G/M/R/T 6 条 | n/a | 完全对齐 |
| CTA Map | 6 | 6 | ✅ | n/a | ✅ B/F 2 条 | n/a | 含 6 行 seed Week-1 默认 |
| 结果复盘表 | 12 | 12 | ✅ | n/a | ✅ E/K 2 条 | n/a | 完全对齐 |
| 趋势词 | view (1 公式) | view (1 公式) | ✅ 公式正确 | ✅ | n/a | n/a | ⚠️ `_styleViewSheet` 行未做（spec 把 row1 当说明行、row2 当表头染色，bootstrap 直接 A1 写公式，无说明行；line 484 显式 TODO） |
| 快速胜利 | view | view | ✅ | ✅ | n/a | n/a | ⚠️ 同上 |
| 战略词 | view | view | ✅ | ✅ | n/a | n/a | ⚠️ 同上 |
| 长尾词 | view | view | ✅ | ✅ | n/a | n/a | ⚠️ 同上 |
| 分桶规则 | rows + 多区段样式 | rows + cellStyling | ✅ | n/a | n/a | n/a | 完全对齐 |
| 内容追踪 | 14 | 14 | ✅ | ✅ G/H/L 3 条 | n/a | n/a | ⚠️ 列宽 spec 只设 col 1=250 / col 4=220，bootstrap 全 14 列都设了（覆盖 spec 默认，无害） |
| 来源分析 | 6 + 合计行 | 6 + 合计行 | ✅ | ✅ seed + tailRow | n/a | n/a | ⚠️ 列宽 spec 只设 col 1=120 / col 6=180，bootstrap 设 6 列（其他差异 cosmetic） |

7 张运维表（README / keyword_candidates / pipeline-status / publish-log / quality-metrics / cost-tracking / config）不在 .gs 范围，正确创建。共 20 tab，符合 PRD v0.7 附录 D + 项目运维需求。

---

## 二、4 个视图 tab 公式验证

| Tab | Spec 公式（.gs） | Bootstrap 公式（VIEW_FORMULAS in spec lib） | Match |
|---|---|---|---|
| 趋势词 | `IF(COUNTIF...REGEXMATCH(R2:R500,"趋势词")...SORT...6,FALSE)...` | `...R2:R1500,"趋势词")...SORT...6,FALSE)...` | ✅ 结构 1:1；range 扩到 1500 |
| 快速胜利 | `...REGEXMATCH...快速胜利...SORT...21,FALSE,3,FALSE)...` | 同结构，1500 | ✅ |
| 战略词 | `...REGEXMATCH...战略词...SORT...5,FALSE)...` | 同结构，1500 | ✅ |
| 长尾词 | `...REGEXMATCH...长尾词...FILTER...(无SORT)...` | 同结构，1500 | ✅ |

公式都正确写到 view 表的 A1。**不再是"空白 tab"**。

视觉装饰（spec `_styleViewSheet` 在 row1 加说明行 + row2 染表头深灰 + freeze 2 行）= bootstrap 未做，仅功能性渲染。

---

## 三、配置 关键 range 校验

| 区域 | Spec | Boot rows | 命中 |
|---|---|---|---|
| 标题行 A1:B1 | "配置项 / 值" | row 1 同 | ✅ |
| 客户产品名 / 实验开始日期 / 目标国家 | A2/A3/A4 | rows[1..3] 同 | ✅ |
| B4 黄底（必填提醒） | `#fff9c4` | `cellBackgrounds: B4 #fff9c4` | ✅ |
| TOPIC_KEYWORDS 标题 | A5 | rows[4][0] 同 | ✅ |
| TOPIC_KEYWORDS 默认 5 词 | A6-A10 (seo/marketing/growth/content/keyword) | rows[5..9] 同 | ✅ |
| TOPIC_KEYWORDS 浅黄底 | A6:A25 `#f9fbe7` | `cellBackgrounds: A6:A25 #f9fbe7` | ✅ |
| NEGATIVE 标题 | A27 | rows[26][0] 同 | ✅ |
| NEGATIVE 默认 5 词 | A28-A32 (miami/dade/trimet/hub city/bus tracker) | rows[27..31] 同 | ✅ |
| NEGATIVE 红底标题 | A27 `#ffcdd2`, A28:A45 `#fff5f5` | `cellBackgrounds` 全对 | ✅ |
| A4/A6/A28 列注释 | hover note | `extras.notes` 3 条 | ✅ |

公式列 K2/O2 都引用 `'配置'!$A$6:$A$25` 和 `$A$28:$A$45`，区域命名稳定。

---

## 四、关键词主表 公式逐列校验（J/K/L/M/N/O/R/S/U/X）

| 列 | Spec | Spec lib `MASTER_FORMULAS` | 一致 |
|---|---|---|---|
| J (DR差值) | `=IF(OR(G2="",I2=""),"待填",G2-I2)` | 同 | ✅ |
| K (G1话题相关) | `SUMPRODUCT((CFG!$A$6:$A$25<>"")*ISNUMBER(SEARCH(...)))` 修空格 bug | 同 | ✅ |
| L (G2可承接) | 手填，下拉 Y/N | `dataValidations L2:L1500` | ✅（无公式） |
| M (意图) | Commercial > Transactional > Problem-aware > Informational | 同（180 字符长公式 1:1） | ✅ |
| N (DR过滤) | `IF(J2="待填"...J2>30,"❌跳过","✅通过")` | 同 | ✅ |
| O (分桶_自动) | v3.0 NEGATIVE 否决 + 5 桶优先级 | 同（含 `$A$28:$A$45` 否决） | ✅ |
| R (分桶最终) | `IF(P2<>"",P2&"★",O2)` | 同 | ✅ |
| S (AIO预判) | `C2>=500 + 定义型词 → ⚠️疑似高风险` | 同 | ✅ |
| U (弱度意图分) | `H弱度(1-3) + M意图(0-1)` | 同 | ✅ |
| X (备注) | 手填 | 无公式 | ✅ |

10/10 公式列 1:1 复刻。Fill-down 范围 row 1500（spec 500，扩容）。

---

## 五、Data Validation（下拉）逐表校验

| Sheet | Spec dropdowns | Boot dropdowns | Match |
|---|---|---|---|
| 关键词主表 | B/H/L/P/T/V (6) | 6 | ✅ |
| 主题集群表 | C/D/I/O/P/Q/R (7) | 7 | ✅ |
| 选题登记表 | E/F/G/M/R/T (6) | 6 | ✅ |
| CTA Map | B/F (2) | 2 | ✅ |
| 结果复盘表 | E/K (2) | 2 | ✅ |

枚举值（'量产线/精修线' / 'P0/P1/P2' / 'Pillar/Series/Support/Tool/Wiki/Strategic' 等）逐项校对一致。

---

## 六、Conditional Formatting 校验（仅关键词主表）

| Spec 规则 | Boot 规则 | Match |
|---|---|---|
| R 列 6 桶颜色（趋势/快速胜利★/快速胜利/战略/长尾/跳过） | 同 6 条 | ✅ |
| O 列 4 个 emoji 浅色 | 同 4 条 | ✅ |
| P 列非空黄底加粗 | 同 | ✅ |
| H 列 ✅弱/⚠️中/❌强 三色 | 同 3 条 | ✅ |
| S 列 "疑似高风险" 橙底 | 同 | ✅ |

14 条规则全部存在。

---

## 七、Gap 优先级

### P0 — sheet unusable without it
**无。** 所有数据流（公式、下拉、条件格式、表头颜色、列注释）都已实现。

### P1 — 功能性次要 gap
1. **配置 `headerColors` 字段名拼写错位**
   - 现象：spec lib 写 `headerColors: { 1: 'header', 2: 'header' }`，但 `buildHeaderFormatRequests` 只识别 `headerColorByCol`。
   - 影响：A1/B1 不会上深灰底（标题行无背景色）。
   - Fix hint: 把 spec lib 第 65 行 `headerColors` 改成 `headerColorByCol`（一行 rename）。
2. **4 个视图 tab 的 `_styleViewSheet` 装饰未实现**
   - 现象：spec 在 row1 插说明行、row2 染深灰表头、freeze 2 行；bootstrap 直接把公式写到 A1。
   - 影响：视图能用，但缺顶部说明文字和视觉表头。
   - Fix hint: 在 `view` 分支补一个 `insertDimension` + 写 note row + freeze 2 行（bootstrap line 480-486 已有 TODO）。
3. **view 表的 `headerColor` 和 `note` 字段未消费**
   - 现象：spec lib 358-361 行给每个 view 配了 `headerColor` 和 `note`，但 builder 完全不读。
   - 修法跟 #2 一并做即可。

### P2 — 纯 cosmetic
1. **内容追踪 / 来源分析 列宽过设**
   - .gs 只 setColumnWidth 2 列（其他用默认），mjs 把所有列都设了固定宽。
   - 视觉差异，不影响功能；不修。
2. **fill-down 行数 1500 vs spec 500**
   - 主动扩容，更利于大批量 mine；不视为 gap。

---

## 八、需要修复的 P0 数

**P0 = 0**

`docs/KEYWORD_MINE_AUDIT.md §三` 的 11 项 ❌ gap 已全部解决。该段需标记为「已作废，见本文件」。

---

## 九、Spec 模糊点

无。`.gs` 是单文件、纯 Apps Script API 调用、无 includes / 无宏，全部可静态解析。

