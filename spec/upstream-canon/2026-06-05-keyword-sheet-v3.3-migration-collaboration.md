---
title: Keyword Sheet v3.3 迁移与协同说明
date: 2026-06-05
type: collaboration-note
status: draft
tags:
  - gengrowth
  - seo
  - google-sheet
  - workflow
  - operations
---

# Keyword Sheet v3.3 迁移与协同说明

本文用于同步 PM 与 SEO/运营同学：PRD v0.8 与 `keyword-sheet-setup.gs` v3.3 的核心变化、现有 Google Sheet 迁移方式，以及各角色分工。

## 0. 今日更新文档清单

| 文档 | 更新内容 | 说明 |
|---|---|---|
| [docs/03-marketing/2026-05-15-gengrowth-internal-growth-mvp-prd-v0.8.md](./2026-05-15-gengrowth-internal-growth-mvp-prd-v0.8.md) | 在原 v0.7 文件基础上迭代为 v0.8 | 明确 DR/KD 不再作为集群架构删除规则；新增 `竞争建议 / 机会分桶 / 生产准入 / 生产状态` 口径；选题登记表定义为页面生产视图；内容 SOP 对齐 v2.3；产能更新为 astrologywiki.com 已达到 AI 批量 + 1 人审核 `10+ 篇/天`。 |
| [docs/03-marketing/03-seo/keyword-sheet-setup.gs](./03-seo/keyword-sheet-setup.gs) | 升级为 v3.3 | 关键词主表扩展为 A-AB；新增 `V 生产准入_自动`、`W 手动生产准入`、`X 生产准入`、`Y 生产状态`、`Z page_id`、`AA 发布URL`、`AB 备注`；生产候选视图按 X 列筛选。 |
| [docs/03-marketing/2026-06-05-keyword-sheet-v3.3-migration-collaboration.md](./2026-06-05-keyword-sheet-v3.3-migration-collaboration.md) | 新增本文档 | 给 PM 与 SEO/运营的迁移说明、分工、任务模板与验收标准。 |
| [/Users/lynne/gengrowth-ops/inbox/08-reports-and-feedback/02-standard-feedback/2026-05-20-prd-v0.7-diagnosis-report.md](</Users/lynne/gengrowth-ops/inbox/08-reports-and-feedback/02-standard-feedback/2026-05-20-prd-v0.7-diagnosis-report.md>) | 在评审文档末尾追加采纳意见 | 采纳 SOP v2.3 对齐、T1/T3 产能调整、Direct Answer Block、按需 FAQ、Day 30 科学排查；Google Sheets 迁移/API 化/部署自动化为分阶段采纳。 |
| [/Users/lynne/gengrowth-ops/inbox/08-reports-and-feedback/02-standard-feedback/2026-05-21-keyword-workflow-risks-report.md](</Users/lynne/gengrowth-ops/inbox/08-reports-and-feedback/02-standard-feedback/2026-05-21-keyword-workflow-risks-report.md>) | 在评审文档末尾追加采纳意见 | 采纳“单点过滤破坏集群完整性”的判断；改为 N 列竞争建议、O/R 机会分桶、V/W/X 生产准入、Y 生产状态；高 DR/KD 但集群必需的词不再从架构中删除。 |

## 1. 核心变化

旧逻辑里，`DR过滤` 的 `✅通过 / ❌跳过` 会直接影响关键词是否进入分桶和生产。这会带来一个问题：高 DR/KD 但属于核心集群骨架的词，例如 Pillar、核心实体、系列母题，可能被提前排除，导致主题集群不完整。

新逻辑改为：

