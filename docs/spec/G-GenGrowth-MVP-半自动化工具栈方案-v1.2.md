---
title: GenGrowth 内部增长 MVP — 半自动化工具栈方案 v1.2
date: 2026-05-20
updated: 2026-05-20
type: implementation-plan
author: wzb
agent: claude
prd: docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7.md
schema_source_of_truth: docs/03-marketing/03-seo/keyword-sheet-setup.gs
status: ready-for-implementation
supersedes:
  - G-GenGrowth-MVP-半自动化工具栈方案-v1.md
  - G-GenGrowth-MVP-半自动化工具栈方案-v1.1.md
review_history:
  - G-GenGrowth-MVP-工具栈方案-v1-Review-Report.md
  - G-GenGrowth-MVP-半自动化工具栈方案-v1.1-Review-Report.md
tags:
  - gengrowth
  - mvp
  - tooling
  - seo
aliases:
  - GenGrowth MVP 工具栈方案
---

# GenGrowth 内部增长 MVP — 半自动化工具栈方案 v1.2

> 这是一份**可直接落地**的工具栈方案，已吸收 v1 / v1.1 两轮共 9 个 reviewer（含 codex 跨模型）的合并 review 意见。
>
> 与 v1.1 相比：①schema 全部按 `.gs` v3.0 真实定义重写；②WriteTransaction 改为更诚实的 WriteSequence；③Sheets-as-lock 改为本地 lockfile；④ProductProfile 抽象推迟到 v1.3；⑤Step 5 引入 codex 推荐的"返工时间 benchmark gate"；⑥Q3/Q8/Q9 给出已锁定答案。
>
> 我接受 v1.2 仍有小问题（详见 §13）。但**主流程已完整、schema 已对齐、可读可执行**。

---

## §0 v1.2 关键变更一览（vs v1.1）

| ID | 类型 | 位置 | v1.1 → v1.2 |
|----|------|------|-------------|
| C-1 | **核心修正** | §2.3 关键词主表 schema | 按 `.gs` 24 列重写：8 公式列（J/K/M/N/O/R/S/U）+ 16 手动列；写入名单只允许手动列 |
| C-2 | **核心修正** | §4.1 `/gg-keyword-mine` | AIO 检测结果写 **T 列**（v1.1 错写 S）；写入名单 A/B/C/D/E/F/G/H/I + L/T 可选；公式列硬禁 |
| C-3 | 重命名 | §3.6 + §4.2 | WriteTransaction → **WriteSequence**（承认非原子事务，靠 manifest + 幂等 backfill） |
| C-4 | 替代方案 | §3.2 + §8.4 | Sheets-as-lock → **本地 `proper-lockfile` + GCS object CAS（cloud cron 时）**；runs 表降级为可观测日志 |
| C-5 | 延后抽象 | §3.7 + §8.5 | ProductProfile 接口 → **扁平 `config/astrologywiki.json`**；ProductProfile 进入 v1.3 trigger（产品 #2 出现时） |
| C-6 | 新增 gate | §4.2 + §11 | Step 5 加入 codex 推荐的"10 篇返工时间 benchmark"，作为 MVP-1 → MVP-2 的 go/no-go gate |
| C-7 | 安全收口 | §8.1 | GSC reader-sa 改为 **Full User**（v1.1 写 "Restricted" 与 API 模型不符）；`--with-raw-query` 仅作应用层 gate |
| C-8 | 安全收口 | §9.3 | Sanitizer prompt injection 从"warn-only"改为"warn + 剔除该段"；drafter 改两阶段：抽取结构化数据 → 用结构化数据 |
| C-9 | 时间表 | §7.1 + §7.2 | Week-3 eng 砍到 16h；Phase 3 WriteSequence 推到 Week-4；红线 32h **实际守得住** |
| C-10 | 决策锁定 | §10 | Q3/Q8/Q9 给出推荐答案 + [DECISION_LOCKED]，用户不满意可改 |
| C-11 | 改名 | §6 | "Step 9 发布回填" → "**Manual SOP M9 · 发布回填**"，避开 PRD §7.9 Step 9（refresh）撞名 |
| C-12 | 范围缩减 | §3.2 + §8.5 | gg-lib 8 个抽象 → 5 个必须（BaseClient / SheetsClient / CostTracker / RunLog / Sanitizer）；Redactor 推 Week-3，SkillBridge/verify-contracts 推 Week-4 |
| C-13 | 安全补强 | §9.4 | PII 5 类 → 7 类（加 address/ZIP，加非西方姓名 fixture）；raw_gsc_private "最小 ACL" 改为"独立 workbook + 仅 wzb collaborator" |
| C-14 | 启动节奏 | §8.0 | 拆 **Day-1 启动**（DataForSEO + GCP billing，耗时 2-5 工作日）+ **Week-1 末验证**（其余 4 项） |
| C-15 | 量化校准 | §11.2 | 删 "Week-1 14 篇 <8h" 硬数字；改 "以 Week-1 实测为基线，>30%/篇返工 → 触发 SOP/工具回归" |

---

## §1 目标与范围

### 1.1 目标（来自 PRD v0.7）

服务 **astrologywiki.com**，把 PRD §7 的 9 步内部增长流程从"全手工" → "半自动化"：

- **可量化**：60 天 PV 目标（PRD §1.1）、Day 14/30/60 决策（PRD §7.9）
- **可审核**：每篇文章 wzb 终审，工具不替代决策
- **可降级**：任何工具失败都能回退手工（详见 §9.5）
- **可扩展**：astrologywiki 验证后，产品 #2 onboard 只改一份 config（v1.3 才上抽象层）

### 1.2 v1.2 范围（哪些工具化 / 哪些手工）

| PRD Step | 名称 | v1.2 处理 | 工具 |
|----------|------|-----------|------|
| 1 | PGB 写作 | 手工 + frontmatter 模板 | — |
| 2-3a | 关键词挖掘 | **工具化（MVP-1，Week-2）** | `/gg-keyword-mine` |
| 2-3c | 集群构建 | **工具化（Week-3 末）** | `/gg-cluster-build` |
| 4 | 技术 SEO 闸门 | 手工 + checklist | — |
| 5 | 内容生产 | **工具化（MVP-1 Week-3, MVP-2 Week-4）** | `/gg-content-draft` |
| 6 | 分发（社媒 + 内链 + Newsletter） | 手工 + Newsletter 已接入 | — |
| 7 | CTA + 事件埋点 + 数据回填 | **工具化（Week-4 末）** | `/gg-event-sync` + `/gg-cta-inject` |
| 8 | 周度编排 | **工具化（Week-5）** | `/gg-weekly` |
| 9 | 刷新/合并/退场 | **工具化（Week-5）** | `/gg-refresh-scan` |
| Mx | 发布回填（manual SOP M9） | 手工 + 半自动脚本辅助 | `bin/publish-backfill` |

**6 个 skill / 7 个脚本 / 3 段 manual SOP** = v1.2 全部范围。

---

## §2 事实基线（开工前 wzb 必读对账）

### 2.1 oracle 现状（vs PRD §1.2 假设）

PRD §1.2 写了几条"❌未"，但 oracle 真实状态如下（已 grep 验证）：

