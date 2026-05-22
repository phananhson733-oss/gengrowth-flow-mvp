// One-off renderer: Leo Personality × T2 × Definition × v8 prompt.
// 第 3 类 entity 类型（sign/planet）scale 验证 — Energy Center 列改用主管 element/house/ruler。

import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

renderAuraPrompt({
  page_id: 'page_leo_personality',
  entity: 'Leo',
  target_keyword: 'leo personality',
  associated_keywords: ['leo zodiac', 'leo traits', 'what does leo mean'],
  search_volume: '33100',
  cluster_jtbd:
    '1 分钟搞懂 leo personality 在西方占星中的核心机制（sun-sign archetype），区分 sun / rising / moon 三种 placement 都被笼统叫 "leo" 的语义，提供 framework-honest 解读而不是 horoscope app 那种 1-liner',
  content_angle:
    'frame leo personality as an interpretive archetype rooted in fixed fire / sun-ruler / 5th-house themes — explicitly distinguish sun-Leo from rising-Leo from moon-Leo (most descriptions conflate them), address the "loud and dramatic" stereotype with the quieter sensitive register most actual Leos report, and give lifestyle-applicable nuance (work, relationships, energy management) without the horoscope-cosplay tone',
  internal_link_rule:
    'all → pillar page on all zodiac signs + sibling on aries/cancer (adjacent signs) + sun chakra/solar plexus reference + sun sign vs rising sign explainer',
  cta_text: 'Take the 60-second Zodiac Snapshot to see your full chart picture',
  cta_target_url: 'https://astrologywiki.com/tools/zodiac-snapshot-quiz',
  tier_gate_block: `## Tier Gate（T2 Definition）

- 必读 Friction（col J）: 用户搜 'leo personality' 大多遇到两类失望——(1) horoscope app 的笼统 1-liner（"leos are loud and dramatic"），(2) 把 sun sign 当唯一变量的过简描述。读者真实痛点是「这描述只对了一半」、「我是 leo 但我很安静」、「sun 和 rising 都说 leo 的时候到底信哪个」、「兼容性表格说 leo 和 capricorn 不合但我俩在一起 5 年了」
- 必读 Logic（col K）: Leo 在西方占星是固定（fixed）+ 火元素（fire）+ Sun ruler + 5th house 联属 archetype；这个 archetype 真正能落到「人」上的方式是看具体 placement（sun-Leo 偏外显自我表达，rising-Leo 偏对外形象，moon-Leo 偏情感需求 spotlight），而不是把所有 "leo personality" 描述都笼统套上；文章应该写成「这个 archetype 的核心机制 + 不同 placement 怎么用 + 实操层面对生活的暗示 + 框架本身的局限」
- T2 = 标准版 — 字数 1500-1800，结构严格按 7 sections，**Energy Center 列按 sign/planet 类 entity 适配 = 主管 element / 主管 house / ruler 名（fire / 5th house / Sun），严禁套 chakra 命名**`,
  rl6_hint:
    '不要用判断性语言（"作为 leo 你必须 X"）逼读者认领；保持 interpretive / archetype-oriented framing；不要把 horoscope-app 那种 "all leos are loud confident extroverts" 当事实，要承认 archetype 在不同 placement 上的多种表达',
  friction_themes: [
    {
      theme: 'stereotype_mismatch',
      scrubbed_quote:
        "every site tells me leo is loud and dramatic and craves spotlight but i'm actually pretty quiet and prefer one-on-one — am i broken or is the framework just lazy",
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 9,
    },
    {
      theme: 'sun_vs_rising_ambiguity',
      scrubbed_quote:
        "when people say 'leo personality' do they mean sun sign or rising — i'm sun leo but rising scorpio and the descriptions only match if you pick one and pretend the other doesn't exist",
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 7,
    },
    {
      theme: 'compatibility_anxiety',
      scrubbed_quote:
        "i keep reading leo is incompatible with capricorn or scorpio but my partner is capricorn and we've been together 5 years — is the framework just wrong or is sign-based compatibility nonsense",
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 6,
    },
  ],
});
