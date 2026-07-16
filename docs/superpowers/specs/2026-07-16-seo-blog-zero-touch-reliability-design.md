---
title: SEO Blog 零人值守可靠性闭环设计
date: 2026-07-16
updated: 2026-07-16
type: framework
version: v1.0
status: final
tags:
  - seo
  - zero-touch
  - repair-controller
  - reliability
aliases:
  - SEO Blog Zero-touch Reliability
  - SEO 零人值守闭环
---

# SEO Blog 零人值守可靠性闭环设计

## 1. 决策与范围

采用“失败生产者持久化事件 + 统一 controller 收敛 + 强制终态对账”的控制面，不再把批尾 hook 当作唯一修复入口。

本设计覆盖 AstrologyWiki 与 Gengrowth 两条 SEO blog 链路，修复以下已复现问题：

- 外层 launchd 父进程被 SIGTERM 后，nightly 子进程继续运行但批尾 repair hook 未执行。
- 同一 `PG-SDS-004` 因增长日志进入 fingerprint 而形成 6 条 active repair generation。
- AstrologyWiki 批次汇总读取全局 claims，混入 Gengrowth 项目。
- `staleCount=0` 时仍可存在 pending writeback 和 Sheet 状态 flip。
- preview gate 只重跑被修复的当前维度，未证明所有门禁针对同一不可变 commit SHA。
- controller 按策略退避，但缺少跨策略总预算与无进展终止条件。

不放松事实、资产、链接、canonical、Article JSON-LD、CTA、生产部署或同 SHA 审核门禁。机械结构规则改为 profile 驱动并优先做确定性归一化。

## 2. 零人值守定义

一次自然 cron 批次只有同时满足以下条件才算完成：

1. 所有本轮 eligible 文章自动达到 `published`；已证明 stale/duplicate 的选题自动达到 `archived`。
2. 没有人工强制 publish、人工改 claim、人工补 Sheet、人工补 plan、人工归档或人工触发 retry。
3. 本轮及历史遗留的 active repair、expired lease、pending writeback、Sheet flip、未勾 plan 全部收敛为 0。
4. 每个 published 目标通过生产 URL 200、精确 canonical、Article JSON-LD、sitemap、同 SHA 审核、Sheet、plan、vault、CTA 和 writeback 验证。
5. 批次通知只在终态发送一次，不把自动修复中的项目描述成“待人工”。

`human_only` 只允许用于已实际尝试且仍被 OAuth 登录、验证码、账户所有者授权、权限或缺失权威来源阻断的外部非委托边界。`quarantined` 用于内部总预算耗尽或无进展，防止活锁。任一自然验收窗口出现 `human_only` 或 `quarantined`，该窗口均不通过零人值守验收。

## 3. 运行架构

```text
com.gengrowth.seo-blog 自然发布唤醒
  -> pre-drain 历史 durable queue
  -> pre-reconcile 历史回填漂移
  -> nightly/author/publish 正常业务链路
       -> 每个失败生产者先写 claim/WAL
       -> 同一进程立即写 schema-v2 repair event
       -> 同一进程尝试 bounded controller drain
  -> runner 兜底 import/drain
  -> strict terminal reconcile
  -> site-scoped final summary
  -> zero-touch readiness verdict

com.gengrowth.seo-reconcile 每 5 分钟恢复唤醒
  -> 永不启动 nightly、author 或新内容 claim
  -> 发布窗内 drain eligible repair
  -> 全天 drain pending writeback / strict reconcile
  -> 恢复 expired lease 与 interrupted run
  -> 满足终态后幂等完成 run summary
```

### 3.1 失败必须在生产者边界落盘

- AstrologyWiki author park 在 `gg-seo-autopilot.mjs` 的 `parkAuthor` 内写 durable event。
- AstrologyWiki preview/review/fact park 在 `--mark-failed` 状态写入后写 durable event。
- Gengrowth factual、publish、writeback 失败继续复用 publisher 的 schema-v2 enqueue。
- 写 event 失败时 v2 路径必须返回非零，不能只保留 `needs_human` 后静默退出。
- 生产者在 event 落盘后立即尝试一次 bounded drain；controller busy 只表示已有单飞执行者接管，不消费额外预算。

因此外层 Bash 父进程即使随后收到 SIGTERM，失败事件也已经由仍在运行的业务子进程持久化，不依赖批尾 hook 才能被发现。

Gengrowth authoring 事件不得先要求存在 publish-ready `*-v8.md`。该 stage 的 canonical action 是定向 `--retry-author --task <pageId>`、重新 author、验证 phase2 manifest、完成 handoff，再进入 publisher；只有 publish/preview stage 才解析 ready draft。