| 能力 | PRD §1.2 说 | oracle 真实状态 | v1.2 决定 |
|------|-------------|-----------------|-----------|
| GA4 埋点 | ❌ 未安装 | ✅ `services/analytics.ts` 已埋 13 类事件（page_view, scroll_depth, cta_clicked, external_link_click, conversion, page_engagement, first_visit, error_occurred, api_error, birth_chart_submit_success, cbt_entry_created, consent_*） | env 注 `VITE_GA4_MEASUREMENT_ID` 即激活；Consent Mode v2 已实现 |
| Newsletter | ❌ 未搭建 | ✅ `backend/src/api/newsletter.ts` 接 Supabase + Resend + UTM + 蜜罐 + IP rate limit 5/h | **无 double opt-in**，是否补开 → §10 Q1 |
| 精选文章 | "6 篇 aura" | ❌ 实际是 **5 篇精选** ：mercury-retrograde / mars-anger / track-mood / mental-health-apps / how-to-read-birth-chart（无 aura） | 量产线（Aura 1A）真正从 0 起；5 篇精选可升级为精修线 v1 |
| Brand voice / Tone | — | `wzb-obsidian/LLM-Wiki/AstrologyWiki/` 已存 | drafter system prompt 引用 |

**待 wzb 回灌 PRD**：§11.3 列了 PRD §7.5.3 / §1.2 / §8.1 三处校准 patch，Week-1 跑完后做。

### 2.2 v2.0 SOP 真五步（PRD §7.5.1 + assembly v0.19）

v1 review 发现 v1 把五步写错。v1.2 锁定如下：

```
准入 / 排版                       ←  Tier 定级、Brief 三句话、模板选定（手工 + skill 提示）
   ↓
Entity 主权搜证                   ←  6 源 5 角度 → entity_passport.json
   ↓
Friction + Logic 取证             ←  SERP site:reddit.com / quora.com → friction_pack.json
   ↓
AI 组装（assembly v0.19）         ←  /gg-content-draft Phase 2，drafter system prompt
   ↓
双向语义布线                      ←  内链、Answer Lock、CTA wiring（Phase 3 + manual M9）
```

这五步映射到 v1.2 §4.2 `/gg-content-draft` 的 Phase 1（前三步合一）+ Phase 2（第 4 步）+ Phase 3（第 5 步）+ M9（发布回填）。

### 2.3 关键词主表 24 列真实 schema（按 `keyword-sheet-setup.gs` v3.0 重写）

**[C-1 核心修正]** 以下是 `.gs` line 113-138 / 145-150 / 196-265 的事实源对齐版。**写脚本必须按这张表，禁写公式列，T 列才是 AIO 风险写入位置**。

| Col | 列名 | 类型 | 颜色（gs） | 说明 / 公式 |
|-----|------|------|------------|-------------|
| A | 关键词 | 手动 | 🟢 绿（必填） | 主关键词 |
| B | 来源 | 手动 | 🟢 绿（必填） | DataForSEO / Ahrefs / GSC / 手工 / Cluster |
| C | 月搜索量 | 手动 | 🟢 绿（必填） | **目标国家**（B4 配置），不用全球量 |
| D | KD | 手动 | 🟢 绿（必填） | 关键词难度 0-100 |
| E | CPC($) | 手动 | ⚪ 灰（选填） | 仅展示，**不参与分桶** |
| F | Trends 比值 | 手动 | ⚪ 灰（选填） | 近 12 个月 / 上一年同期 |
| G | Top10 最低 2 站 DR 均值 | 手动 | 🟢 绿（必填） | SERP 检查时填 |
| H | SERP 弱度 | 手动 | 🟢 绿（必填） | 下拉 `✅弱` / `⚠️中` / `❌强` / `未查` |
| I | 自有站 DR | 手动 | 🟢 绿（必填） | 查词当时站 DR 快照 |
| **J** | **DR 差值** | **公式** 🛑 | 🔵 蓝 | `=IF(OR(G2="",I2=""),"待填",G2-I2)` |
| **K** | **G1 话题相关** | **公式** 🛑 | 🔵 蓝 | 扫 ⚙️配置!A6:A25 TOPIC_KEYWORDS |
| L | G2 可承接 | 手动 | ⚪ 灰（选填） | 下拉 Y/N，趋势词闸门 2 |
| **M** | **意图** | **公式** 🛑 | 🔵 蓝 | 扫词性自动判 Commercial/Transactional/Problem-aware/Informational |
| **N** | **DR 过滤** | **公式** 🛑 | 🔵 蓝 | J 差值 > 30 → ❌跳过 |
| **O** | **分桶_自动** | **公式** 🛑 | 🔵 蓝 | NEGATIVE_KEYWORDS / 趋势词 / 快速胜利 / 战略词 / 长尾词 / 跳过 |
| P | 手动分桶 | 手动 | ⚪ 灰（选填） | 人工覆盖（最终输出 R 会带 ★） |
| Q | 调整原因 | 手动 | ⚪ 灰（选填） | P 修改时填 |
| **R** | **分桶** | **公式** 🛑 | 🔵 蓝 | `=IF(A2="","",IF(P2<>"",P2&"★",O2))` |
| **S** | **AIO 预判** | **公式** 🛑 | 🔵 蓝 | 扫定义性词（what is / meaning / definition / how does / explained）→ ⚠️疑似高风险 |
| T | AIO 风险 | 手动 | ⚪ 灰（选填） | **下拉 Y/N/未查 —— 脚本/查词后实际结论写这里** |
| **U** | **弱度意图分** | **公式** 🛑 | 🔵 蓝 | SERP 弱度 + 意图合成分 |
| V | 内容状态 | 手动 | ⚪ 灰（选填） | 待写 / 写作中 / 质检 / 已发布 / 已刷新 |
| W | 发布 URL | 手动 | ⚪ 灰（选填） | 发布后由 M9 SOP 填 |
| X | 备注 | 手动 | ⚪ 灰（选填） | 自由文本 |

**关键约束**（脚本实现时强制）：
- **公式列硬禁**：J / K / M / N / O / R / S / U（共 8 列）。脚本任何写入到这 8 列 → 抛 `FormulaColumnViolation`，单测覆盖。
- **`/gg-keyword-mine` 写入名单**：A / B / C / D / E / F / G / H / I（核心 9 列）+ 可选 L / T（人工判断列，脚本可预填 default 待人工确认）。
- **绝不写**：M / R / S / U / V / W / X 的脚本路径，这些是公式 + 人工状态列。

### 2.4 选题登记表 21 列真实 schema（按 `.gs` line 365-389）

| Col | 列名 | 类型 | 来源 / 下拉值 |
|-----|------|------|---------------|
| 1 | Target Keyword | 手动 | 主题 head |
| 2 | Associated Keywords | 手动 | 周边词（;分隔） |
| 3 | 月搜索量 | 公式 🛑 | `=VLOOKUP(A2, 关键词主表!A:X, 3, FALSE)` |
| 4 | KD | 公式 🛑 | `=VLOOKUP(A2, 关键词主表!A:X, 4, FALSE)` |
| 5 | Intent | 下拉 | Info / Compare / Tutorial / Utility / Experience / BOFU |
| 6 | Tier | 下拉 | T1 / T2 / T3 |
| 7 | Template | 下拉 | Definition / Comparison / Tutorial / Programmatic / Case Study |
| 8 | Entity | 手动 | 主权 entity（passport.json 引用） |
| 9 | Friction | 手动 | reddit/quora 取证（friction_pack.json 引用） |
| 10 | Logic | 手动 | 推理链条要点 |
| 11 | CTA | 手动 | 目标 CTA（订阅 / 工具 / 内链） |
| 12 | GSC Keywords | 手动 | 已发布后由 M9 + Step 7 回填 |
| 13 | Status | 下拉 | 待写 / 写作中 / 质检 / 已发布 / 已刷新 |
| 14 | URL | 手动 | 发布后回填 |
| 15 | Last Audit | 手动 | 最近一次 Day 14/30/60 决策日期 |
| 16 | page_id | 手动 | gg 内部唯一 ID（kebab-case，e.g. `mercury-retrograde-2026`） |
| 17 | cluster_id | 手动 | `/gg-cluster-build` 输出 |
| 18 | page_role | 下拉 | Pillar / Series / Support / Tool / Wiki / Strategic |
| 19 | content_angle | 手动 | Brief 三句话之一 |
| 20 | psych_safety_flag | 手动 | Y / N（量产线偶现敏感词需手工标 Y） |
| 21 | journal_prompts | 手动 | 文末反思 prompt（精修线 healing 才填） |

