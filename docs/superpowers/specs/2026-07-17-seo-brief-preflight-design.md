---
title: SEO Active Brief 确定性 Preflight 设计
date: 2026-07-17
updated: 2026-07-17
type: plan
version: v1.0
status: review
owner: wzb
tags:
  - seo
  - zero-touch
  - launchd
  - topic-register
  - preflight
aliases:
  - SEO Brief Preflight
  - SEO Active Brief Repair
---

# SEO Active Brief 确定性 Preflight 设计

## 1. 背景与问题

SEO Blog LaunchAgent `com.gengrowth.seo-blog` 在固定时间触发后，会直接进入当晚的 reconcile / author / publish 流程。当前 active plan 对应的 Topic Register 语义修复由另一条独立 Automation 承担；如果该 Automation 延迟、失败或因锁竞争未实际运行，SEO Blog 仍可能读取过期或错误的 brief。

近期实例中，`PG-WDIF-002` 的 active plan 目标是 `what_is_my_love_language`，但 Topic Register 中仍保留了错误的 cluster `why_do_i_feel_stuck_in_my_career`。这类错配不会由 cron 时间本身自动消失，并会使后续 author、review 和 publish 反复失败，最终退化为人工强制发布与人工回填。

根因不是发布 gate 单独“过严”，而是发布流水线在开始写作前没有把 active brief 的正确性纳入同一 fire 的强制前置条件。独立调度只提供最终一致性，无法提供本次 SEO fire 所需的顺序保证。

## 2. 目标与非目标

### 2.1 目标

- 在同一个 SEO fire 内，先确定性校正当前 active plan 的 brief，再允许进入 nightly author / publish。
- 只修复 pinned plan 中仍未完成的既有 page ID，不生成新主题，不扩大写入范围。
- 所有失败都在 author 之前硬停止，由下一次自然 cron 自动重试，不要求人工介入。
- 保留现有 Topic Register Automation 处理常规主题生成，但不再把它作为 SEO 发布正确性的依赖。
- 建立可自动验证的输入、输出、锁和失败契约，使该前置步骤可回归测试、可审计。

### 2.2 非目标

- 不放宽现有内容质量、来源、preview、review、publish 或线上验证 gate。
- 不允许通过该路径生成新 page ID、补充普通 backlog 或跨产品写入。
- 不增加人工审批、人工强制 publish 或手工 Sheet 回填步骤。
- 不替代 Topic Register 的常规 discovery、generate 和 audit 流程。
- 不在 preflight 中发送中间通知；仍由 SEO fire 的最终汇总承担通知责任。

## 3. 总体流程

`gg-seo-blog-launchd-tick.sh` 在取得全局 SEO fire 锁并完成既有 legacy / ownership 检查后，先运行 brief preflight；只有 preflight 明确成功，才进入既有 reconcile / nightly 流程。

```text
SEO cron fire
  -> 获取 SEO fire 锁
  -> legacy / ownership 检查
  -> 读取 pinned W22 plan 的 unchecked page IDs
  -> Topic Register semantic-repair-only preflight
       -> 输入集合为空：成功、无写入
       -> 仅校正 active existing rows
       -> 校验结构化输出与写入边界
  -> preflight 成功：进入既有 reconcile / author / publish
  -> preflight 失败：整轮停止，下一次自然 cron 重试
```

顺序保证由同一 wrapper 和同一 fire 提供；独立 Topic Register Automation 即使未运行，也不会再使 SEO 对错误 brief 开始写作。

## 4. `semantic-repair-only` 契约

### 4.1 调用面

为 Topic Register 增加显式模式 `--semantic-repair-only`，并由固定 wrapper 暴露对应环境开关 `GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY=1`。SEO preflight 通过固定 wrapper 调用，不直接绕过 wrapper 运行 Node 写入命令。

调用必须固定以下边界：

- `product=astrologywiki`
- `apply=1`
- `llm=none`
- `discover-evidence=0`
- `no-notify=1`
- target page IDs = 当前 pinned plan 的 unchecked page IDs
- limit = target page ID 数量
- `GG_TOPIC_REGISTER_REQUIRE_RUN=1`

`--apply` 在此模式下允许与 `llm=none` 同时使用，因为它只执行显式既有行的确定性语义校正；该例外不适用于 generate、普通 incomplete-row audit 或任何新主题生成路径。

