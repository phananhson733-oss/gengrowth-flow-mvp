---
title: 结果复盘 GSC GA4 全 SA 授权设计
date: 2026-07-16
updated: 2026-07-16
type: plan
version: v1.0
status: approved-direction
owner: awayer_mini
tags:
  - recap-performance
  - gsc
  - ga4
  - service-account
  - oauth
aliases:
  - Recap Performance Full SA
  - 结果复盘免重复授权
---

# 结果复盘 GSC/GA4 全 SA 授权设计

## 目标

让无人值守的 `gg-recap-performance-tick.sh` 完全脱离个人 Google OAuth：Sheets 继续使用 writer SA，GSC 和 GA4 改用 reader SA。任务不再依赖 Testing 模式下七天过期的 `GG_OAUTH_REFRESH_TOKEN`，也不需要周期性浏览器授权。

## 已确认现状

- `gg-index-monitor.mjs` 已经用 reader SA 访问 GSC，用 writer SA 访问 Sheets；这条链路不需要迁移。
- `gg-recap-performance.mjs` 的 Sheets token 已来自 writer SA，但 GSC/GA4 token 仍显式调用个人 OAuth `{ user: true }`。
- reader SA 已能读取 AstrologyWiki 与 GenGrowth 两个 GSC property。
- reader SA 当前访问 GA4 `properties/524765570` 返回 `PERMISSION_DENIED`；上线前必须在 GA4 Property Access Management 中授予该 SA `Viewer`。
- 两个 workbook 的 writer SA 原值回写探针均已通过。

reader SA：

```text
gg-reader-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com
```

## 方案比较与决策

### A. reader SA 统一读取 GSC/GA4，writer SA 写 Sheets（采用）

- 一次性给 reader SA 增加 GA4 Viewer。
- reader SA token 同时请求 `webmasters.readonly` 与 `analytics.readonly`。
- recap 任务不再读取个人 refresh token。
- 权限保持最小化：reader 只读，writer 只写目标 workbook。

这是原项目规范中已经锁定的三 SA 分工，也是无人值守任务最稳定的方案。

### B. 把个人 OAuth consent app 发布到 Production（不采用）

- 可以避免 Testing 模式七天失效，但任务仍绑定个人账号、consent 状态与 refresh token。
- 与用户明确要求的 SA 方案不符。

### C. SA 失败时回退个人 OAuth（不采用）

- 会掩盖缺失权限，让无人值守任务重新依赖会过期的个人凭据。
- 本设计选择 fail closed：SA 配置或权限不足时明确失败并报告准确修复项。

## 代码设计

### Token 边界

在 `gg-index-monitor.mjs` 的现有 SA token helper 旁新增 `getReportingAccessToken()`：

- 凭据路径：`GG_READER_SA_JSON`，默认 `~/.config/gg/gg-reader-sa.json`。
- scopes：
  - `https://www.googleapis.com/auth/webmasters.readonly`
  - `https://www.googleapis.com/auth/analytics.readonly`
- 返回短期 access token；不保存 token，不引入新环境变量。

`gg-recap-performance.mjs` 改为从同一模块导入该 helper：

```text
Sheets read/write -> getSheetAccessToken()     -> writer SA
GSC + GA4 read    -> getReportingAccessToken() -> reader SA
```

删除 recap 对 `lib/_oauth-token.mjs` 和 `{ user: true }` 的依赖。保留现有 dependency injection：测试和调用方仍可通过 `deps.getAnalyticsToken` 注入 token provider。

### 错误与通知

- reader SA JSON 不存在或 token mint 失败：错误明确写为无法创建 GSC/GA4 reader SA token。
- GSC 403：提示 reader SA 需要对应 property 的 Full user。
- GA4 403：提示 reader SA 需要 property Viewer。
- recap wrapper 的失败通知不再提示重新检查个人 OAuth，改为列出 GSC reader SA、GA4 reader SA、Sheets writer SA 与 workbook。
- 不回退个人 OAuth，不自动扩大 SA 权限。

## 外部权限变更

在 GA4 `properties/524765570` 的 Property Access Management 中新增：

```text
gg-reader-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com
Role: Viewer
```

这是一次性、可撤销的只读授权。无需给 reader SA Editor、Administrator 或用户管理权限。

## TDD 与验证

实现前先加入并观察以下测试按预期失败：

1. `getReportingAccessToken()` 必须把 reader SA 路径和 GSC/GA4 两个只读 scope 交给 SA token provider。
2. `runRecapPerformance()` 获取 reporting token 时不得传 `{ user: true }` 或其他个人 OAuth 选项。
3. recap 源码不得再导入 `_oauth-token.mjs`。
4. wrapper 失败提示必须指向 reader/writer SA 权限，不再提示 GSC/GA4 OAuth。

实现后执行：

1. `node --test tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs`
2. `node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs`
3. 相关脚本完整 smoke suite。
4. `bash -n tools/scripts/gg-recap-performance-tick.sh`
5. 对 AstrologyWiki 与 GenGrowth 分别运行 reader/writer SA live probe，确认 GSC、GA4 和 Sheets 权限全部通过。
6. 只通过 `bash tools/scripts/gg-recap-performance-tick.sh` 复跑生产任务，并从当日 `recap_performance` 日志隔离最新窗口，确认两个产品结束且出现 `recap performance ok`。

## 验收标准

1. recap 生产调用链不读取 `GG_OAUTH_CLIENT_ID`、`GG_OAUTH_CLIENT_SECRET` 或 `GG_OAUTH_REFRESH_TOKEN`。
2. reader SA 能读取两个 GSC property 和 GA4 `properties/524765570`。
3. writer SA 继续读写两个目标 workbook。
4. 定向测试、相关 smoke suite 与 shell 语法检查全部通过。
5. 现有 wrapper 真实复跑退出 `0`，当日日志中两个产品均完成且无 OAuth/权限失败。
6. 未触发发布、部署、GSC Request Indexing 或普通文章 Google Indexing API。

## 非目标

- 不删除 `oauth-init.mjs` 或 `verify-gcp-oauth.mjs`；它们可以继续作为显式个人 OAuth 诊断工具，但不再是 recap 生产依赖。
- 不修改 index-monitor 的已有 SA 授权路径。
- 不改变 D14/D30/D60 选行、Sheet 回写、报告生成或通知成功逻辑。
- 不新建 core tool、scheduler、环境变量或凭据文件。