**写入约束**：
- 公式列硬禁：3 / 4（VLOOKUP）
- `/gg-content-draft` 写入名单：1 / 2 / 5 / 6 / 7 / 8 / 9 / 10 / 11 / 13 / 16 / 17 / 18 / 19 / 20 / 21
- 14（URL）/ 15（Last Audit）/ 12（GSC Keywords）由 M9 + Step 7 后续写入

**已知 schema 紧张点**（推迟到 v1.3 协调）：
- §7 Template 字段 `.gs` 下拉值（Definition/Comparison/Tutorial/Programmatic/Case Study）与 PRD 附录 A 模板名（Placement+Self-Discovery / Wiki Definition+Reflection / Product-led Prompt / Tool-led / Adjacent Wiki Comparison）**不一致**。v1.2 决定：`.gs` 下拉为事实源；Brief 三句话中可引用附录 A 名作"内容角度"；v1.3 / PRD v0.8 收口对齐。

### 2.5 PRD 数字延后校准（不变 from v1.1）

PRD §7.5.3 写"25 篇/周 + 11h review"；v1.1 / v1.2 不直接接受这个数字，**Week-1 跑完真实数据后写 patch 回灌 PRD**（详见 §11.3）。

---

## §3 8 个架构决策

### 3.1 决策 1：DataForSEO（已确认）

- 来源：wzb 选择
- 用量：Labs（关键词扩展）+ SERP（Top10 DR / AIO 检测）+ Backlinks（必要时）
- 计费：pay-as-you-go，预算约 $5-10/次大跑，月顶 **$50/月 软限 + $150 硬顶**（详见 §9.1）
- KYC：2-5 工作日，**Day 1 启动**（§8.0）

### 3.2 决策 2：Sheets 单一事实源 + 本地锁文件 [C-4 修订]

- **Sheets** 持有：关键词主表 / 选题登记表 / cluster 表 / CTA Map / 结果复盘表 / runs（运行日志）/ raw_gsc_private（PII 隔离）
- **不持有**：草稿、状态机锁、回滚日志（这些进 git + 本地 FS）
- **并发锁**：`proper-lockfile` 在 `~/.gg/locks/{tool}.lock`（单机 cron）；如未来上 cloud cron，改 GCS object + `if-generation-match: 0` precondition（真 atomic CAS）
- **runs 表**：仅作可观测日志（status / cost / errors / duration），**不是锁原语**——避开 v1.1 "Sheets-as-lock" 不安全模式

### 3.3 决策 3：3 SA 拆分 + GSC Full User [C-7 修订]

| SA | Google Workspace 权限 | Cloud 项目权限 | 用途 |
|----|----------------------|---------------|------|
| `gg-reader-sa@..` | GSC **Full User**（v1.1 写 Restricted 错） + Sheets Reader + GA4 Viewer | — | 读 GSC / GA4 / Sheets |
| `gg-writer-sa@..` | Sheets **Editor**（workbook 级直接共享，**不经文件夹**） | — | 写 Sheets |
| `gg-admin-sa@..` | Sheets Owner + GSC Owner（轮换时启用） | — | **默认禁用**，仅 90 天轮换 + 紧急修复时启用 |

- **GSC 角色**：`searchAnalytics.query` API 需 Full User（不是 Restricted）。`--with-raw-query` 仅作**应用层 gate**（默认 false，原始 query 仅在 raw_gsc_private 隔离 sheet）
- **JSON 存储**：3 个 SA JSON → base64 → env 变量（`GG_READER_SA_JSON_BASE64` / `_WRITER_` / `_ADMIN_`）；**禁止裸 JSON 进 git**
- **存储位置**：见 Q9（§10）：**[DECISION_LOCKED] 选 Vercel Cron + Vercel env**（理由：wzb 已用 Vercel，无新基础设施）
- **轮换**：90 天，wzb 日历提醒；轮换流程文档化在 `runbooks/sa-rotate.md`

### 3.4 决策 4：量产线 + 精修线（PRD §7.5 双线）

| 维度 | 量产线（Aura 1A） | 精修线 |
|------|-------------------|--------|
| Tier 分布 | 主 T3 + 部分 T2 | T1 + 少量 T2 |
| 数量 | 14-25 篇/周 | 1-2 篇/2 周 |
| 工具 | `/gg-content-draft` MVP-1 自动化 | `/gg-content-draft` MVP-2 + codex challenge |
| 审稿 | 红线快速检查 ~10-20 min | 全部 SOP ~60-120 min |
| 心理安全 | 默认 N，敏感词手工标 Y | 默认 Y，全 SOP |

### 3.5 决策 5：Claude Cowork（主 + drafter + challenger）

| 角色 | 模型 | 职责 |
|------|------|------|
| 主 Claude（本会话） | opus-4-7 | 编排、决策、审阅 |
| Drafter | sonnet | Phase 2 草稿生成（按 facts + untrusted_quotes） |
| Challenger（仅 T1） | codex (GPT high reasoning) | T1 内容跨模型挑战 |

### 3.6 决策 6：WriteSequence + 三段式输出 [C-3 修订]

**v1.1 的 WriteTransaction 不是真事务**（跨 FS + Sheets + git 没原子提交）。改名 **WriteSequence**，并承认：

1. 预览阶段（Phase 3a）：脚本只写 `_staging/{page_id}/draft.md` + `_staging/{page_id}/manifest.json`
2. 暂存阶段（Phase 3b）：脚本写 Sheets 选题登记表（status='质检'）；manifest.json 记录 `sheet_row_key + content_hash + draft_path + page_id`
3. 发布阶段（Phase 3c）：**wzb 手工**走 M9 SOP 把 `_staging/` 文件 commit 到 oracle PR + 触发 `bin/publish-backfill`（半自动）填回 Sheets URL / Status

失败处理：**幂等 + 可重跑**，不是 rollback。`reconcile` 子命令启动时扫 `_staging/` vs runs 表 vs Sheets，列出 orphans 让 wzb 决定。

**Q9 锁定**：脚本写 `_staging/`，**绝不动 git**（gg 仓库内的 `_staging/` 文件夹被 `.gitignore`）；oracle git 操作全部 manual M9。

### 3.7 决策 7：扁平 config（推迟 ProductProfile 抽象到 v1.3）[C-5 修订]

v1.1 引入 `ProductProfile / ContentRepoAdapter / TemplatePack / SafetyRules` 接口。codex + architect 一致认为这是 YAGNI（产品 #2 不存在）。v1.2 删除接口，改：

