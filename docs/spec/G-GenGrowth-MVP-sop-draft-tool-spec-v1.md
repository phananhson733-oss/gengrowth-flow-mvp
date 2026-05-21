---
title: GenGrowth MVP — bin/gg-sop-draft 工具 spec v1
date: 2026-05-21
type: tech-spec
author: wzb
status: draft (W1 Thu ship 前 Claude Code 实现参考)
version: v1.0
tags:
  - gengrowth
  - mvp
  - sop-draft
  - tool-spec
aliases:
  - sop draft spec
  - 5-in-1 SOP 起草工具
related:
  - "[[G-GenGrowth-MVP-RACI-and-execution-flow-v1]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]"
review_trail:
  - "2026-05-21 v1.0 — RACI v1 §6 P1-3 落地 reference。5 in 1：生成 5 份 Ops SOP draft（M9 / Monday / Reddit / AI-monitor / Social-distribute）。**纯模板填充**，零 API 依赖。wzb 周四 30 min × 3 周 → 30 min × 1 周（自动起草，wzb 只改 brand voice）。"
---

# /bin/gg-sop-draft 工具 spec v1

> [!info] 为什么有这个工具
> plan v1.1.2 §3.5 / §3.6 / §4.3 列了 5 份 Ops SOP 要 wzb 在 Week-1~Week-3 写。
> 每份手写 30-40 min × 5 = 2.5h 净 typing 工时；其中 80% 是模板套话（YAML / 章节骨架 / 编号步骤 / 报告表格），20% 是 wzb 的 brand voice。
> 这个工具是 RACI v1 §6 P1-3：自动起草 80% 模板部分 → wzb 周四 only 改 voice + decide 发布。

---

## §1 30 秒读完

**输入**：`--type <m9|monday|reddit|ai-monitor|social-distribute>` 一个必填 flag
**输出**：在 `wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/Ops-SOP-<type>-<YYYY-MM-DD>-draft.md` 写一份 markdown draft
**wzb 工作量**：每份 LOOK 10 min + FILL voice 10 min + DECIDE 发布 5 min = 25 min/份
**Ship 时机**：W1 Thu PM 30 min（RACI v1 §6 P1-3）
**zero-dependency**：纯 Node 内置（fs / path / url / os），**不调任何 API**（无 LLM / 无 Sheets / 无网络）

---

## §2 用法

```bash
# 生成单份 draft
node tools/scripts/gg-sop-draft.mjs --type m9
# → 写到 wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/Ops-SOP-m9-2026-05-21-draft.md

# 列出 5 个支持的 type
node tools/scripts/gg-sop-draft.mjs --list

# 已存在同名文件 → 默认报错退出 1；--force 才覆盖
node tools/scripts/gg-sop-draft.mjs --type m9 --force

# 自定义输出目录（测试用）
node tools/scripts/gg-sop-draft.mjs --type m9 --out-dir /tmp/sop-drafts
```

### 2.1 flag 解析

| flag | 必填？ | 默认 | 说明 |
|------|-------|------|------|
| `--type <t>` | 是（非 --list 时） | — | 5 选 1：m9 / monday / reddit / ai-monitor / social-distribute |
| `--out-dir <path>` | 否 | `wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/`（相对脚本根） | 输出目录；不存在自动 `mkdirSync recursive` |
| `--force` | 否 | false | 已存在同名文件时覆盖 |
| `--list` | 否 | — | 列出 5 个 type 并退出 0 |
| `--help / -h` | 否 | — | 用法 |

### 2.2 输出路径规则

`<out-dir>/Ops-SOP-<type>-<YYYY-MM-DD>-draft.md`

例：`wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/Ops-SOP-m9-2026-05-21-draft.md`

---

## §3 退出码

| 码 | 含义 |
|----|------|
| 0 | draft 成功生成 / `--list` 正常输出 / `--help` |
| 1 | 文件已存在且未传 `--force`；或文件写入失败 |
| 2 | 参数错误（unknown type / 缺 `--type` / IO 异常） |

---

## §4 5 SOP 模板表

每个模板都按 PRD §19.2 6 项内容（触发条件 / 前置检查 / 执行步骤 / 完成标准 / 报告格式 / 异常 fallback）写，并加 §7「给 wzb 的 LOOK 节点」。

### 4.1 m9 — M9 git mechanics SOP

| 字段 | 内容 |
|------|------|
| **目的** | Ops 在 oracle 项目提精修 PR、跑测试、推送、通知 wzb merge、验证 deploy |
| **触发** | 每篇精修内容在 Obsidian 完稿后 |
| **准备** | oracle repo write 权限 / Node 环境 / Vercel preview 链接习惯 |
| **关键步骤数** | 9 步（branch / 改文件 / lint / test / commit / push / open PR / wait merge / verify deploy） |
| **验收** | PR merged + Vercel preview URL 200 + 文章在线 URL 可访问 |
| **fallback** | lint / test 红 → 修；merge conflict → wzb 介入；deploy 失败 → 回滚 commit + 通知 wzb |
| **wzb LOOK** | 每篇 PR review + merge（5 min/篇）|

