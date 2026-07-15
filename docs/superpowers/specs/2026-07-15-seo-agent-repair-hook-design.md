---
title: SEO 全流程统一修复控制器设计
date: 2026-07-15
updated: 2026-07-15
type: plan
version: v2.0
status: final
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
  - SEO Universal Repair Controller
---

# SEO 全流程统一修复控制器设计

## 1. 规范状态与决策

本文件 v2.0 是当前规范。采用已确认的方案 A：**保留现有 macOS 调度入口和正常业务 wrapper；任何异常由结构化事件进入单一、站点无关的 repair controller，再由 AstrologyWiki / Gengrowth adapter 调用原流程修复、重过 gate、发布和回填。**

第一版只覆盖本仓库内两站 SEO 内容生产闭环：

- AstrologyWiki：选题/写作、phase2、preview、三维 review、Codex fact gate、merge、上线、验证、回填。
- Gengrowth：选题/写作、phase2、事实门、Supabase 发布、线上验证、回填。

索引监控、GSC Request Indexing、结果复盘、报销、趋势雷达等其他自动化不纳入第一版。controller 只保留 adapter 接口，不提前实现这些流程。

Codex Automation `gengrowth-seo-blog` 继续保持 `PAUSED`；不新增 cron、LaunchAgent、轮询 supervisor 或第二执行器。旧 v1 hook 的已验证能力继续复用，但其 pinned W22、plan-order selector、attempt-cap→human-only 和单站 verifier 不再是规范。

## 2. 目标与验收标准

### 2.1 目标

1. clean path 不启动 Agent。
2. 所有可自动处理的异常都必须持续推进到 `published+backfilled` 或有证据的 `archived`，不能停在 authored、preview、needs_human、publish pending 或 writeback pending。
3. `human_only` 只允许用于不可委托的 OAuth/验证码/人工审批/权限、必须由账号所有者确认的授权，或缺失权威来源且不能安全推断的情况。
4. 内容、结构、事实、SVG/图片文字、内部链接、pipeline code、工具抖动、发布与回填问题均属于自动修复范围。
5. 发布资格始终由现有 gate 和确定性 verifier 决定；Agent 文字自报不构成成功证据。

### 2.2 成功标准

- 两站异常均进入同一个 durable queue，状态键为 `site + page_id + stage + fingerprint`。
- `codex exited 3` 等工具故障保留原始 stderr，不再只产生泛化摘要。
- `no_blind_retry` 与 `human_only` 分离：真实 FAIL 默认进入 `agent_fixable`，不提前宣布“彻底停止”。
- controller 是唯一用户终态通知发送者；legacy lane 不再发送 repairable needs_human 或重复告警。
- 单并发 drain 具备 aging、公平性、lease 超时恢复和跨 tick 持久化；`maxTargets` 不再导致后续目标饿死或误判人工。
- `PG-WLS-007`、`PG-TRANS-016`、`PG-TRANS-018` 真实修复、发布、线上验证和回填完成，且无重复 Feishu、残留 repair 锁或 pending queue。

## 3. 运行架构

```text
现有 launchd / author handoff
  -> 原业务 wrapper
  -> atomic event spool
  -> single repair controller
  -> site adapter
  -> deterministic recovery / target Agent
  -> original gate + publish path
  -> product terminal verifier
  -> published | archived | human_only
```

### 3.1 调度和锁

- `com.gengrowth.seo-blog` 继续负责 AstrologyWiki 既有窗口。
- `com.gengrowth.gengrowth-publish` 与 Gengrowth author handoff 继续负责 Lane A。
- 两站 wrapper 都可以原子入队事件；入队不要求取得 controller lock。
- 单一全局目录锁 `/tmp/gg-seo-repair-controller.lock` 只允许一个 controller drain。
- controller 已运行时，另一个 wrapper 只入队并退出；正在运行的 controller 在每个目标后重扫 spool，在总时间预算内继续处理。
- 未完成事件留在 durable queue，由下一次现有调度继续，不创建新 scheduler。

### 3.2 组件边界

