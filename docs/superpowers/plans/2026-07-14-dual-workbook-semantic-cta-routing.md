---
title: 双工作簿意图分类 CTA 路由实施计划
date: 2026-07-14
updated: 2026-07-15
type: plan
version: v1.1
status: approved
owner: awayer_mini
tags:
  - gengrowth
  - seo
  - cta
  - google-sheets
aliases:
  - CTA 路由实施计划
  - Semantic CTA Routing Plan
---

# 双工作簿意图分类 CTA 路由实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 让 CTA Map 先识别文章意图、再在同类候选中选择 CTA，并用该规则优化最近上线的 7 篇 AstrologyWiki 文章。

**Architecture:** `CTA Map` 以 `intent_tags` 描述候选所属意图类别；共享选择器仅从目标关键词、实体与内容角度推断类别，再在该类别内选择候选。批量关联词仅作弱补充，不能因 `birth chart` 等模板词形成类别或覆盖更具体的 Forecast/Compatibility 意图。

**Tech Stack:** Node.js ESM、Node Test、Google Sheets API、AstrologyWiki Oracle TypeScript 内容仓库。

## Global Constraints

- 两份 CTA Map 都从 A:K 扩展为 A:L，L 列字段固定为 `intent_tags`。
- `desc` 为人工维护说明；`match_keywords` 与 `intent_tags` 是机器选择事实源。
- `Blog_Article`、Related Reading、`internal_link_rule`、外链和导航永远不是主 CTA 候选，且本次不改其内容。
- 显式 `cta_id` / URL 保留最高优先级；未匹配时只能使用该 workbook 的唯一 `*` 兜底。
- 每一项生产逻辑改动必须先运行新增测试并观察到预期失败，再实现最小改动至绿。

---

### Task 1: 用意图类别锁定选择器行为

**Files:**
- Modify: `tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs`
- Modify: `tools/scripts/lib/cta-selector.mjs`

**Interfaces:**
- Consumes: CTA candidate `{cta_id, cta_text, target_url, cta_kind, match_keywords, intent_tags, blog_eligible, priority}`。
- Produces: `selectCta()` 的既有结果加可审计 `cta_intent_tags`，以及 `cta_selection_reason` 中的 `intent_tags:` 片段。

- [ ] **Step 1: 写入失败测试**

```js
test('specific Map intent beats boilerplate birth-chart associated keywords', () => {
  const selected = selectCta({
    candidates: ASTRO_CTAS,
    context: {
      target_keyword: 'north node in aquarius 2026',
      entity: 'North Node in Aquarius 2026',
      associated_keywords: 'north node in aquarius 2026 birth chart; astrology; zodiac',
      content_angle: 'A 2026 North Node transit reading',
    },
    allowedHost: 'astrologywiki.com',
  });
  assert.equal(selected.cta_id, 'url_page_forecast');
  assert.equal(selected.cta_intent_tags, 'forecast-transit');
});
```

再添加三条独立断言：`Descendant + seventh house` 选择 `natal-self` Birth Chart；`why am I still single` 不选择 Compatibility；`synastry + two charts` 选择 `two-person` Compatibility；只有模板关联词的未知主题选择 `*` Tools Hub。

- [ ] **Step 2: 验证红灯**

Run: `node --test tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs`

Expected: 新的 `intent_tags` 断言失败，现有选择器仍把 Forecast 案例路由到 Birth Chart 或没有 `cta_intent_tags`。

- [ ] **Step 3: 实现最小 Map 驱动分类**

在 `cta-selector.mjs` 增加：

```js
const DIRECT_INTENT_FIELDS = [['target_keyword', 1000], ['entity', 800], ['content_angle', 40]];
const GENERIC_ASSOCIATION_TERMS = new Set(['birth chart', 'astrology', 'zodiac', 'meaning', 'interpretation']);
```

解析 `intent_tags`；用 `DIRECT_INTENT_FIELDS` 的 `match_keywords` 命中聚合标签分数，取最高标签后只保留同标签候选。`associated_keywords` 中的通用词不得产生类别或分数；类别内非通用关联词维持弱分。结果包含标签，并继续按 `priority`、`cta_id` 做稳定决胜。

- [ ] **Step 4: 验证绿灯**

Run: `node --test tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs`

Expected: 现有选择器测试和 4 条新意图测试全部 PASS。

- [ ] **Step 5: 提交逻辑与测试**

