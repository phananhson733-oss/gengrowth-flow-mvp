---
title: Sheet schema v2.1 对齐 checklist — wzb x Lynne
date: 2026-05-21
type: alignment-checklist
audience: wzb + Lynne
status: draft-for-discussion
canonical_upstream:
  - docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md
  - docs/03-marketing/03-seo/keyword-research-sop.md
  - docs/03-marketing/03-seo/keyword-sheet-setup.gs
tags:
  - gengrowth
  - mvp
  - sheet-schema
  - alignment
---

# Sheet schema v2.1 对齐 checklist — wzb x Lynne

> [!info] 用法
> 30 分钟同步会用。每节有「Lynne 决策」打勾框，会上拍齐 §9 决策汇总 5 项即可动起来。
> 本文不重申 spec 内容，只列「漂移点 + 决策点」。完整 spec 见 frontmatter 里的 canonical_upstream。

---

## §1 背景

`tools/scripts/gg-content-draft.mjs` 工具已 ship，schema 严格按 canonical 三件套（PRD v0.7 / SOP v2.5 / `keyword-sheet-setup.gs` v3.1）实现。问题：**真实 Sheet 跑不起来**，因为 Lynne 已经手填了 291 行旧数据，字段值口径跟 spec 不一致。

具体表现：拉一行真实数据进工具会被字段值校验拦掉（Tier / Status / Template 值不在白名单），核心外键 `page_id` / `cluster_id` 全部空着，无法走 6-ID 体系下的 dry-run。

这次同步要解决的不是"谁对谁错"——canonical spec 是 Lynne 自己定的，Sheet 现状也是 Lynne 自己手填的，**两个 Lynne 之间需要拍板谁服从谁**。wzb 把候选方案 + 时间预估列在下面，Lynne 30 min 内拍齐就可以动起来。

---

## §2 4 处漂移 — 实测对照

实测 2026-05-21，源：`选题登记表` 291 行。

| # | 漂移点 | spec 期望 | Sheet 实际 | Lynne 决策（选 1） |
|---|---|---|---|---|
| 1 | Tier 列值 | `T1` / `T2` / `T3` | `Tier 1 (重装)` / `Tier 2 (标准)`（带括号说明，无 T3） | ☐ Sheet 改成 T1/T2/T3<br>☐ spec + 工具加 alias 接受现值 |
| 2 | Status 列值 | `待写` / `写作中` / `质检` / `已发布` / `已刷新`（5 态） | `初稿` / `质检`（2 态） | ☐ Sheet 补齐 5 态<br>☐ 工具加 alias 映射现值（详见 §5） |
| 3 | Template 列值 | `Tutorial` / `Definition` / `Comparison` / `Programmatic` / `Case Study`（5 种） | `Tutorial` / `Definition` / `Case Study`（缺 Comparison + Programmatic） | ☐ 补齐 5 种<br>☐ MVP 砍到 3 种（spec 同步降级） |
| 4 | page_id / cluster_id 列 | 必填外键 | 291 行 **0 填** | ☐ 立即回填（详见 §3 + §4）<br>☐ 工具放宽允许空值（MVP 妥协） |

> [!warning] 4 处漂移里，第 4 项最重要
> Tier / Status / Template 是字段值口径问题，工具加 alias 半小时能搞定。但 `page_id` / `cluster_id` 是 6-ID 体系的主键，**0 填等于整套 6-ID 没落地**。必须当面拍板命名规则，见 §3 / §4。

---

## §3 page_id 命名规范决策（最重要 ⭐）

PRD v0.7 / SOP v2.5 / `keyword-sheet-setup.gs` 都没硬性定义 `page_id` 命名 convention。工具实现用了白名单 regex `^[A-Za-z0-9_-]{1,64}$`，但具体怎么命名留给业务方拍板。

### 3 个候选 convention

#### A. 关键词 slug 模式 ⭐ wzb 推荐

格式：`page_<keyword_slug>`
例：
- `page_blue_aura_meaning`
- `page_what_is_chiron`
- `page_chiron_7th_house`（**这条跟 `keyword-sheet-setup.gs` line 441 的官方示例完全一致**）