| 组件 | 职责 |
|---|---|
| lane wrapper / publisher | 执行业务 happy path；异常时写结构化事件；v2 开启后不发 repairable 人工告警 |
| event spool | 每事件独立 JSON、原子入队、去重索引、崩溃可恢复 |
| controller core | 分类、优先级、lease、策略升级、全局 lock、唯一终态通知 |
| AstrologyWiki adapter | claim/plan/Oracle worktree/PR、preview gate、merge、生产与回填 verifier |
| Gengrowth adapter | staging/manifest/W25 plan、事实门、Supabase publish、生产与回填 verifier |
| one-shot Agent | 只处理精确 target；修正文/资产/链接/代码/发布状态；不得自证成功 |

现有 `gg-seo-repair-hook.mjs` 演进为 controller 兼容入口；旧调用参数可以转换为 v2 event，避免一次切换破坏已部署 LaunchAgent。

### 3.3 规范文件边界

- `tools/scripts/lib/seo-repair-events.mjs`：schema、原子 spool、fingerprint、lease 与 queue ordering。
- `tools/scripts/lib/seo-repair-controller.mjs`：分类、策略状态机、drain 和终态决策。
- `tools/scripts/lib/seo-repair-adapter-astrologywiki.mjs`：AstrologyWiki canonical action 与 verifier dependencies。
- `tools/scripts/lib/seo-repair-adapter-gengrowth.mjs`：Gengrowth canonical action 与 verifier dependencies。
- `tools/scripts/gg-seo-repair-controller.mjs`：统一 CLI；`gg-seo-repair-hook.mjs` 保留为 v1 参数兼容 shim 并委托该 CLI。
- `tools/scripts/prompts/gg-seo-repair-controller.txt`：站点无关 Agent 契约和 target JSON；不保存运行态。

业务 wrapper 只能通过 events API 入队并调用 controller CLI；不得各自复制 selector、attempt cap 或通知逻辑。

## 4. 结构化事件与持久化

### 4.1 事件格式

每个异常事件至少包含：

```json
{
  "schemaVersion": 2,
  "eventId": "uuid",
  "runId": "site-lane-time",
  "site": "astrologywiki|gengrowth",
  "lane": "author|preview|publish|backfill|run",
  "pageId": "PG-...|RUN",
  "slug": "optional",
  "stage": "exact failing stage",
  "errorKind": "tool_exit|timeout|gate_fail|asset_fail|link_fail|state_fail|auth|source|stale",
  "summary": "stable concise reason",
  "stderr": "bounded raw stderr",
  "logFile": "absolute authoritative log path",
  "logOffsetStart": 0,
  "logOffsetEnd": 0,
  "canonicalRetry": ["executable", "arg1"],
  "createdAt": "ISO-8601"
}
```

`canonicalRetry` 必须是 argv 数组，不接受 shell 字符串；adapter 只允许白名单入口。secret 不写入事件。

### 4.2 Spool 与状态

- 路径：`~/gengrowth-agents/flow-state/seo-repair-queue/`。
- 入队：同目录临时文件写完、fsync/close 后 `rename` 为 `<eventId>.json`。
- 指纹：`site + pageId + stage + normalized(summary + stable stderr tail)`；时间戳、PID、临时路径、preview hostname 去噪。
- 相同活跃指纹合并观察次数和最新证据，不重复启动 Agent、不重复通知。
- processing state 保存 lease owner/start/expiry、策略、attempt、上次结果和下一次 eligible 时间。
- lease 过期时自动回 `queued`；损坏事件隔离到 `quarantine` 并产生一次 controller infrastructure event，不静默丢失。

## 5. 状态机与错误分类

### 5.1 状态机

```text
detected -> queued -> repairing -> regating
                                  |-> published+backfilled
                                  |-> archived
                                  |-> human_only
                                  `-> repair_pending(backoff)
