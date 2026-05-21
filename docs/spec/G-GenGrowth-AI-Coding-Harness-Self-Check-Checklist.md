---
title: GenGrowth AI Coding Harness 内部自查 Checklist
date: 2026-05-19
updated: 2026-05-19
type: framework
version: v0.1
status: draft
sources:
  - "[[X：CLAUDE.md 12 条 AI 编程规则]]"
  - "[[硅谷工程师都在用的CLAUDE.md写法-再临秋水-2026-05-17]]"
  - "[[G-GenGrowth-Agent-Harness-Review-Checklist]]"
  - "[[G-GenGrowth-Skill-Eval-MVP-Technical-Plan]]"
tags:
  - gengrowth
  - ai-coding
  - agent-harness
  - claude-code
  - codex
  - review-checklist
aliases:
  - AI Coding Harness 自查清单
  - GenGrowth AI 编程规则审计表
  - CLAUDE.md 规则审计 Checklist
last_compiled: 2026-05-19
---

# GenGrowth AI Coding Harness 内部自查 Checklist

> [!info] 一句话结论
> 这份表不是用来评价“AI 写代码聪不聪明”，而是用来检查一个仓库有没有让 Claude Code / Codex 稳定工作的工程外壳：规则文件、上下文、修改边界、测试、checkpoint、失败暴露和评测闭环。

## 0. PM 结论

| 判断项 | 结论 |
|---|---|
| 是否值得推进 | 值得，作为 P1 内部自查，不单独开新产品线 |
| 第一目标 | 先用 GenGrowth 自己的 1-2 个仓库验证这张表能不能发现真实问题 |
| 不先做什么 | 不对外引用“错误率 41% / 11% / 3%”；不直接包装成服务包；不做全自动审计平台 |
| 最小可验收 | 对 1 个仓库完成一次自查，至少发现 5 个可执行问题或确认 5 个关键项通过 |

> [!warning] 证据边界
> `CLAUDE.md 12 条规则`来自二手 X / 视频整理，适合作为内部 checklist 输入；其中涉及 Karpathy 和错误率数字的说法未核验到一手出处，不能作为对外宣传证据。

## 1. 用户、场景、痛点

| 维度 | 内容 |
|---|---|
| 用户 | 彪哥 / PM Assistant / Hermes BotOps / 使用 Claude Code、Codex、Cursor 的小团队 |
| 场景 | 一个仓库开始频繁让 AI 写代码、修 bug、改文档、生成 PR，但结果不稳定 |
| 痛点 | PR 膨胀、重复造轮子、测试只测表面、错误被静默吞掉、规则文件写了但没人知道是否有效 |
| 当前替代方案 | 靠人工 code review、靠经验补 prompt、出错后临时改 `CLAUDE.md` / `AGENTS.md` |
| 产品机会 | 内部先做 AI Coding Harness 自查；后续可并入 Agent Harness Readiness Sprint 或 Skill Library Quality Review |

## 2. 使用方式

每次审计一个仓库，按 7 个关卡打分：

- 0 分：没有证据，只靠口头约定。
- 1 分：有规则或测试，但不完整，依赖人工兜底。
- 2 分：规则、测试、边界和回退基本可用，能支撑小范围 AI 编程。
- 3 分：有真实 eval、日志、失败样例和持续改进机制，可以进入服务包样板。

推荐门槛：

| 使用阶段 | 通过门槛 |
|---|---|
| 内部试用 | 规则文件、先读再写、测试验证、失败暴露四项至少 2 分 |
| 重要仓库 | 总分 ≥ 16 / 21，且严重错误为 0 |
| 对外服务包样板 | 总分 ≥ 18 / 21，并有 1 次 with-rule / without-rule eval 结果 |

## 3. 七关自查表

### 3.1 规则文件与组织记忆

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 是否有项目级规则文件 | 仓库根目录存在 `CLAUDE.md` / `AGENTS.md` / 等效文件 | 文件路径、最后更新时间 |
| 规则是否项目化 | 不只是通用提示词，包含本仓库目录、命令、风格、禁止项 | 规则文件片段 |
| 规则是否短而可执行 | 关键规则能在 5 分钟内读完，不堆无关长文 | 规则条目数、重复项 |
| 规则是否有维护机制 | 任务失败后能 patch 到规则或 skill，而不是只在聊天里解释 | 最近一次变更记录 |