```yaml
# config/astrologywiki.json（gg 仓库根目录）
{
  "product_id": "astrologywiki",
  "site_url": "https://astrologywiki.com",
  "sheet_id": "XXX-工作簿 ID",
  "oracle_repo_path": "/Users/wzb/Code/oracle",
  "oracle_content_dir": "src/wiki",
  "cta_map_range": "CTA Map!A2:E",
  "templates_dir": "templates/astrologywiki",
  "allowlist_domains": ["reddit.com", "quora.com"],  // 注意：不含自有 astrologywiki.com（防 SSRF）
  "psych_safety_default": "N",
  "ga4_event_whitelist_source": "CTA Map!E"  // 不在代码里硬编码事件名
}
```

**v1.3 trigger**：当 wzb 真要 onboard 产品 #2（≥30 天后），抽 `ProductConfig` interface（不是 Profile + Adapter 那么重）。

### 3.8 决策 8：`--print-schema` + skill-bridge + verify-contracts

- 所有脚本支持 `--print-schema` → 输出 JSON schema（输入 / 输出）
- skill 通过 `gg-lib/skill-bridge.ts` 调脚本（统一参数校验 + 错误格式化）
- CI hook `verify-skill-contracts.ts`：对比 skill 提示词 prompt 中声明的 IO 与脚本 `--print-schema` 输出，drift → fail commit
- 加 "semantic snapshot"：每个脚本一份小 fixture 输入 + 期望输出 JSON checksum；语义改变 → snapshot diff 告警

**Week-4 才上**（gg-lib 第一批先不带 skill-bridge）。

---

## §4 9 个工具 / SOP 详解

### 4.1 Step 2-3a `/gg-keyword-mine`（关键词挖掘）

#### 4.1.1 目标

输入种子词 + dimension，输出关键词主表新增行（手动列 only），交给 wzb 在 .gs 前端审分桶。

#### 4.1.2 输入

```bash
/gg-keyword-mine \
  --seed "mercury retrograde,natal chart,birth chart" \
  --dimension "astrology,wellness,self-discovery" \
  --country US \
  --max-cost-usd 5 \
  --dry-run            # 默认 true，需 --no-dry-run 才真写 Sheets
```

frontmatter（skill 提示词内）：
```yaml
sources: [dataforseo_labs, dataforseo_serp]
contract_version: 1
expected_cost_usd_range: [3, 8]
```

#### 4.1.3 实现 / Phase

| Phase | 动作 | 工具 |
|-------|------|------|
| 1 | 种子词扩展 | DataForSEO Labs（Related / Suggestions / Volume） |
| 2 | SERP Top10 DR 取证 | DataForSEO SERP API（自顶向下） |
| 3 | SERP 弱度判 | 算 Top10 DR 中位数 + 关键词难度 → ✅弱/⚠️中/❌强 |
| 4 | AIO 风险预判 | SERP Features 字段 + 定义性词扫 → Y/N/未查 |
| 5 | 自有站 DR 快照 | Ahrefs / 手动（精确度不高时打"未查"） |
| 6 | Sheets append（dry-run 不写） | `gg-lib/sheets-client.ts` 仅写**手动列** A/B/C/D/E/F/G/H/I + 可选 L/T |

#### 4.1.4 输出

**写入主表的列**（A-I 9 列 + L/T 2 列可选）：

| Col | 写入值 | 来源 |
|-----|--------|------|
| A | 关键词 | DataForSEO Labs |
| B | 来源 | "dataforseo" |
| C | 月搜索量（目标国） | DataForSEO Labs |
| D | KD | DataForSEO Labs |
| E | CPC($) | DataForSEO Labs |
| F | Trends 比值 | DataForSEO Labs trends |
| G | Top10 最低 2 站 DR 均值 | DataForSEO SERP |
| H | SERP 弱度 | 算法（见 4.1.3 step 3） |
| I | 自有站 DR | 配置 default（精度不足时打"未查"） |
| L | G2 可承接 | default "未查"（人工填 Y/N） |
| T | AIO 风险 | 算法（见 4.1.3 step 4），写到 **T 不是 S**！[C-2] |

**禁写**（公式列）：J / K / M / N / O / R / S / U + 状态列 V / W / X。脚本写到这些列 → 抛 `FormulaColumnViolation`，CI 单测覆盖。

**附加输出**：
- `runs/{run_id}/keyword-mine-summary.json`：扩词数、写入数、跳过数、成本、错误
- runs 表 append 一行

#### 4.1.5 验收

- ✅ 200 个种子词扩出 ≥800 个 keywords（dedupe 后）
- ✅ 写入只动手动列（auto-test 验证）
- ✅ 每次跑 < `$5 max-cost-usd` 默认
- ✅ Sheets append 批次大小 ≤200 行（避公式列全表重算 timeout）[C-2 配套]

---

### 4.2 Step 5 `/gg-content-draft`（内容生产，含 codex benchmark gate）

这是 v1.2 最复杂的工具。**[C-6] Step 5 引入 codex 推荐的 benchmark gate**：MVP-1 在 Week-3 起跑前先做 10 篇对照实验（5 手工 + 5 工具），返工时间下降 ≥30% 才继续。

#### 4.2.1 目标

输入选题登记表行（带 Target Keyword + Tier + Template），输出：
- `_staging/{page_id}/draft.md` 草稿
- `_staging/{page_id}/manifest.json` 元数据
- 选题登记表更新（status = '质检'）

#### 4.2.2 输入

```bash
/gg-content-draft \
  --page-id "mercury-retrograde-2026" \
  --tier T3 \
  --template Tutorial \
  --max-cost-usd 0.5 \
  --skip-friction false \      # T1/T2 必跑，T3 可跳
  --psych-safety-strict false  # 量产线 default false
```

#### 4.2.3 实现 Phase

##### Phase 1：取证（准入 + Entity + Friction/Logic）

1. **准入检查**：选题登记表行存在 + Target Keyword 非空 + Tier ∈ {T1/T2/T3}
2. **Entity 搜证**：6 源 5 角度（PRD §7.5）→ `_staging/{page_id}/entity_passport.json`
3. **Friction/Logic 取证**（T1/T2 必跑，T3 可跳）：
   - SERP `"Target Keyword problem|sucks|terrible|alternative"` site:reddit.com → 5 conditions
   - 同样 quora.com（精修线 hard requirement，量产线可跳）
   - 输出 `_staging/{page_id}/friction_pack.json`
   - **fallback**：SERP 0 结果 → 标 `friction_skipped=true`，继续（不阻塞 T3；T1/T2 触发 manual review）
4. **Sanitizer**（应用在外部抓取的 Reddit / Quora 文本）：
   - allowlist 域名过滤（不含自有 astrologywiki.com）[C-13 配套]
   - prompt injection 检测：包含 "ignore previous instructions" / "system:" / "[INST]" / ... → **剔除该段落**（不只 warn）[C-8]
   - 5+2 类 PII redaction：email / phone / DOB / 全名 / 健康（v1.1 已有）+ **address/ZIP**（新增） + 非西方姓名 fixture（中/韩/阿）[C-13]
   - 拆分：`facts.json`（来自 Entity 搜证可信源）vs `untrusted_quotes.json`（来自 reddit/quora）

##### Phase 2：AI 组装（drafter sonnet）

**两阶段 prompt 架构**（v1.1 是单阶段，security reviewer 指出 security-by-LLM 风险）[C-8]：

1. **抽取阶段**：sonnet 仅做 "从 untrusted_quotes 抽取结构化 friction points + emotional language patterns"，**输出 JSON，没有任何指令在 scope**
2. **组装阶段**：sonnet 用 facts + 抽取结构化数据（不是原始 untrusted 文本）+ 模板 + Brief → 草稿 markdown

