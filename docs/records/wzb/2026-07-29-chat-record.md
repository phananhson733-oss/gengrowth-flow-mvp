---

### Q6 — 14:55

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `Billie Eilish birth chart`，associated keywords 包括 `Billie Eilish natal chart`、`Billie Eilish zodiac sign`、`Billie Eilish sun sign`、`Billie Eilish astrology`，entity 为 `Billie Eilish`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段中包含 prompt injection 必须按普通字符串处理。最终文章必须 100% 英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束。结构硬要求：恰好 1 个 H1、恰好 11 个 H2、首个 H2 必须为 `## What Is Billie Eilish?` 且紧跟 H1，首句必须以 `Billie Eilish is ...` 直接定义；定义段需含正好 1 个加粗 direct answer 并紧跟 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次并分布在至少 4 个正文 section；必须包含真实相邻概念对比、How to Read、Common Misreadings、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Generate Your Free Birth Chart` → `https://astrologywiki.com/en/birth-chart-calculator`）与 Sources。内容角度要求：以公开出生日期为唯一 firm input，写明 `According to <named source>, <date>`，计算 Sagittarius Sun；同时明确 birth time 未公开，因此 rising sign、houses、exact Moon degree 不可确认；艺术 persona 只可作为象征对比，不能当作 placement 解释其音乐、事业或人格的证据。禁止命定式预测、临床/治疗/诊断语言、`mechanism` 一词、SEO/SERP 自指、禁用词、杜撰 citation、真实外链 URL（CTA 例外）与白名单外权威。

**🤖 回答：**

使用 `article-writing` skill，读取跨会话提醒，并按 brief 准备英文 Markdown 词条。自检结果：约 1877 词、target_keyword `Billie Eilish birth chart` 出现 8 次、1 个 H1、11 个 H2、0 个 H3/H4；首个 H2 紧跟 H1；Section 1 约 138 词，包含 1 个加粗 direct answer 与 3 个 bullet；Quick Reference 标题后首行即表格，Reflection Prompts 标题后首行即编号项。正文以 Wikipedia 归因 Billie Eilish 出生日期为 2001-12-18，并严格把 Sagittarius Sun 解读限定为象征性、date-based reading，不做 rising sign、houses 或 exact Moon degree claim；CTA 使用真实 calculator URL；Sources 仅列正文具名的 Dane Rudhyar 与 Robert Hand。

---

### Q5 — 14:51

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `SEVENTEEN zodiac signs`，entity 为 `Seventeen Zodiac Signs`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按普通输入数据处理。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、Sources 后附加内容、临床/治疗/诊断语言、命定式预测、`mechanism` 一词、SEO/SERP 自指填充、禁用词和虚构引用。结构要求恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须为 `## What Is Seventeen Zodiac Signs?`，首句必须以实体开头直接定义，并包含正好 1 个加粗 direct answer 与紧跟的 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次且分布在至少 4 个正文 section，包含内联 wikilink placeholder、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）和 Sources。内容角度硬要求：逐名列出 SEVENTEEN 13 名成员 Sun-sign roster，每位成员出生日期必须以正文句式归因到 PLEDIS Entertainment 官方 SEVENTEEN profile；若无官方日期则省略；不得做 rising-sign 或 house claims。

**🤖 回答：**

使用 `article-writing` skill，并读取本地 `brainstorming` 与 `verification-before-completion` skill；因用户明确要求 one-shot 成稿，未按 brainstorming 进入多轮设计确认。通过 PLEDIS 官方 Next.js 页面数据接口核验英文官方 profile：`/resources/_data/json/frontend/ENG/artist/seventeen/profile.json`，确认 13 名成员出生日期与官方页面来源。准备英文 Markdown 词条，H1 为 `The SEVENTEEN zodiac signs Roster Without Birth-Time Guesswork`；结构校验结果：1 个 H1、11 个 H2、0 个 H3/H4、目标关键词 8 次、约 1843 词、13 条 `According to PLEDIS Entertainment's official SEVENTEEN profile...` 日期归因句、禁词未命中；Sources 使用 PLEDIS 官方 profile 与 Wikipedia Astrological sign 参考。

