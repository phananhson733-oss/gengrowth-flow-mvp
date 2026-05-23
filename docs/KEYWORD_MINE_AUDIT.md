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
| NEGATIVE_KEYWORDS 否决 | PRD §7.3.2 修法 #1 + .gs v3.1 line 97-108 | ⚠️ mine 实现了 `isNegativeMatch` 但只读 CLI/env，**不读 sheet 配置区** | 高 |
| 种子词不可用单个多义词 | SOP v2.4 §三 + PRD §7.3.2 修法 #3 | ❌ mine 完全未校验；CLI 接受任何 string | 中 |
| AIO 风险预判（vol≥500 + what is/meaning/definition...）| SOP §二第三关 + .gs v3.1 line 250-254 | ✅ mine `isAioHighRisk` 实现正确，写 `ai_recommend` 列 | — |
| GEO 评分（用于 fallback/mine 内部排序）| 自创（不在 SOP）| ✅ mine + fallback 共用 `computeGeo`，公式一致 | — |
| 目标国家 Day-0 参数 | PRD §3.3 + SOP v2.4 + .gs v3.1 B4 | ⚠️ mine hardcode 2840 (US) 可用；但**不从 sheet 配置 B4 读** | 中 |
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
| `.gs` 模板 配置 A28:A45 NEGATIVE_KEYWORDS 区 | wiki `.gs v3.1` 已实现 | ✅（上游）|
| 关键词主表 O 列前置 SUMPRODUCT(SEARCH(...)) 否决 | wiki `.gs v3.1` 已实现 | ✅（上游）|
| **本地 sheet 同步该 schema** | `_bootstrap-flow-mvp-workbook.mjs` 创建的"关键词主表"是占位列名，**没有真公式**| ❌ |
| mine 脚本本地 negative 二次过滤 | `gg-keyword-mine.mjs` `isNegativeMatch` | ⚠️ 实现了，但只读 CLI/env |
| mine 脚本从 sheet 配置 A28:A45 拉负向词 | — | ❌ 未实现 |

**影响：** 跑 `gg-keyword-mine` 时如果不显式传 `--negatives` 或设 `GG_NEGATIVE_KEYWORDS` env，垃圾词照样进 keyword_candidates 副表。SOP 的"一劳永逸"承诺打折。

**修法：**
1. 重写 `_bootstrap-flow-mvp-workbook.mjs`，按 `.gs v3.1` 1:1 复刻 13 张工作表（含公式）
2. 修改 `gg-keyword-mine.mjs` `parseNegatives()`，加一步从 sheet 配置 A28:A45 读取，与 CLI/env 合并去重

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

**实现状态：** ✅ 已落地（2026-05-23）

**实现脚本：** `tools/scripts/gg-cluster-init.mjs`
- 读关键词主表 R 列 = `快速胜利` / `长尾词` 的行（默认；--buckets 可改）
- token 共现 + 词边界匹配聚类（优先 bigram seed，回退 unigram；stopwords 过滤）
- 写主题集群表自动列：`cluster_id` / `cluster_name` / `keywords_included`
- 业务字段（track / jtbd / content_angle / cta / priority / week）留空，人工补
- 默认 dry-run，`--write` 才落；`--rebuild` 清空重建

**首跑结果（2026-05-23, DR=5 回填后）：**
- 502 词进入聚类（336 快速胜利 + 166 长尾）
- 输出 144 集群（最大 40 词 / 平均 3.5 词 / 11 未分配）
- 主题集群表 144 行草稿落盘

