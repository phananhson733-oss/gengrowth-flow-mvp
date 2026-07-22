---
title: Cluster ID 治理与 SEO 内链实施计划
date: 2026-07-22
updated: 2026-07-22
type: plan
version: v1.0
status: in-progress
owner: wzb
tags:
  - cluster-id
  - seo
  - internal-linking
  - cron
  - tdd
aliases:
  - Cluster ID 硬门计划
  - SEO 内链回填计划
---

# Cluster ID 治理与 SEO 内链实施计划

**目标：** OPS 必须在生成 brief 前手工填入并批准 `cluster_id`；Flow、LLM 和 cron 均不得猜测、创建、修复或覆盖该值。cron SEO blog 只按已批准的 Cluster 数据生成可重复执行的内链计划，并在干净发布工作树中回填文章。

**架构：** `gg-sheet-to-brief.mjs` 继续作为 brief 的 Cluster 准入门；`gg-seo-brief-preflight.mjs` 改为只读校验 active plan，不再调用 Topic Register 或写入 Sheet；`gg-seo-blog-launchd-tick.sh` 去除 Topic Register 依赖。新增确定性内链规划器：从 canonical Cluster/Pages 表读取手填的 `cluster_id`、`page_role`、目标 slug 与发布状态，产生 Hub/Spoke 或同组链接清单；发布后由 cron 的干净 Oracle 工作树执行受管理的 Related Reading 回填，保护人工链接、去重且可安全重跑。

## 不变量

- 缺失、未知或未批准的 `cluster_id` 必须在生成 brief 前 fail closed，并返回 Page ID 给 OPS；不得语义匹配或写回 Sheet。
- LLM 只能读取 Cluster 规则和生成文案，不得决定或持久化 `cluster_id`。
- cron 预检只读，不调用 `gg-topic-register-tick.sh`，不传 `GG_TOPIC_REGISTER_APPLY=1`，不产生任何 Sheets/Feishu 写入。
- 内链候选只能来自已发布且同站点的已注册 Pages；同一 URL 最多一次，禁止自链，输出稳定排序。
- 回填只管理明确标记的区块；既有正文和人工 Related Reading 条目必须保留。无候选时不改文件；重复运行必须 no-op。
- `hub_spoke` 以 Hub→Spoke、Spoke→Hub 为主；没有单一 Hub 的 Cluster 使用同组 mesh。Pillar 晚于 Spoke 发布时，下一次回填必须补齐反向链接。
- 不直接修改当前 `/Users/awayer_mini/oracle` 脏工作树；运行时只接受 cron 已固定的、已验证干净的 Oracle 发布基线。

## 文件与测试

### 修改

- `tools/scripts/gg-seo-brief-preflight.mjs`：cron 入口改为只读 active-plan Cluster 校验与 attested manifest，不再调用 Topic Register；历史 semantic repair 证明代码仅保留为不可达兼容测试对象。
- `tools/scripts/gg-seo-blog-launchd-tick.sh`：移除 Topic Register 路径、可执行性检查与参数；预检改名为 Cluster readiness preflight；仅在 `GG_CLUSTER_LINKS_ENABLED=1` 时，于严格对账后构建输入快照并调用 review-PR 模式，随后才进入 readiness。
- `tools/scripts/gg-topic-register.mjs`：在自动候选/生成路径中禁止填充或改写 `cluster_id`，将缺失值作为 `needs_ops_cluster_id` 反馈；保留显式人工填写后的普通元数据补全。
- `tools/scripts/gg-sheet-to-brief.mjs`：确保 Cluster 缺失或未知永远无法被宽松 flag 降级为可 author 的 brief。
- `tools/scripts/gg-cluster-internal-links.mjs`（新增）：纯函数内链规划、受管理区块渲染与干净 Oracle 文章回填 CLI；任何输入快照都必须再次通过 Oracle 文件与文章注册表校验。

### 测试

- `tools/scripts/__tests__/gg-seo-brief-preflight.smoke.test.mjs`：Cluster readiness 不需要 wrapper；缺失/未知 Cluster 阻断；manifest 只绑定 active IDs；历史 wrapper 路径必须失败。
- `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`：launcher 不再引用或执行 Topic Register，预检失败时 nightly 不启动；Cluster 开关启用时先构建快照、创建 review PR，再执行 readiness。
- `tools/scripts/__tests__/gg-topic-register.smoke.test.mjs`：无论关键词语义多匹配，自动计划都不产生 Cluster ID 写入；缺失 Cluster 给出 OPS 处理状态。
- `tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs`：`--allow-missing-cluster` 不得越过 author 准入。
- `tools/scripts/__tests__/gg-cluster-internal-links.smoke.test.mjs`（新增）：Hub/Spoke、同组 mesh、延后 Hub、去重、自链、人工链接保护、幂等与脏工作树拒绝。

## 执行步骤

- [x] 先写并运行 Flow Cluster 硬门的失败测试，确认当前 semantic repair / 自动选群行为会被捕获。
- [x] 以最小改动移除 cron 的 wrapper 调用，并把 preflight 改为只读 Cluster readiness 校验；运行对应 smoke tests。
- [x] 收紧 Topic Register 与 sheet-to-brief 的 Cluster 权限边界；运行相关 unit/smoke tests。
- [x] 先写内链规划与受管理回填区块的失败测试，再实现纯函数与 CLI。
- [ ] 用临时干净 Oracle fixture 做回填 dry-run、apply、第二次 no-op 验证；不触碰交互 Oracle 工作树。
- [x] 运行完整相关测试组、shell 语法检查和 diff 检查；`gg-seo-blog-launchd-tick` 43 项、Cluster planner 7 项、autopilot Cluster 目标测试 3 项均通过。
- [x] 对真实发布台账执行只读输入构建预检；在 `PG-EMPATH-004` 缺少固定 Oracle 基线的注册文章文件时 fail closed，未创建输入快照、未改 Oracle、未写 Sheet。
- [ ] 只有在 cron 的实际干净发布基线可用且用户确认历史文章批次范围后，执行真实历史文章回填；再次验证生成页面与链接清单。

## OpenSpec 审批状态

- [x] 已在 Oracle 隔离工作树创建 `openspec/changes/add-managed-cluster-article-links/` 提案、设计、任务与增量规范；它要求内链只消费 OPS 批准的 Cluster 快照，并通过专用 PR 进入既有 preview/人工 merge gate。
- [x] 用户已批准该提案，已开始 Flow/cron 实现；真实历史文章仍需 OPS 明确确认 Page ID 批次范围。
- [ ] `openspec validate add-managed-cluster-article-links --strict` 仍待执行：本机全局命令、项目 `node_modules/.bin` 与 `npx --no-install` 均无可用 OpenSpec CLI；不得以安装或手工替代为由绕过审批。