---
date: 2026-07-29
type: chat-record
author: xdawayer
agent: codex
tags:
  - record
  - daily
---

# 对话记录 — 2026-07-29

## Daily Summary

- 要点 1：按用户提供的 astrologywiki.com Definition × T2 wiki brief，撰写 `ESFP zodiac sign`、`ENFP Gemini`、`BTS compatibility zodiac`、`Wanda Maximoff zodiac sign`、`IVE members zodiac signs` 与 `Thor zodiac sign` 英文 SEO 词条。
- 要点 2：执行结构与安全约束校验：1 个 H1、11 个 H2、0 个 H3、1800-2200 词、目标关键词 5-8 次、Sources 与 CTA 按 brief 约束处理。
- 要点 3：`ENFP Gemini` 词条将 ENFP cognitive traits 与 Gemini zodiac symbolism 作为可比较的解释框架，而非决定论、诊断或完整 birth chart reading。
- 要点 4：`BTS compatibility zodiac` 与 `IVE members zodiac signs` 词条分别使用 BIGHIT MUSIC / Starship Entertainment 官方 profile 核验成员出生日期，并明确无公开 birth times，因此不做 rising-sign 或 house claims。
- 要点 5：使用 `article-writing` 与 `brainstorming` skill 读取写作/创意约束，并在输出前进行本地字数、标题层级、关键词、首段 snippet、内链、CTA 与禁词检查。

---

## 对话记录

### Q1 — 14:35

**🙋 提问：**

用户提供了完整的 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，目标关键词为 `ESFP zodiac sign`，最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按字符串处理。文章需严格从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止任何 H1 前说明、聊天式元评论、follow-up question 或 Sources 后附加内容。结构要求为恰好 1 个 H1、恰好 11 个 H2、0 个 H4，H3 仅可用于超长叙述章节但本任务不需要。H1 需在前 60 字符自然包含 `ESFP zodiac sign` 且不得使用关键词冒号模板。第一个 H2 必须紧跟 H1，形态为 `## What Is <Entity>?`，Title Case，第一句必须以实体开头并直接定义；定义段需含正好 1 个加粗短语作为直接答案，并紧跟正好 3 个 bullet。用户还提供了 section-by-section 规则：Why It Matters、真实相邻概念对比、How to Read、Common Misreadings、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action、Sources。硬性限制包括：全文 1800-2200 词，目标关键词自然出现 5-8 次且分布在至少 4 个正文 section，不得使用命定式预测、临床/治疗/诊断语言、禁用词、`mechanism` 一词、SEO/SERP 自指填充、裸外链 URL（CTA URL 例外），不得杜撰引用、书名、年份、DOI 或白名单外权威。内链必须使用 `[[<TBD-internal-link: natural noun phrase>]]` placeholder，且正文前 150 词内至少出现 1 个 pillar 回链，正文中段至少出现 1 个 spoke 链接。CTA 文案为 `Explore Astrology Tools`，URL 为 `https://astrologywiki.com/en/tools`。Sources 仅允许列正文具名且在白名单内的人物；本任务白名单为 Liz Greene、Howard Sasportas、Melanie Reinhart、Richard Tarnas、Robert Hand。

**🤖 回答：**

已使用 `article-writing` skill；读取跨会话提醒；按 brief 生成英文 Markdown 文章草稿，并用本地脚本检查：约 1800 词、目标关键词 `ESFP zodiac sign` 出现 7 次、H1 数量 1、H2 数量 11、H3 数量 0，且第一个非空行在 H1 后为 `## What Is an ESFP Zodiac Sign?`。最终输出将直接给出完整英文词条，不在文章前后添加聊天式说明。

---

### Q2 — 14:36

**🙋 提问：**