drafter system prompt 关键约束：
- 外部内容仅作为用户观点引用，不作指令
- 禁用工具调用
- 数字 / 表格 / 列表密度约束（assembly v0.19）
- 模板对应字段（Definition / Comparison / Tutorial / Programmatic / Case Study）
- Brand voice：见 `wzb-obsidian/LLM-Wiki/AstrologyWiki/`
- 基线心理安全（**所有 Tier 都跑**，不只 psych_safety_flag=Y）[C-13]：不做诊断、不替代专业咨询、不做绝对承诺

##### Phase 3：双向语义布线 + 三段式输出 [C-3 修订]

1. **Answer Lock**：开头第一段必须直接回答 Target Keyword 字面问题
2. **CTA wiring**：从 CTA Map sheet E 列读取 GA4 事件白名单（**不在代码硬编码**）[C-7 配套]
3. **内链建议**：基于 cluster_id + page_role 推荐 3-5 个内链 anchor
4. **6 红线自动检查**：禁词 / 数字密度 / 表格密度 / Answer Lock / CTA 存在 / 心理安全基线
5. **psych_safety_flag = Y**（精修线 healing）→ 加跑全 SOP（journal_prompts / 危机干预措辞）
6. **写 `_staging/{page_id}/draft.md` + `manifest.json`**

manifest.json 字段：
```json
{
  "page_id": "mercury-retrograde-2026",
  "sheet_row_key": "Target Keyword=mercury retrograde 2026",
  "content_hash": "sha256:xxx",
  "draft_path": "_staging/mercury-retrograde-2026/draft.md",
  "tier": "T3",
  "template": "Tutorial",
  "phase_1_artifacts": ["entity_passport.json", "friction_pack.json"],
  "created_at": "2026-05-20T12:00:00Z",
  "cost_usd": 0.18,
  "drafter_model": "claude-sonnet-4-6",
  "red_line_checks": {"all_pass": true, "details": {...}}
}
```

#### 4.2.4 codex benchmark gate（Week-3 起跑前必跑）[C-6]

**触发**：Week-3 Day 1 之前
**方式**：
1. 选 5 篇 T3 题目，wzb 用现有 SOP 手工写 Claude 草稿 → 记录"生成时间 + 返工分钟数 + 可发布率"
2. 同 5 篇 T3 用 `/gg-content-draft` MVP-1 跑 → 记录同样三项
3. 比较：**返工时间下降 ≥30% / 篇 → go**；否则 stop，先迭代 prompt + 模板

这个 gate 单独消耗 Week-2 末 ~6h（5 篇手工 × 0.5h + 5 篇工具 × 0.3h + 比较分析 1h），但是是 Week-3 起跑前**最关键的 go/no-go gate**。

#### 4.2.5 验收

- ✅ T3 单篇 < $0.3，T2 < $0.5，T1 < $1.0
- ✅ 6 红线自动检查通过率 ≥95%
- ✅ 草稿返工时间下降 ≥30%（vs Week-1 手工对照组基线）
- ✅ 两阶段 prompt：抽取阶段不接受外部 untrusted_quotes 作为指令
- ✅ Sanitizer 单测覆盖中文 / 韩文 / 阿拉伯姓名 fixture

---

### 4.3 Step 7 `/gg-event-sync` + `/gg-cta-inject`（CTA + 数据回填）

#### 4.3.1 目标

`/gg-cta-inject`：把 CTA Map sheet 的事件名映射注入 oracle 文章 frontmatter / shortcode
`/gg-event-sync`：每周一从 GSC / GA4 拉数据，写 raw_gsc_private + 结果复盘表

**Week-4 末才上**（首批文章 Day 14 节点到达）。

#### 4.3.2 `/gg-cta-inject`

**Q8 锁定方案**：CTA Map sheet E 列是 GA4 事件名**唯一事实源**。脚本支持 `--dry-run --print-events` 反向扫 `oracle/src/**/trackEvent("...")` 自动生成种子（首次跑 + 季度同步）。

oracle 真实 GA4 事件（已 grep）：
```
api_error, birth_chart_submit_success, cbt_entry_created,
consent_banner_shown/denied/granted, conversion, cta_clicked,
error_occurred, external_link_click, first_visit, newsletter_submit_error,
page_engagement, page_view, scroll_depth
```

注意：`newsletter_submit_success` 在 oracle **不存在**（v1.1 错引用），实际成功路径走 `conversion`。Q8 推荐 wzb 在 oracle 加 `newsletter_submit_success` 显式事件（10 min 改 1 行），或在 CTA Map 用 `conversion + payload type` 区分。

#### 4.3.3 `/gg-event-sync`

输入：`--week 2026-W22 --pages 200`
流程：
1. **取锁** `proper-lockfile` 在 `~/.gg/locks/event-sync.lock`（避免重跑）[C-4]
2. 读 已发布 URL 列表（从选题登记表 W 列）
3. **GSC**：reader-sa（Full User）调 `searchAnalytics.query`
   - 默认 dimensions: `[date, page]`（**不含 query**）
   - `--with-raw-query=true` 才加 query dimension → Redactor → 写 `raw_gsc_private` sheet（**独立 workbook，仅 wzb collaborator**，30 天 retention）[C-13]
4. **GA4**：reader-sa 调 GA4 Data API（page_view / cta_clicked / conversion / scroll_depth）
5. 算每 page_id 的 Day 14/30/60 节点是否在本周
6. **写结果复盘表**：page_id / URL / clicks / impressions / CTR / position / GA4_pageviews / cta_clicks / 决策建议
   - **决策算法**：impressions < 10 → "数据不足，继续观察"（v1.1 review P1-L 修复）[from review]
7. 释放锁，写 runs 表，发 Telegram 报告（成功 / 失败 / 含 PII 行数）

#### 4.3.4 PII / 安全

- 5+2 类 redaction（见 4.2.3 Phase 1 step 4）
- raw_gsc_private 独立 workbook：URL 在 1Password；仅 wzb collaborator；30 天自动清理（手动 cron）
- "最小 ACL" 定义：**独立 workbook + 仅 wzb collaborator**（v1.1 写"最小 ACL"语义不清，security reviewer 指出 Sheets 不支持 per-tab ACL）[C-13]

#### 4.3.5 验收

- ✅ 200 页 GSC + GA4 单次 < 60s（Vercel Hobby cron 限制）
- ✅ raw_gsc_private 默认不写；启用时全部经 Redactor
- ✅ PII 单测覆盖 fixtures：地址 / ZIP / 中文姓 / 韩文姓
- ✅ lock 真生效：并发跑 2 次第 2 次拒绝

---

### 4.4 Step 2-3c `/gg-cluster-build`（集群构建）

输入：关键词主表 R 列 = 战略词/趋势词/快速胜利的关键词列表
输出：cluster 表（Pillar / Series / Support / Tool / Wiki / Strategic 角色）+ 选题登记表 cluster_id 回填

简单实现（Week-3 末）：embedding（OpenAI ada / Cohere）+ HDBSCAN 聚类 + 人工 review 每个 cluster 命名。

### 4.5 Step 8 `/gg-weekly`（周度编排）

Week-5 实现。从 runs 表 + 结果复盘表 + 关键词主表自动生成周报草稿：
- 本周产出（按 Tier）
- Day 14/30/60 触发 URL 列表
- 成本本周 / 月累计
- 失败 / 降级触发次数
- 红线检查失败率

