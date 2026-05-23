---
title: G-GenGrowth-MVP 半自动化工具栈方案 v1.1 — 5 视角合并评审报告
date: 2026-05-20
updated: 2026-05-20
type: review-report
author: wzb
reviewers:
  - architect (Claude)
  - security-reviewer (Claude)
  - code-reviewer / ops-devex (Claude)
  - general-purpose / consistency (Claude)
  - codex (GPT high reasoning, cross-model challenger)
reviews:
  - /Users/wzb/gengrowth-wiki/wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-半自动化工具栈方案-v1.1.md
supersedes: G-GenGrowth-MVP-工具栈方案-v1-Review-Report.md
status: needs-v1.1.1-patch-before-implementation
tags:
  - review
  - gengrowth
  - mvp
  - schema-drift
  - cross-model
---

# v1.1 合并评审报告

## 0. 元数据

**评审对象**：`G-GenGrowth-MVP-半自动化工具栈方案-v1.1.md`（1048 行）

**评审方式**：5 个 reviewer 并行 fan-out
- 架构（Claude architect）— 内部一致性 / WriteTransaction / ProductProfile
- 安全 + PII（Claude security-reviewer）— SA 权限 / Sanitizer / 5 类脱敏
- Ops + DevEx（Claude code-reviewer）— 时间表 / KYC 风险 / 监控开销
- 一致性 schema（Claude general-purpose）— .gs 24 列 / 选题登记表 / 模板名
- 跨模型挑战（codex / GPT high reasoning）— YAGNI / dead-on-arrival risk / one-thing-to-cut

**5 视角 verdict 汇总**

| 视角 | Verdict | 高优 finding 数 |
|---|---|---|
| 架构 | FIX_AND_REVIEW | 3 P0 + 5 P1 + 3 P2 |
| 安全/PII | FIX_AND_REVIEW | 2 P0 + 3 P1 + 2 P2 |
| Ops/DevEx | FIX_AND_REVIEW | 2 P0 + 4 P1 + 2 P2 |
| 一致性 schema | **MAJOR_DRIFT** | **12 P0** + 5 P1 + 4 P2 |
| 跨模型 codex | MAJOR_REVISION_NEEDED | 5 top challenges + 1 cut |

**总体结论**：

- v1.1 闭合了 v1 28 findings 中的 **26 个**（93%）。架构、安全、SOP、跨仓库事务的 P0 都按 v1 review 要求修了。
- **但最关键的 P0-2（关键词主表 schema 对齐）没真闭合**——v1.1 §2.3 列名相对 .gs v3.0 错位 7+ 处，§4.1.4 step 6 / §4.1.5 让脚本写公式列 S 又漏写手动列 I/L。脚本按 v1.1 跑一次就会破坏 .gs v3.0 主表的公式链。
- v1.1 **过度修复** v1 几条 P1：`ProductProfile` 抽象、`WriteTransaction` "事务"、`Sheets-as-lock` 并发原语都不该在 4 周单人 MVP 引入。codex 称为 "platform engineering disguised as a content automation MVP"。

**决策建议**：选 **B — 出 v1.1.1 schema patch + 关键收口**（详见 §6 修订路径选项）。

---

## 1. 5 视角交叉一致点（cross-model agreement，最高信号）

下面每条至少 2 个 reviewer 独立指出。

### 1.1 [P0] WriteTransaction 不是真事务（架构 + codex）

跨 FS + Sheets API + git 仓库不可能原子提交。v1.1 §4.2.4 Phase 3 的"sheet 写失败就 rollback 暂存文件"只覆盖最简单 happy-path：

- partial batchUpdate（Sheets API 一次写多行，可能写了一部分就 429）
- 人工中途改表
- 重复运行
- 写完 sheet 进程崩溃，FS 未 commit
- mv 后忘回填

**两个 reviewer 给的修复方向一致**：

