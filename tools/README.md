---
title: 工具区
date: 2026-04-14
updated: 2026-04-16
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
