---
title: SEO 异常触发 Agent Repair Hook 设计
date: 2026-07-15
updated: 2026-07-15
type: plan
version: v1.0
status: review
owner: wzb
tags:
  - seo
  - agentic-repair
  - launchd
  - needs-human
  - automation
aliases:
  - SEO Agent Repair Hook
  - SEO needs_human 自动修复
---

# SEO 异常触发 Agent Repair Hook 设计

## 1. 决策

采用方案 A：**macOS LaunchAgent 直接启动正常写作/发布；只有异常、报错或可处理的 `needs_human` 才启动一次性 Codex Agent repair hook。**

Codex Automation `gengrowth-seo-blog` 保持 `PAUSED`，不恢复其内部定时调度。系统不新增第二个 repair scheduler，也不重新启用 `com.gengrowth.flow-driver`。

本设计替代以下旧决策：

- `docs/superpowers/specs/2026-07-13-macos-scheduler-consolidation-design.md` 中“SEO 每个 tick 先启动 Codex CLI、再由 prompt 启动 wrapper”的部分；Notes 调度和单执行器约束不变。
- `docs/superpowers/specs/2026-07-07-flow-driver-overlay-design.md` 中“单独启动 `com.gengrowth.flow-driver` lane”的部分；其 triage、重过门、回填到收敛等能力继续复用，但改为主 LaunchAgent 内的事件触发 hook。

## 2. 目标与成功标准

### 2.1 目标

1. 干净的 SEO 写作/发布批次不消耗 Codex Agent。
2. 写作、preview、review、merge 或回填出现异常时，系统自动启动一次性 Agent，代替过去的人工接管动作。
3. Agent 负责修复和推进流程，但发布资格仍由现有确定性 gate 决定。
4. 每篇进入明确终态：已发布并回填、明确归档，或达到有界修复上限后成为去重的真正 human-only。

### 2.2 成功标准

- 正常运行时 `codex exec` 调用数为 0。
- 出现 eligible park 或 run-level error 时，同一错误指纹只触发一次在途 Agent，最多尝试 2 次。
- 修复后的文章必须重新通过 preview verify、三维 review、Codex fact gate 和 merge 前状态校验。
- 发布后的 ledger、生产 URL、canonical、Article JSON-LD、sitemap、plan、publish-log 和 Google Sheet 回填全部通过确定性验证。
- Codex Automation 仍为 `PAUSED`，旧 SEO/flow-driver LaunchAgent 仍禁用且未加载。
- 并发运行、hook 崩溃、状态文件损坏或 Agent 超时均不会造成无限重试或绕过 gate。

## 3. 运行架构

### 3.1 唯一调度入口

`com.gengrowth.seo-blog` 仍是唯一 SEO 时间调度器，保持现有 18:30–21:30 每半小时一次的 `StartCalendarInterval`。

`tools/scripts/gg-seo-blog-launchd-tick.sh` 改为：

1. 校验启动时窗、外层单飞锁、旧执行器冲突和 clean Oracle automation baseline。
2. 记录 `RUN_START`、ledger 快照和 nightly 日志起始偏移。
3. **直接**执行 `bash tools/scripts/gg-nightly-seo.sh`，不读取 Automation TOML，不在正常路径启动 Codex。
4. 读取 wrapper 退出码、精确日志窗口和运行后的 ledger。
5. 调用 repair selector；selector 为空则结束，非空才启动 repair hook。
6. hook 结束后运行终态 verifier，写入一条最终汇总并退出。

外层 LaunchAgent 锁覆盖正常主链和 repair hook。上一个 hook 尚未结束时，下一个日历 tick 只记录 skip，不并发启动第二轮。

### 3.2 组件边界

| 组件 | 职责 | 不负责 |
|---|---|---|
| `gg-seo-blog-launchd-tick.sh` | 唯一调度入口、直跑 nightly、采集运行窗口、按 selector 结果启动 hook | 不理解内容、不直接修稿 |
| `tools/scripts/lib/seo-repair-hook.mjs` | 纯 selector/state：识别目标、计算错误指纹、规划 attempt/cap/terminal | 不运行 LLM、不发布 |
| `tools/scripts/gg-seo-repair-hook.mjs` | 原子持久化 attempt，使用 prompt 模板启动一次性 `codex exec` | 不决定绕过 gate、不创建第二 scheduler |
| `tools/scripts/prompts/gg-seo-repair-hook.txt` | 定义一次性 Agent 的输入契约、允许入口和安全边界 | 不保存运行时状态 |
| `tools/scripts/gg-seo-repair-verify.mjs` | 复核 publish、live 和 backfill 后置条件 | 不接受 Agent 的文字自报作为成功证据 |
| `~/gengrowth-agents/flow-state/seo-repair-hook.json` | 保存错误指纹、尝试次数、在途与终态 | 不作为内容或业务 ledger |