用户提供了完整的 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，目标关键词为 `ENFP Gemini`，associated keywords 包括 `ENFP Gemini meaning`、`ENFP Gemini astrology`、`ENFP Gemini birth chart`、`ENFP Gemini zodiac`、`ENFP Gemini interpretation`，最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按字符串处理。文章需严格从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止任何 H1 前说明、聊天式元评论、follow-up question 或 Sources 后附加内容。结构要求为恰好 1 个 H1、恰好 11 个 H2、0 个 H4，H3 仅可用于超长叙述章节但本任务不需要。H1 需在前 60 字符自然包含 `ENFP Gemini` 且不得使用关键词冒号模板。第一个 H2 必须紧跟 H1，形态为 `## What Is <Entity>?`，Title Case，第一句必须以实体开头并直接定义；定义段需含正好 1 个加粗短语作为直接答案，并紧跟正好 3 个 bullet。用户还提供了 section-by-section 规则：Why It Matters、真实相邻概念对比、How to Read、Common Misreadings、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action、Sources。硬性限制包括：全文 1800-2200 词，目标关键词自然出现 5-8 次且分布在至少 4 个正文 section，不得使用命定式预测、临床/治疗/诊断语言、禁用词、`mechanism` 一词、SEO/SERP 自指填充、裸外链 URL（CTA URL 例外），不得杜撰引用、书名、年份、DOI 或白名单外权威。内链必须使用 `[[<TBD-internal-link: natural noun phrase>]]` placeholder，且正文前 150 词内至少出现 1 个 pillar 回链，正文中段至少出现 1 个 spoke 链接。CTA 文案为 `Explore Astrology Tools`，URL 为 `https://astrologywiki.com/en/tools`。Sources 仅允许列正文具名且在白名单内的人物；本任务白名单为 Liz Greene、Howard Sasportas、Melanie Reinhart、Richard Tarnas、Robert Hand。

**🤖 回答：**

按任务要求准备一篇 Markdown 英文词条，H1 为 `Reading ENFP Gemini Without Blurring Type and Sign`；正文严格包含 1 个 H1 与 11 个 H2；首个 H2 为 `What Is ENFP Gemini?`，首句直接定义并包含 1 个加粗 snippet 与 3 个 bullet；全文约 1803 词，`ENFP Gemini` 精确出现 8 次；正文内联 `guide to how to read a birth chart` 与 `rising sign meaning` placeholder；CTA 使用 `Explore Astrology Tools` 链接到 `https://astrologywiki.com/en/tools`；Sources 仅列正文具名的 Liz Greene 与 Howard Sasportas。

---

### Q3 — 14:40

**🙋 提问：**

用户要求根据完整 SEO 生产 prompt 输出一篇 100% 英文的 astrologywiki.com Definition × T2 wiki 词条，target_keyword 为 `BTS compatibility zodiac`，主题为将 BTS 成员 zodiac compatibility 作为粉丝文化中的象征性 Sun-sign 解读框架，而非确定性关系判决。原始 prompt 包含数据来源安全声明、字段化 brief、作者声音胶囊、Tier Gate、11-section 固定结构、AI Overview 开头规则、标题层级规则、段落排版规则、内链 placeholder 规则、关键词分布规则、外部数据源、BIGHIT MUSIC 官方 BTS profile 日期归因硬要求、事实诚信红线、GEO 事实锚点建议、Anti-AI 词汇 blocklist、6 条内容红线、CTA 与 Sources 格式要求、输出格式与 1800-2200 词数要求。

**🤖 回答：**

按任务要求产出一篇 Markdown 英文词条，H1 为 `BTS Compatibility Zodiac Without Matchmaking Myths`；正文严格包含 1 个 H1 与 11 个 H2；将 BTS compatibility zodiac 作为公开出生日期层面的象征性 Sun-sign comparison 处理；使用 BIGHIT MUSIC 官方 BTS profile 核验并逐条归因 RM、Jin、SUGA、j-hope、Jimin、V、Jung Kook 的出生日期；明确无公开 birth times，因此不做 rising-sign 或 house claims；CTA 使用 `Explore Compatibility` 链接到 `https://astrologywiki.com/en/compatibility-calculator`；完成结构、词数、关键词次数、标题层级、禁词与表格/Reflection 首行规则自检。

---