### 4.2 monday — 周一数据复盘 SOP

| 字段 | 内容 |
|------|------|
| **目的** | Ops 周一手跑 `bin/event-export --week last` 拉 GA4 + GSC 数据 → 填周报 Sheets → wzb 周二看 |
| **触发** | 每周一 9:00-11:00 |
| **准备** | `bin/event-export` 可跑 / Sheets `weekly_report` tab 写权限 / Obsidian retro 模板路径 |
| **关键步骤数** | 7 步（pull last week → run event-export → 检查 raw 数据齐 → 填 weekly_report tab → 写 Obsidian retro 草稿 → 标异常 → 通知 wzb）|
| **验收** | weekly_report tab 数据完整 + Obsidian retro 草稿 ≤30 min wzb review |
| **fallback** | event-export 失败 → fallback 手抄 GSC UI；数据 0 行 → 检查日期窗口 + 通知 wzb；Sheets 写失败 → 截图发 IM |
| **wzb LOOK** | 周二 10:00 周报会议 30 min |

### 4.3 reddit — Reddit 社区运营 SOP

| 字段 | 内容 |
|------|------|
| **目的** | Ops 在 r/AskAstrologers / r/astrology 等社区自然回答含本周精修主题的问题，30 天持续巡检 |
| **触发** | 精修发布后 24h 内启动 + 持续 30d 巡检 |
| **准备** | Reddit 账号 ≥6 个月 age / 阅过目标 subreddit rule / Sheets `reddit_log` tab |
| **关键步骤数** | 8 步（搜本周主题词 → 筛选 ≤7d 帖 → 写自然回答 → 引用规则（只在 user 主动问「where can I read more」时贴）→ 发帖 → 记录 URL → 24h 看是否被删 → 填 Sheets）|
| **验收** | ≥3 回复/周 + 0 删帖（subreddit rule violation）+ Sheets 全填 |
| **fallback** | 被删帖 → 立刻停发 + 通知 wzb 复盘 tone；账号被 shadow ban → 切备用号 + 通知 wzb；mod 私信警告 → 暂停该 sub 7d + retro |
| **wzb LOOK** | 每周抽查 1 条回复看 tone（5 min/周）|

### 4.4 ai-monitor — AI 引用监测 SOP

| 字段 | 内容 |
|------|------|
| **目的** | Ops 周二在 perplexity.ai + Google AIO 巡检本周精修主题词，记录引用情况 |
| **触发** | 每周二 14:00 |
| **准备** | perplexity.ai 账号（无登录也可搜）/ Chrome 截图工具 / Sheets `ai_monitor` tab |
| **关键步骤数** | 7 步（取本周 5 个精修主题词 → perplexity 搜 → 截图引用 → Google AIO 搜同 5 词 → 截图 → 填 Sheets `ai_monitor` → 标 cited/not_cited）|
| **验收** | 5/5 覆盖 + Sheets 全填 + 周报包含「本周新增引用 X 篇」|
| **fallback** | perplexity 抽到无引用 → 记 not_cited 即可（不强行 retry）；Google AIO 不触发 → 标 「AIO not shown」；连续 2 周 0 引用 → escalate Lynne（Day 30/60 judge）|
| **wzb LOOK** | 周报会议看覆盖率 + escalate 决策（10 min/周）|

### 4.5 social-distribute — 社媒分发 SOP

| 字段 | 内容 |
|------|------|
| **目的** | 精修发布后 24-48h 内多平台扩散（X / Threads / Reddit / Newsletter）|
| **触发** | 精修上线后 24-48h 窗口内 |
| **准备** | 4 平台账号（X / Threads / Reddit / Substack 或自托管 newsletter）/ UTM 模板 / Sheets `social_distribute` tab |
| **关键步骤数** | 8 步（取 article URL → 基于 URL 生成 4 平台草稿 → Ops 评审推荐档（recommended=true）→ 按推荐发布 → UTM 校验 → 记录发布 URL 回 Sheets → 24h 看互动数据 → 异常 escalate）|
| **验收** | 4 平台 ≥3 平台发布 + URL 全填 Sheets + UTM 正确（无 typo）|
| **fallback** | 某平台账号被限流 → 跳过 + 记 「rate-limited」；UTM 错 → 立刻删原帖重发；互动 0 / 内容被举报 → 通知 wzb retro voice|
| **wzb LOOK** | 候选选定时拍 brand voice（10 min/篇）|

---

## §5 模板共同结构

每份生成的 draft 都有以下骨架（章节顺序固定）：