输出 markdown → 邮件 / Telegram。

### 4.6 Step 9 `/gg-refresh-scan`（刷新/合并/退场）

Week-5 实现。按 PRD §7.9 规则扫已发布文章：
- Day 14：未收录 → "等" 或 "noindex 重发"
- Day 30：流量低 → "刷新" 或 "合并到 Pillar"
- Day 60：流量持平 → "sunset 移到 /graveyard"

**注意**：与 Manual SOP M9（发布回填，§6）名字撞——v1.1 提到的 "Step 9 发布回填" 已改名 M9。[C-11]

### 4.7 手工 Step 1 PGB / Step 4 tech gate / Step 6 distribution

- Step 1 PGB：手工写 + frontmatter 模板（v1.2 不工具化）
- Step 4 tech gate：手工 checklist
- Step 6 distribution：社媒 + 内链 + Newsletter（已接入）手工触发

---

## §5 暂留手工的内容

按 v1.2 范围（§1.2），以下保持手工：
- PGB 写作
- 技术 SEO 闸门检查
- 社媒分发（X / Threads / Reddit）
- 内链人工 review（工具仅给建议）
- 心理安全 SOP 全套（仅 psych_safety_flag=Y 触发）
- 退场 / sunset 决策（工具列出，wzb 拍板）

---

## §6 Manual SOP M9 · 发布回填 [C-11 改名]

**触发**：`/gg-content-draft` 输出到 `_staging/{page_id}/` 后，wzb 决定发布。

**SOP（9 步）**：

1. `cd /Users/wzb/Code/oracle`
2. `git checkout -b gg-draft/{page_id}` （oracle 仓库分支）
3. `cp /Users/wzb/gengrowth-wiki/_staging/{page_id}/draft.md src/wiki/{page_id}/index.mdx`
4. （可选）`bin/publish-backfill --page-id {page_id}` 自动注入 frontmatter（slug / title / cluster_id / page_role）
5. 手工 review draft.md → mdx 转换正确
6. `git add . && git commit -m "feat(wiki): add {page_id}"`
7. `git push origin gg-draft/{page_id}`
8. 在 GitHub 自审 + merge（小项目自审 OK）
9. 回 gg 仓库跑 `bin/publish-backfill --confirm --page-id {page_id} --url https://astrologywiki.com/wiki/{slug}` → 自动填选题登记表 W 列 URL / V 列 Status='已发布' / Last Audit 当日

**估时**：5-8 min / 篇 × 14 篇/周 = 70-112 min/周。**§7.2 ops cell +1.5h/周**显式预算 [from v1.1 review P1-M]。

---

## §7 4 周（+ 第 5 周稳态）开发计划

### 7.1 周拆解 [C-9 修订]

| 周 | 主线 | 工具交付 | 内容产出 | 备注 |
|----|------|----------|----------|------|
| **Week-0**（启动前） | §8.0 Day-1 启动（DataForSEO + GCP billing 注册） | — | — | 不计入 wzb 工时 |
| **Week-1** | 完成 Day-1 启动剩余 4 项 + 跑首批 14 篇手工 | — | **14 篇手工**（5 篇精选升级 + 9 篇新作） | 实测 wzb 单篇审稿时间，PRD §7.5.3 校准 patch |
| **Week-2** | gg-lib 第一批（BaseClient / SheetsClient / CostTracker / RunLog / Sanitizer） + `/gg-keyword-mine` MVP | `/gg-keyword-mine` ship | **7-10 篇手工** | gg-lib 走 Claude Code 实现 + wzb 审 |
| **Week-3** | **Step 5 MVP-1（T3 only + Phase 1+2 骨架）** + benchmark gate | `/gg-content-draft` MVP-1 ship | **10 篇**（5 手工对照 + 5 工具跑） | Phase 3 / WriteSequence 推到 Week-4；eng cell 砍到 **16h**（v1.1 是 22h） |
| **Week-4** | Step 5 MVP-2（T1/T2 + codex challenge + psych safety）+ Step 7 `/gg-event-sync` + Phase 3 WriteSequence | `/gg-content-draft` MVP-2 + `/gg-event-sync` + `/gg-cta-inject` ship | **14 篇** | Step 7 Week-4 末跑（首批 Day 14 节点正好触发） |
| **Week-5** | `/gg-cluster-build` + `/gg-weekly` + `/gg-refresh-scan` | 三个稳态工具 ship | **14 篇** | 进入稳态，月度回顾 |

### 7.2 wzb 时间分配表（红线 32h，实际守得住）[C-9]

每格小时数 = wzb 实际投入时间（含 Claude Code 协作的 review + direction 时间，**不是 keyboard 时间**）。

| 周 | reviewer（审稿） | ops（监控/M9） | eng（manage Claude Code） | PGB / decisions | 合计 |
|----|-------------------|----------------|--------------------------|------------------|------|
| Week-1 | 11h（14 篇 × ~45 min） | 2h | 0h | 4h | **17h** ✅ |
| Week-2 | 5h（7 篇 × 45 min） | 3h（含 M9） | 6h（manage gg-lib + keyword-mine 实现） | 2h | **16h** ✅ |
| Week-3 | 8h（10 篇 × 45 min，含对照组分析） | 4h（含 M9 + benchmark gate 6h 分摊 2h） | 8h（manage Step 5 MVP-1） | 2h | **22h** ✅ |
| Week-4 | 8h（14 篇 × 30 min，工具加速） | 5h（含 M9 + Step 7 监控） | 12h（manage MVP-2 + Step 7） | 2h | **27h** ✅ |
| Week-5 | 6h（14 篇 × 25 min，稳态） | 4h | 8h（manage 三个稳态工具） | 2h | **20h** ✅ |

**红线**：任一周 > 32h → 触发降级（§9.5）

**关键假设**（Q3 答案锁定）：**[DECISION_LOCKED] wzb 是 eng manager / reviewer，Claude Code 出实现**——eng cell 是 wzb 的 review + direction 时间，不是 keyboard 时间。否则全表数字翻 3-4 倍。[C-10]

### 7.3 失败保护（连锁降级）

- 任意一周 wzb 实际投入 > 32h → 停下当周工具开发，只做内容产出
- Week-3 benchmark gate 失败（返工时间下降 < 30%） → MVP-2 推到 Week-5，Week-4 改 SOP 迭代
- Week-4 末若 `/gg-event-sync` 跑不出数据 → 改 codex one-thing-to-cut（手工每周一从 GSC / GA4 dashboard 导出）

---

## §8 共用层与基础设施

### 8.0 启动前置（Day-1 启动 + Week-1 末验证）[C-14]

#### Day-1 启动（耗时项，立刻提交，不能等）

1. ⏳ DataForSEO 账号注册 + KYC（2-5 工作日）+ $50 充值
2. ⏳ GCP project 创建 + billing 绑卡（24-72h 验证）+ 启用 Sheets API / GSC API / GA4 Data API

#### Week-1 末验证（短耗时，确认绿灯）

3. ☐ 3 个 SA 创建 + workbook 级共享（详见 §8.1）
4. ☐ GSC property 类型确认（domain property vs URL prefix）
5. ☐ Vercel env 注入策略 ：`GG_*_SA_JSON_BASE64` 三个 env vars
6. ☐ Cron 位置确认：[DECISION_LOCKED] Vercel Cron（理由：wzb 已用，零新基础设施）。注意 Vercel Cron 60s timeout（Hobby）/ 300s（Pro），如不够则改 GitHub Actions。

