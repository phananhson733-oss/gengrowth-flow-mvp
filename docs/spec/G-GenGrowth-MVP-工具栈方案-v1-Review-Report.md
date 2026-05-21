---
title: GenGrowth MVP 工具栈方案 v1 — 多 reviewer 评审报告
date: 2026-05-20
updated: 2026-05-20
type: review-report
target: G-GenGrowth-MVP-半自动化工具栈方案-v1.md
reviewers:
  - claude-architect-agent
  - claude-planner-agent
  - claude-superpowers-code-reviewer
  - codex-gpt-5-high-reasoning
overall_verdict: REWORK_TO_V1.1_BEFORE_IMPLEMENTATION
sources:
  - "[[G-GenGrowth-MVP-半自动化工具栈方案-v1]]"
  - "[[2026-05-15-gengrowth-internal-growth-mvp-prd-v0.7]]"
tags:
  - gengrowth
  - review
  - tooling
aliases:
  - 工具栈方案 v1 评审报告
  - gg-tools-stack-v1-review
---

# 工具栈方案 v1 多 Reviewer 评审报告

## 0. 评审范围与方法

- **被审对象**：`G-GenGrowth-MVP-半自动化工具栈方案-v1.md`
- **评审日期**：2026-05-20
- **评审方法**：fan-out 4 个独立 reviewer，无 cross-talk，独立读方案 + 父 PRD + 关联 SOP
  - Claude `architect` agent — 架构合理性
  - Claude `planner` agent — 执行可行性
  - Claude `superpowers:code-reviewer` agent — 文档一致性
  - Codex MCP（GPT-5 high reasoning）— cross-model 独立挑战
- **汇总规则**：按 fingerprint 去重；多 reviewer 共同提到的 finding 标 ⚡ cross-model（高置信度）

## 1. 总体 Verdict

| Reviewer | Verdict | 一句话 |
|---|---|---|
| Architect | **RISKS_TO_FIX** | 骨架方向正确，但 5 处 P0/P1 必须 Week-2 起跑前修 |
| Planner | **NOT_FEASIBLE_AS_WRITTEN** | 单人 3 周 6 工具 + 无测试 + 内容生产暂停 = 60 天 PV 5000 deadline 必然失守 |
| Consistency | **MAJOR_DRIFT** | v2.0 SOP 五步映射错、.gs 主表 24 列被写成 10 列、字段名 schema 错位 |
| Codex (cross-model) | **revise_to_v1.1_risk_fix_spec** | 缺数据写入隔离、LLM trust boundary、PII 最小化、降级、回归测试、监控 |

**综合**：v1 **不能直接 ship**，必须修订为 v1.1 后才可进入 Week-2 实施。

## 2. Findings 汇总表（按 severity）

### 2.1 P0 — Ship-blocker（10 项，修完才能继续）