```bash
git add tools/scripts/lib/cta-selector.mjs tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs
git commit -m "feat(cta): classify Map candidates by intent"
```

### Task 2: 贯通 A:L schema 与 override 审计字段

**Files:**
- Modify: `tools/scripts/gg-sheet-to-brief.mjs`
- Modify: `tools/scripts/gg-content-draft.mjs`
- Modify: `tools/scripts/lib/_workbook-spec.mjs`
- Modify: `tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs`

**Interfaces:**
- Consumes: `CTA Map!A:L`，其中 L 为 `intent_tags`。
- Produces: bridge override 的 `cta_intent_tags`；legacy draft 路径同样读取 L 列。

- [ ] **Step 1: 写入失败测试**

```js
assert.equal(override.cta_intent_tags, 'forecast-transit');
assert.equal(buildCtaMap([HEADER_WITH_INTENT_TAGS, FORECAST_ROW]).candidates[0].intent_tags, 'forecast-transit');
```

- [ ] **Step 2: 验证红灯**

Run: `node --test tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs`

Expected: `cta_intent_tags` 不存在或 CTA Map 第 L 列未被映射。

- [ ] **Step 3: 最小实现**

将 `CTA_HEADER_MAP`、`CTA_COLS`、`CTA_RANGE`、`_workbook-spec.mjs` 的 header/seed/comment 同步扩展为 `intent_tags`；将选择结果的 `cta_intent_tags` 写入 `composeOverride()`。不修改 `internal_link_rule` 的读取与输出。

- [ ] **Step 4: 验证绿灯**

Run: `node --test tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs tools/scripts/__tests__/lib-cta-selector.smoke.test.mjs`

Expected: 相关测试全部 PASS。

- [ ] **Step 5: 提交 schema 贯通**

```bash
git add tools/scripts/gg-sheet-to-brief.mjs tools/scripts/gg-content-draft.mjs tools/scripts/lib/_workbook-spec.mjs tools/scripts/__tests__/gg-sheet-to-brief.smoke.test.mjs
git commit -m "feat(cta): carry intent tags through CTA schema"
```

### Task 3: 同步模板与操作文档

**Files:**
- Modify: `docs/spec/upstream-canon/keyword-sheet-setup.gs`
- Modify: `docs/PIPELINE.md`
- Modify: `docs/superpowers/specs/2026-07-14-astrologywiki-semantic-cta-routing-design.md`
- Modify: `docs/superpowers/plans/2026-07-14-dual-workbook-semantic-cta-routing.md`

**Interfaces:**
- Consumes: A:L CTA Map schema。
- Produces: 新 workbook 与日常维护均使用 `intent_tags`，并明确关联词限制与内链隔离。

- [ ] **Step 1: 更新模板和表头说明**

将 Apps Script 的 CTA Map 宽度改为 12，header 尾部加入 `intent_tags`，并写入列 12 注释：`intent_tags：分号分隔的候选意图类别；选择器先按目标关键词、实体和内容角度识别标签，再在同标签候选中选择。`。

- [ ] **Step 2: 更新 Pipeline 文档**

在 CTA Map 表格新增 L 列说明，并写明 `associated_keywords` 中的 `birth chart`、`astrology`、`zodiac`、`meaning`、`interpretation` 不得单独决定类别；明确 blog 内链不在候选池。

- [ ] **Step 3: 自检文档元数据与一致性**

Run: `rg -n 'A:K|11 列|intent_tags|intent tag' docs/PIPELINE.md docs/spec/upstream-canon/keyword-sheet-setup.gs tools/scripts/lib/_workbook-spec.mjs`

Expected: 运行时 schema、模板和说明均为 A:L / 12 列，未保留将 CTA Map 描述为 11 列的有效规则。

- [ ] **Step 4: 提交文档与模板**

```bash
git add docs/spec/upstream-canon/keyword-sheet-setup.gs docs/PIPELINE.md docs/superpowers/specs/2026-07-14-astrologywiki-semantic-cta-routing-design.md docs/superpowers/plans/2026-07-14-dual-workbook-semantic-cta-routing.md
git commit -m "docs(cta): define intent-classified map routing"
```

### Task 4: 迁移两份 live CTA Map

**Files:**
- External: AstrologyWiki Google Sheet `CTA Map!L:L` 与候选关键词/描述
- External: GenGrowth Google Sheet `CTA Map!L:L`