| 字段 | 作用 | 说明 |
|---|---|---|
| `N 竞争建议` | 判断竞争强弱 | 公式自动。`✅可做` / `⏸暂缓`。等同于旧 DR 判断，但不再从桶内剔除。 |
| `O/R 机会分桶` | 判断机会类型 | 趋势词 / 快速胜利 / 战略词 / 长尾词 / 无关。高 DR/KD 相关词仍然可以归桶。 |
| `V 生产准入_自动` | 自动给默认准入 | 公式自动。`可生产` / `暂缓` / `无关`。 |
| `W 手动生产准入` | 人工覆盖 | 可手动标 `可生产` / `暂缓` / `集群必需` / `无关`。 |
| `X 生产准入` | 最终准入结果 | 公式自动。W 非空用 W，否则用 V。`可生产` / `集群必需` 进入生产候选。 |
| `Y 生产状态` | 生产进度 | 手动维护。`未开始` / `已建卡` / `已发布` / `已合并` / `暂停`。 |
| `Z page_id` | 页面回填 | 建卡后回填选题登记表里的 page_id。 |
| `AA 发布URL` | URL 回填 | 页面发布后回填正式 URL。 |
| `AB 备注` | 备注 | 记录迁移说明、争议原因、特殊判断。 |

关键原则：

- `N 竞争建议` 只是建议，不是删除规则。
- `O/R 分桶` 只是机会类型，不是生产进度。
- `X 生产准入` 决定是否进入生产候选。
- `Y 生产状态` 只记录做到了哪一步。
- 高 DR/KD 但属于集群骨架的词，应该通过 `W 手动生产准入 = 集群必需` 保留下来。

## 2. 新站接手后的生产流程

用最简单的话讲，新站流程如下：

1. **先填基础信息**  
   明确产品、目标国家、竞品、种子词、不做范围。  
   衔接靠：`⚙️配置`、PGB/Day-0 模板。

2. **做关键词研究**  
   把关键词、搜索量、KD、DR、SERP 弱度填进关键词主表。  
   衔接靠：关键词主表，一行一个 keyword。

3. **Sheet 自动判断**  
   自动生成竞争建议、机会分桶、默认生产准入。  
   衔接靠：`N 竞争建议`、`O/R 机会分桶`、`V 生产准入_自动`。

4. **人工修正特殊情况**  
   运营检查无关词、暂缓词、集群必需词。  
   衔接靠：`W 手动生产准入`。

5. **进入生产候选**  
   只有 `X 生产准入 = 可生产 / 集群必需` 的词进入生产候选视图。  
   衔接靠：`🧩生产候选` 视图。

6. **做主题集群**  
   按 `cluster_id` 归并，不只看低难度词，还要保留 Pillar、核心实体、系列骨架。  
   衔接靠：`cluster_id`、主题集群表。

7. **生成页面候选**  
   多个关键词合并成一个页面，形成 `Target Keyword + Associated Keywords`。  
   衔接靠：1+N 折叠、`page_id`。

8. **进入选题登记表**  
   选题登记表一行是一个页面，不是一行一个关键词。  
   衔接靠：`page_id`、`cluster_id`、`page_role`。

9. **生产、发布、回填**  
   按 SOP v2.3 写作、质检、发布。发布后回填 `page_id`、URL 和状态。  
   衔接靠：关键词主表 `Z page_id`、`Y 生产状态`、`AA 发布URL`，以及选题登记表 `Status/URL`。

10. **复盘**  
   Day 14/30/60 看收录、排名、点击和 PV。  
   衔接靠：`page_id`、`cluster_id`、结果复盘表。

一句话总结：

```text
关键词主表管词
主题集群表管结构
选题登记表管页面
结果复盘表管表现
它们靠 cluster_id 和 page_id 串起来
```

## 3. 现有 Google Sheet 迁移方式

当前已有生产内容的 Google Sheet 不建议直接重跑脚本覆盖。

当前表：

```text
https://docs.google.com/spreadsheets/d/1CkjOCgYbRfXGYc6l2FJOaxUIzxT0NBVUhUpgCjyzcQc/edit
```

推荐迁移方式：

1. **复制当前 Sheet，做迁移副本**  
   原表继续生产，副本用于测试字段、公式、下拉和视图。