### 4.2 候选选择

- 输入集合只来自当前 pinned W22 plan 的 unchecked page IDs。
- 只允许命中 Topic Register 中已有的同产品行。
- 不扫描或修复输入集合之外的普通 incomplete rows。
- 输入为空时返回结构化成功结果，写入数为 0；不把“今日无 active backlog”视为错误。
- 输入 page ID 在 Topic Register 中不存在、重复归属、跨产品或无法唯一解析时，preflight 失败，不进入 author。

### 4.3 允许的修复

- 正确的既有行保持 no-op。
- 只有确定性语义评分为 0、且现有字段与该 page ID 的 canonical scaffold 不匹配时，才允许 `semantic-repair-new`。
- `semantic-repair-new` 可以为该既有 page ID 写入确定性的新 cluster；它不是新 page ID，也不进入主题生成。
- 写入只限既有 Topic Register 行中由 semantic repair 所拥有的字段，其他人工字段和跨产品数据保持不变。

### 4.4 明确禁止

- 禁止进入 generate mode。
- 禁止创建新 page ID 或追加新主题行。
- 禁止调用 LLM、趋势发现或 evidence discovery。
- 禁止普通 incomplete-row audit、backlog 扩张或跨产品写入。
- 禁止输出或写入任何不属于本次 active input set 的 page ID。
- 禁止把普通空跑、锁跳过或结构化结果缺失伪装为已完成运行。

## 5. 输出与写入证明

preflight 必须消费 Topic Register wrapper 的结构化 JSON 结果，而不是仅依据进程退出码判断成功。结果至少包含：

- mode = `semantic-repair-only`
- product
- requested page IDs
- selected page IDs
- changed page IDs
- change reason / provenance
- created page ID count
- cross-product write count
- run status

进入 nightly 前必须同时满足：

1. wrapper 退出码为 0；
2. JSON 存在、可解析、mode 与 product 正确；
3. requested IDs 与 launcher 提供的 active set 一致；
4. selected IDs 和 changed IDs 都是 requested IDs 的子集；
5. created page ID count = 0；
6. cross-product write count = 0；
7. 每个新 cluster 的 provenance 都是 `semantic-repair-new`；
8. run status 明确表示本次实际执行，或输入为空时明确表示合法 no-op。

任一条件不满足都视为 preflight 失败。该校验同时防止未来 Topic Register 改动意外扩大 SEO fire 的写入范围。

## 6. Launcher 集成位置

在 `gg-seo-blog-launchd-tick.sh` 中新增一个独立、可测试的 brief preflight 函数，放置顺序为：

1. 获取既有全局 SEO fire 锁；
2. 执行既有 legacy / ownership / runtime 检查；
3. 解析 pinned W22 plan 的 unchecked page IDs；
4. 调用 Topic Register fixed wrapper 的 `semantic-repair-only` 模式；
5. 校验结构化结果与写入证明；
6. 成功后才调用既有 reconcile / nightly 入口。

launcher 不自行实现 Topic Register 的业务修复逻辑，只负责确定 target set、调用固定入口、验证证明和决定是否放行。这样可保持语义修复只有一个实现来源。

## 7. 锁、失败与重试语义

### 7.1 Topic Register 锁

现有 Topic Register wrapper 的“锁忙则跳过并返回成功”语义不适合作为强制 preflight。新增 `GG_TOPIC_REGISTER_REQUIRE_RUN=1` 后：

- 锁可得：实际运行并返回结构化结果；
- 锁忙：返回非零，并输出明确的 lock-busy 原因；
- 不改变独立 Topic Register Automation 的默认 quiet skip 行为。

SEO fire 不等待或抢占 Topic Register 锁，也不删除锁文件。锁忙时整轮在 author 前停止，由下一次 30 分钟自然 SEO cron 重试。

### 7.2 失败策略

以下任一情况均在 author 前失败：

- wrapper 非零退出；
- lock busy 且要求实际运行；
- JSON 缺失、损坏或字段不完整；
- 输入 page ID 无法解析为唯一的同产品既有行；
- selected / changed target 超出 active set；
- 生成新 page ID、跨产品写入或进入 generate mode；
- 新 cluster provenance 不是 `semantic-repair-new`；
- 任何写入计数无法证明处于允许边界。

