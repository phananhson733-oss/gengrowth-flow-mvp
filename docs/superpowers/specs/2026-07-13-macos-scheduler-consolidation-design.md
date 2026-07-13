---
title: macOS 调度器整合设计
date: 2026-07-13
updated: 2026-07-13
type: plan
version: v1.0
status: approved
owner: awayer_mini
tags:
  - macos
  - launchd
  - seo
  - automation
aliases:
  - macOS scheduler consolidation
  - Notes 与 SEO 调度整合
---

# macOS 调度器整合设计

## 目标

把本机两个独立任务收敛为可审计、单执行器的 macOS `launchd` 调度：Notes 周任务不再使用 Unix crontab；SEO Blog 不再由 Codex 内置调度和旧 launchd 链并行触发。

## 决策

### Notes：用户级 LaunchAgent

- 保留现有 `gengrowth-wiki/tools/scripts/weekly-notes-digest.sh`，不改写业务逻辑。
- 新增版本受控的 `com.gengrowth.wiki-notes-digest.plist` 模板，并部署到 `~/Library/LaunchAgents/`。
- 每周一 09:07（Asia/Shanghai）运行；任务在当前用户 GUI 域执行，因此 Claude CLI 使用已有登录凭据，不需要任务时手动输入密码。
- 删除 crontab 中唯一的 Notes 条目和相邻说明注释；不影响其他 crontab 条目。
- 安装后立刻 `kickstart` 一次，并以 LaunchAgent 状态和任务日志作为启动证据。

### SEO：单一 LaunchAgent + Codex CLI

- 新增 `com.gengrowth.seo-blog.plist`，仅在 18:30 至 21:30 每半小时调度，共七个触发点；不设 `RunAtLoad`。
- 新增轻量运行器 `gg-seo-blog-launchd-tick.sh`。它只负责时窗、单飞锁、旧执行器冲突检查和启动本地 `codex exec`；不复写 SEO 状态机。
- 运行器从既有 `~/.codex/automations/gengrowth-seo-blog/automation.toml` 读取完整 prompt，因此保留其中的 wrapper-first、有界修复、回填、上线验证、终态通知和记录约束。
- Codex CLI 在 flow-mvp 工作目录运行，并使用 `danger-full-access` sandbox 与 `never` approval，匹配用户已授权的无人值守本地发布范围。
- `gg-nightly-seo.sh` 仍是唯一业务入口；它已包含作者、预览门、自动合并、线上验证、发布记录、回填与索引跟踪入队。

### 互斥边界

- 通过官方 Automation 更新接口将 `gengrowth-seo-blog` 置为非活跃状态，但保留其完整 TOML/prompt，供本地运行器读取。
- 继续禁用并 bootout 旧 SEO 标签：`seo-nightly`、`seo-author`、`seo-autopilot`、`seo-author-kicker`、`flow-driver`、`lane-watchdog`、`ledger-reconcile`、`index-monitor`。
- 新运行器在每次启动前检查这些标签未加载，并检查没有残留旧 wrapper 进程；任何冲突均 fail closed，不启动新一轮发布。
- 不删除旧 SEO plist 模板，方便保留历史和明确回退路径。

## 非目标

- 不改写 `gg-nightly-seo.sh` 或 `gg-seo-autopilot.mjs` 的发布逻辑。
- 不自动处理 `needs_human`、Oracle dirty state、过期主题或 GSC Request Indexing；沿用既有停机与人工边界。
- 不要求 Mac 从睡眠中唤醒。用户已确认该 Mac mini 会保持唤醒并已登录。

## 验收标准

1. `crontab -l` 不再含 Notes 周任务，Notes LaunchAgent 已加载并成功启动一次。
2. Notes 最新日志包含启动记录，且不再出现历史的认证失败即退出。
3. SEO 新 LaunchAgent 处于加载状态，七个日间触发点正确，且没有 `RunAtLoad`。
4. Codex 内置 SEO Automation 不再调度，旧八个标签均禁用且未加载。
5. 运行器的静态测试、shell 语法检查、plist 语法检查均通过；实时预检确认无重叠进程。
