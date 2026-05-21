#!/usr/bin/env node
// gg-sop-draft.mjs — GenGrowth MVP 5-in-1 Ops SOP draft generator
//
// 用法:
//   node tools/scripts/gg-sop-draft.mjs --type <m9|monday|reddit|ai-monitor|social-distribute>
//   node tools/scripts/gg-sop-draft.mjs --list
//   node tools/scripts/gg-sop-draft.mjs --type m9 --out-dir /tmp/sop --force
//
// 输出:
//   <out-dir>/Ops-SOP-<type>-<YYYY-MM-DD>-draft.md
//   默认 out-dir = wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/（相对 repo 根）
//
// 退出码:
//   0  draft 成功 / --list / --help
//   1  文件已存在且未传 --force / 写入失败
//   2  参数错（unknown type / 缺 --type / IO 异常）
//
// 设计:
//   - 纯 Node 内置（fs/path/url/os）
//   - 不调任何 API（无 LLM / 无 Sheets / 无网络）
//   - 5 个 SOP 模板硬编码在 TEMPLATES const map
//
// spec 来源:
//   wzb-obsidian/LLM-Wiki/Tech/G-GenGrowth-MVP-sop-draft-tool-spec-v1.md

import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// constants
// ============================================================

export const SUPPORTED_TYPES = Object.freeze([
  'm9',
  'monday',
  'reddit',
  'ai-monitor',
  'social-distribute',
]);

// repo root = tools/scripts/.. /..
const REPO_ROOT = join(__dirname, '..', '..');

export const DEFAULT_OUT_DIR = join(
  REPO_ROOT,
  'wzb-obsidian',
  'LLM-Wiki',
  'Tech',
  'Ops-SOP',
);

// ============================================================
// helpers
// ============================================================