**Week-2 第一行代码之前 6 项必须全绿。如 DataForSEO 未到账**：用 mock fixture 写 gg-lib + Sanitizer + 测试，不阻塞 Week-2 开发。

### 8.1 3 SA + 权限分配（详细）

```
gg-reader-sa@<project>.iam.gserviceaccount.com
├── GSC：Full User on https://astrologywiki.com domain property
├── Sheets：Reader on 主 workbook（workbook 级直接共享，**不经 Drive folder**）
└── GA4：Viewer on property 123456789

gg-writer-sa@<project>.iam.gserviceaccount.com
└── Sheets：Editor on 主 workbook + raw_gsc_private workbook

gg-admin-sa@<project>.iam.gserviceaccount.com（默认 disabled）
├── Sheets：Owner
└── GSC：Owner（90 天轮换或紧急维护启用）
```

**Q9 锁定**：Cron 在 Vercel Cron；SA JSON → base64 → Vercel env vars（仅 wzb 在 Vercel project 有访问权）。

**轮换**：日历提醒 + `runbooks/sa-rotate.md` 文档化（base64 重生成 + Vercel env 更新 + 旧 key 禁用）

### 8.2 gg-lib（精简到 5 个模块）[C-12]

```
gg-lib/
├── base-client.ts        # retry + token bucket + circuit breaker + Result<T, E>
├── sheets-client.ts      # batchUpdate + 公式列禁写校验 + 200 行批次
├── cost-tracker.ts       # cost-ledger.json + --max-cost-usd 拦截
├── run-log.ts            # runs 表 + runs/{run_id}/*.json 本地冗余
└── sanitizer.ts          # allowlist + prompt injection 剔除 + PII 7 类 redaction
```

**Week-3 加**：（不在 Week-2）
- redactor.ts（GSC 专用，从 sanitizer 拆出）

**Week-4 加**：
- skill-bridge.ts（统一 IO 校验）
- verify-skill-contracts.ts（CI hook）
- semantic-snapshot.ts（小 fixture checksum）

**v1.3 trigger 才上**：
- product-config.ts → product-profile（产品 #2 真出现时）

### 8.3 测试矩阵（4 类必过）

| 类型 | 工具 | 覆盖目标 |
|------|------|----------|
| Schema contract | vitest + json-schema | `--print-schema` 与 skill 提示词声明对齐 |
| Sheets fake | 内存版 SheetsClient + 公式列禁写断言 | 不真调 API 跑公式列违规测试 |
| Recorded API fixture | DataForSEO / GSC / GA4 response JSON | 重放 + 边界情况 |
| E2E dry-run | --dry-run 全流程跑 fixtures | 不写 prod / 不调真 API / 检查 manifest 完整性 |

**Week-4 加上 semantic snapshot**：每个脚本 1 个小 fixture + checksum 期望输出，语义改变 → snapshot diff 告警 [from review P2-A]

### 8.4 runs 表 schema + 锁文件

#### runs 表（Google Sheets，可观测日志，**不是锁**）

| Col | 字段 | 类型 |
|-----|------|------|
| A | run_id | UUID v4 |
| B | tool_name | `gg-keyword-mine` / `gg-content-draft` / ... |
| C | started_at | ISO 8601 |
| D | finished_at | ISO 8601 |
| E | status | success / partial / failure / locked-skipped |
| F | cost_usd_snapshot | number（与 `runs/.cost-ledger.json` 是源 of truth；F 列是快照） |
| G | summary_json_url | `runs/{run_id}/summary.json` 路径 |
| H | error_summary | 1 行文本（如有） |
| I | actor | wzb / vercel-cron / manual |
| J | branch | git branch（如适用） |
| K | freshness_marker | data_freshness 字段（GSC / GA4 数据滚动窗口） |

#### 锁文件（本地，**不进 Sheets**）

```
~/.gg/locks/
├── keyword-mine.lock
├── content-draft.lock
├── event-sync.lock
└── ...
```

使用 `proper-lockfile`（npm）。stale 锁 60s 自动失效。

如未来上 cloud cron → 改 GCS object + `if-generation-match: 0` precondition（真 atomic CAS）。

### 8.5 配置文件（替代 v1.1 ProductProfile）[C-5]

```
config/
├── astrologywiki.json   # 见 §3.7
└── _gg.env              # 共用 env（datawforseo key / vercel env 占位）
```

**不引入** `ProductProfile interface` / `ContentRepoAdapter` / `TemplatePack` / `SafetyRules`（v1.3 trigger 才上）。

---

## §9 风险与降级（合并版）

### 9.1 成本闸门

- 每脚本 `--max-cost-usd N`，超额前抛 `CostCeilingExceeded`
- 月度 ledger：`runs/.cost-ledger.json` + runs 表 F 列快照
- 软限 $50/月 → email 提醒；硬顶 $150/月 → 阻断所有写 API 调用
- T1 单篇 < $10（v1.1 调整），T2 < $1，T3 < $0.3

### 9.2 并发

- 本地 cron / 手动跑：`proper-lockfile`
- Cloud cron（未来）：GCS object CAS
- runs 表仅作可观测日志

### 9.3 LLM trust boundary [C-8]

- Sanitizer 剔除 prompt injection 段落（不只 warn）
- 两阶段 drafter：抽取阶段无指令，组装阶段用结构化数据
- drafter 禁用工具调用
- 所有外部内容标 `untrusted_quotes`，与 `facts` 分离

### 9.4 PII（7 类）[C-13]

- email / phone / DOB / 全名（含中/韩/阿 fixture）/ 健康 / **address+ZIP** / 财务（增）
- 默认 GSC `--with-raw-query=false`
- raw_gsc_private：独立 workbook，仅 wzb collaborator，30 天清理

### 9.5 降级（throughput-budgeted）

| 触发 | 降级动作 | 工时影响 |
|------|----------|----------|
| DataForSEO 超月度 | 关键词挖掘改手工 6 源 | +6-10h/周（如发生 1 次，2 周内不能再发生） |
| GSC API 429 | 改手工 dashboard 导出 | +30 min/周 |
| Codex challenge timeout | T1 改 sonnet 双轮自审 | +50% sonnet 成本，T1 上限 5 篇/周 |
| Sheets API quota 满 | 改本地 CSV 缓冲，下次窗口同步 | +0.5h/周 |
| 任一周 wzb > 32h | 停工具开发，只产内容 | 推迟工具 1 周 |

**fallback 总预算**：累计 fallback 工时 > 8h/周 → §9.7 止损触发

### 9.6 监控

- runs 表 SoT（每周一 wzb 看一次）
- Telegram bot（healthchecks.io ping + 关键告警 P0/P1）
- weekly newsletter freshness banner（data_freshness 字段过时 → 红条）
- 月度 cost ledger 复盘

### 9.7 止损决策表

| 信号 | 触发条件 | 决策 |
|------|----------|------|
| Step 5 benchmark gate 不过 | Week-2 末返工下降 < 30% | MVP-2 推到 Week-5，Week-3/4 改 SOP 迭代 |
| 草稿合格率 < 60% | 红线检查 + wzb 主观通过率 | 暂停量产线，回 SOP |
| 月成本 > $100 中位 | cost ledger 周中 | 启用 dry-run 强制 + 减半 batch |
| Day 30 阅读率 < 5% | 结果复盘表 | sunset + 改 Pillar |
| fallback > 8h/周 | §9.5 累计 | retro，砍工具范围 |

---