- 改名 `WriteTransaction` → `WriteSequence`，承认不是事务
- 两阶段 ledger：`draft_manifest.json` 记录 `page_id / slug / draft_path / content_hash / sheet_row_key`
- 预览/暂存阶段只写文件和 manifest；**发布后**由 `publish-backfill` 半自动脚本按 page_id 幂等回填 Sheet
- 加 `reconcile` 子命令，启动时扫 `_staging/` vs `runs sheet` orphans

### 1.2 [P0] Sheets 作为并发锁不安全（架构独家，但 codex 间接支持）

Sheets API 没有 atomic compare-and-swap。`acquireLease()` 最多是 read-then-write with eventual consistency。两个 runner 可同时读到"无锁"、同时 append 自己的锁行、同时进入临界区。Sheets API 默认 quota 60 read/min/user + 60 write/min/user，锁存储本身可能限流被它保护的工具。

**修复**：
- 单机 cron → `proper-lockfile` 在 `~/.gg/locks/{tool}.lock`
- Cloud cron → GCS object + `if-generation-match: 0` precondition（真 CAS）
- Sheets 的 `工具锁` 行保留为**可观测日志**，不是锁原语；§8.6 schema 拆 `运行日志` + `事件流水`，删 `工具锁` 表

### 1.3 [P0] Week-3 时间表越自定红线（Ops + codex）

文档自相矛盾：
- §7.1 说 Week-3 "wzb 总投入 ~32-40 h"
- §7.2 表格说 Week-3 cell 合计 30-34 h
- §7.2 红线 32 h

且 §7.2 假设 reviewer / ops / eng / PGB 可以独立时间盒，**忽略了 4 角色都是同一个 wzb 的肉身**——切换成本 10-15% 让 30 h table 实际是 33-34 h。

**修复方向**：
- Option A：Week-3 内容产出降到 5 篇，剩下 5 篇推到 Week-4（"工具验证批"）
- Option B：Week-3 eng 砍到 16 h，把 Phase 3 WriteTransaction 推到 Week-4
- Option C（codex 推荐）：Week-3 只做 `/gg-content-draft-lite`（输入 Brief + 模板，输出 preview markdown，不写 oracle、不写 sheet、不分 T1/T2），T1/T2 + codex challenge + WriteTransaction 全部推迟到内容质量证明之后

### 1.4 [P1] ProductProfile 过早抽象（架构 + codex）

v1.1 §3 决策 7 + §8.4 引入 `ProductProfile` / `ContentRepoAdapter` / `TemplatePack` / `SafetyRules`。但当前只有 astrologywiki 一个产品，且 PRD §14 明确说"产品 #2 到来时才拆框架层"。提前抽象的代价：

- gg-lib 从 ~0 涨到 ~2000 LOC infra，Week-2 没出第一个工具前先背平台债
- 抽象形状对着 0 个真实第二实例设计，产品 #2 真到来时形状几乎必错

**修复**：删 `ProductProfile` 接口，改 `config/astrologywiki.json` 扁平配置（`site_url / sheet_id / oracle_repo_path / cta_map_range / templates_dir / allowlist_domains`）。~30 LOC 替代 ~300 LOC。等产品 #2 真出现再抽象。

### 1.5 [P1] Q3（工程谁写）未答 → §7.2 整张表不可审计（Ops 独家强调）

- 如果 wzb 自写 eng cell = 12-22 h/周 → Week-3 已死
- 如果 Claude Code 写 + wzb 审 = 4-6 h/周 → 表格需重写

**这是 Week-2 起跑前必须答的唯一问题**。当前文档承认问题但没答。

---

## 2. STOP-THE-LINE：P0-2 schema drift 没真闭合（一致性 reviewer 独家，但严重度最高）

这是整个评审最关键的发现。

### 2.1 事实

v1.1 §0.2 自检表把 P0-2"关键词主表 schema 对齐 .gs v3.0 实际 24 列"标为 CLOSED。**实际 §2.3 列定义相对 `keyword-sheet-setup.gs` v3.0 至少 7+ 处错位**：