| 维度 | 评分 |
|---|---|
| ✅ 直觉好记，看 ID 就知道页面写什么 |  |
| ✅ 跟 URL slug 同构，发布后改一处同步两处 |  |
| ✅ 跟 .gs 注释里的官方示例一致（背书） |  |
| ❌ 关键词改了要 rename，但 ID 改 = 所有外键追改 |  |

#### B. 集群 + 序号模式

格式：`<cluster_prefix>_<3位序号>`
例：
- `aura_001` / `aura_002` / `aura_003`
- `chiron_001` / `chiron_002`

| 维度 | 评分 |
|---|---|
| ✅ 完全稳定，关键词改了 ID 不动 |  |
| ✅ 序号天然有顺序，方便聚合统计 |  |
| ❌ 不直观，看 `aura_017` 不知道是什么 |  |
| ❌ 需要维护「集群 → 序号映射表」 |  |

#### C. UUID 短码

格式：`p_<6位 base36>`
例：
- `p_a7d3f2`
- `p_x9k2m4`

| 维度 | 评分 |
|---|---|
| ✅ 完全稳定 + 完全不跟 URL 耦合 |  |
| ✅ 不需要协调命名空间，并发安全 |  |
| ❌ 100% 不直观，必须查表 |  |
| ❌ 跟 .gs 注释里的官方示例风格不一致 |  |

### wzb 推荐 A，理由

1. `keyword-sheet-setup.gs` line 441 已经写了 `page_chiron_7th_house` 作为字段注释示例，**Lynne 自己写的 .gs 就在用 A**
2. 工具实现的 mock fixture 已经按 A 跑通了
3. 长尾矩阵下 95% 关键词命名稳定，rename 是低频事件

> [!tip] Lynne 决策
> ☐ A. slug 模式（wzb 推荐 + 跟 .gs 一致）
> ☐ B. 集群 + 序号
> ☐ C. UUID 短码

---

## §4 cluster_id 现状 — 同样的问题

`keyword-sheet-setup.gs` line 335-376 定义的「主题集群表」有 19 列 schema，但目前 **0 行数据**。`page_id` 的外键 `cluster_id` 因此也填不了。

`.gs` 官方注释示例：`clu_aura_colors`（line 364）。建议命名 convention 跟 §3 同构：`clu_<topic_slug>`。

### 启动路径决策

| 选项 | 说明 | 时间 |
|---|---|---|
| ☐ Lynne 先填核心 5 集群再让工具跑 | astrologywiki 的 P0：`clu_aura_colors` / `clu_chiron` / `clu_vedic_basics` / `clu_natal_chart` / `clu_retrograde` | Lynne 1-2 h |
| ☐ wzb 临时按 keyword brainstorm 填，事后 Lynne 调 | wzb 周末填，标 `draft-by-wzb`，Lynne 周一校对 | wzb 30 min + Lynne 30 min |
| ☐ MVP 阶段允许空 cluster_id（工具放行） | 跑得动，但 6-ID 体系名存实亡 | 0 h，但欠技术债 |

> [!tip] Lynne 决策
> ☐ Lynne 填核心 5 集群（最规范，但需要 1-2 h block）
> ☐ wzb 起草 Lynne 校对（最快出活）
> ☐ MVP 允许空（最快但欠债）

---

## §5 状态机映射 — 「初稿 / 质检」vs canonical 5 态

Lynne 在 Sheet 里实际只用了 `初稿` / `质检` 两个状态。canonical 工具白名单是 5 态。会上需要拍 1 种映射方案。

### 方案 P1：Sheet 服从 spec（补齐 5 态）

```
Lynne 改 Sheet                工具不动
─────────────────────────────────────
原「初稿」    → 拆成「待写」+「写作中」
原「质检」    → 保持
新增「已发布」「已刷新」
```

- ✅ 状态机完整，复盘表 / 内容追踪表能跑全流程
- ❌ 291 行需要回标，人工 2-3 h 或脚本 30 min

### 方案 P2：工具服从 Sheet（加 alias）⭐ wzb 推荐 MVP 阶段用

```
Sheet 现状                     工具内部映射
─────────────────────────────────────
（空白）         →    待写
初稿             →    写作中
质检             →    质检
（未来出现）已发布 →    已发布
（未来出现）已刷新 →    已刷新
```