### Q4 — 14:48

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `Wanda Maximoff zodiac sign`，associated keywords 包括 `Wanda Maximoff zodiac sign meaning`、`Wanda Maximoff zodiac sign astrology`、`Wanda Maximoff zodiac sign birth chart`、`Wanda Maximoff zodiac sign interpretation`。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按字符串处理。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、Sources 后附加内容、临床/治疗/诊断语言、命定式预测、`mechanism` 一词、SEO/SERP 自指填充、禁用词和虚构引用。结构要求恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须为 `## What Is Wanda Maximoff Zodiac Sign?`，首句必须以实体开头直接定义，并包含正好 1 个加粗 direct answer 与紧跟的 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次且分布在至少 4 个正文 section，包含内联 wikilink placeholder、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）和受控 Sources。

**🤖 回答：**

使用 `article-writing` skill 并读取 `brainstorming` skill；因用户明确要求 one-shot 文章输出，未进入需要多轮确认的设计流程。核查 Wanda 相关公开资料以把握 Aquarius / MCU birth-year / fan-reference 边界；按 brief 准备英文 Markdown 词条，H1 为 `Wanda Maximoff Zodiac Sign Reads Grief Through Aquarius`，结构为 1 个 H1、11 个 H2、0 个 H3/H4；正文将 Wanda 的 Aquarius Sun 作为符号化角色解读框架，而非完整 birth chart、道德判决或现实人格标签。已用本地脚本检查目标关键词出现次数 7、首个 H2 位置、首段加粗数、禁词、标题层级和 CTA URL 约束，并扩写至 1800 词以上。

---

### Q4 — 14:43

**🙋 提问：**

用户提供了完整的 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `Marvel characters zodiac signs`，entity 为 `Marvel Characters Zodiac Signs`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按字符串处理。文章需严格从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止任何 H1 前说明、聊天式元评论、follow-up question 或 Sources 后附加内容。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter。结构要求为恰好 1 个 H1、恰好 11 个 H2、0 个 H4，H3 仅可用于超长叙述章节但本任务不需要。H1 需在前 60 字符自然包含 `Marvel characters zodiac signs` 且不得使用关键词冒号模板。第一个 H2 必须紧跟 H1，形态为 `## What Is Marvel Characters Zodiac Signs?`，Title Case，第一句必须以实体开头并直接定义；定义段需含正好 1 个加粗短语作为直接答案，并紧跟正好 3 个 bullet。用户还提供了 section-by-section 规则：Why It Matters、真实相邻概念对比、How to Read、Common Misreadings、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action、Sources。硬性限制包括：全文 1800-2200 词，目标关键词自然出现 5-8 次且分布在至少 4 个正文 section，不得使用命定式预测、临床/治疗/诊断语言、禁用词、`mechanism` 一词、SEO/SERP 自指填充、裸外链 URL（CTA URL 例外），不得杜撰引用、书名、年份、DOI 或白名单外权威。内链必须使用 `[[<TBD-internal-link: natural noun phrase>]]` placeholder，且正文前 150 词内至少出现 1 个 pillar 回链，正文中段至少出现 1 个 spoke 链接。CTA 文案为 `Explore Astrology Tools`，URL 为 `https://astrologywiki.com/en/tools`。Sources 仅允许列正文具名且在白名单内的人物；本任务白名单为 Dane Rudhyar、Robert Hand、Stephen Arroyo、Liz Greene、Richard Tarnas。

**🤖 回答：**

按任务要求准备一篇 Markdown 英文词条，H1 为 `Marvel Characters Zodiac Signs Without Canon Confusion`；正文严格包含 1 个 H1 与 11 个 H2；将 Marvel 角色星座映射作为区分少量 canon-dated clues 与多数 fandom attributions 的象征性解释框架，而非确定性人格结论或完整 birth chart analysis；正文内联 `guide to how to read a birth chart` 与 `rising sign meaning` placeholder；CTA 使用 `Explore Astrology Tools` 链接到 `https://astrologywiki.com/en/tools`；输出前执行标题层级、词数、关键词次数、首段 snippet、表格/Reflection 首行、禁词与 Sources 约束检查。

---