**Interfaces:**
- Consumes: live `CTA Map` header、行号、URL、现有 `blog_eligible`。
- Produces: 两个 workbook 的 A:L 表头和候选 `intent_tags`，不改变任何 Blog_Article 行的 URL 或资格。

- [ ] **Step 1: 只读定位并备份核验值**

读取两个 spreadsheet metadata、`CTA Map!A1:L` 与候选行，记录 `sheetId`、表头、候选行号、`target_url`、`blog_eligible` 和 wildcard 行。

- [ ] **Step 2: 批量更新 AstrologyWiki**

新增 L1 `intent_tags`；填写 Birth Chart=`natal-self`、Compatibility=`two-person`、Forecast=`forecast-transit`、Energy Timeline=`timing`、各计算器的专属标签、Tools Hub=`tool-hub`。在 `match_keywords` 补充本命盘和 2026 行运的具体短语；Compatibility 仅含 `synastry`、`compatibility`、`two charts`、`compare charts`、`partner chart` 等双人信号。

- [ ] **Step 3: 批量更新 GenGrowth**

新增 L1 `intent_tags`；按候选实际用途填写 `product-entry`、`pricing`、`feature`、`use-case`、`tool-hub` 等标签。保留历史跨产品和 Blog_Article 行，继续令其 `blog_eligible=FALSE`。

- [ ] **Step 4: 复读并验证**

重新读取两张 `CTA Map!A1:L`，确认 header 一致、每个启用 wildcard 仍唯一、非 blog 候选没有被改为可选，且 `target_url` 和 Blog_Article 记录未变。

### Task 5: 重新匹配、更新 7 篇文章并发布

**Files:**
- Modify (Oracle worktree): `data/articles/north-node-in-aquarius-2026.ts`
- Preserve (Oracle worktree): 其余 6 篇文章的正文和所有 `Related Reading` / blog-to-blog 链接。

**Interfaces:**
- Consumes: bridge dry-run 的 `cta_id`、`cta_text`、`cta_target_url`。
- Produces: 7 篇文章的主 CTA 与 live Map 选择一致；只有 URL 或锚文本变化的文章才改源稿。

- [ ] **Step 1: 对第 291–297 行执行 dry-run**

Run: `node tools/scripts/gg-sheet-to-brief.mjs --rows 291-297 --dry-run`

Expected: `PG-NODE-013` 为 Forecast；6 篇个人本命盘页面为 `natal-self` Birth Chart；每条都含 `cta_selection_reason` 和 `cta_intent_tags`。

- [ ] **Step 2: 只改与选择结果不一致的主 CTA**

将 `north-node-in-aquarius-2026.ts` 的主 CTA 文案和 URL 替换为 Map 的 Forecast 值；保留全文和每一条 article-to-article 链接。保留已有 `why-do-i-attract-toxic-people.ts` 的 Map 锚文本对齐改动。

- [ ] **Step 3: 运行 Oracle 定向 CTA 测试和构建校验**

Run: `npm test -- tests/unit/wiki-chart-cta.test.tsx`

Expected: 既有 Birth Chart 测试按 Map 更新后的断言通过，并新增/更新 Forecast CTA 断言。

- [ ] **Step 4: 提交、推送并走现有发布入口**

```bash
git add data/articles/north-node-in-aquarius-2026.ts data/articles/why-do-i-attract-toxic-people.ts tests/unit/wiki-chart-cta.test.tsx
git commit -m "fix(cta): route recent articles by intent"
git push -u origin codex/cta-recent-articles-20260715
```

使用现有 Oracle 发布流程将已经验证的源稿上线；不得手动改 production HTML。

- [ ] **Step 5: 生产复核**

请求 7 个 production URL，确认每篇的主 CTA 文案和 URL 与 Map / dry-run 一致，尤其 `north-node-in-aquarius-2026` 为 Forecast；同时确认 Related Reading 仍存在。

## Completion Checklist

- [ ] 选择器 red-green 测试证明通用关联词无法把 2026 行运页路由到 Birth Chart。
- [ ] 两份 CTA Map 的 header 均为 A:L，且选择器输出 `cta_intent_tags`。
- [ ] 7 篇文章的 dry-run 选择与 production CTA 一致；仅 North Node 2026 改为 Forecast，个人命盘主题保留 Birth Chart 的可审计原因。
- [ ] Blog 内链、`internal_link_rule`、Related Reading 和不可选 CTA 行均未被修改。
- [ ] 所有定向测试、差异检查和生产请求均有本轮新鲜输出。
