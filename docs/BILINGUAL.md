# bilingual-v9 — 中英双语 SEO 内容轨道

> Date added: 2026-05-25 · Status: Demo verified (page_aura_color_blue) · Scope: prompt + render layer; LLM/phase2/oracle layers reuse EN pipeline with `language='zh'` fixture flag.

## 1. 设计原则（read first）

**这不是翻译流水线。** 同一个 SEO 主题（target_keyword）输出**两篇独立文章**：
一篇为英文圈灵性读者写，一篇为华语圈灵性 / 命理读者写。
两套 prompt 模板**完全独立**重写，处理文化差异 + 引用源差异 + 关键词形态差异，
绝不通过逐字翻译产出。

**为什么不直译**：
- 中文搜索意图与英文不重叠（`blue aura meaning` ≠ `蓝色气场代表什么` 的查询者期待）
- 中文长尾词的 phrasing 完全不同（中文用动宾结构 + 疑问式：「代表什么」「含义」「解读」）
- 文化参照不同：英文版引 Mayo Clinic / Healthline / Reiki / Sound bath；中文版桥接气脉 / 中医 / 紫微 / 打坐 / 调息
- 合规红线不同：中文版必须避「调理」「治愈」「改善体质」等中医药法雷区
- 文风风险不同：中文 LLM 易出「深入探索」「赋能」「博大精深」公众号水稿腔，需要独立 anti-AI blocklist

## 2. CLI 用法

```bash
# EN only (默认，向后兼容 — 不传 --language 时行为 0 变化)
node tools/scripts/gg-render-batch.mjs --batch <batch.json> --overrides <overrides.json>

# ZH only (用中文 template 重写，自动派生中文长尾词)
node tools/scripts/gg-render-batch.mjs --batch <batch.json> --overrides <overrides.json> --language zh

# BOTH (推荐 — 同 page_id 产出 EN + ZH 两份 prompt + 两份 fixture)
node tools/scripts/gg-render-batch.mjs --batch <batch.json> --overrides <overrides.json> --language both
```

## 3. 文件命名规则

| 阶段 | EN | ZH |
|---|---|---|
| Template | `lib/content-draft-templates/definition.prompt.md` | `lib/content-draft-templates/definition.prompt.zh.md` |
| Template | `lib/content-draft-templates/pillar.prompt.md` | `lib/content-draft-templates/pillar.prompt.zh.md` |
| Rendered prompt | `.gg-cache/prompts/<page>.v8-prompt.md` | `.gg-cache/prompts/<page>.v8.zh-prompt.md` |
| Fixture sidecar | `.gg-cache/prompts/<page>.v8-fixture.json` | `.gg-cache/prompts/<page>.v8.zh-fixture.json` |
| LLM 产出 (人工 / 自动) | `_staging/<page>-<llm>-v8.md` | `_staging/<page>-<llm>-v8.zh.md` (约定) |
| Oracle 变量 | `${slug}En` | `${slug}Zh` |
| Oracle 索引 | `ARTICLES_EN[]` (in `data/articles/index.ts`) | `ARTICLES_ZH[]` |
| Wiki 公开 URL | `/en/wiki/<slug>` | `/zh/wiki/<slug>` (oracle 已有路由 `/:lang/wiki/:slug`) |

`.zh` 中缀 = 互不覆盖。同 page_id 的 EN 和 ZH 文件在同一目录下共存。

## 4. 默认参数（按 entity 类型）

| Field | EN definition | ZH definition | EN pillar | ZH pillar |
|---|---|---|---|---|
| `word_range` | `[1500, 1800]` (英文 word count) | `[1500, 2000]` (中文字符数) | `[2500, 3500]` | `[3000, 4000]` |
| `kw_count_range` | `[5, 8]` | `[5, 8]` | `[8, 12]` | `[8, 12]` |
| `target_country` 占位符 | `US (English)` | `CN/华语圈 (简体中文)` | 同左 | 同左 |
| `expected_h2` | 7 | 7 | 9 | 9 |

中文字符数 ≈ EN word count × 1.0（中文表达比英文紧凑），按经验值定（2026-05-25 opus 实跑校准）。
可在 overrides 里逐 page 调（如长综述给 `word_range: [2000, 2800]`）。

## 5. ZH prompt 与 EN prompt 的关键差异

