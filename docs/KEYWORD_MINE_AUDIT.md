---
title: 关键词模块 mine 选词逻辑审计报告
date: 2026-05-23
type: audit
status: live
upstream: spec/upstream-canon/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md
---

# 关键词模块 mine 选词逻辑审计

**审计基准（SSOT）：**
- `spec/upstream-canon/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md` (PRD v0.7 final)
- `spec/upstream-canon/keyword-research-sop.md` (SOP v2.5)
- `spec/upstream-canon/keyword-research-overview.md` (overview v0.4)
- `spec/upstream-canon/keyword-sheet-setup.gs` (.gs v3.1 — 13 张工作表权威 schema)

**审计对象：**
- `tools/scripts/gg-keyword-mine.mjs` (v0.2)
- `tools/scripts/gg-keyword-promote.mjs`
- `tools/scripts/gg-keyword-fallback.mjs`
- `tools/scripts/_bootstrap-flow-mvp-workbook.mjs`

---

## 一、与需求匹配度总览

| 维度 | 需求来源 | 实现状态 | 严重性 |
|---|---|---|---|
| 六源挖掘（竞品/缺口/种子/社区/趋势/Social）| SOP §一 | ⚠️ 部分 — 只覆盖 "种子（mine）" + "社区（fallback Reddit）" | 中 |
| 四桶分级（趋势/快速胜利/长尾/战略）| SOP §二 | ❌ 不在脚本侧实现 — 全部依赖 sheet 公式（合理设计）| — |
| DR 差距过滤（≤30）| SOP §二第一关 | ❌ mine 不算 DR，sheet G/I 列人工填 | — |
| KD 过滤 | SOP §二 | ✅ mine `--max-kd` flag | — |
| Volume 过滤 | SOP §二 | ✅ mine `--min-volume` flag | — |
| NEGATIVE_KEYWORDS 否决 | PRD §7.3.2 修法 #1 + .gs v3.1 line 97-108 | ⚠️ mine 实现了 `isNegativeMatch` 但只读 CLI/env，**不读 sheet ⚙️配置区** | 高 |
| 种子词不可用单个多义词 | SOP v2.4 §三 + PRD §7.3.2 修法 #3 | ❌ mine 完全未校验；CLI 接受任何 string | 中 |
| AIO 风险预判（vol≥500 + what is/meaning/definition...）| SOP §二第三关 + .gs v3.1 line 250-254 | ✅ mine `isAioHighRisk` 实现正确，写 `ai_recommend` 列 | — |
| GEO 评分（用于 fallback/mine 内部排序）| 自创（不在 SOP）| ✅ mine + fallback 共用 `computeGeo`，公式一致 | — |
| 目标国家 Day-0 参数 | PRD §3.3 + SOP v2.4 + .gs v3.1 B4 | ⚠️ mine hardcode 2840 (US) 可用；但**不从 sheet ⚙️配置 B4 读** | 中 |
| 写入主表只碰 A-I（公式列 J-X 不动）| SOP §六 + .gs v3.1 | ✅ promote 严格 `关键词主表!A:I` 范围；mine 副表写 A:K | — |
| 选题登记表 21 列（v2.1 = v2.0 15 列 + 新 6 列）| PRD 附录 C | ✅ bootstrap 列结构正确；promote 只写 A 列（target_keyword）| — |

---

## 二、关键 gap（按 PRD v0.7 §7.3.2 五项修法对账）

### 修法 #1 — `.gs` 加 NEGATIVE_KEYWORDS 配置区 + O 列前置否决

**PRD 要求：**
> 关键词包含 `miami / dade / bus tracker / hub city / trimet` 等任意负向词 → 直接 `❌跳过`，不进任何桶。

**实现状态：**
| 子任务 | 实现 | 状态 |
|---|---|---|
| `.gs` 模板 ⚙️配置 A28:A45 NEGATIVE_KEYWORDS 区 | wiki `.gs v3.1` 已实现 | ✅（上游）|
| 关键词主表 O 列前置 SUMPRODUCT(SEARCH(...)) 否决 | wiki `.gs v3.1` 已实现 | ✅（上游）|
| **本地 sheet 同步该 schema** | `_bootstrap-flow-mvp-workbook.mjs` 创建的"关键词主表"是占位列名，**没有真公式**| ❌ |
| mine 脚本本地 negative 二次过滤 | `gg-keyword-mine.mjs` `isNegativeMatch` | ⚠️ 实现了，但只读 CLI/env |
| mine 脚本从 sheet ⚙️配置 A28:A45 拉负向词 | — | ❌ 未实现 |

**影响：** 跑 `gg-keyword-mine` 时如果不显式传 `--negatives` 或设 `GG_NEGATIVE_KEYWORDS` env，垃圾词照样进 keyword_candidates 副表。SOP 的"一劳永逸"承诺打折。