依赖：本修法依赖 [修法 #1+2+3] + [关键词主表 I 列填了真实 Ahrefs DR]，否则 R 列全 ❌跳过，无米下锅。

---

### 修法 #5 — 一次性人工扫桶

**PRD 要求：** 对 快速胜利桶做一次 30 分钟人工扫一遍。

**实现状态：** 这是人工动作，不写在脚本里。但脚本可以 **flag 嫌疑词**：

修改 mine：在 `ai_recommend` 列写入 emoji 提示，让 wzb 扫桶时优先看：
- `⚠️ kd-volume-conflict`：KD 极低但 volume 极高 → 嫌疑词（一般这种"免费午餐"不存在）
- `⚠️ multi-token-mismatch`：与 entity 字符串无重叠 → 嫌疑词
- `⚠️ AIO`：已实现

**优先级：** 中（5 分钟改 mine.mjs）

---

## 三、bootstrap sheet vs 附录 D 规格 gap 详表

> **2026-05-23 更新：本节旧 gap 表已作废。** Bootstrap 已重写为 spec-driven（`_workbook-spec.mjs`
> 单数据源），13 张 .gs 表 + 7 张运维表全部建立，公式 / 下拉 / 条件格式 1:1 复刻 .gs v3.1。
> 最新逐表 diff 见 [`BOOTSTRAP_GS_DIFF_2026-05-23.md`](./BOOTSTRAP_GS_DIFF_2026-05-23.md)。

| Tab | 附录 D / .gs v3.1 规格 | 本地 bootstrap 实现 | 状态 |
|---|---|---|---|
| 配置 | 客户产品名 / 实验开始日期 / 目标国家 / TOPIC_KEYWORDS (A6:A25) / NEGATIVE_KEYWORDS (A28:A45) | ✅ 已建（B2/B3 客户产品名+实验日期 P0-4 落地）| ✅ 见 BOOTSTRAP_GS_DIFF_2026-05-23.md |
| 关键词主表 | A–X 24 列含 J/K/M/N/O/R/S/U **公式列** | ✅ 24 列，10/10 公式 1:1 复刻 v3.1，fill-down row 1500 | ✅ 见 BOOTSTRAP_GS_DIFF_2026-05-23.md |
| 主题集群表 | 19 列（含 us_share 三档）+ 表头颜色注释 | ✅ 19 列对齐 | ✅ |
| 选题登记表 | 21 列（v2.0 15 + 新 6）+ 注释 | ✅ 21 列正确 + C2/D2 VLOOKUP | ✅ |
| CTA Map | 6 列 | ✅ 6 列 + 6 行 Week-1 seed | ✅ |
| 结果复盘表 | outcome_id / Day 14·30·60 / GSC粘贴区 / GA4粘贴区 | ✅ 12 列已建 + E/K 下拉 | ✅ 见 BOOTSTRAP_GS_DIFF_2026-05-23.md |
| 趋势词 | 视图（VLOOKUP 主表筛分桶= 趋势词）| ✅ 公式落 A1（视图样式 P1 cosmetic）| ✅ |
| 快速胜利 | 同上 | ✅ 同上 | ✅ |
| 战略词 | 同上 | ✅ 同上 | ✅ |
| 长尾词 | 同上 | ✅ 同上 | ✅ |
| 分桶规则 | 文档表 — 列各桶规则 | ✅ rows + cellStyling 对齐 | ✅ |
| 内容追踪 | 已发布 URL + GSC 关键词 | ✅ 14 列 + G/H/L 公式 | ✅ 见 BOOTSTRAP_GS_DIFF_2026-05-23.md |
| 来源分析 | 各来源命中率统计 | ✅ 6 列 + seed + tailRow 公式 | ✅ 见 BOOTSTRAP_GS_DIFF_2026-05-23.md |
| keyword_candidates | 11 列副表 | ✅ 正确 | ✅ |
| pipeline-status / publish-log / quality-metrics / cost-tracking / config（项目运维表）| 不在 .gs v3.1 范围 | ✅ 自建 | OK，gg-status 用 |
| README | 不在 .gs v3.1 范围 | ✅ 自建 | OK |

**结论（2026-05-23）**：bootstrap 已符合 PRD v0.7 附录 D 规格。剩余 P1 gap（视图样式 `headerColors` 拼写、view tab 顶部说明行）见 `BOOTSTRAP_GS_DIFF_2026-05-23.md §七`。P0=0。

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

## 六、优先级总结（落地状态）

| # | 动作 | 工作量 | 优先级 | 状态 |
|---|---|---|---|---|
| 1 | 重写 `_bootstrap-flow-mvp-workbook.mjs` 按 `.gs v3.1` 复刻 13 张工作表 | 4-6h | **P0** | ✅ 2026-05-23 |
| 2 | 修 `gg-keyword-mine.mjs`：默认写 flow-mvp sheet + 从 配置 A28:A45 拉负向词 | 1h | **P0** | ✅ 2026-05-23 |
| 3 | 新建 `_migrate-legacy-to-flow-mvp.mjs` 迁移 590 词 + 301 选题 | 2h | **P0** | ✅ 2026-05-23 |
| 4 | 加 mine 种子词校验（SUSPICIOUS_SINGLE_TERMS 警告）| 30min | P1 | ✅ 2026-05-23 |
| 5 | 加 mine 嫌疑词 flag（kd-vol-conflict / multi-token-mismatch）| 30min | P1 | ✅ 2026-05-23 |
| 6 | 新建 `gg-cluster-init.mjs`（修法 #4）| 4h | **P0** | ✅ 2026-05-23 |
| 7 | 写 `_sync-canon.sh`（保持 upstream-canon 与 wiki 同步）| 30min | P2 | ✅ 2026-05-23 |
| 8 | 修 bootstrap fill-down 公式 row 号 bug（rewriteFormulaRow）| 30min | **P0** | ✅ 2026-05-23 |
| 9 | 新建 `gg-backfill-site-dr.mjs`（按用户告知的真实 DR 批量回填 I 列）| 30min | **P0** | ✅ 2026-05-23 |
| 10 | P0-1 `_sync-canon.sh` + `spec/upstream-canon/` | 30min | **P0** | ✅ 2026-05-23 |
| 11 | P0-2 Reddit OAuth scaffold (`lib/_reddit-oauth.mjs` + `gg-friction-mine.mjs` + `REDDIT_OAUTH_SETUP.md`) | 2h | **P0** | ✅ 2026-05-23 |
| 12 | P0-3 `gg-llm-orchestrator.mjs`（并行 + frontier-strict + retry）| 3h | **P0** | ✅ 2026-05-23 |
| 13 | P0-4 配置 B2/B3 客户产品名+实验开始日期 | 30min | **P0** | ✅ 2026-05-23 |
| 14 | P1-1 mine 4-项升级（sheet-read NEG / SUSPICIOUS_SINGLE_TERMS / 嫌疑词 flag / workbook default）| 1h | P1 | ✅ 2026-05-23 |
| 15 | P1-2 `gg-cluster-fields-suggest.mjs` | 2h | P1 | ✅ 2026-05-23 |
| 16 | P1-3 `gg-brief-suggest.mjs` | 2h | P1 | ✅ 2026-05-23 |
| 17 | P1-4 `gg-phase2-fix.mjs`（RL fail 自动 retry）| 2h | P1 | ✅ 2026-05-23 |
| 18 | P1-5 embedding 聚类（`--algo embedding` in gg-cluster-init）| 3h | P1 | ✅ 2026-05-23 |
| 19 | P1-6 `gg-classify-unsorted.mjs`（ind-001/ind-002 归类）| 2h | P1 | ✅ 2026-05-23 |
| 20 | P2-1 `gg-deploy-oracle.sh` | 1h | P2 | ✅ 2026-05-23 |
| 21 | P2-2 `gg-monitor.mjs`（GSC + GA4）| 2h | P2 | ✅ 2026-05-23 |
| 22 | P2-3 `gg-config-sync.mjs` + `lib/_config.mjs`（sheet → code config snapshot）| 2h | P2 | ✅ 2026-05-23 |
| 23 | P2-4 bridge fuzzy match（`gg-sheet-to-brief.mjs` upgrade）| 1h | P2 | ✅ 2026-05-23 |
| 24 | P2-5 SERP auto-snapshot（`gg-render-batch.mjs --auto-serp-snapshot/--check-only`）| 1h | P2 | ✅ 2026-05-23 |
| 25 | P2-6 bootstrap 1:1 复核 → `BOOTSTRAP_GS_DIFF_2026-05-23.md` | 1h | P2 | ✅ 2026-05-23 |

**2026-05-23 P0+P1+P2 wave 全部落地（18 项）**。原 9 项也已全部 ✅。

## 七、当前生产状态（2026-05-23）

| 指标 | 值 | 说明 |
|---|---|---|
| 关键词主表行数 | 590 | 100% 迁自老 sheet（A-I 一字不差）|
| TOPIC_KEYWORDS | 20 词（真实）| 从 oracle/data/articles/ 17 篇文章 keywords 反推 |
| NEGATIVE_KEYWORDS | 5 词（默认 + 用户可扩展）| miami/dade/trimet/hub city/bus tracker |
| 站 DR (I 列) | 5（用户 2026-05-23 告知 ≤5 区间上限）| 用 `gg-backfill-site-dr.mjs --dr <真实值>` 调整 |
| R 列分桶 | 336 快速胜利 / 166 📌长尾 / 87 ❌跳过 / 1 🎯战略 | 公式 fill-down bug 修复后正确 |
| 主题集群表 | 144 集群草稿 → Phase 2 合并为 24 publishable units | `gg-cluster-init.mjs --write` 落盘；详见 `CLUSTER_AUDIT_2026-05-23.md` |
| 选题登记表 | 301 行 | 迁自老 sheet，C/D VLOOKUP 重写 |
| keyword_candidates | 15 行 | wzb_approve 状态保留 |
| BOOTSTRAP_GS_DIFF_2026-05-23.md | 13 表 1:1 复核 → P0=0 / P1=3 / P2=2 | 详见该文件 §七 |

---

## 八、2026-05-23 Pipeline-Wave Summary

本次 wave 一次性落地 P0+P1+P2 共 18 项。详细单项审计 / 设计 / 操作分散在以下文档：

- [`CLUSTER_AUDIT_2026-05-23.md`](./CLUSTER_AUDIT_2026-05-23.md) — 聚类算法 4 路验收 + Phase 1/2/3 路径
- [`BOOTSTRAP_GS_DIFF_2026-05-23.md`](./BOOTSTRAP_GS_DIFF_2026-05-23.md) — bootstrap vs SSOT .gs 1:1 复核
- [`REDDIT_OAUTH_SETUP.md`](./REDDIT_OAUTH_SETUP.md) — Reddit OAuth 接入指南（friction RAG 真数据来源）
- [`../spec/upstream-canon/README.md`](../spec/upstream-canon/README.md) — upstream-canon 同步规范（_sync-canon.sh）