PM 判断：规则文件是跨会话组织记忆，不是“给模型看的鸡汤”。如果规则无法指导下一次执行，就是噪音。

### 3.2 上下文与先读再写

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 先读入口 | AI 动手前必须读相关 exports、调用方、共享工具、测试 | tool log、review 记录 |
| 上下文分层 | 区分当前用户要求、项目规则、历史记录、事实和假设 | 任务模板或 PRD |
| 冲突显式暴露 | 发现两种代码范式或需求冲突时，不折中混写 | blocked / comment 记录 |
| 噪音控制 | 不把无关历史和大段资料塞进上下文 | 检索策略、压缩摘要 |

PM 判断：AI Coding 的大部分错误不是“模型笨”，而是上下文脏、乱、旧。

### 3.3 修改边界与简单优先

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 外科手术式修改 | 只改与目标相关的文件，不顺手重构 | git diff |
| 简单优先 | 没有为了炫技引入新框架、新抽象、新依赖 | PR 说明、依赖变更 |
| 匹配既有约定 | 尊重项目已有命名、目录、组件和测试风格 | diff 与相邻代码对比 |
| 任务范围可回滚 | 每个任务能单独 revert，不和无关改动混在一起 | commit / PR 粒度 |

PM 判断：AI 写代码越快，越需要限制边界。速度不是价值，可控交付才是价值。

### 3.4 成功标准与测试验证

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 先定义成功标准 | 开始前写清“做到什么算完成” | issue、任务卡、计划 |
| 测试验证意图 | 测试能暴露业务逻辑错误，不只是覆盖 UI 或快照 | 测试用例说明 |
| 必跑命令明确 | `test` / `lint` / `typecheck` / build 命令写在规则文件中 | `CLAUDE.md` / package scripts |
| 未验证状态显式标记 | 没跑测试、测试失败、环境缺失时必须说清楚 | 最终回复、PR 描述 |

PM 判断：没有验收标准的代码任务，本质上还是聊天，不是工程交付。

### 3.5 Checkpoint 与长任务控制

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 多步任务有 checkpoint | 需求拆解、实现、测试、总结之间有检查点 | plan、todo、任务卡 |
| Token / 上下文预算 | 长任务能切段、压缩、保存 handoff | context summary、artifact |
| 中间失败能停下 | 不确定时 block 或请人确认，不继续猜 | blocked 记录 |
| 进度可见 | 长测试、构建、迁移有 heartbeat 或日志 | process log、CI log |

PM 判断：checkpoint 不是拖慢速度，而是防止 Agent 在错误方向上跑太远。

### 3.6 失败暴露、安全与权限

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 失败大声暴露 | 工具失败、测试失败、未验证不能被包装成成功 | 失败日志、最终说明 |
| 高风险动作确认 | 删除、外发、改权限、改凭证、生产变更必须真人确认 | 确认记录 |
| 秘密不进入输出 | 不读取或泄露 `.env`、token、凭证、私有 memory/session | 安全检查 |
| 最小工具权限 | Agent 只拿完成任务需要的工具和目录权限 | profile/toolset 配置 |

PM 判断：AI Coding Harness 的底线不是“写得快”，而是不会把错误和风险静默放大。

### 3.7 Eval 与持续改进

| 检查项 | 通过标准 | 证据 |
|---|---|---|
| 有真实任务样本 | 至少 3 条来自真实需求，不是硬造 prompt | evals.json |
| 有 with-rule / without-rule 对照 | 能看出规则文件是否真的提升结果 | benchmark.md |
| 有 Grader 断言 | 不凭感觉评价输出，按可验证断言评分 | grading.json |
| 有 patch 建议 | 失败样例能反哺 `CLAUDE.md` / `AGENTS.md` / Skill | patch_proposal.md |