失败时不调用 nightly、不强制 publish、不手工回填，也不发送单独的中间通知。最终 fire 汇总记录失败阶段和机器可读原因；下一次自然 cron 使用相同确定性入口重试。

## 8. 状态与通知边界

- preflight 不拥有 claims、repair event、publish log 或 plan completion 的终态写入。
- preflight 只拥有 Topic Register 中允许字段的确定性既有行修复。
- author / review / publish / reconcile 继续由现有 SEO autopilot 状态机负责。
- 独立 Topic Register Automation 继续负责常规主题发现和生成，但它不再是 active SEO fire 的 correctness dependency。
- preflight 使用 `no-notify=1`；用户可见通知仍保持每个 SEO fire 最终一次汇总，避免重复提醒。

## 9. 测试设计

### 9.1 Topic Register 单元与集成测试

- `semantic-repair-only` 永不进入 generate mode。
- 该模式不会创建新 page ID 或追加新行。
- target 为空时成功且零写入。
- 只选择显式 active IDs；普通 incomplete rows 不被扫描或修改。
- 正确行是 no-op；确定性零分错配行才产生 `semantic-repair-new`。
- 新 cluster 只有 `semantic-repair-new` provenance 才可写入。
- 跨产品、未知或重复 page ID 失败。
- 非该模式下，原有 `apply + llm=none` 安全限制保持不变。

### 9.2 Wrapper 测试

- 环境变量映射为预期的 mode、product、target、limit、apply 和 no-notify 参数。
- `GG_TOPIC_REGISTER_REQUIRE_RUN=1` 时 lock busy 返回非零；默认模式仍保留原有 quiet skip。
- wrapper 始终产生可供 launcher 校验的结构化结果；失败时给出稳定 reason code。

### 9.3 SEO Launcher 测试

- preflight 非零、JSON 缺失、JSON 损坏或输出越界时，不调用 nightly。
- created page ID、cross-product write 或错误 provenance 非零时，不调用 nightly。
- target 为空的合法 no-op 可以继续 nightly。
- preflight 成功后，按既有顺序调用 reconcile / nightly。
- preflight 不产生重复通知。
- 自然下一 fire 能在前一轮 lock busy 或临时错误消失后重试并继续。

## 10. 发布与验收

### 10.1 上线前验证

- 新增测试先失败，再实现最小改动使其通过。
- 运行 Topic Register、SEO launcher、autopilot、reconcile 相关回归测试。
- 执行 shell syntax、Node syntax、diff check 和状态契约检查。
- 使用 fixture 证明错误 active brief 被修复、正确 brief 保持不变、范围外行完全不变。

### 10.2 自然 cron 验收

不通过人工强制 publish 或手工 Sheet 写入验收。首个自然验收周期应完成：

- `PG-WDIF-002` 的错误 cluster 被 preflight 校正；
- `PG-TRANS-021` 的已通过内容保持可发布状态；
- `PG-WDIN-001` 经自然 author / repair / review 完成；
- 三篇文章自然 publish；
- plan、publish log、Google Sheet、Vault 与 live URL 状态由既有 reconciler 收敛一致；
- claims non-done、active repairs、outbox、needs-human/writeback drift 均为 0。

完成首轮发布后，还需要连续 3 个自然 cron 窗口满足：

- 无人工介入；
- 无强制 publish；
- 无手工回填；
- 无 active repair、needs-human 或 writeback drift；
- readiness / reconciler 保持终态一致；
- 未出现因 brief 错配导致的重复 author / review 失败。

只有三窗自然运行证据全部成立，才把“0 人值守”目标判定为完成。

## 11. 已确认决策

- 采用同一 SEO fire 内的强制 brief preflight，而不是依赖独立 Topic Register 调度的先后顺序。
- 采用 fail-closed：无法证明 preflight 实际运行且未越界时，禁止进入 author。
- 允许确定性 existing-row semantic repair 使用 `apply + llm=none`，但不放宽任何生成路径。
- 锁忙不抢锁、不删锁、不人工接管；下一次自然 SEO cron 重试。
- 保留现有质量 gate，不用降低质量标准来换取自动上线。
- 以自然发布和连续 3 个自然 cron 窗口作为最终验收，而不是以代码合并或单次测试通过作为完成标准。
