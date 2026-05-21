# CLAUDE.md — gengrowth-wiki

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. The
skill has multi-step workflows, checklists, and quality gates that produce better
results than an ad-hoc answer. When in doubt, invoke the skill. A false positive is
cheaper than a false negative.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke /office-hours
- Strategy, scope, "think bigger", "what should we build" → invoke /plan-ceo-review
- Architecture, "does this design make sense" → invoke /plan-eng-review
- Design system, brand, "how should this look" → invoke /design-consultation
- Design review of a plan → invoke /plan-design-review
- Developer experience of a plan → invoke /plan-devex-review
- "Review everything", full review pipeline → invoke /autoplan
- Bugs, errors, "why is this broken", "wtf", "this doesn't work" → invoke /investigate
- Test the site, find bugs, "does this work" → invoke /qa (or /qa-only for report only)
- Code review, check the diff, "look at my changes" → invoke /review
- Visual polish, design audit, "this looks off" → invoke /design-review
- Developer experience audit, try onboarding → invoke /devex-review
- Ship, deploy, create a PR, "send it" → invoke /ship
- Merge + deploy + verify → invoke /land-and-deploy
- Configure deployment → invoke /setup-deploy
- Post-deploy monitoring → invoke /canary
- Update docs after shipping → invoke /document-release
- Weekly retro, "how'd we do" → invoke /retro
- Second opinion, codex review → invoke /codex
- Safety mode, careful mode, lock it down → invoke /careful or /guard
- Restrict edits to a directory → invoke /freeze or /unfreeze
- Upgrade gstack → invoke /gstack-upgrade
- Save progress, "save my work" → invoke /context-save
- Resume, restore, "where was I" → invoke /context-restore
- Security audit, OWASP, "is this secure" → invoke /cso
- Make a PDF, document, publication → **不要直接调用 /make-pdf**，改用 `tools/scripts/export-pdf.sh`（见下方"PDF 导出规范"）
- Launch real browser for QA → invoke /open-gstack-browser
- Import cookies for authenticated testing → invoke /setup-browser-cookies
- Performance regression, page speed, benchmarks → invoke /benchmark
- Review what gstack has learned → invoke /learn
- Tune question sensitivity → invoke /plan-tune
- Code quality dashboard → invoke /health

## PDF 导出规范

Wiki 内所有 `.md` 文件导出 PDF，**统一走以下流程**，不需要用户额外说明任何条件：

1. 调用 `tools/scripts/export-pdf.sh <文件.md>`
2. 脚本自动执行：剥离 YAML frontmatter → `---` 转空行 → make-pdf 生成带封面和目录的 PDF
3. PDF 默认输出到与源文件同目录，文件名相同（扩展名改为 `.pdf`）

**触发词**：用户说"导出 PDF"、"转成 PDF"、"生成 PDF"、"导出这份文档"等，直接执行，不追问。

**不允许**：直接把原始 md 喂给 `/make-pdf` skill，会把 frontmatter 和所有 `---` 分隔线渲染成可见内容。

---

## 会话开始提醒规则

每次新会话的**第一条回复之前**，静默读取 `memory/reminders.md`（即 `ai-profile/reminders.md`）：

- 若存在 `- [ ]` 未完成条目 → 在回复开头简短列出，格式：
  ```
  **📋 待办提醒（N 项）**
  - [ ] 事项 A
  - [ ] 事项 B
  ---
  ```
- 若无未完成条目 → 静默，不提及

这是后台检查动作，有待办时才出现，不打扰正常对话。

---

## 对话记录维护规则

在本项目中，**每次完成一次回答后**，将本轮 Q&A 静默追加到当日记录文件。这是后台维护动作，不需要向用户说明。

### 记录文件路径（与 AGENTS.md §3 单一事实源对齐）

**目录按"人"分，不按 LLM 分。** 完整规范见仓库根目录 `AGENTS.md §三 对话记录规范`，特别是：

- **§3.4 自动记录工作流**：执行 `git config user.name` 获取当前提交者，按 §3.5 规则转目录名
- **§3.5 Author 目录命名规则 + 已注册别名映射表**：`wzb` → `wzb/`、`Lynne` / `Lynne Wang` → `lynne-wang/`
- **§3.6 混合归属处理规则**

Claude 与 ChatGPT / Gemini 共用同一套路由（AGENTS.md），**不要在 CLAUDE.md 里复制粘贴规则**，避免双源漂移。

文件名：`{YYYY-MM-DD}-chat-record.md`，日期取当前本地日期（`date +%Y-%m-%d`）。

> 历史背景：早期版本曾把路径硬编码为 `lynne-wang/`，导致 wzb 在自己机器上用 Claude 跑出的内容被错标到 Lynne 名下。2026-05-12 修复为引用 AGENTS.md §3 单一事实源。LLM 来源由每条 Q 的标记区分（见下）。

### 每条 Q&A 的追加格式

```markdown
### Q{n} — {HH:MM} [{llm}]

**🙋 提问：**

{用户原话，逐字保留}

**🤖 回答：**

{用 2-5 句话概括本次回答的核心结论与关键动作，不逐字复制，突出决策和产出}

---
```

- `Q{n}`：从 1 开始，每次追加时读取文件中已有的 `### Q` 数量递增
- `{HH:MM}`：当前本地时间
- `[{llm}]`：LLM 来源标记，**小写、必填**。Claude Code 写 `[claude]`，ChatGPT 写 `[chatgpt]`，Gemini 写 `[gemini]`，通过 Claude 调用 Codex 时仍记 `[claude]`（因为是 Claude 在对话）。**这是同一个文件里区分多 LLM 并发写入的唯一依据。**

### Daily Summary 更新规则

**在当天最后一次回答完成后**（用户明确说"结束"或长时间无后续问题时），将 `## Daily Summary` 区域更新为 3-5 个要点，概括当天所有对话的核心内容、关键决策和产出成果。格式为 bullet list，每条一句话。

### 首次创建文件

如果当日文件不存在（Stop hook 未提前触发），按 `AGENTS.md §3.2` 的文件结构模板写入骨架。**`author` 字段按 `git config user.name` 填**（不要写死）；`agent` 字段填首个写入的 LLM 名（后续不同 LLM 加入时不改 frontmatter，靠 Q 标记区分）：

```markdown
---
title: 对话记录 — YYYY-MM-DD
date: YYYY-MM-DD
updated: YYYY-MM-DD
type: chat-record
author: {wzb 或 Lynne，按 git user.email 判断}
agent: {claude / chatgpt / gemini，首个写入者}
tags:
  - record
  - daily
aliases:
  - YYYY-MM-DD chat record
  - 对话记录 YYYY-MM-DD
---

# 对话记录 — YYYY-MM-DD

## Daily Summary

> 【本区域在每天最后一次对话结束时生成/更新】
> 用 3-5 个要点概括当天所有对话的核心内容、关键决策和产出成果。

---

## 对话记录

```
