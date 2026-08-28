---
title: 工具区
date: 2026-04-14
updated: 2026-08-28
type: index
tags:
  - tools
  - index
  - workflow
aliases:
  - tools
  - 工具目录
---

# 工具区

本目录用于存放 `gengrowth-wiki` 根目录下的工具、扩展、脚本与 vendored 外部仓库。

---

## 1. 目录定位

这里的内容以“可执行、可安装、可复用的工具资产”为主，不属于正式制度文档，也不属于业务实例。

---

## 2. 子目录边界

1. `browser-extensions/`：浏览器扩展及其打包产物。
2. `internal/`：团队自有脚本、技能包与内部工具。
3. `external/`：外部仓库或 vendored 工具代码。

---

## 3. 当前包含内容

1. `browser-extensions/x-writer-extension/`：X Writer 浏览器扩展源码、图标与打包文件。
2. `internal/hr-doc-export/`：HR 文档导出脚本、命令与样式依赖。
3. `internal/skills/`：技能包、`web-clipper` 代码与相关脚本。
4. `external/wechat-cli/`：外部 `wechat-cli` 仓库正文与其自带说明文档。

---

## 4. 使用规则

1. 与某个工具强耦合的 README、脚本、模板可放在该工具目录下。
2. 纯说明性、分析性、学习型文档优先放 `参考资料/`，不要混入工具目录。
3. `Clippings/` 是系统自动落盘入口，不属于 `tools/`，本轮迁移保持冻结。
4. `wechat-cli` 这类外部代码仓，如需纳入本仓，目标位置统一为 `external/`。

---

## 5. DramaShortsTV 文档生产线

`scripts/gg-dramashortstv-doc.mjs` 从指定 Google Sheet 只读获取一个选题，按
`gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/2026-08-26-dramashortstv-blog写作SOP-v1.0.md`
生成并质检一份 Markdown。它不生成 hero 或任何图片，也不调用网站、Oracle、GenGrowth、
Supabase、Vercel、sitemap 或 indexing 发布路径。

正文生成固定使用 Claude 无工具文本 worker：`--tools` 为空，并启用 safe-mode、no-chrome、
空 MCP 配置和 repo 外 cwd。模型不能读写文件或调用外部工具；只有确定性父进程能写 Flow cache
及最终 Markdown。

只读预检：

```bash
node tools/scripts/gg-dramashortstv-doc.mjs \
  --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos \
  --row 4 --json
```

实际生成与交付：

```bash
node tools/scripts/gg-dramashortstv-doc.mjs \
  --workbook 1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos \
  --row 4 --apply --json
```

`--apply` 只有在 QA、事实审和 Git preflight 全部通过时，才会原子写入
`~/gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/`，并且只 stage 目标 Markdown，普通
push 到 `phananhson733-oss/gengrowth-ops` 的 `main`。任何无关本地修改、远端分叉、错误
remote 或不可验证 SHA 都会 fail-closed；不会自动 stash、reset、merge、rebase、clean 或 force push。

### 5.1 Apply 前置条件与 provider 用量

`--apply` 会进行真实搜证；必须先在受限的环境文件中配置
`GG_DATAFORSEO_LOGIN` 和 `GG_DATAFORSEO_PASSWORD`。每篇尝试固定发起 **5 次** DataForSEO Live
请求：Google Organic 分别查询目标词、真实 friction 和 IMDb（3 次，每个请求严格只有一个 task），
Google Trends（1 次），以及演员同名污染查询（1 次）。Apple Search 不要求本地凭据。

Reddit OAuth（`GG_REDDIT_CLIENT_ID`、`GG_REDDIT_CLIENT_SECRET`，以及可选的用户名/密码）只有在
Google SERP 已给出可验证的真实 friction（规范 Reddit 帖子或 Apple App Store 结果）时才是可选项。
若没有这类 Google 结果，必须有有效 Reddit OAuth 证据；两者都缺失时不得生成或交付。

### 5.2 证据与事实审缓存

证据对象固定为 `schemaVersion: '1'`，并绑定当前 `pageId`、`entity`、`targetKeyword`、采集时间、
按来源分组的结果、coverage 与 canonical `sha256`。它只能在 `.gg-cache/sites/dramashortstv/<page_id>/`
中留下本次运行的缓存；业务产物始终且只会是
`gengrowth-ops/inbox-maboyang/05-blog/dramashortstv/` 下的一份 Markdown。

事实审输入是同一缓存目录内不可变的
`<page_id>.factual-source.<draft-sha256>.<evidence-sha256>.md`。该文件含经清洗、标记为不可信的证据
及草稿，并在创建后回读校验字节和 SHA-256；并发运行不会复用可覆盖的审稿输入。

### 5.3 Fail-closed 与 dry-run 边界

任何必需证据缺失、来源身份不匹配、DataForSEO HTTP/顶层/task 错误、无效或过期证据、Evidence SHA
不匹配、草稿 QA 失败、事实审不是 `PASS`、事实审的 draft/evidence SHA 不匹配，或 Ops Git preflight
失败，都会在写 Ops Markdown 或 Git 交付之前停止。

未传 `--apply` 时是只读 dry-run：它只通过 Sheet bridge 读取指定 Google Sheet 并规划目标路径；不会
调用 DataForSEO、Apple、Reddit 等 research provider，不会调用 Claude/事实审 LLM，不会读取或写入 Ops
目录，也不会进行 Git 预检、暂存、提交、push 或其他 Git 操作。Sheet 的只读 API 获取不属于 research
provider 调用。该 lane 从不生成 hero、图片、图片 prompt、网站内容或发布/站点历史，也不会写 Sheet、
Supabase、Vercel、sitemap 或 indexing。