| 列 | .gs v3.0 实际 | v1.1 §2.3 说 | 严重度 |
|---|---|---|---|
| I | **自有站 DR**（手动，查词时站 DR 快照） | "关键词集群" | P0 |
| L | **G2 可承接**（Y/N 下拉，趋势词闸门 2） | "风险类别" | P0 |
| O | **分桶_自动**（公式，中间结果） | "分桶"（公式 + NEGATIVE_KEYWORDS 否决） | P0 |
| P-R | P=手动分桶（下拉）/ Q=调整原因（手动）/ R=分桶最终（公式） | "备注 / 视图分类 / 主题集群" | P0 |
| **S** | **AIO 预判（公式列）** | "AIO 标记（输入）" | **P0 致命** |
| T | **AIO 风险**（Y/N 下拉，手动） | "SERP features"（输入） | P0 |
| U | **弱度意图分**（公式） | "长尾标记"（公式） | P0 |
| V-X | V=内容状态 / W=发布 URL / X=备注 | "状态 / Page ID / 备注" | P0（关键词主表没有 page_id 列） |

且：

- §2.3 列出"公式列：J/K/M/N/O/R/U" —— **漏掉 S**。`.gs` navyCols = [10,11,13,14,15,18,19,21] = J/K/M/N/O/R/S/U 全是公式。
- §4.1.4 step 6 说"AIO 检测 → S 列" —— S 是公式，脚本写 S 会直接覆盖公式
- §4.1.5 写入名单 "A/B/C/D/E/F/G/H/**S**/T" —— 写公式列 S + 漏写手动列 I 和 L

### 2.2 后果

如果按 v1.1 §4.1.4 / §4.1.5 实施 `/gg-keyword-mine`，第一次跑就会：

1. 写入公式列 S，覆盖 AIO 预判公式
2. 漏写手动输入列 I（自有站 DR）和 L（G2 可承接），趋势词闸门 2 失效
3. 把 AIO 检测结果写到 T 列（"SERP features"），实际 T 是 AIO 风险下拉，破坏下拉值

下一次任何用户在前端打开 .gs，公式列 S 已是死值，分桶 R 列依赖的 S 失效，**整个 24 列公式链断裂**。

### 2.3 强制修复（必须出 v1.1.1 patch）

- 把 §2.3 整个 A-X 列表按 `.gs` v3.0 line 113-138 + line 145-150（绿/灰/暗色分类）+ line 196-265（公式）重写
- §4.1.4 step 6：AIO 检测结果写 **T 列**，不是 S 列
- §4.1.5 写入名单改为 **手动列 A/B/C/D/E/F/G/H/I/L/T/V/W/X**；公式列 **J/K/M/N/O/R/S/U 一律禁写**
- 加一行单元测试：`writeKeywordRow` 拒绝任何写到 J/K/M/N/O/R/S/U 的 batchUpdate，违反 → 抛 `FormulaColumnViolation`
- §0.2 P0-2 行改回 **OPEN**

预计工时：30-60 min schema 重写 + 30 min 单测。**不修不能进 Week-2**。

---

## 3. 按视角的高优 finding 清单（去重后）

### 3.1 P0 findings（共 17 项，其中 12 项是 schema drift）

| ID | 来源 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| P0-A | 一致性 ×12 | §2.3 + §4.1.4 + §4.1.5 | 关键词主表 schema 7+ 列错位 + 写公式列 S | §2 强制修复（必须 v1.1.1） |
| P0-B | 架构 + codex | §3 决策 6 + §4.2.4 Phase 3 | WriteTransaction 不是真事务 | 改 WriteSequence + manifest + 幂等 backfill |
| P0-C | 架构 | §8.6 + §4.3.2 | Sheets-as-lock 不安全 | proper-lockfile 或 GCS CAS |
| P0-D | 架构 + Ops + codex | §7.1 vs §7.2 | Week-3 越红线 32 h；文档自相矛盾 | Codex one-thing-to-cut（见 §5） |
| P0-E | 安全 | §8.1 | GSC "Restricted User" 角色错——`searchAnalytics.query` 需要 Full User | 改 §8.1 写 "Full User"；承认 `--with-raw-query` 是应用层 gate；或拆第 4 个 SA 专用 query |
| P0-F | 安全 | §4.2.4 Phase 2 + §9.3 | Sanitizer prompt injection 防御是 security-by-LLM | "警告但不剔除" → "警告 + 拒绝注入段落进入 Phase 2"；或两阶段 prompt 架构 |
| P0-G | 架构 | §3 决策 6 + §6.1 | PR 创建流程其实是 wzb 手工，但决策 6 写得像工具创建 | 拆决策 6a"工具只写 `_staging/`，不动 git" + 6b"§6.1 是手动 SOP" |
| P0-H | Ops | §10 Q3 | 工程谁写未答 → §7.2 表不可审计 | Week-2 Day 0 给 Q3 一句话答案：wzb 是 eng manager / reviewer，Claude Code 出实现 |