2. **PM 用 v3.3 脚本生成一个全新模板 Sheet**  
   这个模板不是直接替换当前表，而是作为标准列结构和公式参考。

3. **在现有关键词主表中插入新列**  
   建议在 U 列后插入：
   - `V 生产准入_自动`
   - `W 手动生产准入`
   - `X 生产准入`
   - `Y 生产状态`
   - `Z page_id`
   - `AA 发布URL`
   - `AB 备注`

4. **迁移旧字段**

| 旧数据 | 新字段 |
|---|---|
| 旧 `内容状态 = 暂缓` | `W 手动生产准入 = 暂缓` |
| 旧 `内容状态 = 已发布` | `Y 生产状态 = 已发布` |
| 旧 `发布URL` | `AA 发布URL` |
| 旧 `备注` | `AB 备注` |
| 已进入选题登记表的词 | 回填 `Z page_id`，`Y = 已建卡` 或 `已发布` |

5. **重新判断旧 `❌跳过`**

| 旧 `❌跳过` 类型 | 新处理 |
|---|---|
| 真无关词 | `W = 无关` |
| 只是 DR/KD 高 | `W` 留空或 `W = 暂缓` |
| Pillar / 核心实体 / 系列骨架词 | `W = 集群必需` |

6. **不要清空选题登记表**  
   已有页面继续保留。只补齐：
   - `page_id`
   - `cluster_id`
   - `page_role`
   - `Status`
   - `URL`

7. **回填主表**  
   对已建卡或已发布页面，把对应 `page_id` 回填到关键词主表 `Z page_id`。

8. **检查生产候选视图**  
   确认 `X = 可生产 / 集群必需` 的词是否合理。

## 4. PM 与运营分工

### PM 负责

- 维护 `keyword-sheet-setup.gs` v3.3。
- 生成标准模板 Sheet。
- 在迁移副本里加列、加公式、加下拉、加条件格式。
- 确认 `🧩生产候选` 视图按 `X 生产准入` 正确筛选。
- 确认迁移不会破坏当前已生产数据。
- 最后安排正式表迁移窗口。

### SEO/运营负责

- 逐行判断旧 `❌跳过`：
  - `无关`
  - `暂缓`
  - `集群必需`
- 回填已有内容：
  - `page_id`
  - `URL`
  - `生产状态`
- 检查 P0 集群：
  - 是否缺 Pillar
  - 是否有核心实体词被误标为暂缓/无关
  - 是否存在孤岛页面
- 输出迁移报告。

### 创始人负责处理有争议的意见



## 5. 运营迁移任务模板

```text
请基于 PRD v0.8 / Sheet v3.3，对当前关键词主表做一次生产准入迁移：

1. 旧 ❌跳过 逐行判断为：
   - 无关
   - 暂缓
   - 集群必需

2. 已进入选题登记表或已发布的词：
   - 回填 page_id
   - 更新生产状态为 已建卡 / 已发布
   - 回填 URL

3. 对 P0 集群检查：
   - 是否缺 Pillar
   - 是否有核心实体词被误标暂缓/无关
   - 是否存在孤岛页面

输出一份迁移报告：
 - 多少词标为无关
 - 多少词标为暂缓
 - 多少词标为集群必需
 - P0 集群发现的问题
 - 需要负责人拍板的争议词/争议集群
```

## 6. 迁移验收标准——PM

迁移完成后，至少满足：

- 关键词主表有 `V/W/X/Y/Z/AA/AB` 新列。
- `N 竞争建议` 不再让高 DR/KD 词从分桶中消失。
- `X 生产准入 = 可生产 / 集群必需` 的词能进入 `🧩生产候选`。
- 已建卡或已发布页面能在主表回查到 `page_id`。
- 选题登记表一行对应一个 page，而不是一个 keyword。
- P0 集群不缺 Pillar、核心实体、系列骨架。
- 负责人只需查看争议项，不需要参与逐行迁移。