### 3.2 Runner 是兜底和终态所有者

`gg-seo-blog-launchd-tick.sh` 在 nightly 前后都调用统一 controller 与 reconcile：

- pre-drain 处理上一自然窗口遗留事件。
- post-drain 兼容旧 claim 和 run-level failure。
- strict reconcile 负责 pending writeback、ledger、Sheet、plan 与 archive 收敛。
- 最终 readiness 非零时 launchd 不记录健康成功；但 repairable 状态仍保留在 durable queue，下一自然窗口继续。

nightly 不再提前发送批次完成消息；最终汇总移到 strict reconcile 之后。

### 3.3 独立 recovery reconciler

新增的 reconciler 不是第二个发布执行器：它没有调用 nightly/author/scan 的能力，也不能创建新 claim。它只消费已经持久化的 repair、writeback 和 interrupted run。

- 18:30–22:00：允许执行定向 repair、regate、publish 与回填。
- 22:00 之后：禁止开始新的文章 repair/publish，只允许回填、状态对账、lease 恢复与只读 readiness。
- live owner 锁不可抢；dead owner 或 expired lease 必须自动恢复。
- 每次 tick 都有独立 wall-clock budget，busy-skip 不得重复消费 attempts 或发送通知。

## 4. Incident 身份、代际和去重

### 4.1 稳定身份

`incidentId` 是 `site + pageId`；run-level 事件使用 `site + lane + RUN`。每个 incident 同时最多只有一个 active generation。generation 的稳定 `failureFingerprint` 只由稳定语义组成：

```text
site + pageId + canonicalStage + errorKind + stableErrorCode + normalize(summary)
```

原始 stderr、日志文件长度、offset、时间戳、PID、临时路径、preview hostname 只作为 evidence 保存，不参与身份计算。

### 4.2 Active 唯一性

- 同一 `failureFingerprint` 重复观察只增加 `observations` 并更新 `latestEvent`。
- 同一 incident 出现新的稳定语义或确定性 regate 后 stage 变化时创建新 generation，并把旧 active generation 原子转为 `superseded`。
- `superseded` 是内部终态，不发送终态通知，也不再被 controller 调度。
- retry budget 归属于 incident/budget epoch，不能通过换 fingerprint、换 stage、换策略或增长日志重置。
- 原始 observation append-only；incident 折叠在 per-incident CAS/锁内完成，两个并发 producer 不能各自创建 active head。

现有 `PG-SDS-004` 六条 active 记录通过显式、可重入的 `compact` 迁移：先写 `migration_hold` canonical incident，累计保留六个 source event、完整 history 与已发生的 20 次 attempts，再把六条来源转为 `superseded`；禁止删除队列文件或清空历史。修复 author-stage adapter 后只授予一次带代码版本和原因的 rollout verification credit，不把 20 次历史 attempts 清零，也不允许正常策略重新循环。

## 5. Controller 有界收敛

每个 incident family 使用以下硬预算：

- 最多 3 次总修复尝试，跨所有策略累计。
- 最多 2 次 Agent 内容/代码变更。
- 最多跨 3 个连续自然 cron 窗口或累计 90 分钟。
- 单次 controller drain 默认 25 分钟，保留 5 分钟做持久化、解锁和终态对账。
- 相同 artifact SHA 与相同 failure fingerprint 连续两次出现，立即判定 `no_progress`。

预算耗尽或无进展进入 `quarantined`，不再无限 `repair_pending`。`quarantined` 不是人工授权，也不得伪装成 `human_only`。

终态通知键使用 `terminal + incidentId + budgetEpoch`，不得包含会因日志噪声变化的 fingerprint。

## 6. 同 SHA 门禁与有界多轮修复

### 6.1 安全门禁

以下门禁始终 fail-closed：

- Chrome/runtime/canonical/H1/Article JSON-LD/认证墙。
- 事实、占星计算、引文、医疗或科学背书、抄袭红线。
- 最终正文的每个内部链接必须属于已验证候选集合，并满足 route 或 sitemap、HTTP 200 与 canonical。
- 每个最终引用资源必须存在、HTTP 200、MIME 正确、非空且可解码。
- CTA 必须来自 CTA Map 并与生产页面一致。
- required 模式无法取得 commit SHA，或审核中 branch head 漂移，必须阻断。

### 6.2 修复后全量重审

任何 Agent 或 deterministic edit 产生新 commit 后：

1. 重新读取 branch head SHA。
2. 在该 SHA 上重跑 Chrome、全部 review dimensions、Codex fact gate、链接和资产检查。
3. 把 reviewed SHA 写入 claim。
4. merge 使用同一 SHA 的 `--match-head-commit`；不允许 best-effort unpinned merge。