- ✅ Sheet 0 改动，工具加 alias 30 min
- ✅ 后续 Lynne 想用「已发布」/「已刷新」时直接填，工具已经认
- ❌ 工具代码里多一层映射，长期来看是技术债

### 方案 P3：混合（推荐 ⭐⭐）

短期 P2 跑通 → 中期 Lynne 按 P1 渐进补齐 → 工具 alias 层加 deprecation warning，6 个月后移除。

> [!tip] Lynne 决策
> ☐ P1 — Sheet 一次性补齐（彻底）
> ☐ P2 — 工具加 alias（最快）
> ☐ P3 — 混合渐进（wzb 推荐）

---

## §6 第一次试跑的最小可行数据

为了 dry-run 走通 6-ID 体系，**至少需要 1 行完整数据**。候选：

### Candidate：选题登记表 row 5「blue aura meaning」

已有字段：
- ✅ `target_keyword`：blue aura meaning
- ✅ `Tier`：Tier 2 (标准) → 需 alias 映射成 `T2`
- ✅ `Template`：Definition
- ✅ `Status`：初稿 → 需 alias 映射成 `写作中`

缺字段（wzb 临时填 6 项）：
- ⏳ `page_id`：`page_blue_aura_meaning`（按 §3 方案 A）
- ⏳ `cluster_id`：`clu_aura_colors`（按 §4，wzb 起草）
- ⏳ `Friction`：从 friction-mine 工具 mock fixture 取
- ⏳ `Logic`：从 mock fixture 取
- ⏳ `Entity`：从 entity-passport mock 取
- ⏳ `CTA`：从 CTA Map mock 取

### 流程

1. wzb 周末按上面 6 项填 row 5（标 `tmp-by-wzb-2026-05-21`）
2. 跑 `tools/scripts/gg-content-draft.mjs --row=5 --dry-run`
3. Lynne 看输出 quality
4. 通过 → 把这套字段值作为「真规范」回填 spec；不通过 → 找 quality 卡点

> [!tip] Lynne 决策
> ☐ 同意「先跑通再规范」路径（wzb 周末填）
> ☐ 不同意，要先把规范定死再跑
> ☐ 用别的 row（指定：______）

---

## §7 时间预估（让 Lynne 看到代价）

| 任务 | 人工 | 脚本辅助 | 责任人 |
|---|---|---|---|
| Sheet 291 行 Tier 值标准化（`Tier 1 (重装)` → `T1`） | 2-3 h | 30 min（一次性 batch update） | wzb 写脚本 / Lynne 审 |
| Sheet 291 行 Status 补齐 5 态（按 §5 P1） | 2-3 h | 不适用（需人判断） | Lynne |
| Sheet 填 page_id（291 行，按 slug 规则） | 4-6 h | 1-2 h（自动生成草稿 + 人工校对） | wzb 写脚本 / Lynne 校对 |
| 主题集群表填核心 5 集群 | 1-2 h | 不适用 | Lynne |
| 工具加 alias 层（保持 Sheet 现状跑通） | — | 30 min | claude-code |
| Template 补齐 Comparison + Programmatic 模板文件 | 4-6 h（写两套 prompt 模板） | — | Lynne 写 prompt / wzb 集成 |

**总计**：
- P2 alias 路线（MVP 妥协）：**1-2 h 即可跑动**
- P1 标准化路线（彻底）：**Lynne 8-12 h + wzb 5-7 h，共 2-3 个工作日**

---

## §8 wzb 建议路径（仅供参考，Lynne 拍板）

短期 alias + 长期标准化的三周路线：

### Week 1（本周）— 跑通

- claude-code：工具加 alias 层（30 min），接受 `Tier 1 (重装)` / `初稿` / 空 `cluster_id`
- wzb：row 5 临时填 6 个空字段，跑通 dry-run（1 h）
- Lynne：看 dry-run 输出，给 quality feedback（30 min）

✅ 验收：**1 行真实数据走通 friction-mine → entity-passport → gate-check → draft 完整流程**

### Week 2（下周）— 拍规范