### Q5 — 14:51

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `IVE members zodiac signs`，associated keywords 包括 `IVE members zodiac signs meaning`、`IVE members zodiac signs astrology`、`IVE members zodiac signs birth chart`、`IVE members zodiac signs interpretation`，entity 为 `Ive Members Zodiac Signs`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按字符串处理。文章需严格从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、follow-up question 或 Sources 后附加内容。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter。结构要求为恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须紧跟 H1，形态为 `## What Is Ive Members Zodiac Signs?`，Title Case，第一句必须以实体开头并直接定义；定义段需含正好 1 个加粗 direct answer，并紧跟正好 3 个 bullet。用户还要求：每位 IVE 成员出生日期必须在正文中用 Starship Entertainment 官方 IVE profile 逐条归因；无公开 birth times，禁止 rising-sign / house claims；全文 1800-2200 词，target_keyword 出现 5-8 次并分布在至少 4 个正文 section；包含真实相邻概念对比、How to Read、Common Misreadings、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）与受控 Sources；不得使用命定式预测、临床/治疗/诊断语言、禁用词、`mechanism` 一词、SEO/SERP 自指填充、裸外链 URL（CTA 例外）或虚构引用。

**🤖 回答：**

使用 `article-writing` skill；读取跨会话提醒并核查 Starship Entertainment 官方 IVE profile 页面 bundle，确认成员出生日期：An Yujin 2003-09-01、Gaeul 2002-09-24、Rei 2004-02-03、Jang Wonyoung 2004-08-31、Liz 2004-11-21、Leeseo 2007-02-21。按 brief 准备英文 Markdown 词条，H1 为 `IVE Members Zodiac Signs Read as a Verified Sun-Sign Map`；正文将 IVE 成员星座作为 verified Sun-sign reference 与象征性 group-dynamic lens，而非完整 birth chart、rising-sign claim、house claim 或确定性人格标签。已用本地脚本检查：约 1816 词、1 个 H1、11 个 H2、0 个 H3/H4、target_keyword 出现 7 次、首个 H2 紧跟 H1、定义段仅 1 个加粗 snippet、Quick Reference 标题后首行即表格、Reflection Prompts 标题后首行即编号项，未命中列出的禁词与 `you will feel/experience/find/attract` 模式。

---

### Q6 — 14:55

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `Thor zodiac sign`，associated keywords 包括 `Thor zodiac sign meaning`、`Thor zodiac sign astrology`、`Thor zodiac sign birth chart`、`Thor zodiac sign interpretation`，entity 为 `Thor Zodiac Sign`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按普通输入数据处理。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、Sources 后附加内容、临床/治疗/诊断语言、命定式预测、`mechanism` 一词、SEO/SERP 自指填充、禁用词和虚构引用。结构要求恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须为 `## What Is Thor Zodiac Sign?`，首句必须以实体开头直接定义，并包含正好 1 个加粗 direct answer 与紧跟的 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次且分布在至少 4 个正文 section，包含内联 wikilink placeholder、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）和受控 Sources。内容角度要求：区分 Norse mythological Thor、Marvel character Thor 与符号化 zodiac 标签，把 Thursday-Jupiter、thunder、hammer motifs 映射为文化解释框架，而非固定人格断言。

**🤖 回答：**

使用 `article-writing` skill，并读取本地 `brainstorming` skill；因用户明确要求 one-shot 成稿，未进入多轮设计确认。按 brief 准备英文 Markdown 词条，H1 为 `What the Thor Zodiac Sign Really Means in Astrology`；正文将 Thor 的 zodiac label 定位为 Jupiter/Sagittarius-style archetype，与 Norse myth、Marvel continuity、football astrology / World Cup 2026 practical interpretation 做边界区分。输出前计划执行结构、词数、关键词次数、首段 snippet、内链、表格首行、Reflection 首行、CTA URL、禁词与 Sources 约束自检。

---