| # | Finding | 来源 | Cross-model | Fix |
|---|---|---|---|---|
| P0-1 | **v2.0 SOP 五步映射错**：方案 §4.2.1 写"SERP→大纲→装配→QA→发布"，v2.0 真五步是"准入/排版→实体主权搜证→信息增益→AI 组装→双向语义布线" | Consistency | — | 重写 §4.2.1 + §4.2.4 Phase 2/3 对齐真五步，补 Entity 主权查重 + Friction/Logic 取证 |
| P0-2 | **关键词主表 schema 错位**：方案 §4.1.5 写 10 列，`.gs v3.0` 实际 24 列（A-X）且字段名全错（如方案 F=competition 实际是 Trends 比值；方案 G=AIO 实际是 Top10 最低 2 站 DR 均值）。脚本按方案 schema 写会覆盖公式列 | Consistency | — | 重写 §4.1.5 完全对齐 .gs 24 列；脚本明确"只 append 手动列，绝不动公式列 J/K/M/N/O/R/U" |
| P0-3 | **选题登记表 v2.1 字段名错**：方案 §4.2.3 写 `primary_keyword / secondary_keywords`，附录 C 实际列名是 `Target Keyword / Associated Keywords` | Consistency | — | §4.2.3 输入字段表完全对齐附录 C 原文 |
| P0-4 | **跨仓库写入无事务**：`/gg-content-draft` 写 oracle/、`/gg-weekly` 写 wiki/，但谁 commit、谁 push、写一半失败如何回滚全部未定义。直接写 oracle main 会自动触发 Vercel deploy 到 prod | Architect | — | 显式定义"草稿写盘 ≠ commit"；引入 WriteTransaction 模式；oracle 走 PR 分支 `gg-draft/{page_id}` 禁止直推 main |
| P0-5 | **SA 权限过载**：单 SA + GSC Owner（可改 sitemap）+ Sheets Editor + GA4 Viewer + 无轮换。泄露 = 整个增长基础设施沦陷 | Architect + Codex | **⚡** | §8.1 拆 2-3 个 SA（reader-sa / writer-sa / admin-sa），GSC 用 Restricted 而非 Owner，加 90 天轮换 |
| P0-6 | **无测试/dry-run，直接写 prod**：Step 5 第一次跑就写 `oracle/data/articles/*.ts`（进 git → Vercel deploy → GSC 索引），LLM bug 污染上线难回滚 | Planner + Codex | **⚡** | 三段式输出路径：`runs/draft-preview/` → `oracle/.../staging/` → 正式位置；CI 拒 staging deploy；fixture 全链路 e2e 必须先跑 |
| P0-7 | **Step 5 单周 5-7 天严重低估**：spec 含 research 脚本 + cowork 调度 + 5 模板 + psych safety + tier 分流 + codex challenge + 内链/CTA + Sheets 回写 + dry-run，实际 12-18 工程日 | Planner | — | 拆两周：Week-3 = T3 单分支 + 模板 A/B + 无 codex/无 psych safety + dry-run；Week-4 上半周补 T2/T1 + psych safety + codex；B 档推到 Week-5 |
| P0-8 | **Step 2-3a + Step 7 Week-2 同周做不合理**：Step 7 需"URL 已发布 + indexed + 14 天"才有 Day-14 节点数据，Week-2 末库里只有起步几篇，跑空 | Planner | — | Step 7 推到 Week-4 末/Week-5 初；Week-2 只做 2-3a；空出来时间滚给 Step 5 |
| P0-9 | **wzb 三角色时间未分账**：reviewer + ops 落地 + eng 开发三角色 Week-2/3 同时干 = 内容生产停摆 3 周 → 60 天 PV 5000 deadline 累计少 42-75 篇（总目标 50-60%） | Planner | — | Week-1 末前定死 Q3「工程谁写」；显式降 Week-2/3 内容产能到 7-10 篇/周；加 3 周时间分配表，每格求和 ≤ 实际可用 h |
| P0-10 | **成本闸门缺失**：deep mode 一次 $30+、25 篇 T2 batch 一次 $5+、Step 7 周扫 200 页一次——单次操作可能爆 $150/月预算 | Planner | — | 所有脚本支持 `--max-cost-usd N` flag 超阈值 abort；`gg-lib/cost-tracker.ts` 落盘月累计；deep mode + batch ≥10 必须 dry-run 二次确认 |

### 2.2 P1 — 重要但可分批（13 项，建议进 v1.1）