- Lynne：拍板 page_id 命名（§3）+ 状态机方案（§5）+ Template 是否补 2 种（§2-#3）
- Lynne：填核心 5 集群到主题集群表
- wzb：根据决策同步更新 spec 三件套（PRD / SOP / .gs 注释）

✅ 验收：**spec 三件套与 Sheet 一致，新行手填遵循新规范**

### Week 3+ — 回填

- wzb 写脚本：批量回填 page_id（按 slug 规则自动生成 → Lynne 抽样校对）
- wzb 写脚本：批量标准化 Tier 列值
- Lynne：291 行 Status 人工回标（如果选 P1 路线）

✅ 验收：**Sheet 291 行历史数据全部符合 v2.1 schema**

> [!warning] 风险点
> 如果 §3 / §5 拖到 week 3 才拍，week 1 的 row 5 dry-run 会被 redo。建议本次会议**至少把 §3 page_id 命名和 §5 状态机方案先定下**，其他可以渐进。

---

## §9 决策汇总区 ⭐⭐⭐

> [!tip] 30 分钟同步会的核心产出
> Lynne 在本表里勾 5 个 ☐，wzb 拿着这张表就能动起来。

| # | 决策项 | 选项 | wzb 推荐 | Lynne 决定 |
|---|---|---|---|---|
| 1 | Tier 值标准化 | A. Sheet 改 T1/T2/T3<br>B. 工具加 alias 接受 `Tier 1 (重装)` 等 | **B**（MVP 优先跑通） | ☐ A ☐ B |
| 2 | Status 状态机映射 | P1. Sheet 一次补齐 5 态<br>P2. 工具加 alias<br>P3. 混合渐进 | **P3** | ☐ P1 ☐ P2 ☐ P3 |
| 3 | page_id 命名规范 | A. slug 模式（`page_blue_aura_meaning`）<br>B. 集群+序号（`aura_001`）<br>C. UUID（`p_a7d3f2`） | **A**（跟 .gs 注释例子一致） | ☐ A ☐ B ☐ C |
| 4 | Template 漏的 2 个 | A. 补 Comparison + Programmatic（4-6 h）<br>B. MVP 砍到 3 种 + spec 同步降级 | **B**（MVP 阶段先砍） | ☐ A ☐ B |
| 5 | 首次试跑数据来源 | A. row 5 blue aura（wzb 周末填空 6 字段）<br>B. 新建专门测试行<br>C. 等 Lynne 填好 1 行规范数据再跑 | **A**（最快出 dry-run） | ☐ A ☐ B ☐ C |

---

## §10 会后 wzb 行动清单（预填，会上确认）

> [!info] 会后 24 h 内 wzb 启动
> 假设 5 项决策全部按 wzb 推荐：B / P3 / A / B / A

- [ ] 在 `tools/scripts/gg-content-draft.mjs` 加 alias 层（Tier + Status）
- [ ] 在 Sheet `选题登记表` row 5 临时填 `page_id` / `cluster_id` / Friction / Logic / Entity / CTA
- [ ] 跑 `gg-content-draft --row=5 --dry-run`，截图发 Lynne
- [ ] 同步更新 `docs/03-marketing/03-seo/keyword-sheet-setup.gs` 注释，记录 v2.1 alias 规则
- [ ] 在 `docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md` 加 changelog 条目 v0.7.1
- [ ] 发起 Week 2 同步会议（拍 page_id / 集群表 / Template 收尾）

---

## §11 附录：实测数据样本（参考用）

实测命令：
```
打开 GenGrowth 关键词研究主表 → 选题登记表 → 291 rows
列出每列实际填入值的 distinct set
```

实际 distinct 值（节选）：
- **Tier 列**：`Tier 1 (重装)`、`Tier 2 (标准)`、空
- **Status 列**：`初稿`、`质检`、空
- **Template 列**：`Tutorial`、`Definition`、`Case Study`、空
- **page_id 列**：全 0 行
- **cluster_id 列**：全 0 行

实测时间：2026-05-21
实测人：wzb (claude-code 协助)

---

> [!info] 文档状态
> draft-for-discussion · 等 30 min 会议拍板后转 status: aligned，并把 §9 决策落到 spec 三件套