```markdown
---
title: Ops SOP — <中文标题>
date: <YYYY-MM-DD>
type: ops-sop
status: draft
author: wzb
audience: Ops
sop_type: <type>
tags:
  - gengrowth
  - ops-sop
  - <type>
aliases:
  - <type> SOP
related:
  - "[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
---

# Ops SOP — <中文标题>（<type>）

## §1 SOP 目的
<1 段，1-2 句话>

## §2 触发时机
<什么时候 Ops 跑这个流程>

## §3 准备工作
- [ ] <凭据 / 工具 / 文件，5-8 项 checkbox>

## §4 步骤
- [ ] Step 1 — <动作 + 期望结果>
- [ ] Step 2 — ...
（5-10 步，每步带 checkbox）

## §5 验收标准
<Ops 做完后报给 wzb 的标准，bullet list>

## §6 失败场景
| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| <failure mode 1> | <处理> | <yes/no> |
| <failure mode 2> | ... | ... |
| <failure mode 3> | ... | ... |

## §7 wzb LOOK 节点
- <wzb 每周/每月看什么 + 时长>

---

— draft 由 `tools/scripts/gg-sop-draft.mjs` 自动生成 / wzb 改 voice 后转 status: published
```

---

## §6 Ship checklist（W1 Thu 30 min）

- [ ] `tools/scripts/gg-sop-draft.mjs` 入口脚本（Node 内置 only）
- [ ] 5 个模板（嵌入 script 内的 const map，无外部依赖）
- [ ] `--type` `--out-dir` `--force` `--list` `--help` flag 解析
- [ ] 已存在同名文件检查（默认拒；`--force` 覆盖）
- [ ] `mkdirSync recursive` 输出目录不存在自建
- [ ] 退出码 0 / 1 / 2 分支
- [ ] **不**调任何 API（LLM / Sheets / 网络）
- [ ] 1 个 smoke test 覆盖：5 种 type 生成 / unknown type 拒绝 / 已存在文件不覆盖 / `--force` 覆盖 / `--list` 输出
- [ ] 实跑生成 5 份 SOP draft 到 `wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/`

---

## §7 不做（边界）

- ❌ **不**调 LLM（sonnet / claude / openai）— wzb 在 Claude Code 会话里手动让 sonnet 改 voice，工具只填模板骨架
- ❌ **不**直接发布（不动 Obsidian published 状态 / 不写 IM 通知）
- ❌ **不**做模板版本管理（每次跑都是当前模板 + 当天日期；旧 draft 由 wzb 自己 git 管）
- ❌ **不**校验 brand voice / 不做 lint（wzb 改 voice 后 obsidian 内 manual review）
- ❌ **不**接 cron / 不自动周期跑（W1 Thu wzb 手跑 5 次或一次跑 5 个 type 都行）

---

## §8 Verify after ship（dry-run 验证）

W1 Thu ship 后立刻跑 5 次 + 边界验证：

```bash
# 5 type 各跑一次
for t in m9 monday reddit ai-monitor social-distribute; do
  node tools/scripts/gg-sop-draft.mjs --type "$t"
done
# 期望：5 份 draft 写到 wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/，退出码全 0

# unknown type
node tools/scripts/gg-sop-draft.mjs --type bogus
# 期望：退出码 2，stderr 提示 5 个合法 type

# 已存在不覆盖
node tools/scripts/gg-sop-draft.mjs --type m9
# 期望：退出码 1，stderr 提示用 --force

# 覆盖
node tools/scripts/gg-sop-draft.mjs --type m9 --force
# 期望：退出码 0，文件 mtime 刷新

# --list
node tools/scripts/gg-sop-draft.mjs --list
# 期望：退出码 0，stdout 列出 5 个 type
```

**accept 标准**：5 个 draft 文件齐 + 内容包含 PRD §19.2 6 项；边界用例退出码 + stderr 行为符合预期。

---

## §9 与 RACI v1 的链接

| RACI 项 | 关联 |
|---------|------|
| §6 P1-3 | 本 spec 是 P1-3 "ship `/gg-sop-draft --type m9\|monday\|reddit\|ai-monitor\|social-distribute`（5 in 1）" 的实现 reference |
| §3 W1 Thu PM | 本 spec 对应 W1 Thu PM wzb 20 min「LOOK 2 份 SOP draft + FILL voice + DECIDE 发布」 |
| §3 W2 Thu | ai-monitor + reddit draft 起草（同工具，跑 `--type ai-monitor` + `--type reddit`） |
| §3 W3 Thu | social-distribute draft 起草（同工具，跑 `--type social-distribute`） |

---

## §10 给 wzb 的 30 秒读法

- 你不用懂 §4-§8，那是给 Claude Code 看的
- 你要懂的就一句：**W1 Thu / W2 Thu / W3 Thu 你跑一行命令，5 份 SOP draft 全有了，你只 LOOK + FILL voice + DECIDE 发布**
- 工具不调 LLM 不发网络请求 — 纯模板填充，offline 也能跑
- 5 份 SOP 内容是按 PRD §19.2 6 项 + plan v1.1 各 SOP 的关键步骤数硬编码的，**改模板**要改这个 spec + script，**改 voice** 在生成的 .md 里改

---

**一句话结尾**：把 5 份 Ops SOP 起草从「2.5h 手写模板套话」→「30 min 跑工具 + wzb 改 voice」。**Ship 30 min Claude Code 投入，3 周省 2h wzb 红线工时。**

— sop-draft spec v1.0 / 2026-05-21