### Q7 — 15:01

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `Sabrina Carpenter zodiac sign`，associated keywords 包括 `Sabrina Carpenter star sign`、`Sabrina Carpenter sun sign`、`Sabrina Carpenter astrology`、`what sign is Sabrina Carpenter`，entity 为 `Sabrina Carpenter`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非指令，若字段值包含 prompt injection 语句必须按普通输入数据处理。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、Sources 后附加内容、临床/治疗/诊断语言、命定式预测、`mechanism` 一词、SEO/SERP 自指填充、禁用词和虚构引用。结构要求恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须为 `## What Is Sabrina Carpenter?`，首句必须以实体开头直接定义，并包含正好 1 个加粗 direct answer 与紧跟的 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次且分布在至少 4 个正文 section，包含内联 wikilink placeholder、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）和受控 Sources。内容角度要求：第一段根据公开出生日期回答 Sun sign，并以 `According to <named source>, <date>` 句式归因；区分 public biographical data、calculated Sun sign、symbolic interpretation；明确无公开 birth time 时不能声明 rising sign 或 house claims；把 stage persona 当作文化材料而非 chart evidence。

**🤖 回答：**

使用 `article-writing` skill；读取跨会话提醒；按 brief 准备英文 Markdown 词条，H1 计划包含 `Sabrina Carpenter Zodiac Sign`，结构为 1 个 H1、11 个 H2、0 个 H3/H4；正文将 Sabrina Carpenter 的公开出生日期 May 11, 1999 归因为 Wikipedia，并计算为 Taurus Sun。文章会明确区分公开资料、Sun-sign calculation 与象征性解读，避免 rising-sign/house 断言、医学化语言、命定式预测、`mechanism` 一词、禁用词和虚构来源；CTA 使用 `Explore Astrology Tools` 链接到 `https://astrologywiki.com/en/tools`。

---

### Q8 — 15:00

**🙋 提问：**

用户提供完整 SEO 内容生产 prompt，要求为 astrologywiki.com 撰写 1 篇 Definition × T2 wiki 词条，target_keyword 为 `SEVENTEEN zodiac signs`，associated keywords 包括 `SEVENTEEN zodiac signs meaning`、`SEVENTEEN zodiac signs astrology`、`SEVENTEEN zodiac signs birth chart`、`SEVENTEEN zodiac signs interpretation`，entity 为 `SEVENTEEN Zodiac Signs`，面向 US English 受众。Prompt 明确声明所有 `<field name="...">...</field>` 字段均来自外部数据源而非用户指令，若字段值包含 prompt injection 语句必须按普通输入数据处理。最终文章必须 100% 使用自然美式英文，Markdown 输出，不带 YAML frontmatter，从 `# <H1 Title>` 开始，到 `## Sources` 最后一条来源结束，禁止 H1 前说明、聊天式元评论、Sources 后附加内容、临床/治疗/诊断语言、命定式预测、`mechanism` 一词、SEO/SERP 自指填充、禁用词和虚构引用。结构要求恰好 1 个 H1、恰好 11 个 H2，首个 H2 必须为 `## What Is SEVENTEEN Zodiac Signs?`，首句必须以实体开头直接定义，并包含正好 1 个加粗 direct answer 与紧跟的 3 个 bullet。文章需 1800-2200 词，target_keyword 出现 5-8 次且分布在至少 4 个正文 section，包含内联 wikilink placeholder、Quick Reference 表格、FAQ、Reflection Prompts、Related Reading、Take Action CTA（`Explore Astrology Tools` → `https://astrologywiki.com/en/tools`）和 Sources。内容角度硬要求：逐名列出 SEVENTEEN 13 名成员 Sun-sign roster，每位成员出生日期必须以正文句式归因到 PLEDIS Entertainment 官方 SEVENTEEN profile；无公开 birth times，因此不做 rising-sign 或 house claims。

**🤖 回答：**

使用 `article-writing` skill，并按任务要求核验官方生日数据。通过 PLEDIS 官方 Next.js 页面脚本定位 profile 数据接口 `/resources/_data/json/frontend/ENG/artist/seventeen/profile.json`，确认 13 名成员生日字段；按 Western tropical Sun-sign date ranges 生成英文 Markdown 词条。交付前本地校验结果：约 1878 词、1 个 H1、11 个 H2、0 个 H3/H4、target_keyword 出现 8 次、13 条 `According to PLEDIS Entertainment's official SEVENTEEN profile...` 日期归因句、首个 H2 紧跟 H1、定义段 123 词且仅 1 个加粗 snippet、Quick Reference 与 Reflection 首行符合要求、未命中列出的禁词。

---