runner 与 hook 都从 `~/.config/gg/_gg.env` 加载环境。功能开关为 `GG_SEO_REPAIR_HOOK_ENABLED=1`；上限可由 `GG_SEO_REPAIR_MAX_TARGETS`、`GG_SEO_REPAIR_MAX_ATTEMPTS` 和 `GG_SEO_REPAIR_TIMEOUT_SECONDS` 覆盖，但默认值固定为 2、2、2700。Codex executable 只在 selector 非空且 hook 已启用时检查；clean path 不因 Codex 缺失而失败。

## 4. 触发契约

### 4.1 会触发 Agent 的情况

selector 只检查 pinned AstrologyWiki plan 中仍未完成的目标，满足任一条件即形成 repair target：

1. wrapper 非零退出，且精确日志窗口能形成 run-level error fingerprint；
2. ledger 中存在 `status=needs_human` 且尚未达到该错误指纹的尝试上限；
3. 本轮出现“无 passing draft”“publish scan 无 branch”“gate parked”或 pending merge/backfill，且没有进入可验证终态；
4. 之前已存在但 nightly 因 `needs_human` 跳过的 park，只要仍属于当前 pinned plan 且未达到 cap，也必须被选中，不能因不是本轮新增而永久遗漏。

### 4.2 不会触发 Agent 的情况

- wrapper 成功且 selector 为空；
- 已发布并通过终态 verifier；
- 已按明确理由归档的 stale/错误前提主题；
- 相同错误指纹已尝试 2 次并进入 terminal；
- 另一个 hook 持有有效锁；
- 状态目录不可写、sidecar 无法解析或无法保证 attempt cap；此时 fail closed，并发送一次基础设施终态告警。

### 4.3 错误指纹与尝试上限

指纹输入为：

```text
page_id + stage + normalized_error
```

`normalized_error` 去除时间戳、PID、临时目录、preview hostname 等易变噪声后计算 SHA-256。状态必须在启动 Agent **之前**原子写入，避免进程崩溃导致同一错误无限重启。

sidecar 写入复用 `lib/flow-state.mjs` 的 vault 外状态目录，并采用同目录临时文件加 `rename`；旧文件解析失败或目录不可写时不允许启动 Agent。

固定上限：

- 同一错误指纹最多 2 次 Agent 尝试；
- 单个 scheduler tick 最多选择 2 篇；
- 单次 Agent 最长 45 分钟；
- 同一时刻最多 1 个 Agent hook；
- 错误指纹变化后视为新的、可验证的问题，重新获得 2 次尝试额度；
- 21:30 后不启动新的 nightly，但 21:30 前已经启动的主链或 hook 可以继续完成，不在 22:00 强杀在途发布。

## 5. Agent 修复契约

### 5.1 输入

hook 只向 Codex 提供本轮必要上下文：

- `RUN_START` / 当前时间；
- 精确 nightly 日志窗口；
- 被选中的 `page_id`、keyword、slug、stage、branch、error、attempt；
- 当前 ledger 条目和 plan 路径；
- Oracle automation baseline 路径；
- 允许使用的既有修复/验证入口与安全边界。

hook 不再读取 `~/.codex/automations/gengrowth-seo-blog/automation.toml` 作为 prompt，也不读取或跨仓回退到 `ai-profile/lynne-soul.md`。

### 5.2 按阶段修复

- **transient authoring**：复用 `--auto-retry-parks` 或 `--retry-author --task`，然后定向 `--author --task`。
- **fixable authoring**：依据 phase2/author repair 失败证据做一次有界重写，再跑 phase2；通过后执行该 `page_id` 的定向 scan 和 preview gate。
- **pushed/verified preview**：复用 `--retry-failed --branch` 和 `gg-preview-gate.mjs`；gate 内的 surgical repair 仍最多执行其既有上限。
- **pending merge/live/backfill**：只从已验证状态继续 merge、部署传播等待、live verify 和 backfill loop。
- **stale/错误前提**：不发布；写入带证据的归档终态并退出活跃修复队列。
- **凭据、权限、缺失源数据或安全边界**：不得猜测或绕过；达到 cap 后保留真正 human-only，并发送一次去重终态告警。

Agent 不得再次启动顶层 `gg-nightly-seo.sh`，避免撞外层锁或重复扫整批；只能处理 selector 给出的目标。

### 5.3 “强制 publish”的定义

“强制”只表示 Agent 不停在 authored、preview pushed、waiting merge 或 pending backfill 等中间态，而是主动调用现有流程继续推进。

以下行为永远禁止：

- 手工把 ledger 改成 `verified-preview` 或 `done`；
- 绕过 preview verify、三维 review 或 Codex fact gate；
- 对 FAIL 内容直接调用 merge；
- 为了过门而删除事实风险、CTA 审计字段或 Related Reading；
- 对普通文章调用 Google Indexing API，或无人值守点击 GSC Request Indexing；
- 使用破坏性 git/filesystem 命令或覆盖用户的 dirty worktree。

## 6. 终态验证与回填

Agent 退出后，runner 必须使用确定性数据重新判定结果，不接受 prompt 输出中的“已完成”作为证据。

### 6.1 发布终态

每篇声称发布成功的文章必须同时满足：