### 3.2 P1 findings（共 20 项，去重后）

| ID | 来源 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| P1-A | 架构 + codex | §8.4 + §3 决策 7 | ProductProfile 过早抽象 | 改扁平 `config/astrologywiki.json` |
| P1-B | 架构 | §8.4 | 8 个抽象（BaseClient/Sheets/Cost/Sanitizer/Redactor/RunLog/SkillBridge/ProductProfile）= Week-2 过载 | 削到 4 个必须（BaseClient/Sheets/Cost/RunLog），Sanitizer/Redactor 推到 Week-3 with Step 5，SkillBridge/verify-contracts 推到 Week-4，ProductProfile 推到 v1.2 |
| P1-C | 架构 | §4.2.4 Phase 1 step 4 | Friction SERP query `"Target problem\|bad\|sucks"` 对非英文 / 多词 target 无效 | `profiles/astrologywiki/friction-queries.yaml` 按 Intent 模板化 + 显式 fallback |
| P1-D | 架构 + Ops | §9.5 + §7.4 | 降级 cascade 无 throughput 上限——"DataForSEO 超预算 → 手工挖词"实际是 6-10 h | 加 fallback throughput table；§9.7 retro 触发条件加 "projected fallback hours > 8h/week" |
| P1-E | 架构 | §4.1.4 step 8 / §4.2.4 Phase 3 | `USER_ENTERED` + 500 行 batch 会触发公式列全表重算 → 5 分钟 Sheets timeout | spec 最大批次 200 行；用 `RAW` + 末尾无 op 触发一次重算 |
| P1-F | 安全 | §9.4 | 5 类脱敏漏地址/ZIP/非西方姓名 | Redactor 加地址 + ZIP；`redactNameLike` 加中文/韩/阿测试 fixture |
| P1-G | 安全 | §8.1 + §10 Q9 | SA JSON secret 生命周期未定（cron 跑哪 + key 存哪 + rotation 怎么连） | Q9 答案确定后写明：at-rest 在哪，谁有读权限，breach response；加 pre-commit hook 拒绝 `*-sa.json` 文件 |
| P1-H | 安全 | §4.2.3 + §2.4 | `psych_safety_flag` 仅 Y 路径有保护，量产线敏感词（"highly sensitive person"）会漏 | drafter system prompt 加普适基线安全指令；§9.8 加 safe messaging 决策（即使是"不适用" 也写明） |
| P1-I | 安全 | §8.4 Sanitizer | `filterLinks` allowlist 包含自有 `astrologywiki.com` → 自有域开放重定向就是 SSRF 旁路 | 从 allowlist 删 astrologywiki.com |
| P1-J | Ops | §8.0 | KYC 延迟（DataForSEO 2-5 工作日 + GCP billing 24-72h）放在"Week-1 末检查"太迟 | 拆 Day-1 initiate（DataForSEO + GCP billing）+ Week-1 末 verify（其余 4 项） |
| P1-K | Ops | §7.1 Week-3 + §4.2.1 | T3-only MVP-1 验收信号弱——6 个红线自动检查全过 ≠ 内容能排名 | Week-3 加 2-3 篇手工对照组；Day 14/30 比较 GSC impressions；wzb 起跑第 1 篇先 gate（>30 min 重写就停批量） |
| P1-L | Ops | §4.3 + §7.9 | Step 7 首次跑只有 7-14 天数据；DR<10 站点的 Day-14 impressions 常 0-5，决策算法噪声拟合 | 算法 impressions<10 时输出"数据不足"不出决策；Day-30 才是有意义触发点 |
| P1-M | Ops | §6.1 | Step 9 发布回填每周 70-112 min git 机械操作未计入任何 cell | §7.2 ops cell +1-2 h/week 显式标注 "Step 9 git mechanics" |
| P1-N | Ops + 一致性 | §10 Q8 + §4.3.4 step 5d | Q8 标 CTA map owner 未决，但 §4.3.4 已硬编码 `cta_clicked / tool_use / newsletter_submit_success`；且 `tool_use` 在 oracle 不存在（真实是 `tool_card_clicked`） | 删硬编码事件名；改"从 CTA Map E 列加载"；先实现 `/gg-cta-inject --dry-run --print-events` 反向扫 oracle `trackEvent(...)` 自动生成种子 |
| P1-O | 一致性 | §6 "Step 9 发布回填" | 与 PRD §7.9 Step 9（refresh/sunset）撞名 | 改名 "Manual SOP M9 · 发布回填" 或 "Step 6.5" |
| P1-P | 一致性 | §10 Q7 + §4 各处 | Q7 标 skill 前缀未决，但 §4 已全用 `gg-*` | 把 Q7 推荐 A 升级为已定 + 删 Q7；或 §4 改占位 `<prefix>-keyword-mine` |
| P1-Q | 一致性 | §2.1 Newsletter | v1.1 写"已搭建"正确，但 PRD §1.2 + §8.1 仍写"Week 1 完成" | §11.3 校准 patch 范围加 PRD §1.2 + §8.1 |