## §10 已锁定决策与待答 Q [C-10]

### 10.1 锁定（v1.2 默认值，不满意可改）

| Q | 锁定答案 | 理由 |
|---|----------|------|
| **Q3 工程谁写** | **[DECISION_LOCKED] wzb 是 eng manager / reviewer，Claude Code 出实现** | §7.2 时间表按此计算；否则全表翻 3-4 倍 |
| **Q9 cron 跑哪** | **[DECISION_LOCKED] Vercel Cron + Vercel env** | wzb 已用 Vercel，无新基础设施；如 60s timeout 不够再迁 GitHub Actions |
| **Q8 CTA map owner** | **[DECISION_LOCKED] CTA Map sheet 是事实源，脚本 `--print-events` 反向扫 oracle `trackEvent(...)` 自动 seed** | 避免硬编码 + 季度同步可重跑 |
| Q7 skill 前缀 | **`gg-*`**（v1.1 推荐 A，v1.2 确认） | 已全文档使用 |
| Q6 T1 codex challenge 默认 | **默认开**（T1 必跑） | 跨模型对照值得 $1/篇成本 |
| Q1 newsletter double opt-in | **暂不开**（MVP 阶段） | 当前 Resend + 蜜罐 + rate limit 已足；double opt-in 进 v1.3 |
| Q2 lead magnet 文案 | **延后到首批数据后定** | Week-2 末有 GSC query 数据更精准 |
| Q4 开发顺序 | 按 §7.1（不变 from v1.1） | — |

### 10.2 仍待 wzb 答的 Q（不阻塞 Week-2，但 Week-3 / Week-4 之前要答）

| Q | 阻塞什么 | 推荐答案 |
|---|----------|----------|
| Q-NEW-1 | Sanitizer 注入段落 warn vs block | **已锁 block**（[C-8]）；如改 warn → §9.3 加风险接受 |
| Q-NEW-2 | raw_gsc_private "最小 ACL" 机制 | **已锁独立 workbook + wzb collaborator**（[C-13]） |
| Q-NEW-3 | 产品 #2 是否 60 天内 onboard | **暂定否**（v1.3 触发） |
| Q-NEW-4 | Friction SERP 0 结果回退 | **T3 跳过，T1/T2 触发 manual review** |
| Q-NEW-5 | Step 5 benchmark gate go/no-go 接受 | **已锁接受**（[C-6]）；返工下降 < 30% → MVP-2 推迟 |
| Q-NEW-6 | newsletter_submit_success 事件 | **wzb 在 oracle 加 1 行 + CTA Map E 列加** |
| Q-NEW-7 | psych safety scope（量产线敏感词） | **已锁：所有 Tier 基线安全 + Y 加全 SOP**（[C-13]） |
| Q-NEW-8 | Template 字段对齐（.gs vs PRD 附录 A） | **v1.2 `.gs` 为准；v1.3 / PRD v0.8 收口** |

---

## §11 验收点

### 11.1 Week-1 跑通验收

- ✅ 14 篇手工产出实测，记录每篇真实工时
- ✅ §8.0 6 项前置全绿
- ✅ 写 PRD §7.5.3 / §1.2 / §8.1 校准 patch

### 11.2 工具实现验收（Week-5 末）

- ✅ `/gg-keyword-mine` 写主表只动手动列（公式列禁写单测过）
- ✅ `/gg-content-draft` MVP-1 + MVP-2 ship，6 红线自动检查覆盖
- ✅ **Step 5 benchmark gate 通过**：返工时间下降 ≥30%
- ✅ Sanitizer 单测覆盖中/韩/阿姓名 + prompt injection 剔除
- ✅ `/gg-event-sync` 60s 内跑完 200 页 GSC + GA4
- ✅ `proper-lockfile` 并发拒绝单测过
- ✅ `--dry-run` 全流程不写 prod
- ✅ 3 SA 权限按 §8.1 实施 + 文档化轮换 SOP
- ✅ cost ledger 周对账 + 月度 < $150
- ✅ 删 v1.1 ProductProfile / WriteTransaction 残留 → 改 config + WriteSequence
- ✅ **以 Week-1 实测为基线**：>30%/篇返工触发 SOP/工具回归（不再是 v1.1 的 "<8h" 硬数字）[C-15]

### 11.3 PRD 校准 patch（Week-1 末 wzb 写）

- §1.2 现状表：GA4 ✅已埋 / Newsletter ✅已搭 / 5 篇精选（非 6 篇 aura）
- §7.5.3 数字：用 Week-1 实测替换 25/11 估算
- §8.1：Newsletter 已搭，Week-1 不重做

---

## §12 后续节奏

- **Week-6 月度回顾**：实测 vs §11 验收，决定 v1.3 范围
- **Day 60 节点**：触发 `/gg-refresh-scan` 首次完整跑 + sunset 决策
- **v1.3 trigger 条件**：
  - 产品 #2 真要 onboard → 抽 ProductConfig（不是 ProductProfile 那么重）
  - 月度 < $150 守得住 → 考虑加深度报告自动化
  - benchmark gate 持续 > 50% 下降 → 考虑全量产线自动化

---

## §13 已知的小问题（v1.2 接受，v1.3 修）

按 wzb "可以接受小问题"原则，v1.2 接受以下：

1. **Template 字段 .gs vs PRD 附录 A 命名不一致**：v1.2 用 .gs 为准，PRD v0.8 收口
2. **runs 表 F 列 cost_usd 与 cost-ledger.json 双源**：以 ledger.json 为 SoT，F 列是快照（v1.3 加自动对账）
3. **DataForSEO Trends 比值精度有限**：精修线时可改手工 Google Trends export
4. **psych_safety_flag = Y 路径未完全自动化**：journal_prompts 当前手工填，v1.3 加 sonnet 草稿
5. **`/gg-event-sync` GSC URL Inspection（rate 1/2s）不在 Vercel Hobby cron 范围**：v1.2 不调 URL Inspection，只调 searchAnalytics.query（够用）；URL Inspection 进 v1.3
6. **Step 5 benchmark gate 用 5 + 5 样本太小**：统计意义弱，v1.2 接受作为方向性 gate；v1.3 累积到 30 篇后做正式 A/B

---

## §14 评审 trail

- v1（2026-05-18）：4 subagents 评审 → 28 findings（P0×10 / P1×13 / P2×5）
- v1.1（2026-05-19）：26 项 fix；schema 漂移未真闭合 + 过度修复（WriteTransaction / Sheets-as-lock / ProductProfile）
- v1.1 review（2026-05-20，本会话）：5 reviewer（含 codex 跨模型）→ 17 P0 + 17 P1 + 8 P2 新增 finding
- **v1.2（2026-05-20，本文）**：吸收 v1.1 review，schema 重写，过度修复回退，引入 codex benchmark gate

---

## §15 wzb 接下来 3 个动作

1. **Day-1（今天）** ：DataForSEO 注册 + KYC 提交 + GCP billing 绑卡（耗时项立刻启动，2-5 工作日并行）
2. **Week-1 起跑**：按 §8.0 跑前置自检 6 项 + 跑首批 14 篇手工内容，实测工时
3. **Week-2 Day 0**：确认 §10.1 8 个锁定决策 + §10.2 8 个 Q 答案 → 可改可不改，确认后 Claude Code 开始 gg-lib + `/gg-keyword-mine` 实现

---

**v1.2 状态**：ready-for-implementation。完整、可读、schema 真对齐、过度修复已回退。小问题接受（§13）。