| 维度 | EN | ZH |
|---|---|---|
| 角色定位 | "English SEO writer for US audience" | "中文 SEO 作者，为华语圈灵性/命理读者" |
| 第一段定义句 | `<entity> is …` (主语开头, ≤ 60 词) | `<entity 中文译名> 是 …` (主语开头, ≤ 50 字) |
| H2 标题 | 英文 (`## What is Blue Aura?`) | 中文 (`## 蓝色气场（Blue Aura） 是什么？`) |
| Anti-AI 词汇 blocklist | delve, leverage, harness, In conclusion, ... | 深入探索, 赋能, 博大精深, 综上所述, 让我们一起来探索, ... |
| 权威引用 | `Barbara Brennan in *Hands of Light*…` ❌ → `traditional teachings describe…` ✅ | `南怀瑾在《XX》中提到…` ❌ → `传统灵性教学普遍描述…` ✅ |
| 临床红线 | `lab studies show blue light lowers BP` ❌ | `调理蓝色气场可改善气虚体质` ❌ (中医药法) |
| 例子文化 | Western celebrities / movies | 港台命理大师思路 / 抽象偶像类型 / 武侠小说气场比喻 |
| 桥接外来词 | (none — assume reader knows chakra) | 首次出现给中文对照：`脉轮（chakra，可类比中医气脉中的能量节点）` |
| Keyword 形态 | English exact-match phrase `blue aura meaning` | LLM 自动派生 3-5 个中文长尾词 (`蓝色气场代表什么` / `蓝色光环 含义`)，挑 1 个作主词分布 |
| 标点 | ASCII (`?`, `:`, `,`) | 全角中文 (`？`, `：`, `，`, `「」`) — 数字 / 英文术语周围保留半角 |

## 6. 中文 keyword 派生策略 (v9-demo 决策)

**当前选择**：LLM 自动派生（同 brief，不改 sheet schema）。

中文 prompt 里指示 LLM：
> target_keyword 是英文 (`blue aura meaning`)，把它**自然映射为 3-5 个 native 中文长尾词**
> (如 `蓝色气场代表什么`、`蓝色光环 含义`、`蓝光能量场`)，挑 1 个作主词跨 section 分布。

**优势**：0 运营成本，立即能跑；中文 prompt 自己有 4-section 分布规则保 SEO 质量。
**风险**：中文 SEO 选词依赖 LLM 判断，可能偏离实际搜索量最高的词。
**未来升级**：sheet 加 `target_keyword_zh` 列由运营手填，复用同 render 路径，
optional `b.language` / `o.language` 字段已在 `composeCfg` 准备就绪。

## 7. 与 phase2 validator 的对接（2026-05-25 fan-out review 后落地）

**已修复 (F1+F2)**：`_phase2-validate.mjs` 现在按 `fixture.language` 切换 H2 spec + word count：

- **H2 结构检测**：language='zh' → 用 ZH H2 spec（substring match `是什么？` / `速查表` / `自我觉察小提示` / `延伸阅读` / `下一步行动` 等），不再假性 fail 中文 H2
- **Word count**：language='zh' → 数 CJK 字符 + 拉丁 word + 数字组（旧版 `split(/\s+/)` 给 ~1，必假性 fail；新版给 ZH 实字符数）
- ZH default word_range: definition `[2000, 2400]`、pillar `[3500, 4800]`（与 render 端 fixture 一致）

**v1 已知 gap (low-priority follow-up)**：

- RL1 (临床伪科学): ZH 文章只检英文关键词 → 漏检中医违规话术（但 prompt 已硬禁，LLM 不应生成；红线兜底缺失但概率低）
- RL2 (竞品): 中文竞品 / 命理 app / 占星师品牌名不在英文 blocklist 里
- RL3 (抄袭 n-gram): jaccard 算法对中文按字符 vs 按词分词不同
- RL4 (drift): jaccard 算法基于英文 target_keyword，ZH 文章必 0% 命中 → 验证时建议加 `--allow-low-keyword-density` 或先用 `--strict false`
- RL5 (keyword stuffing): 主词从英文换成主中文长尾词，需要按 language 决定数哪个
- RL6 (心理安全): 中文版需要避「修行」「能量净化」等承诺型语言（**已在 prompt §C 神秘学营销红线硬禁**）

**v2 计划** (post-demo)：
1. `red-lines.zh.mjs` 维护独立的中文 keyword list（覆盖 RL1 中医禁词 + RL2 中文竞品 + RL6 中文心理安全）
2. 中文 n-gram 用 `intl-segmenter` 或 jieba 切分后再算 jaccard / shingle
3. RL4 / RL5 读 fixture 内新增的 `target_keyword_zh` 字段（先 LLM 派生填 fixture，后续 sheet 手填）

## 8. Oracle 落盘（已就绪，未对接）

Oracle 端**双语基础设施已完整**（无需改 oracle 代码）：

```typescript
// data/articles/types.ts
export type Language = "zh" | "en";
export type WikiArticle = { ..., lang: Language };

// data/articles/index.ts
export const ARTICLES_EN: WikiArticle[] = [...]; // 当前 15 篇
export const ARTICLES_ZH: WikiArticle[] = [...]; // 当前 5 篇 (老文章)

export function getArticleBySlug(slug: string, lang: Language): WikiArticle | undefined;
```