### 3.3 P2 findings

| ID | 来源 | 位置 | 问题 | 修复 |
|---|---|---|---|---|
| P2-A | 架构 | §3 决策 8 | schema contract 测 field 在但不测语义（field 名相同语义变） | 加 "semantic snapshot"——小 fixture 输出 JSON checksum |
| P2-B | 架构 | §7.2 vs §7.1 | Week-3 cell 30-34 h vs 红线 32 h 自相矛盾 | 紧 Week-3 eng 到 16-20 或抬红线到 34 |
| P2-C | 架构 | §8.6 vs §9.1 | runs sheet F 列 cost_usd 与 cost-ledger.json 双源 | 选一个为 SoT（推荐 ledger.json），runs 表为快照 |
| P2-D | 安全 | §8.1 | Sheets workbook-level 分享 vs 文件夹分享未明 | §8.1 加一行 "SA 通过工作簿级直接共享，不经文件夹" |
| P2-E | Ops | §8.6 + §9.6 + §4.3 | v1.1 新增至少 6 个监控面（runs sheet / locks sheet / Telegram / runs/*.json / raw_gsc_private / cost-ledger.json）未计入 ops cell | 加"weekly monitoring checklist 30-45 min"独立条目 |
| P2-F | Ops | §11.2 | "Week-1 14 篇产出 < 8h" 与"Week-1 跑完再校准" 自相矛盾 | 删 8h 硬数字，改"以 Week-1 实测为基线" |
| P2-G | 一致性 | §4.2.3 | Template 字段二元名词冲突：附录 A（Placement / Wiki Definition / ...）vs .gs 下拉枚举（Definition / Comparison / Tutorial / Programmatic / Case Study） | §4.2.3 加注；M1.5 修 .gs 对齐附录 A，或 PRD 改用 .gs 枚举 |
| P2-H | 一致性 | §4.2.4 Phase 1 step 4c | "精修线必抓 quora，量产线跳过"在 PRD/SOP 中找不到来源 | 注明 "v1.1 自决"，或退到"可选" |

---

## 4. v1 28 findings 闭合审计（最终版）

| v1 ID | 状态 | 备注 |
|---|---|---|
| P0-1 SOP 五步映射 | ✅ CLOSED | §2.2 + §4.2.4 重写为准入/Entity/Friction-Logic/Assembly/双向布线 |
| **P0-2 关键词主表 schema** | ❌ **STILL_DRIFTING** | §2.3 7+ 列错位；§4.1.4 写公式列 S；§4.1.5 漏手动列 I/L。详见 §2 |
| P0-3 选题登记表字段 | ✅ CLOSED | §4.2.3 完全对齐附录 C |
| P0-4 跨仓库写入无事务 | ⚠️ PARTIAL | WriteTransaction 概念引入，但不是真事务（见 §1.1） |
| P0-5 SA 权限过载 | ⚠️ PARTIAL | 3 SA 拆分正确；GSC role 写错（"Restricted" 实需 Full User，见 §3.1 P0-E）；JSON 存储未定（Q9） |
| P0-6 无测试直接写 prod | ✅ CLOSED | 三段式 + 测试矩阵 4 类 + verify-contracts CI |
| P0-7 Step 5 单周低估 | ⚠️ PARTIAL | 拆 Week-3 + Week-4 但 Week-3 仍越红线 |
| P0-8 Step 7 同周不合理 | ✅ CLOSED | Step 7 推到 Week-4 下半周 |
| P0-9 wzb 三角色未分账 | ⚠️ PARTIAL | §7.2 表存在但 Week-3 越红线 + Q3 未答让表不可审计 |
| P0-10 成本闸门 | ✅ CLOSED | --max-cost-usd + ledger + $150 月顶 |
| P1-1 Sheets 并发 | ⚠️ PARTIAL | runs+locks 表引入，但 Sheets-as-lock 不安全（见 §1.2） |
| P1-2 gg-lib 重试限流 | ✅ CLOSED | BaseClient 完整 |
| P1-3 LLM trust boundary | ⚠️ PARTIAL | facts/untrusted_quotes 拆分对；Sanitizer 仅 warn 不 block，是 security-by-LLM |
| P1-4 PII / GSC query | ⚠️ PARTIAL | 5 类脱敏 + 默认 no-query + raw_gsc_private 隔离；漏地址/非西方姓名/"最小 ACL" 未定义 |
| P1-5 降级策略 | ⚠️ PARTIAL | 列了场景但 fallback throughput 未计入预算 |
| P1-6 回归测试 | ✅ CLOSED | 4 类测试矩阵 |
| P1-7 监控告警 | ✅ CLOSED | Telegram + healthchecks + runs sheet |
| P1-8 PRD 数字打架 | ✅ CLOSED | §2.5 + §11.3 显式延后校准 |
| P1-9 CTA map owner | ❌ STILL_DRIFTING | Q8 列了选项，但 §4.3.4 step 5d 硬编码事件名（且 `tool_use` 在 oracle 不存在） |
| P1-10 ProductProfile | ⚠️ OVER_FIXED | 实现了但 YAGNI；应推回 v1.2 |
| P1-11 skill↔脚本契约 | ✅ CLOSED | --print-schema + verify-contracts + skill-bridge |
| P1-12 T1 Friction 取证 | ✅ CLOSED | §4.2.4 Phase 1 step 4 显式 SERP+Reddit |
| P1-13 发布回填断链 | ✅ CLOSED | §6.1 SOP（虽撞名 PRD Step 9，是 P1-O） |
| P2-1 T1 成本分项 | N/A | Week-1 跑完后补 |
| P2-2 B 档合并 | N/A | 后置评估 |
| P2-3 前置自检 | ⚠️ PARTIAL | §8.0 列了 6 项但未分 Day-1 启动 vs Week-1 末验证（见 P1-J） |
| P2-4 退场决策表 | ✅ CLOSED | §9.7 |
| P2-5 frontmatter / PGB / 种子词 | ✅ CLOSED | 三项都对齐 |

**合计**：26 CLOSED + 2 STILL_DRIFTING + 8 PARTIAL（PARTIAL 都是"概念到位但实现细节不安全/不完整"，需 v1.1.1 / v1.2 收尾）

---

## 5. codex 跨模型独到挑战

codex（GPT high reasoning）做的是"如果你不是 Claude 怎么看 v1.1"的角色。它独有 2 个洞察：

### 5.1 Step 5 验证逻辑错位

当前所有验收指标（红线质检、禁词、数字密度、表格密度、prompt injection sanitizer）都是**可测的表面指标**。但 Step 5 的核心假设是 "自动草稿把 wzb 审稿从 10-45 分钟降下来"——这个假设**没有任何验收指标在测**。

**codex 推荐**：先做 10 篇 benchmark（5 篇手工 Claude + SOP，5 篇 `/gg-content-draft-lite`），记录每篇：
- 生成时间
- wzb 返工分钟数
- 最终可发布率
- 是否满足 Answer Lock / CTA / 内链

**只有返工时间下降 ≥30% 才继续工程化**。这是真正的 go/no-go gate，而不是"测试矩阵 4 类全过"。

### 5.2 One Thing to Cut

如果 wzb 必须 3 周 ship 而不是 4 周，**最高杠杆的 cut = 砍掉整块 `/gg-event-sync` 自动化**。

Week-4 不做 GSC/GA4 API、PII redactor、cron、locks、Telegram、data_freshness、CTA event sync。改成：
- 每周一手工从 GSC/GA4 dashboard 导出/复制核心指标
- 填入 `结果复盘表`
- 最多写一个 30 行的校验脚本检查 `published_at / URL / day_marker` 是否缺失

**理由**：
- 移除一整组外部 API、权限、quota、隐私、监控复杂度
- 对 60 天 PV 目标零影响（人工导出一周一次完全够 100 页内的站）
- Day 14/30/60 决策本来就是人工判断
- 保留"内容产出 + staging 安全 + 成本闸门 + 手工复盘"四项核心

### 5.3 Dead-on-arrival risk（codex 一段话）

> 最可能的死亡路径是：Week-2 先被 GCP billing、DataForSEO、SA、env、gg-lib、测试夹具拖住；Week-3 `/gg-content-draft` 出了一个能跑但草稿返工很重的版本，wzb 一边修工具一边审内容，实际发布量下降；Week-4 因为已发布页面不足或 published_at 回填不稳定，`/gg-event-sync` 跑不出有意义数据；最后系统留下半套 API/事务/监控框架，但内容产能没有提升，60 天 PV 目标反而因为工程挤占内容生产而变远。

---

## 6. 建议的修订路径（3 个选项）

### Option A：仅出 v1.1.1 schema patch（30-60 min）→ 进 Week-2

只修 §2 stop-the-line 问题：
- §2.3 整个 A-X 按 .gs v3.0 重写
- §4.1.4 step 6 AIO 写 T 列
- §4.1.5 写入名单改对
- §0.2 P0-2 标 STILL_OPEN → 改后再标 CLOSED

**风险**：其他 16 项 P0/P1 finding 没处理；codex 的"过度修复"判断没回应；Week-3 越红线没改。可能 Week-2 跑通但 Week-3 翻车。

### Option B：v1.1.1 schema patch + 关键收口（半天） — **推荐**

修 §2 schema + 处理 §1 5 项 cross-model agreement + Q3 答案：

1. v1.1.1 schema patch（§2，必须）
2. WriteTransaction → WriteSequence（§1.1）
3. Sheets-as-lock → proper-lockfile（§1.2）
4. Week-3 时间表收紧（§1.3 Option B：eng 砍到 16h，Phase 3 推 Week-4）
5. ProductProfile → 扁平 config（§1.4）
6. Q3 答一句话（§1.5）
7. CTA map 解决（P1-N，删硬编码 + dry-run --print-events）
8. KYC Day-1 启动（P1-J）

预计 4-6 h wzb 时间。把 v1.1 -> v1.2（不是补丁，是收尾版）。

### Option C：codex 的激进剪枝（v2 重写）

按 codex 推荐：
- Step 5 改 `/gg-content-draft-lite` 单段式
- Week-4 砍 `/gg-event-sync` 整块，改手工导出
- 4 周改 3 周
- 删 ProductProfile / WriteTransaction / SkillBridge / verify-contracts / Sanitizer 复杂版

预计 1-2 day rewrite。把 v1.1 -> v2.0（剪枝版）。最快 ship 但放弃了一部分自动化能力。

---

## 7. 给 wzb 的 8 个待答问题（v1.1 + 评审新增）

| # | 问题 | 阻塞什么 |
|---|---|---|
| Q3 | 工程谁写？wzb 自写 vs Claude Code 写 + wzb 审 | §7.2 表 + Week-2 起跑 |
| Q9 | cron 跑哪？Vercel Cron / GitHub Actions / 本机 launchd | SA secret at-rest + lock 原语选型 |
| Q8 | CTA map owner + 事件名生成路径（推荐 dry-run --print-events 自动反扫 oracle） | §4.3.4 step 5d 不再硬编码 |
| NEW-1 | Sanitizer 注入段落是 warn-only 还是 block？ | 是控制还是监控 |
| NEW-2 | raw_gsc_private "最小 ACL" 的具体机制（Sheets 没有 per-tab ACL） | PII 边界真实可执行性 |
| NEW-3 | 产品 #2 是否 60 天内 onboard？ | ProductProfile 留还是删 |
| NEW-4 | Friction SERP 0 结果时的回退（exit / 跳过 / quora-only） | T1/T2 必跑承诺的真正含义 |
| NEW-5 | Step 5 是否接受 codex 的 benchmark 验证逻辑（返工时间下降 ≥30% 作为 go/no-go） | Week-3/4 内容路线 |

---

## 8. 建议的 next step（按选项分支）

**如果选 Option B（推荐）**：

1. 回答 Q3 + Q9 + Q8（30 min）
2. 出 v1.1.1 schema patch（30-60 min）
3. 处理 5 项 cross-model agreement → 写 v1.2（半天）
4. Week-1 末按 P1-J 时点跑 §8.0 前置自检
5. Week-1 跑完写 PRD §7.5.3 校准 patch + v1.1.1/v1.2 收尾审计

**如果选 Option A**：

1. 只出 v1.1.1 schema patch（30-60 min）
2. 直接进 Week-2
3. 记下"Week-3 末必须 mid-sprint review"——届时若越红线启动 Option C

**如果选 Option C**：

1. 接受 codex 的剪枝
2. 写 v2.0（1-2 day）
3. 直接 3 周 ship

---

## 9. 评审元信息

**评审耗时**：5 reviewer 并行，最长 ~4 分钟。Codex 用 GPT high reasoning，~140 s。

**单独输出原文**：每个 reviewer 的完整原始报告保存在 task output：
- 架构：`tasks/aa0d82397e936609a.output`
- 安全：`tasks/a1cf574f15d6a20c4.output`
- Ops：`tasks/ac538a8d6a1ae488d.output`
- 一致性：`tasks/ac31e3bacb9e27c32.output`
- Codex：thread `019e4464-2c33-7661-989e-5e5f60d2da64`

**报告作者**：合并整理 by Claude（基于 5 reviewer fan-out）

**与 v1 review report 的对比**：
- v1 review 28 findings → v1.1 26 CLOSED + 2 STILL_DRIFTING + 8 PARTIAL
- v1.1 review **新增 17 P0 + 17 P1 + 8 P2** finding（其中 12 P0 是 schema drift 的细分项）
- 主要新增 lens：跨模型 codex（YAGNI / dead-on-arrival），一致性 schema（.gs 列对账）

---

**一句话最终结论**：v1.1 闭合了 v1 大部分 P0/P1，**但在最关键的关键词主表 schema 上没修干净（写公式列 S 会破坏 .gs）；同时过度修复几条 P1（ProductProfile / WriteTransaction / Sheets-as-lock），引入了不该在 4 周单人 MVP 出现的平台工程**。必须出 v1.1.1 schema patch（30-60 min）才能进 Week-2，建议同时按 Option B 做收口到 v1.2。