1. ledger 为 `done`，存在 branch/slug/merge 时间证据；
2. 生产 URL 返回 200；
3. canonical 精确指向生产 URL；
4. 页面含有效 Article JSON-LD；
5. sitemap 包含该 slug；
6. CTA 继续满足 CTA Map intent routing，Related Reading 保持独立；
7. plan 已勾选，publish-log 已追加，选题登记表的发布状态和 URL 已回填；
8. pending-writeback/backfill loop 已收敛，或明确记录未收敛步骤并进入下一次有界 repair。

### 6.2 非发布终态

- `archived`：必须有明确 stale/错误前提证据和去重 sidecar 状态；不会在后续 tick 重复触发。
- `human_only`：必须记录尝试次数、最后错误、日志路径和所需人工动作；同一指纹只通知一次。
- Agent 自身失败或超时：算作本指纹的一次尝试；未到 cap 可在下个 tick 重试，到 cap 后进入 `human_only`。

## 7. 可观测性与通知

- launchd 日志记录：run window、nightly exit code、selector 目标数、Agent PID/attempt/timeout、verifier 结果。
- repair Agent 使用独立日志目录 `~/gengrowth-agents/cron-sync/seo_repair_hook/`，按日期追加。
- 正常无异常运行静默，不发送 hook 通知。
- 修复成功、归档或达到 human-only 时只发送一条批次终态汇总；不发送“开始修复”“正在 review”等中间态。
- 通知发送失败进入现有 outbox，下一次正常 wrapper 开始时重放。

## 8. Lynne Soul 指令污染清理

repair hook 上线前必须同步清理直接影响其运行的错误项目指令：

1. 将 flow 仓库 `AGENTS.md` 的项目名称从 `GenGrowth Wiki` 修正为当前 flow 项目；
2. 删除将 `ai-profile/lynne-soul.md` 声明为 flow 项目所有者档案的硬编码，不跨仓加载个人 profile；
3. 从暂停的 `gengrowth-seo-blog` Automation prompt 删除 Lynne soul 读取和“Codex Automation 是唯一调度入口”的旧声明，状态仍保持 `PAUSED`；
4. repair hook prompt 只使用 flow 项目级规则、精确失败证据和确定性命令，不继承团队成员个人 soul。

该清理只移除错误归属，不修改 Lynne 在 gengrowth-wiki 中的真实个人档案。

## 9. 测试策略

### 9.1 单元测试

- selector：clean、run error、新 park、旧 park、已归档、已到 cap、非 pinned plan。
- fingerprint：时间戳/PID/临时 hostname 变化不改变指纹；stage 或真实错误变化会改变。
- sidecar：attempt 在 spawn 前写入；原子写；损坏/不可写 fail closed。
- verifier：done 但 URL/canonical/JSON-LD/sitemap/backfill 任一缺失均不得判成功。

### 9.2 runner/hook smoke

- clean nightly：fake Codex 调用数为 0；
- 新 `needs_human`：fake Codex 恰好调用 1 次，并只收到目标条目；
- 旧但未处理 park：仍触发；
- 同指纹两次后：第三次不再 spawn，进入去重 human-only；
- wrapper 非零但无 claim：run-level synthetic target 触发一次；
- 外层锁存在：第二个 tick skip；
- Agent 超时/非零：计入 attempt，绝不误报 publish；
- runner 源码不再读取 Automation TOML，也不在 clean path 执行 `codex exec`。

### 9.3 回归与上线验证

- 运行 flow-driver、preview-gate、park-autoretry、CTA 和 backfill 现有测试；
- 运行完整 `tools/scripts/__tests__` 回归，并区分既有失败；
- `bash -n` 校验 shell，`plutil -lint` 校验 plist；
- 使用临时 ledger、临时 flow-state 和 fake Codex 完成端到端演练；
- 验证本机 Codex Automation 仍为 `PAUSED`，旧八个标签禁用且未加载；
- 不在测试中触发真实文章发布。正式启用后由下一个自然 launchd window 首次运行，并根据精确日志窗口验收。

## 10. 灰度与回退

1. 先落 selector、fingerprint、sidecar 和测试，hook 保持关闭。
2. 改 runner 为直接 nightly，并用 fake wrapper/fake Codex 验证 clean path 与异常 path。
3. 设置 `GG_SEO_REPAIR_HOOK_ENABLED=1` 后由自然 launchd window 启用，不额外创建或加载 job。
4. 首个真实异常只允许每 tick 1 篇；验证成功后把默认值提升到设计上限 2 篇。
5. 回退时只关闭 `GG_SEO_REPAIR_HOOK_ENABLED`；正常 nightly 直跑继续工作，Codex Automation 和旧 flow-driver lane 均不恢复。

## 11. 明确非目标

- 不把整个 happy path 改成 Agent 控制；
- 不恢复 Codex Automation 的 scheduler；
- 不新增 repair cron/LaunchAgent；
- 不自动处理 GSC Request Indexing 点击；
- 不重写 CTA 路由、author repair、preview gate 或 backfill 的已验证核心逻辑；
- 不保证事实错误或缺失凭据一定能发布，目标是自动推进到安全、可审计的终态。