同一维度默认最多 2 次 repair，总 repair edit 不超过 3 次；达到预算后交给 controller 的 `quarantined` 终态，不无限循环。

## 7. 结构规则 profile 与 normalizer

结构约束由版本化 profile 解析：

```text
site + locale + template + intent + content_tier -> structural profile
```

Profile 可配置字数区间、H2/H3 可选范围、FAQ、表格、snippet、内链数量和关键词次数。确定性 normalizer 在 Agent 前运行，且必须幂等；只允许修改空白、标题别名、列表和 FAQ/table 外壳等非语义结构。

Normalizer 禁止修改事实、数字、日期、URL、slug、CTA、来源、资产引用和正文语义。超过 normalizer 白名单的失败仍进入 Agent repair，并重过全部安全门禁。

## 8. 站点隔离与最终汇总

- claim、repair event、batch summary 与 readiness 均显式携带 `site`、`plan` 和 `runId`。
- AstrologyWiki 汇总只读取指定 plan 中的 page ID；Gengrowth 只读取 Gengrowth plan 或显式 URL。
- 全局 claims 中其他站点、其他 plan、旧 run 的项目不得进入本轮计数或提醒。
- batch summary 在 terminal reconcile 后生成，内容只包含 published、archived、quarantined、human_only 四类终态；处理中状态保持静默。

## 9. Strict reconcile 与 readiness

`gg-ledger-reconcile.mjs` 增加机器可读 strict 模式，输出并验证：

- `pendingWritebackAfter`
- `sheetFlipsAfter`
- `planUncheckedAfter`
- `activeRepairAfter`
- `expiredLeasesAfter`
- `eligibleNeedsHumanAfter`
- 每个子步骤的错误列表

只有所有计数为 0 且错误列表为空时退出 0。`staleCount=0` 继续作为只读观测，但不再代表 SEO 批次健康。

测试产生的 `PG-TEST-*` 状态必须隔离到临时 `GG_FLOW_STATE_DIR`；生产 readiness 发现 test-shaped sidecar 时 fail closed 并报告污染，不自动删除文件。

## 10. 测试与上线验收

### 10.1 必须先失败的回归

1. gate 写入 claim 后即使外层 runner SIGTERM，durable event 仍存在并可在下一次 drain 恢复。
2. 同一 claim 以增长日志重复 import，只保留一个 active incident 且累计预算不重置。
3. `compact` 不删除历史文件；六条来源记录全部转为 `superseded`，另保留一个 canonical incident head。
4. AstrologyWiki summary 不得包含 Gengrowth claim。
5. pending writeback 或 Sheet flip 非零时 readiness 必须失败，即使 stale report 为 0。
6. 修复产生新 SHA 后全部门禁重跑；SHA 漂移或缺失不得 mark/merge。
7. 总尝试达到 3 或连续无进展后进入 `quarantined`，adapter 不再调用。
8. normalizer 连跑两次输出一致，且语义保护字段未变化。
9. Gengrowth authoring event 在不存在 ready draft 时进入定向 author/handoff，不抛 `publish-ready target not found`。
10. reconciler 在发布窗外不调用 nightly/author/publish，但仍能清空 writeback、恢复 lease 并完成状态对账。
11. live owner lock 不被抢，dead owner/expired lease 在下一次 5 分钟 tick 自动恢复。

### 10.2 自然 cron 验收

不手动 kick，使用连续三个自然窗口：

| 窗口 | 场景 | 通过条件 |
| --- | --- | --- |
| 18:30 | 机械结构偏差与一次瞬态工具失败 | 事件稳定去重；normalizer/自动 retry 生效；无人工提醒 |
| 19:00 | 同一 incident 恢复并产生一次内容修复 | 只产生一个 active generation；新 SHA 全量重审；自动发布与回填 |
| 19:30 | 历史 pending、Sheet flip 与跨站点 claims 并存 | strict reconcile 全零；汇总站点纯净；无 active lease/repair |

三个窗口都必须满足：没有人工操作、没有 force publish、没有 `human_only`/`quarantined`、没有重复终态通知、没有残留 active repair、pending writeback 或 flip。只有这组证据完成后，才把 SEO blog 标记为零人值守已验收。

## 11. 安全与回退

- 不删除 queue、claim、WAL 或历史证据；迁移只追加 transition。
- 不绕过事实、链接、资产、canonical 或同 SHA 门禁。
- 不使用普通文章 Google Indexing API，不执行无人值守 GSC Request Indexing。
- 不覆盖用户 dirty worktree，不使用 destructive git 命令。
- 回退以环境开关关闭新增 producer drain/strict readiness，但保留 durable 事件和既有安全门禁；不得通过恢复 force publish 达成表面成功。