```

- `repair_pending` 不是终态，也不通知人工。
- 单次策略达到尝试上限时升级策略或进入慢速 backoff；不得仅因 attempt cap 变成 `human_only`。
- 错误指纹变化时创建新诊断代际，但保留父事件链，避免 cap 被无意清零。

### 5.2 分类

| 分类 | 示例 | 处理 |
|---|---|---|
| `transient` | exit 3、timeout、quota、network | 定向重试；持续失败转 Agent 诊断 |
| `deterministic_fixable` | lock/state reconcile、known backfill、可机械结构修复 | 运行既有确定性入口后重过门 |
| `agent_fixable` | 内容/事实 FAIL、SVG、内部链接、代码缺陷 | 启动目标 Agent 修复后重过门 |
| `nondelegable` | OAuth 登录、验证码、人工审批、无权限、缺权威来源 | 使用现有安全授权路径仍失败后才 `human_only` |
| `unpublishable` | 已过时且明确不应发布、错误前提、重复主题 | 保存证据并 `archived` |

旧 `classifyPark(...)=permanent` 只保留“不可盲目机械重试”的含义，不再拥有终态通知权。真实 review/Codex FAIL 通过 `triagePark` 或 v2 classifier 进入 `agent_fixable`，除非有明确 unpublishable 证据。

## 6. 队列、公平性与预算

- 并发固定为 1，避免跨站写入、worktree、Sheet 和 publish 冲突。
- 优先级基础权重：已上线待回填 > 已验证待 merge/live > publish/gate > authored/authoring > run-level infrastructure。
- aging 每等待一个调度周期提高优先级，保证低层级目标最终获得执行；同级 FIFO。
- controller 单次运行有总时间预算，单目标有 lease/timeout；预算用尽后安全落盘并退出。
- `maxTargets` 只限制单次实际执行量，不改变其他事件的 queued 状态，不触发 human-only 或通知。
- 每个策略有独立预算；确定性重试耗尽后升级 Agent，Agent 内容修复耗尽后升级代码/环境诊断，仍未收敛则慢速 repair_pending。

## 7. 修复能力与 adapter 契约

### 7.1 共同行为

Agent 必须：

1. 读取 exact event、claim/manifest、日志窗口和当前 live 状态。
2. 找到失败所在层，不重复顶层全批 wrapper。
3. 只修改 target 所需的最小正文、资产、链接、代码或状态恢复路径。
4. pipeline code 缺陷在隔离 worktree/branch 中按 TDD：先复现失败，再实现单一修复，运行定向与相关回归；不得修改活跃运行 checkout。
5. 调用 adapter 的 canonical re-gate/re-publish 入口。
6. 等待确定性 verifier；失败则记录新证据并回队列。

### 7.2 AstrologyWiki adapter

- author/phase2：`--retry-author --task`、定向 author、phase2。
- preview/review：`--retry-failed --branch`、`gg-preview-gate.mjs`。
- 资产：允许修复目标 worktree 的 SVG/图片可读文字和关联元数据，再重新 preview/Codex 审核完整 diff。
- 链接：只使用可通过 repo route、sitemap 或生产 200 验证的真实 slug；不得臆造。
- merge/live/backfill：沿现有 reviewed-head guard、merge、部署传播、`gg-backfill-one` 和 verifier 推进。

### 7.3 Gengrowth adapter

- author/phase2：复用 Gengrowth pinned plan、定向 author/handoff 和 manifest。
- `SKIPPED/tool_exit`：保留 reviewer stderr，定向重跑 `gg-codex-pr-review.mjs --source`；PASS 后调用 `gg-gengrowth-publish.mjs --apply --pages <PID> --limit 1`，不撞外层 wrapper lock。
- 真实 FAIL：调用 Lane A gate repair，或由 Agent 修正文/资产/来源，再重新 phase2 + fact gate。
- publish/live/backfill：Supabase published row、生产页面、canonical、Article JSON-LD、sitemap、W25 plan、Sheet、vault 和 pending-writeback 全部验证。

## 8. 终态验证

### 8.1 Published

两站共同必须满足：生产 URL 200、canonical 精确、Article JSON-LD、sitemap、plan checked、Sheet 状态/URL、vault archive、pending-writeback 清零、通知幂等键存在。

AstrologyWiki 另需 claim `done`、branch/PR merged、reviewed head 与 CTA Map/Related Reading 验证。Gengrowth 另需 Supabase `status=published`、目标 staging manifest pass、W25 plan 精确匹配。

### 8.2 Archived 与 Human-only

- `archived` 必须包含可复核 stale/错误前提/重复证据，且不会再次入活跃队列。
- `human_only` 必须包含 external action type、已尝试的安全授权路径、准确日志与用户所需最小动作；同一指纹只通知一次。
- 内部代码问题、内容 FAIL、工具失败或“Agent 两次没修好”均不满足 human-only 定义。

## 9. 通知所有权

- v2 开启时，legacy `auto-retry-parks`、batch summary 和 Gengrowth publisher 对 repairable 异常只写 event/log，不直接 @ 人。
- controller 仅在 `published`、`archived`、`human_only` 发送一次终态通知；`queued/repairing/regating/repair_pending` 静默。
- 批次 summary 可以在本地日志记录 pending 数，不在 Feishu 把 pending 描述为“暂停待人工”。
- 通知幂等键使用 `terminal + site + pageId + fingerprint`；发送失败进入既有 outbox。

## 10. 安全边界

- 不绕过 preview verify、三维 review、Codex fact gate、reviewed-head merge guard、CTA Map、Supabase/live verifier。
- 不手工把 claim/ledger 改成 verified/done，不把 `GG_CODEX_GATE_REQUIRED` 设为 0 作为修复。
- 不使用破坏性 git/filesystem 命令，不覆盖交互 dirty worktree。
- 不对普通文章调用 Google Indexing API，不无人值守点击 GSC Request Indexing。
- 可使用现有凭据、权限和安全授权 wrapper；不得冒充用户绕过 OAuth 登录、验证码、人工审批或账号所有者确认。
- 不读取或跨仓回退到个人 soul/profile。

## 11. TDD 与回归策略

### 11.1 必须先失败的回归用例

1. Gengrowth `codex exited 3`：raw stderr 入队、publisher 不通知、controller 重跑 PASS 后发布回填。
2. AstrologyWiki SVG factual FAIL：旧正文-only repair 失败，v2 Agent/adapter 修 SVG 后完整 diff gate PASS。
3. AstrologyWiki links-seo FAIL：只选择已验证真实 slug，重过 links review。
4. `maxTargets=1`：第二/第三目标保持 queued 并因 aging 获得执行，不被 human-only。
5. `no_blind_retry`：不触发 legacy permanent notification。
6. controller busy：第二站事件成功入队，无双 Agent。
7. controller crash：lease 到期重排，不重复 terminal notify。
8. clean path：Codex Agent 调用数为 0。
9. nondelegable 与 unpublishable：分别得到一次 human-only / archived。

### 11.2 验证层级

- pure unit：event schema、fingerprint、taxonomy、priority aging、lease、terminal rules。
- hermetic adapter E2E：fake Codex、fake gate、fake Supabase/HTTP/Sheet、fake notify。
- shell/static：`bash -n`、plist lint、legacy notify ownership invariant。
- 定向真实只读验证：当前 claims、staging、PR、生产和 Sheet。
- 完整 `tools/scripts/__tests__/*.test.mjs` 回归，区分并记录既有失败。

## 12. 上线、回退与当前真实验收

### 12.1 原子切换

单一开关 `GG_SEO_REPAIR_CONTROLLER_V2_ENABLED=1` 同时启用 controller v2 和 legacy repairable 通知抑制；不能分两步部署，避免“事件无人处理”或“双重通知”窗口。关闭开关恢复 v1 行为。

上线顺序：

1. event/core/queue 与 tests，开关关闭；
2. 两站 adapter 与 legacy notify invariant；
3. hermetic E2E、定向和完整回归；
4. 确认活跃旧 scheduler 结束、锁释放后同步到运行 checkout；
5. 开启 v2；原子导入当前三条异常事件；
6. controller 顺序修复并真实验收。

### 12.2 本次完成定义

本任务只有在以下全部成立时完成：

- `PG-WLS-007 / chatgpt-seo`：事实门 PASS、Gengrowth live published、W25/Sheet/vault/writeback 全部收敛。
- `PG-TRANS-016 / saturn-return-age-29`：错误 SVG 已修、完整 preview/review/Codex gate PASS、merged/live/backfilled。
- `PG-TRANS-018 / saturn-return-in-capricorn`：有效站内链接修复、完整 gate PASS、merged/live/backfilled。
- 三条事件在 v2 state 为 terminal，queue 无同指纹活跃项。
- Feishu 不再出现同类重复 needs_human/“彻底停止”告警；只保留每目标一次最终成功或真实终态。
- controller、lane、worktree 和 publish 锁清空，无残留 Agent/publish/backfill 进程。

下方附录保存 v1 已实施基线与 2026-07-15 首次真实 backfill 验收，供迁移对照；其规范性被本 v2 正文取代。

## 附录 A：v1 已实施基线（非规范）

### A.1 决策

采用方案 A：**macOS LaunchAgent 直接启动正常写作/发布；只有异常、报错或可处理的 `needs_human` 才启动一次性 Codex Agent repair hook。**

Codex Automation `gengrowth-seo-blog` 保持 `PAUSED`，不恢复其内部定时调度。系统不新增第二个 repair scheduler，也不重新启用 `com.gengrowth.flow-driver`。

本设计替代以下旧决策：

- `docs/superpowers/specs/2026-07-13-macos-scheduler-consolidation-design.md` 中“SEO 每个 tick 先启动 Codex CLI、再由 prompt 启动 wrapper”的部分；Notes 调度和单执行器约束不变。
- `docs/superpowers/specs/2026-07-07-flow-driver-overlay-design.md` 中“单独启动 `com.gengrowth.flow-driver` lane”的部分；其 triage、重过门、回填到收敛等能力继续复用，但改为主 LaunchAgent 内的事件触发 hook。

### A.2 目标与成功标准

#### A.2.1 目标

1. 干净的 SEO 写作/发布批次不消耗 Codex Agent。
2. 写作、preview、review、merge 或回填出现异常时，系统自动启动一次性 Agent，代替过去的人工接管动作。
3. Agent 负责修复和推进流程，但发布资格仍由现有确定性 gate 决定。
4. 每篇进入明确终态：已发布并回填、明确归档，或达到有界修复上限后成为去重的真正 human-only。

#### A.2.2 成功标准

- 正常运行时 `codex exec` 调用数为 0。
- 出现 eligible park 或 run-level error 时，同一错误指纹只触发一次在途 Agent，最多尝试 2 次。
- 修复后的文章必须重新通过 preview verify、三维 review、Codex fact gate 和 merge 前状态校验。
- 发布后的 ledger、生产 URL、canonical、Article JSON-LD、sitemap、plan、publish-log 和 Google Sheet 回填全部通过确定性验证。
- Codex Automation 仍为 `PAUSED`，旧 SEO/flow-driver LaunchAgent 仍禁用且未加载。
- 并发运行、hook 崩溃、状态文件损坏或 Agent 超时均不会造成无限重试或绕过 gate。

### A.3 运行架构

#### A.3.1 唯一调度入口

`com.gengrowth.seo-blog` 仍是唯一 SEO 时间调度器，保持现有 18:30–21:30 每半小时一次的 `StartCalendarInterval`。

`tools/scripts/gg-seo-blog-launchd-tick.sh` 改为：

1. 校验启动时窗、外层单飞锁、旧执行器冲突和 clean Oracle automation baseline。
2. 记录 `RUN_START`、ledger 快照和 nightly 日志起始偏移。
3. **直接**执行 `bash tools/scripts/gg-nightly-seo.sh`，不读取 Automation TOML，不在正常路径启动 Codex。
4. 读取 wrapper 退出码、精确日志窗口和运行后的 ledger。
5. 调用 repair selector；selector 为空则结束，非空才启动 repair hook。
6. hook 结束后运行终态 verifier，写入一条最终汇总并退出。

外层 LaunchAgent 锁覆盖正常主链和 repair hook。上一个 hook 尚未结束时，下一个日历 tick 只记录 skip，不并发启动第二轮。

#### A.3.2 组件边界

| 组件 | 职责 | 不负责 |
|---|---|---|
| `gg-seo-blog-launchd-tick.sh` | 唯一调度入口、直跑 nightly、采集运行窗口、按 selector 结果启动 hook | 不理解内容、不直接修稿 |
| `tools/scripts/lib/seo-repair-hook.mjs` | 纯 selector/state：识别目标、计算错误指纹、规划 attempt/cap/terminal | 不运行 LLM、不发布 |
| `tools/scripts/gg-seo-repair-hook.mjs` | 原子持久化 attempt，使用 prompt 模板启动一次性 `codex exec` | 不决定绕过 gate、不创建第二 scheduler |
| `tools/scripts/prompts/gg-seo-repair-hook.txt` | 定义一次性 Agent 的输入契约、允许入口和安全边界 | 不保存运行时状态 |
| `tools/scripts/gg-seo-repair-verify.mjs` | 复核 publish、live 和 backfill 后置条件 | 不接受 Agent 的文字自报作为成功证据 |
| `~/gengrowth-agents/flow-state/seo-repair-hook.json` | 保存错误指纹、尝试次数、在途与终态 | 不作为内容或业务 ledger |

runner 与 hook 都从 `~/.config/gg/_gg.env` 加载环境。功能开关为 `GG_SEO_REPAIR_HOOK_ENABLED=1`；上限可由 `GG_SEO_REPAIR_MAX_TARGETS`、`GG_SEO_REPAIR_MAX_ATTEMPTS` 和 `GG_SEO_REPAIR_TIMEOUT_SECONDS` 覆盖，但默认值固定为 2、2、2700。Codex executable 只在 selector 非空且 hook 已启用时检查；clean path 不因 Codex 缺失而失败。

### A.4 触发契约

#### A.4.1 会触发 Agent 的情况

selector 只检查 pinned AstrologyWiki plan 中仍未完成的目标，满足任一条件即形成 repair target：

1. wrapper 非零退出，且精确日志窗口能形成 run-level error fingerprint；
2. ledger 中存在 `status=needs_human` 且尚未达到该错误指纹的尝试上限；
3. 本轮出现“无 passing draft”“publish scan 无 branch”“gate parked”或 pending merge/backfill，且没有进入可验证终态；
4. 之前已存在但 nightly 因 `needs_human` 跳过的 park，只要仍属于当前 pinned plan 且未达到 cap，也必须被选中，不能因不是本轮新增而永久遗漏。

#### A.4.2 不会触发 Agent 的情况

- wrapper 成功且 selector 为空；
- 已发布并通过终态 verifier；
- 已按明确理由归档的 stale/错误前提主题；
- 相同错误指纹已尝试 2 次并进入 terminal；
- 另一个 hook 持有有效锁；
- 状态目录不可写、sidecar 无法解析或无法保证 attempt cap；此时 fail closed，并发送一次基础设施终态告警。

#### A.4.3 错误指纹与尝试上限

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

### A.5 Agent 修复契约

#### A.5.1 输入

hook 只向 Codex 提供本轮必要上下文：

- `RUN_START` / 当前时间；
- 精确 nightly 日志窗口；
- 被选中的 `page_id`、keyword、slug、stage、branch、error、attempt；
- 当前 ledger 条目和 plan 路径；
- Oracle automation baseline 路径；
- 允许使用的既有修复/验证入口与安全边界。

hook 不再读取 `~/.codex/automations/gengrowth-seo-blog/automation.toml` 作为 prompt，也不读取或跨仓回退到 `ai-profile/lynne-soul.md`。

#### A.5.2 按阶段修复

- **transient authoring**：复用 `--auto-retry-parks` 或 `--retry-author --task`，然后定向 `--author --task`。
- **fixable authoring**：依据 phase2/author repair 失败证据做一次有界重写，再跑 phase2；通过后执行该 `page_id` 的定向 scan 和 preview gate。
- **pushed/verified preview**：复用 `--retry-failed --branch` 和 `gg-preview-gate.mjs`；gate 内的 surgical repair 仍最多执行其既有上限。
- **pending merge/live/backfill**：只从已验证状态继续 merge、部署传播等待、live verify 和 backfill loop。
- **stale/错误前提**：不发布；写入带证据的归档终态并退出活跃修复队列。
- **凭据、权限、缺失源数据或安全边界**：不得猜测或绕过；达到 cap 后保留真正 human-only，并发送一次去重终态告警。

Agent 不得再次启动顶层 `gg-nightly-seo.sh`，避免撞外层锁或重复扫整批；只能处理 selector 给出的目标。

#### A.5.3 “强制 publish”的定义

“强制”只表示 Agent 不停在 authored、preview pushed、waiting merge 或 pending backfill 等中间态，而是主动调用现有流程继续推进。

以下行为永远禁止：

- 手工把 ledger 改成 `verified-preview` 或 `done`；
- 绕过 preview verify、三维 review 或 Codex fact gate；
- 对 FAIL 内容直接调用 merge；
- 为了过门而删除事实风险、CTA 审计字段或 Related Reading；
- 对普通文章调用 Google Indexing API，或无人值守点击 GSC Request Indexing；
- 使用破坏性 git/filesystem 命令或覆盖用户的 dirty worktree。

### A.6 终态验证与回填

Agent 退出后，runner 必须使用确定性数据重新判定结果，不接受 prompt 输出中的“已完成”作为证据。

#### A.6.1 发布终态

每篇声称发布成功的文章必须同时满足：

1. ledger 为 `done`，存在 branch/slug/merge 时间证据；
2. 生产 URL 返回 200；
3. canonical 精确指向生产 URL；
4. 页面含有效 Article JSON-LD；
5. sitemap 包含该 slug；
6. CTA 继续满足 CTA Map intent routing，Related Reading 保持独立；
7. plan 已勾选，publish-log 已追加，选题登记表的发布状态和 URL 已回填；
8. pending-writeback/backfill loop 已收敛，或明确记录未收敛步骤并进入下一次有界 repair。

#### A.6.2 非发布终态

- `archived`：必须有明确 stale/错误前提证据和去重 sidecar 状态；不会在后续 tick 重复触发。
- `human_only`：必须记录尝试次数、最后错误、日志路径和所需人工动作；同一指纹只通知一次。
- Agent 自身失败或超时：算作本指纹的一次尝试；未到 cap 可在下个 tick 重试，到 cap 后进入 `human_only`。

### A.7 可观测性与通知

- launchd 日志记录：run window、nightly exit code、selector 目标数、Agent PID/attempt/timeout、verifier 结果。
- repair Agent 使用独立日志目录 `~/gengrowth-agents/cron-sync/seo_repair_hook/`，按日期追加。
- 正常无异常运行静默，不发送 hook 通知。
- 修复成功、归档或达到 human-only 时只发送一条批次终态汇总；不发送“开始修复”“正在 review”等中间态。
- 通知发送失败进入现有 outbox，下一次正常 wrapper 开始时重放。

### A.8 Lynne Soul 指令污染清理

repair hook 上线前必须同步清理直接影响其运行的错误项目指令：

1. 将 flow 仓库 `AGENTS.md` 的项目名称从 `GenGrowth Wiki` 修正为当前 flow 项目；
2. 删除将 `ai-profile/lynne-soul.md` 声明为 flow 项目所有者档案的硬编码，不跨仓加载个人 profile；
3. 从暂停的 `gengrowth-seo-blog` Automation prompt 删除 Lynne soul 读取和“Codex Automation 是唯一调度入口”的旧声明，状态仍保持 `PAUSED`；
4. repair hook prompt 只使用 flow 项目级规则、精确失败证据和确定性命令，不继承团队成员个人 soul。

该清理只移除错误归属，不修改 Lynne 在 gengrowth-wiki 中的真实个人档案。

### A.9 测试策略

#### A.9.1 单元测试

- selector：clean、run error、新 park、旧 park、已归档、已到 cap、非 pinned plan。
- fingerprint：时间戳/PID/临时 hostname 变化不改变指纹；stage 或真实错误变化会改变。
- sidecar：attempt 在 spawn 前写入；原子写；损坏/不可写 fail closed。
- verifier：done 但 URL/canonical/JSON-LD/sitemap/backfill 任一缺失均不得判成功。

#### A.9.2 runner/hook smoke

- clean nightly：fake Codex 调用数为 0；
- 新 `needs_human`：fake Codex 恰好调用 1 次，并只收到目标条目；
- 旧但未处理 park：仍触发；
- 同指纹两次后：第三次不再 spawn，进入去重 human-only；
- wrapper 非零但无 claim：run-level synthetic target 触发一次；
- 外层锁存在：第二个 tick skip；
- Agent 超时/非零：计入 attempt，绝不误报 publish；
- runner 源码不再读取 Automation TOML，也不在 clean path 执行 `codex exec`。

#### A.9.3 回归与上线验证

- 运行 flow-driver、preview-gate、park-autoretry、CTA 和 backfill 现有测试；
- 运行完整 `tools/scripts/__tests__` 回归，并区分既有失败；
- `bash -n` 校验 shell，`plutil -lint` 校验 plist；
- 使用临时 ledger、临时 flow-state 和 fake Codex 完成端到端演练；
- 验证本机 Codex Automation 仍为 `PAUSED`，旧八个标签禁用且未加载；
- 不在测试中触发真实文章发布。正式启用后由下一个自然 launchd window 首次运行，并根据精确日志窗口验收。

### A.10 灰度与回退

1. 先落 selector、fingerprint、sidecar 和测试，hook 保持关闭。
2. 改 runner 为直接 nightly，并用 fake wrapper/fake Codex 验证 clean path 与异常 path。
3. 设置 `GG_SEO_REPAIR_HOOK_ENABLED=1` 后由自然 launchd window 启用，不额外创建或加载 job。
4. 首个真实异常只允许每 tick 1 篇；验证成功后把默认值提升到设计上限 2 篇。
5. 回退时只关闭 `GG_SEO_REPAIR_HOOK_ENABLED`；正常 nightly 直跑继续工作，Codex Automation 和旧 flow-driver lane 均不恢复。

### A.11 明确非目标

- 不把整个 happy path 改成 Agent 控制；
- 不恢复 Codex Automation 的 scheduler；
- 不新增 repair cron/LaunchAgent；
- 不自动处理 GSC Request Indexing 点击；
- 不重写 CTA 路由、author repair、preview gate 或 backfill 的已验证核心逻辑；
- 不保证事实错误或缺失凭据一定能发布，目标是自动推进到安全、可审计的终态。

### A.12 实现验收

- 2026-07-15 18:30:04–18:36:55 CST 的首个自然 LaunchAgent 窗口完成真实异常闭环：`gg-nightly-seo.sh` 直接空跑退出 0，selector 仅选择 `PG-WAIA-001/backfill`，一次性 Codex Agent 仅执行定向 `gg-backfill-one`。
- attempt 在 Agent spawn 前以 fingerprint `6d75e277...095c28` 原子记录为 `inflight`；最终 state 为 `attempts=1 / status=published / lastError=null`，Agent PID `20693`、timeout `2700s` 均进入日志。
- 外层确定性 verifier 的 `ledger_done`、`branch_and_merge`、`http_200`、`canonical`、`article_jsonld`、`sitemap`、`plan_checked`、`publish_log`、`sheet_published`、`cta_audit`、`cta_matches_map`、`writeback_clear` 全部为 true。
- launchd `runs=14 / last exit code=0`；launchd/nightly 锁均释放，无残留 nightly、repair hook、`codex exec` 或 backfill 进程。终态通知于 18:36:55 审计为 `SENT`，outbox 为空。
- Codex Automation 保持 `PAUSED`，旧八个 launchd 标签均 disabled/unloaded，Unix crontab 无 SEO 执行项；回退仍只需关闭 `GG_SEO_REPAIR_HOOK_ENABLED`。
- 定向 repair/backfill 回归为 43/43；完整 `tools/scripts/__tests__/*.test.mjs` 新鲜运行退出码 0；生产 verifier 复跑仍为 `published` 且 12 项全真。