路由 `App.tsx` 已支持 `/:lang/wiki/:slug` 模式。同 slug 双语共存通过路由 lang 参数 + `getArticleBySlug(slug, lang)` 解决。

**待对接** (`gg-md-to-oracle-ts.mjs`): 转换时读 `fixture.language`，决定 `varName` 后缀 (`En` / `Zh`) 和写入 `ARTICLES_EN[]` 还是 `ARTICLES_ZH[]`。当前脚本只走 EN 路径。

## 9. Demo 验证记录 (2026-05-25)

`page_aura_color_blue` (definition × T2, target_keyword=`aura color blue`):

```
EN V8 PROMPT WRITTEN: .gg-cache/prompts/page_aura_color_blue.v8-prompt.md
Length: 23,886 chars, 3,462 tokens (rough)

ZH V8 PROMPT WRITTEN: .gg-cache/prompts/page_aura_color_blue.v8.zh-prompt.md
Length: 21,389 chars, 2,818 tokens (rough)
```

两份 fixture 均通过 placeholder check (all replaced ✓)，区分点：
- EN fixture: `language='en'`, `word_range=[1500, 1800]`
- ZH fixture: `language='zh'`, `word_range=[2000, 2400]`

`--language both` 模式 batch report：
```
total=2 rendered=2 skipped=0 errored=0
✅ row 310 [en] page_aura_color_blue: rendered
✅ row 310 [zh] page_aura_color_blue: rendered
```

## 10. Open work (post-demo, post-review, post-v9-full)

**v9-demo 修复 (2026-05-25 fan-out review)**：

- ✅ F1: phase2 中文 H2 spec
- ✅ F2: phase2 中文字符 word count
- ✅ F3: 删脉轮 ↔ 中医气脉桥接（合规）
- ✅ F4: 加大陆《广告法》§9 绝对禁词 section
- ✅ F5: 加神秘学营销红线 section (改运 / 招财 / 化解灾难 等)
- ✅ H1: 删紫微 / 八字嫁接 aura/chakra 类比
- ✅ H2: chakra/aura 改三对照「气场 / 光环 / 磁场」
- ✅ H3: keyword 形态 guardrail (长度 cap + AI 农场尾缀禁词 + 主语化测试)
- ✅ H4: anti-AI blocklist 补 12 词小红书爆款腔
- ✅ LLM ZH demo: opus 4.7 实际产出 1590 字中文 wiki 词条

**v9-full 落地 (2026-05-25)**：

- ✅ Phase A: `gg-md-to-oracle-ts.mjs` 加 `--language zh` → ZH `.ts` 文件 + `lang: "zh"` + `${slug}Zh` 变体名 + index.ts hint 切 `ARTICLES_ZH.push`
- ✅ Phase B: 新建 `lib/red-lines.zh.mjs` (66 中医 + 广告法禁词 / 18 中文竞品 / 神秘学营销红线) + phase2 按 `fixture.language` 切 RL1/RL2/RL6
- ✅ Phase C: phase2 RL4/RL5 按 language 切中文 keyword (CLI `--zh-keyword` > `fixture.target_keyword_zh` > H1-derive) + `tokenizeKeepStop` 加 CJK char-level fallback
- ✅ Phase D: Sheet 加第 22 列 `target_keyword_zh`（运营手填）+ `gg-sheet-pull.mjs` header_map + `gg-render-batch.mjs` composeCfg 透传 + `_render-aura-shared.mjs` fixture 字段
- ✅ Phase E: `gg-publish-to-wiki.sh` 加 `--language en|zh`，ZH 文章分流到 `astrologywiki-<batch>-zh/` 子目录
- ✅ ZH demo phase2 全 PASS：Structure ✓ / RL1-6 全 PASS (RL4 中文 jaccard work)
- ✅ EN regression 0 影响：RL1 still scans 6 EN competitors / RL5 EN keyword count / RL6 EN disclaimer 检测

**仍待办 (low priority)**：

| 项 | 工作量 | 优先级 |
|---|---|---|
| 中文版 obsidian RAG 接入 (现在中文 prompt 只能消费英文 RAG) | ~4-6h | 低 (LLM 中文化能力足够桥接) |
| oracle 自动合并 `<slug>.zh.ts` 进 `<slug>.ts` (single-file dual-export) | ~1h | 低 (oracle 端可手动 merge) |
| 中文 NLP 升级：用 jieba 替代 char-level tokenizer (RL4 jaccard 更准) | ~3-4h | 低 (char-level 已 work) |
| sheet 第 22 列在线 apply (调 workbook-bootstrap 把 spec 实际写到 GS) | ~15min | 中 (此前操作时机) |