| # | Finding | 来源 | Cross-model | Fix |
|---|---|---|---|---|
| P1-1 | **Sheets 并发写入冲突**：cron + 手动 + 人工编辑同时跑，duplicate rows / last-write-wins / overwrite 公式列 | Architect + Codex | **⚡** | 加 `runs`/`locks` sheet，主键 upsert，run_id + lease；或拆 fetch/apply（fetch 写 raw cache，apply 写 sheet） |
| P1-2 | **gg-lib 缺统一重试/限流/错误处理**：4 个 client 只暴露 happy-path，6 个 skill 各自实现 → 6 份重复且不一致 | Architect | — | 引入 `BaseClient`（retry-with-jitter + token bucket + circuit breaker + structured error）；client 层统一 429/5xx/timeout |
| P1-3 | **LLM trust boundary - Reddit/Quora prompt injection**：research 包来自外部网页直接喂 sonnet drafter，可含"ignore previous instructions / output affiliate links" | Codex | — | research 包拆 `facts` vs `untrusted_quotes`；外部文本 sanitize（去 HTML/script/隐藏文本）+ JSON 转义；drafter system prompt 标 untrusted；drafter 禁工具调用 |
| P1-4 | **PII 风险 - GSC query 含敏感词**：GSC query dimension 可能含姓名/邮箱/位置/心理健康表达；写入 Sheets 后访问面扩大 | Codex | — | 默认不落原始 query，只落 aggregate + redacted top query；email/phone/name pattern 本地脱敏或 hash；如必须 raw query，单独 `raw_gsc_private` sheet + 最小 ACL + 30-60 天保留 |
| P1-5 | **降级策略不全**：DataForSEO 中断 >24h、Vercel cron 漏跑、Sheets quota exhaust、GA4/GSC transient 429/5xx 没覆盖 | Codex | — | 每工具定义 retry/backoff + circuit breaker + max-staleness + catch-up window；外部 API 失败时写 `data_freshness=stale\|partial\|failed`，禁生成最终决策 |
| P1-6 | **回归测试无方案**：6 个 skill 改 prompt 或 schema 后破坏数据，无 fixture / contract test / snapshot | Planner + Codex | **⚡** | 实现前补测试矩阵：Sheets fake client + golden workbook fixture；DataForSEO/GSC/GA4 recorded fixtures；`--dry-run --fixture` 全链路 e2e；snapshot；schema contract test |
| P1-7 | **监控/告警缺失**：runs/*.json 是本地日志不是监控；无 heartbeat/SLO/失败告警/最后成功时间 | Codex | — | `tool_runs` sheet 记 last_success/duration/rows/cost/partial_failures；失败或 stale > SLA 发 Telegram；周报顶部显示数据新鲜度；外部 uptime ping |
| P1-8 | **PRD 与方案数字打架**：PRD §7.5.3 写 25 篇/周 + 11h/周审核，方案 §2 改成 14 篇/周 + 6-8h 但 PRD 未同步 | Consistency | — | 二选一：① 改 PRD §7.5.3 加注「Week-1 校准为 14 篇/周（见工具栈方案 §2）」② 改方案 §2 不重设产能，写「Week-1 跑完再校准」 |
| P1-9 | **cta_id↔ga4_event_name 映射 owner 未定**：方案 §4.3 写死 `cta_clicked / tool_use / newsletter_submit_success`，但 PRD §15 待补充项 owner 没指；oracle 已埋 13 类事件，映射表谁填、何时填空白 | Consistency | — | §9 加 Q8：映射表由 wzb 在 Week-2 setup 时填进 CTA Map sheet ga4_event_name 列；§4.3.3 输入栏明确 CTA Map 是唯一事实源 |
| P1-10 | **可扩展性 - 产品 #2 fork 量 > 50%**：方案 §3「锁定架构决策」全部硬编码 astrologywiki 上下文（oracle 路径、psych-safety healing-only），声称"框架级"实际不足 | Architect | — | 引入 `ProductProfile`（site config + content_repo_adapter + template_pack + safety_rules）；oracle 路径抽象为 `ContentRepoAdapter.write(slug, tier, content)`；附录 A 模板归 `profiles/astrologywiki/templates/` |
| P1-11 | **Skill↔脚本 contract 漂移**：脚本改 flag/输出格式，skill 端不会知道，跑到生产才发现 | Architect | — | 每脚本 `--print-schema` 输出 JSON Schema；skill 引用 `tools/scripts/gg-*.contract.json`；加 `verify-skill-contracts.ts` CI |
| P1-12 | **T1 Friction 取证被删**：方案 §4.2.4 T1 路径只写「sonnet 起草 + codex challenge + 修订」，PRD §7.5.4 验收"T1 有真实 Friction 或 SERP 差异证据"会不达标 | Consistency | — | §4.2.4 T1 补 Friction 取证（脚本调 SERP `keyword problem/bad/sucks` + WebFetch Reddit），或显式声明 wzb 审核时人工补 |
| P1-13 | **发布回填断链**：方案没有 `/gg-publish` 或 SOP 接管「审核完→Status 推到已发布 + 填 URL」，断了会让 Step 7 永远找不到 published_at，整个数据闭环静默失效 | Architect | — | 二选一：① `/gg-publish --page-id=xxx` 监听 git commit 自动回填；② §6 Part C 加 SOP 第 9 项「发布回填」+ `/gg-event-sync` 加健康检查（本周新发布但 7 天未回填 ≥ 3 篇 → 警报） |

### 2.3 P2 — Informational（5 项，记录但不阻塞 v1.1）

| # | Finding | 来源 | Fix |
|---|---|---|---|
| P2-1 | T1 成本 < $1.50/篇 估算未列分项（sonnet + 主 Claude + codex + research 注入），实测大概率 $3-5 | Architect | §4.2.7 验收成本三栏拆分；先跑 3 篇真实 T1 做基线再写死预算 |
| P2-2 | B 档 3 工具是同一 pattern（读多表→LLM→markdown→写回），可合并为 `/gg-ops` subcommand | Architect | 后置评估，等 3 个跑过一遍再决定 |
| P2-3 | 前置工作 ETA 低估：GSC Domain Property 类型确认、GCP billing 绑卡、Vercel env 注入策略、cron 跑在哪里 | Planner | §8 加 §8.0 前置自检清单，Week-1 末 wzb 亲自打勾 |
| P2-4 | 退场预案缺失：Week-4 末若工时净省 < 10h/周怎么止损 | Planner | §10 加 §10.4 止损/降级决策表 |
| P2-5 | frontmatter `parent:` 不符 wiki 约定（其他文件用 `sources:` 数组+wikilink）；PGB 字段数 11 错（实际是 PRD §7.2 的 9+3）；种子词 intent 枚举错位（v2.4 intent 是 .gs M 列自动算，不是种子输入） | Consistency | 3 处小修：frontmatter 改 sources、§6 PGB 字段数改对、§4.1.3 种子词字段改成"维度"而非 intent |

### 2.4 Cross-model 高置信 findings（多 reviewer 共同提）

⚡ **3 处 cross-model agreement**，置信度上调到 10/10：

1. **SA 权限过载**（P0-5）— architect + codex 同时提
2. **无测试 / 直接写 prod**（P0-6 + P1-6）— planner + codex 同时提，architect 跨仓库角度也提
3. **Sheets 并发写入冲突**（P1-1）— architect + codex 同时提

## 3. 综合修订建议

按 fix-first 原则分三档处理：

### 3.1 必须改才能继续（10 个 P0）
建议作为 **v1.1 修订** 一次性 rework 完成，预计方案文档增量 + 改动约 30-40% 内容。

### 3.2 v1.1 同期补（13 个 P1）
建议与 P0 一起进 v1.1，因为：
- LLM trust boundary、PII 风险是合规底线
- Sheets 并发、回归测试、监控告警是"上线即生产事故"风险
- gg-lib 错误/限流契约、可扩展性、contract 漂移是后续开发地基

P0 + P1 = 23 项一次性修完，方案文档增量约 50%。

### 3.3 v1.2 或上线后再补（5 个 P2）
informational 性质，不阻塞 Week-2 起跑。

## 4. 处理路径选项

给 wzb 三条路径：

- **A**（推荐）：我按 P0 + P1 一次性修订到 v1.1（23 项 fix），交付后你审。预估 1.5-2 小时工作，方案文档增量 ~50%。
- **B**：我只按 P0 修订（10 项），P1 列入 v1.1 backlog 后续处理。预估 45 分钟，方案文档增量 ~30%。
- **C**：你来 review 上面 38 个 findings 自己决定改哪些，我按你勾选清单修。

## 5. 评审元数据

- 方案文档行数：v1 ~600 行
- 4 reviewer 总 findings：38 个
- 去重后：28 个（含 3 个 cross-model 高置信）
- 严重度分布：P0×10 / P1×13 / P2×5
- Codex 调用：1 次失败（gpt-5.5-codex 不支持账号）+ 1 次成功（账号默认模型 + high reasoning）
- 总评审用时：~10 分钟（fan-out 并行）