export function todayStamp(now = new Date()) {
  // YYYY-MM-DD in local time (matches existing tools' convention)
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function outputFileName(type, stamp) {
  return `Ops-SOP-${type}-${stamp}-draft.md`;
}

export function resolveOutDir(outDirArg) {
  if (!outDirArg) return DEFAULT_OUT_DIR;
  return isAbsolute(outDirArg) ? outDirArg : join(process.cwd(), outDirArg);
}

// ============================================================
// 5 SOP templates (frontmatter + body)
//
// Each template is a function: (stamp: string) => string
// Frontmatter date = stamp; body content is hardcoded per PRD §19.2 6 items.
// ============================================================

function fm({ titleCn, type, stamp }) {
  return `---
title: Ops SOP — ${titleCn}
date: ${stamp}
type: ops-sop
status: draft
author: wzb
audience: Ops
sop_type: ${type}
tags:
  - gengrowth
  - ops-sop
  - ${type}
aliases:
  - ${type} SOP
  - Ops ${type} SOP
related:
  - "[[G-GenGrowth-MVP-OpsPM-PRD-v1.2-lean]]"
  - "[[G-GenGrowth-MVP-落地plan-v1.1]]"
  - "[[G-GenGrowth-MVP-RACI-and-execution-flow-v1]]"
---

`;
}

function footer() {
  return `
---

— draft 由 \`tools/scripts/gg-sop-draft.mjs\` 自动生成 / wzb 改 voice 后转 status: published
`;
}

// ---------- m9 ----------
function tplM9(stamp) {
  return (
    fm({ titleCn: 'M9 git mechanics（精修发布 git 流程）', type: 'm9', stamp }) +
    `# Ops SOP — M9 git mechanics（m9）

## §1 SOP 目的

Ops 在 oracle 项目把精修内容提 PR、跑测试、推送、通知 wzb merge、验证 Vercel deploy 上线，确保每篇精修内容从 Obsidian 完稿到线上可访问的 git 链路稳定可重复。

## §2 触发时机

每篇精修内容在 Obsidian 完稿且 wzb 标 \`status: ready-to-publish\` 后立刻启动。预算 25 min/篇 × 3 篇/周 = 75 min/周。

## §3 准备工作

- [ ] oracle repo write 权限已配（\`gh auth status\` 绿）
- [ ] 本地 Node 环境齐（\`node -v\` ≥ 18）
- [ ] 已 \`git pull origin main\` 到最新
- [ ] Vercel preview 链接习惯已建立（PR 自动评论里抓 URL）
- [ ] Obsidian 精修源文件路径已知

## §4 步骤

- [ ] Step 1 — 从 main 切 feature branch：\`git checkout -b publish/<slug>\`
- [ ] Step 2 — 把 Obsidian 精修 .md 复制/转换到 oracle repo 对应目录
- [ ] Step 3 — 跑 \`npm run lint\`（或项目对应 lint 命令），红就修
- [ ] Step 4 — 跑 \`npm test\`（或项目对应 test 命令），红就修
- [ ] Step 5 — \`git add\` 改动文件（**只 add 本篇相关**，不要 \`git add -A\`）
- [ ] Step 6 — \`git commit -m "publish: <article slug>"\`
- [ ] Step 7 — \`git push -u origin publish/<slug>\`
- [ ] Step 8 — \`gh pr create\` 开 PR，title = "publish: <article slug>"，body 含 article URL 预期
- [ ] Step 9 — 等 wzb merge → 抓 Vercel preview URL → 验证 200 + 文章可见 → 在 Sheets \`publish_log\` 记录上线时间

## §5 验收标准

- PR 状态 = merged
- Vercel preview URL 返回 200
- 线上文章 URL 可访问且内容与 Obsidian 源一致
- Sheets \`publish_log\` tab 当行齐：article_slug / pr_url / merged_at / live_url / ops_owner

## §6 失败场景

| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| lint / test 红 | 看错误信息，能修就修；超过 15 min 没头绪 → 把错误日志贴给 wzb | yes（如 15 min 没解） |
| merge conflict | **不要硬 resolve**，直接 ping wzb，给出 conflict 文件清单 | yes（每次都升级） |
| Vercel deploy 失败 | 立刻在 PR 评论留言 + git revert merge commit + 通知 wzb | yes（每次都升级） |
| PR 评审超 4h 无响应 | IM 提醒 wzb；超 24h 升级到「阻塞 P1」 | yes（4h 提醒，24h 升级） |
| repo push 被拒（branch protection） | 不要 \`--force\`；ping wzb 检查 protection rule | yes |

## §7 wzb LOOK 节点

- 每篇 PR review + merge：5 min/篇 × 3 篇/周 = 15 min/周
- 每周五 17:00 同步会议看 \`publish_log\` 完成率：5 min/周
` +
    footer()
  );
}

// ---------- monday ----------
function tplMonday(stamp) {
  return (
    fm({ titleCn: '周一数据复盘（event-export + 周报填表）', type: 'monday', stamp }) +
    `# Ops SOP — 周一数据复盘（monday）

## §1 SOP 目的

Ops 周一上午手跑 \`bin/event-export --week last\` 拉上周 GA4 + GSC 数据，填入周报 Sheets \`weekly_report\` tab，写 Obsidian 周 retro 草稿，让 wzb 周二 10:00 周报会议 30 min 内完成决策。

## §2 触发时机

每周一 9:00-11:00（2h 窗口，预算 30 min 实际操作 + buffer）。如周一是节假日，顺延到节假日后第 1 个工作日同时段。

## §3 准备工作

- [ ] \`bin/event-export\` 本地可跑（先 \`bin/event-export --version\` 验）
- [ ] Sheets \`weekly_report\` tab 写权限（writer SA 已配）
- [ ] Obsidian 周 retro 模板路径已知（\`wzb-obsidian/LLM-Wiki/Tech/Weekly-Retro/template.md\`）
- [ ] 上周日期窗口已确认（\`date -v-7d +%Y-%m-%d\` ~ \`date -v-1d +%Y-%m-%d\`）
- [ ] 已 \`git pull\` Obsidian vault 到最新

## §4 步骤

- [ ] Step 1 — 算上周日期窗口（Mon..Sun）记在本地便签
- [ ] Step 2 — 跑 \`bin/event-export --week last\` → 看 console 是否 0 错误
- [ ] Step 3 — 检查 raw 数据齐（GA4 sessions ≥ 0 + GSC clicks ≥ 0 + 行数 ≥ 7 天）
- [ ] Step 4 — 把 raw 数据填到 Sheets \`weekly_report\` tab 对应行（按列模板）
- [ ] Step 5 — 复制 Obsidian retro 模板 → 新建 \`Weekly-Retro-<YYYY-WW>.md\` → 填上周 KPI 数字 + 异常标注
- [ ] Step 6 — 在 retro 草稿标 ≤3 个本周需要 wzb 决策的 item
- [ ] Step 7 — IM 通知 wzb：「周报数据齐 + retro 草稿就绪，周二会议见」

## §5 验收标准

- Sheets \`weekly_report\` tab 数据完整（无空 cell 在必填列）
- Obsidian retro 草稿 ≤30 min 可被 wzb review 完
- 周二 10:00 会议前 12h 已通知 wzb

## §6 失败场景

| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| event-export 跑挂 | 看错误日志；尝试 \`--retry\`；超过 15 min 没头绪 → fallback 手抄 GSC UI + GA4 UI | yes（如 fallback 也失败） |
| 数据 0 行（GSC / GA4 返回空） | 检查日期窗口是否颠倒；检查 SA 是否过期；通知 wzb | yes |
| Sheets 写失败（权限错） | 截图发 IM；不要重复 retry（可能产生重复行）| yes |
| retro 草稿写不出来（信息不够） | 在 retro 里标 「需要 wzb 提供 context」 并继续 | no |

## §7 wzb LOOK 节点

- 周一 10:00 IM 同步当周关注点：5 min/周
- 周二 10:00 周报会议（看 retro 草稿 + 填决策列）：30 min/周
- 月底看月度行为 KPI 自查：5 min/月
` +
    footer()
  );
}

// ---------- reddit ----------
function tplReddit(stamp) {
  return (
    fm({ titleCn: 'Reddit 社区运营（自然回答 + 30d 巡检）', type: 'reddit', stamp }) +
    `# Ops SOP — Reddit 社区运营（reddit）

## §1 SOP 目的

Ops 在 r/AskAstrologers / r/astrology 等占星社区，针对本周精修主题的真问题写自然回答；只在 user 主动问「where can I read more」时引用站点链接。30 天持续巡检每篇精修主题的相关讨论，避免被 mod 删帖。

## §2 触发时机

每篇精修发布后 24h 内启动；持续 30d 每周 ≥3 次巡检主题相关 thread。预算 1.5h/周。

## §3 准备工作

- [ ] Reddit 主账号 age ≥ 6 个月 + karma ≥ 100（避免 throttle）
- [ ] 备用账号 ≥1 个（主号被 shadow ban 时切换）
- [ ] 已阅每个目标 subreddit 的 rules 页（特别是「self-promotion」「外链」规则）
- [ ] Sheets \`reddit_log\` tab 写权限
- [ ] 本周精修主题词清单（从 \`weekly_report\` tab 取）

## §4 步骤

- [ ] Step 1 — 在 r/AskAstrologers / r/astrology 搜本周主题词（按时间排序，取 ≤7d 帖）
- [ ] Step 2 — 筛选「真问题」（user 描述具体处境 + 问怎么办，跳过 meme / repost）
- [ ] Step 3 — 写自然回答（不要包含站点链接 / 不要包含品牌名）
- [ ] Step 4 — 引用规则：**只**在 user 评论里主动问「where can I read more about X」时贴站点链接
- [ ] Step 5 — 发帖；24h 后回检（是否被删 / mod 警告）
- [ ] Step 6 — 把发布 URL 填到 Sheets \`reddit_log\`（columns: thread_url / reply_url / subreddit / theme / posted_at / status）
- [ ] Step 7 — 24h 巡检 status（live / removed / shadow_banned）
- [ ] Step 8 — 周五 17:00 统计本周回复数 + 0 删帖 → 报 wzb

## §5 验收标准

- ≥3 回复/周（横跨 ≥2 subreddit）
- 0 删帖（subreddit rule violation）
- Sheets \`reddit_log\` 全填（无空 URL）
- 每周 ≥1 条标 \`status=live + 24h+\`（验证不是隐性删）

## §6 失败场景

| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| 被删帖（mod 删 + bot 删） | 立刻停发同 subreddit 24h；复盘原因（规则 / tone）；通知 wzb 看 voice | yes（每次都升级） |
| 账号被 shadow ban（自己看到帖但别人看不到） | 切备用号；主号停发 7d；ping wzb 复盘 | yes |
| mod 私信警告 | 暂停该 sub 7d；不要回复争辩；retro + 通知 wzb | yes |
| 24h 后回检全 0 互动 | 看 thread 是否被 mod 转 「pending」；不强行 bump | no |

## §7 wzb LOOK 节点

- 每周抽查 1 条回复看 brand voice：5 min/周
- 候选 subreddit 列表变更（新增 / 黑名单）：10 min/月
- 删帖 / 警告 retro：按需 30 min/次
` +
    footer()
  );
}

// ---------- ai-monitor ----------
function tplAiMonitor(stamp) {
  return (
    fm({ titleCn: 'AI 引用监测（perplexity + Google AIO 周巡检）', type: 'ai-monitor', stamp }) +
    `# Ops SOP — AI 引用监测（ai-monitor）

## §1 SOP 目的

Ops 周二在 perplexity.ai + Google AI Overview 巡检本周精修主题词，记录站点引用情况，输出给 Lynne（Day 30 / Day 60 kill criterion judge）作为评估依据。

## §2 触发时机

每周二 14:00-15:00（1h 窗口，预算 30 min 实际操作）。

## §3 准备工作

- [ ] perplexity.ai 可访问（无登录也能搜，但登录有 history）
- [ ] Chrome 截图工具（macOS \`cmd+shift+4\`）就绪
- [ ] Sheets \`ai_monitor\` tab 写权限
- [ ] Google 搜索默认地区 = US（用 incognito 排除个性化）
- [ ] 本周 5 个精修主题词清单（从 \`weekly_report\` tab 取）

## §4 步骤

- [ ] Step 1 — 取本周 5 个精修主题词（如不足 5，取过去 4 周累计 5 个 most-recent）
- [ ] Step 2 — 在 perplexity.ai 逐词搜：query 用 user-style（不要塞 SEO 关键词堆叠）
- [ ] Step 3 — 截图 perplexity 引用区（Sources 卡片）→ 文件名 \`ai-monitor-perp-<theme>-<YYYY-MM-DD>.png\`
- [ ] Step 4 — 在 Google incognito 同 5 词搜，看 AIO（AI Overview）是否触发 + 是否引用站点
- [ ] Step 5 — 截图 Google AIO 区 → 文件名 \`ai-monitor-aio-<theme>-<YYYY-MM-DD>.png\`
- [ ] Step 6 — 填 Sheets \`ai_monitor\` tab（columns: theme / engine / query / appeared / cited_url / screenshot_path / confidence / checked_by）
- [ ] Step 7 — 标 cited / not_cited 状态 → 算本周覆盖率 → 写到周报

## §5 验收标准

- 5/5 主题词覆盖（perplexity + Google AIO 各 5 次）
- Sheets \`ai_monitor\` tab 全填（无空 confidence cell）
- 周报包含「本周新增引用 X 篇」一行
- 所有截图存档（路径在 Sheets 可点开）

## §6 失败场景

| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| perplexity 抽到无引用 | 记 \`not_cited\`，不强行 retry / 不换 query | no |
| Google AIO 不触发（query 不进 AIO 路径） | 标 \`AIO not shown\`；记到 Sheets | no |
| 连续 2 周 0 引用（mature cohort） | escalate Lynne（Day 30/60 judge）+ 通知 wzb retro 精修策略 | yes（Lynne 主线，wzb knock）|
| perplexity 限流 / 验证码 | 等 10 min 重试；超 1h 不通则当周记 \`partial\` + 通知 wzb | yes（如限流持续）|
| 截图丢失 | 重新跑该 theme + 通知 wzb 看是否需要补 | no |

## §7 wzb LOOK 节点

- 周二周报会议看引用覆盖率 + escalate 决策：10 min/周
- mature cohort 2 周 0 引用 retro：按需 30 min/次
- Day 30 / Day 60 看 Lynne 总结：30 min/月
` +
    footer()
  );
}

// ---------- social-distribute ----------
function tplSocialDistribute(stamp) {
  return (
    fm({ titleCn: '社媒分发（精修发布后 24-48h 多平台扩散）', type: 'social-distribute', stamp }) +
    `# Ops SOP — 社媒分发（social-distribute）

## §1 SOP 目的

精修文章上线 24-48h 内基于 article URL 生成 4 平台（X / Threads / Reddit / Newsletter）草稿，Ops 评审推荐档（recommended=true 的），按推荐发布 + UTM 校验 + 记录发布 URL 回 Sheets。

## §2 触发时机

精修上线后 24-48h 窗口内启动（上线 24h 是 SEO 索引黄金期，社媒同步要错开但不能拖过 48h）。

## §3 准备工作

- [ ] 4 平台账号齐：X（Twitter）/ Threads / Reddit / Substack（或自托管 newsletter）
- [ ] UTM 模板就绪：\`?utm_source=<platform>&utm_medium=social&utm_campaign=<article-slug>\`
- [ ] Sheets \`social_distribute\` tab 写权限
- [ ] 本周精修 article URL 清单（从 \`publish_log\` tab 取）
- [ ] brand voice cheatsheet 已读（wzb 在 Obsidian 维护）

## §4 步骤

- [ ] Step 1 — 取本周精修 article URL（按发布时间）
- [ ] Step 2 — 基于 URL 生成 4 平台草稿（手写 / 复用模板，**不调外部生成 API**）
- [ ] Step 3 — Ops 评审：每个草稿标 \`recommended=true/false\`（要符合 brand voice + 平台 norm）
- [ ] Step 4 — 给每篇加 UTM 参数；自查 UTM 字符串无 typo
- [ ] Step 5 — 按推荐发布（≥3/4 平台；newsletter 可延后到第 2 个 cycle）
- [ ] Step 6 — 记录发布 URL 回 Sheets \`social_distribute\`（columns: article_slug / platform / post_url / utm_string / posted_at / status）
- [ ] Step 7 — 24h 后回检互动数据（impressions / clicks）→ 标 \`status=live\` 或 \`flagged\`
- [ ] Step 8 — 异常（被举报 / 限流 / UTM 错）立刻 escalate

## §5 验收标准

- 4 平台 ≥3 发布
- Sheets \`social_distribute\` 全填 post_url（recommended=true 的全填）
- UTM 字符串正确（无 typo，可用 UTM builder 校验）
- 24h 后无被举报 / 无被删

## §6 失败场景

| 场景 | 处理 | 升级到 wzb? |
|------|------|------------|
| 某平台账号被限流（rate-limited） | 跳过该平台，记 \`rate-limited\`，下个 cycle 再试 | no |
| UTM 字符串 typo（已发布后发现） | 立刻删原帖；重发正确 UTM 的版本 | yes（每次都升级，避免重复）|
| 互动 0 / 被举报 | 截图发 IM + 复盘 voice + 通知 wzb | yes |
| 某平台账号被 ban | 暂停该平台；通知 wzb 评估申诉 | yes |
| Newsletter 出错（subscriber 抱怨） | 立刻停发；ping wzb retro | yes |

## §7 wzb LOOK 节点

- 候选选定时拍 brand voice（recommended=true 列表 review）：10 min/篇
- 周五 17:00 看 \`social_distribute\` 完成率：5 min/周
- 异常 retro（被 ban / 被举报）：按需 30 min/次
` +
    footer()
  );
}

export const TEMPLATES = Object.freeze({
  m9: tplM9,
  monday: tplMonday,
  reddit: tplReddit,
  'ai-monitor': tplAiMonitor,
  'social-distribute': tplSocialDistribute,
});

// ============================================================
// renderer
// ============================================================

export function renderTemplate(type, stamp) {
  const fn = TEMPLATES[type];
  if (typeof fn !== 'function') {
    throw new Error(
      `unknown SOP type: "${type}"; supported: ${SUPPORTED_TYPES.join(', ')}`,
    );
  }
  return fn(stamp);
}

// ============================================================
// CLI parsing
// ============================================================

export function parseArgs(argv) {
  const out = {
    type: null,
    outDir: null,
    force: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--type') out.type = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--force') out.force = true;
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`gg-sop-draft.mjs — 5-in-1 Ops SOP draft generator

usage:
  node tools/scripts/gg-sop-draft.mjs --type <type>
  node tools/scripts/gg-sop-draft.mjs --list
  node tools/scripts/gg-sop-draft.mjs --type m9 --out-dir /tmp/sop --force

flags:
  --type <t>        必填（非 --list 时）；5 选 1：${SUPPORTED_TYPES.join(' / ')}
  --out-dir <path>  默认 wzb-obsidian/LLM-Wiki/Tech/Ops-SOP/
  --force           已存在同名文件时覆盖
  --list            列出 5 个 type 并退出
  --help, -h        本帮助

exit codes:
  0  draft 成功 / --list / --help
  1  文件已存在且未传 --force / 写入失败
  2  参数错（unknown type / 缺 --type / IO 异常）
`);
}