**修法：**
1. 重写 `_bootstrap-flow-mvp-workbook.mjs`，按 `.gs v3.1` 1:1 复刻 13 张工作表（含公式）
2. 修改 `gg-keyword-mine.mjs` `parseNegatives()`，加一步从 sheet ⚙️配置 A28:A45 读取，与 CLI/env 合并去重

---

### 修法 #2 — K 列子串匹配改词边界匹配（可选）

**PRD 要求：** 减少 G1 话题相关误判（如 `transit chart` 这种合法多义被混入垃圾词）。

**实现状态：**
- wiki `.gs v3.1` 中 K 列空配置格 bug 已修复（line 9-15 changelog），词边界匹配未实现（PRD 标可选）
- 本地 sheet 没有 K 列公式（占位列名错）

**优先级：** 低（修法 #1 + #4 已能拦住 99% 垃圾）

---

### 修法 #3 — 种子词纪律：禁止用单个多义词做种子

**PRD 要求：**
> SOP §三已说种子词"不能过大"，`transit` 太泛，应该用 `transit chart` / `astrological transit`。

**实现状态：**
- ❌ `gg-keyword-mine.mjs` 完全无种子词校验
- ❌ 没有"多义词黑名单"或"种子词需 ≥ 2 个 token"等启发式

**修法：**

```javascript
// gg-keyword-mine.mjs 应加：
const SUSPICIOUS_SINGLE_TERMS = new Set([
  'transit',     // 占星过境 vs 公交
  'cycle',       // 占星周期 vs 自行车
  'house',       // 占星宫位 vs 房屋
  'mercury',     // 占星水星 vs 化学元素
  // 由 PRD/SOP 维护
]);

export function validateSeed(seed) {
  const lc = seed.trim().toLowerCase();
  const tokens = lc.split(/\s+/);
  if (tokens.length === 1 && SUSPICIOUS_SINGLE_TERMS.has(tokens[0])) {
    return { ok: false, warning: `single-term seed "${seed}" is multi-meaning; use "${seed} chart" or similar` };
  }
  return { ok: true };
}
```

打到 console.warn 即可（不阻塞），让操作者意识到风险。

---

### 修法 #4 — 集群生成只喂 R=快速胜利/长尾词的行

**PRD 要求：**
> cluster doc 是 LLM 从关键词列表自动生成的，没读 R 列分桶。要求：集群生成只喂 R 列 = 快速胜利 / 长尾词 的行。

**实现状态：**
- ❌ 集群生成脚本本仓库未建（应在 `tools/scripts/gg-cluster-init.mjs` 或类似）
- 老 sheet 主题集群表只有 1 行（手填）

**修法：** 新建 `tools/scripts/gg-cluster-init.mjs`：
1. 读关键词主表 R 列 = 快速胜利 / 长尾词 的行
2. 按 entity / token 相似度聚类（先简单 jaccard，后续可换 embedding）
3. 写入主题集群表 cluster_id / cluster_name / primary_entity / keywords_included 列
4. wzb 在 sheet 补 track / us_share / content_angle / pillar_page 等人工字段

优先级：高（PRD §2.3 "执行单位 = 主题集群"，目前没有自动化）

---

### 修法 #5 — 一次性人工扫桶

**PRD 要求：** 对 ⚡快速胜利桶做一次 30 分钟人工扫一遍。

**实现状态：** 这是人工动作，不写在脚本里。但脚本可以 **flag 嫌疑词**：

修改 mine：在 `ai_recommend` 列写入 emoji 提示，让 wzb 扫桶时优先看：
- `⚠️ kd-volume-conflict`：KD 极低但 volume 极高 → 嫌疑词（一般这种"免费午餐"不存在）
- `⚠️ multi-token-mismatch`：与 entity 字符串无重叠 → 嫌疑词
- `⚠️ AIO`：已实现

**优先级：** 中（5 分钟改 mine.mjs）

---

## 三、bootstrap sheet vs 附录 D 规格 gap 详表

附录 D 要求 13 张工作表；当前 bootstrap 只建了 11 张占位 tab。逐项对比：