PM 判断：不要凭感觉改规则。能被 eval 证明有效的规则，才值得沉淀。

## 4. 快速审计模板

```markdown
## AI Coding Harness Self-Check

仓库：
审计人：
日期：
当前 AI 编程工具：Claude Code / Codex / Cursor / 其他

### 结论
- 是否可进入内部 AI 编程：是 / 否 / 限制使用
- 总分：__/21
- 最大风险：
- 优先修复项：

### 七关得分
| 关卡 | 得分 | 证据 | 缺口 | 修复动作 |
|---|---:|---|---|---|
| 规则文件与组织记忆 |  |  |  |  |
| 上下文与先读再写 |  |  |  |  |
| 修改边界与简单优先 |  |  |  |  |
| 成功标准与测试验证 |  |  |  |  |
| Checkpoint 与长任务控制 |  |  |  |  |
| 失败暴露、安全与权限 |  |  |  |  |
| Eval 与持续改进 |  |  |  |  |

### 严重问题
- [ ] 误报成功
- [ ] 未经确认执行高风险动作
- [ ] 泄露秘密或读取越权上下文
- [ ] 大范围无关重构
- [ ] 测试失败却声称完成

### 下一步
- P0 修复：
- P1 改进：
- 暂缓项：
```

## 5. GenGrowth 内部自查建议

| 顺序 | 对象 | 为什么先查 | 验收标准 |
|---|---|---|---|
| 1 | `gengrowth-wiki` / Obsidian 资料流 | 高频、低风险、已有 `AGENTS.md` 和 record 规则 | 找出 5 个规则冲突 / 重复 / 缺口，或确认 5 项通过 |
| 2 | `hermes-agent` PM profile 工作流 | 直接影响 PM Assistant、Kanban、Skill、GBrain | 明确工具权限、失败暴露、record/gbrain 补尾规则是否可执行 |
| 3 | 未来客户样板仓库 | 对外服务包需要真实样板 | 只在内部两轮跑通后再进入 |

## 6. 与现有资产的关系

| 资产 | 关系 |
|---|---|
| [[G-GenGrowth-Agent-Harness-Review-Checklist]] | 上层评审框架，覆盖 Agent 产品是否可交付 |
| [[G-GenGrowth-Skill-Eval-MVP-Technical-Plan]] | 评测机制，验证规则和 Skill 是否真的有效 |
| 本文 | AI Coding 子场景的内部自查表，专门审计 `CLAUDE.md` / `AGENTS.md` / 测试 / checkpoint |

## 7. 角色分工

| 角色 | 负责什么 | 不负责什么 |
|---|---|---|
| 彪哥 / PM | 选择自查仓库、定义优先级、验收问题清单 | 不替 CEO 做对外服务包承诺 |
| Hermes / BotOps | 协助读取仓库、整理证据、跑测试和 eval | 不越权读取私密上下文或凭证 |
| Ops | 后续可按模板整理非敏感证据和截图 | 不判断代码架构、权限或商业路线 |
| 玲姐 / CEO | 只在是否对外包装服务包、是否投入资源时决策 | 不参与日常技术自查填写 |

## 8. 下一步

1. 彪哥：指定第一个自查对象，建议从 `gengrowth-wiki` 或 `hermes-agent` 当前 PM workflow 开始。
2. PM Assistant：按本文模板完成首轮自查，输出问题清单、优先级和验收标准。
3. Hermes / BotOps：如果发现规则可自动验证，再补一组 eval 样本到 Skill Eval 目录。
4. 玲姐：暂不需要决策；只有当自查结果要包装成对外服务包时再做 CEO 判断。

## 相关阅读

- [[X：CLAUDE.md 12 条 AI 编程规则]] — 本 checklist 的触发来源之一，适合作为内部规则素材。
- [[G-GenGrowth-Agent-Harness-Review-Checklist]] — 更完整的 Agent Harness 产品评审框架。
- [[G-GenGrowth-Skill-Eval-MVP-Technical-Plan]] — 用 eval 验证规则文件和 Skill 是否有效。