function printList() {
  console.log('Supported SOP types (5):');
  for (const t of SUPPORTED_TYPES) console.log(`  - ${t}`);
}

// ============================================================
// generate (exported for tests)
// ============================================================

export function generateDraft({ type, outDir, force, now }) {
  if (!SUPPORTED_TYPES.includes(type)) {
    const err = new Error(
      `unknown SOP type: "${type}"; supported: ${SUPPORTED_TYPES.join(', ')}`,
    );
    err.code = 'UNKNOWN_TYPE';
    throw err;
  }
  const stamp = todayStamp(now || new Date());
  const dir = resolveOutDir(outDir);
  const filePath = join(dir, outputFileName(type, stamp));

  if (existsSync(filePath) && !force) {
    const err = new Error(
      `file already exists: ${filePath} (pass --force to overwrite)`,
    );
    err.code = 'EXISTS';
    err.path = filePath;
    throw err;
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = renderTemplate(type, stamp);
  writeFileSync(filePath, content);
  return { path: filePath, bytes: Buffer.byteLength(content, 'utf8'), stamp };
}

// ============================================================
// main
// ============================================================

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.list) {
    printList();
    process.exit(0);
  }
  if (!args.type) {
    console.error('error: --type is required (or pass --list / --help)');
    printList();
    process.exit(2);
  }

  let result;
  try {
    result = generateDraft({
      type: args.type,
      outDir: args.outDir,
      force: args.force,
    });
  } catch (e) {
    if (e && e.code === 'UNKNOWN_TYPE') {
      console.error(`error: ${e.message}`);
      process.exit(2);
    }
    if (e && e.code === 'EXISTS') {
      console.error(`error: ${e.message}`);
      process.exit(1);
    }
    console.error(`fatal: ${e && e.message ? e.message : e}`);
    process.exit(2);
  }

  console.log(`[gg-sop-draft] wrote ${result.path} (${result.bytes} bytes)`);
  process.exit(0);
}

const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('gg-sop-draft.mjs');
if (isMain) main();