| Tab | 附录 D / .gs v3.1 规格 | 本地 bootstrap 实现 | gap |
|---|---|---|---|
| ⚙️配置 | 客户产品名 / 实验开始日期 / 目标国家 / TOPIC_KEYWORDS (A6:A25) / NEGATIVE_KEYWORDS (A28:A45) | ❌ 未建 | **整张表缺失** |
| 关键词主表 | A–X 24 列含 J/K/M/N/O/R/S/U **公式列** | ⚠️ 24 个占位列名，**无公式**（J=DR差值名字对，但 K/L/M 等列名全错）| **公式全缺失，列名错乱** |
| 主题集群表 | 19 列（含 us_share 三档）+ 表头颜色注释 | ✅ 20 列接近正确（多 child_entities）| 无大问题 |
| 选题登记表 | 21 列（v2.0 15 + 新 6）+ 注释 | ✅ 21 列正确 | 无 |
| CTA Map | 6 列 | ✅ 正确 | 无 |
| 结果复盘表 | outcome_id / Day 14·30·60 / GSC粘贴区 / GA4粘贴区 | ❌ 未建 | **整张表缺失** |
| 🚀趋势词 | 视图（VLOOKUP 主表筛分桶= 趋势词）| ❌ 未建 | 视图缺失 |
| ⚡快速胜利 | 同上 | ❌ 未建 | 视图缺失 |
| 🎯战略词 | 同上 | ❌ 未建 | 视图缺失 |
| 📌长尾词 | 同上 | ❌ 未建 | 视图缺失 |
| 📋分桶规则 | 文档表 — 列各桶规则 | ❌ 未建 | 文档缺失 |
| 📊内容追踪 | 已发布 URL + GSC 关键词 | ❌ 未建 | 缺失 |
| 📈来源分析 | 各来源命中率统计 | ❌ 未建 | 缺失 |
| keyword_candidates | 11 列副表 | ✅ 正确 | 无 |
| pipeline-status / publish-log / quality-metrics / cost-tracking / config（项目运维表）| 不在 .gs v3.1 范围 | ✅ 自建 | OK，gg-status 用 |
| README | 不在 .gs v3.1 范围 | ✅ 自建 | OK |

**结论：当前 bootstrap 不符合 PRD v0.7 附录 D 规格。最小修复 = 重写 bootstrap 1:1 复刻 .gs v3.1 + 保留我们自建的项目运维表。**

---

## 四、mine.mjs 写入通道错配

**问题：** `gg-keyword-mine.mjs` 默认写 `GG_SHEETS_WORKBOOK_ID`（老 sheet），不是新 sheet `GG_SHEETS_FLOW_MVP_WORKBOOK_ID`。

```javascript
// gg-keyword-mine.mjs:413
const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
```

**修法：** 加 `--workbook flow-mvp|legacy|<id>` flag，默认指向 flow-mvp。或者直接改默认为 `GG_SHEETS_FLOW_MVP_WORKBOOK_ID`，老 sheet 仅在 `--workbook legacy` 时用。

---

## 五、迁移老 sheet 数据到新 sheet 的方案

老 sheet 数据规模：
- 关键词主表 590 行（含 header → 589 关键词，全部由历史 mine + Lynne 手填）
- 选题登记表 301 行
- 主题集群表 1 行（基本空，PRD v0.7 §3.3 是新设计，需重做集群）
- CTA Map 1 行（基本空）
- keyword_candidates 15 行

**建议迁移策略：**

| Tab | 是否迁移 | 理由 |
|---|---|---|
| 关键词主表 590 词 | ✅ 全量迁移（仅 A-I + R/T/V/W/X 9 列，公式列由新 sheet 重算）| 历史劳动成果，含 Lynne 实测的 SERP 弱度/Top10 DR |
| 选题登记表 301 行 | ✅ 全量迁移 | 包含已发布的 6 篇 aura + 在产的批次 |
| keyword_candidates 15 行 | ⚠️ 选择性迁移：wzb_approve=Y 但未 promote 的迁过去 | 大部分已 promote 进主表，不必重复 |
| 主题集群表 1 行 | ❌ 不迁移 | 老的 1 行是占位测试，按 PRD v0.7 §3.3 重做 |
| CTA Map 1 行 | ❌ 不迁移 | 同上 |

**执行脚本：** 新建 `tools/scripts/_migrate-legacy-to-flow-mvp.mjs`：
```bash
node tools/scripts/_migrate-legacy-to-flow-mvp.mjs \
  --tabs "关键词主表,选题登记表,keyword_candidates" \
  --filter-approved-only   # 仅对 keyword_candidates 生效
```

---

## 六、优先级总结（建议落地顺序）

| # | 动作 | 工作量 | 优先级 |
|---|---|---|---|
| 1 | 重写 `_bootstrap-flow-mvp-workbook.mjs` 按 `.gs v3.1` 复刻 13 张工作表 | 4-6h | **P0** |
| 2 | 修 `gg-keyword-mine.mjs`：默认写 flow-mvp sheet + 从 ⚙️配置 A28:A45 拉负向词 | 1h | **P0** |
| 3 | 新建 `_migrate-legacy-to-flow-mvp.mjs` 迁移 590 词 + 301 选题 | 2h | **P0** |
| 4 | 加 mine 种子词校验（SUSPICIOUS_SINGLE_TERMS 警告）| 30min | P1 |
| 5 | 加 mine 嫌疑词 flag（kd-vol-conflict / multi-token-mismatch）| 30min | P1 |
| 6 | 新建 `gg-cluster-init.mjs`（修法 #4）| 4h | **P0**（PRD 核心：cluster 是执行单位）|
| 7 | 写 `_sync-canon.sh`（保持 upstream-canon 与 wiki 同步）| 30min | P2 |

**总工时：约 12-14h。**
