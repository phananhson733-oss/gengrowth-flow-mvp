// One-off renderer: Purple Aura × T2 × Definition × v8 prompt.

import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

renderAuraPrompt({
  page_id: 'page_purple_aura_meaning',
  entity: 'Purple Aura',
  target_keyword: 'purple aura meaning',
  associated_keywords: ['purple aura', 'purple aura personality', 'what does purple aura mean'],
  search_volume: '8100',
  cluster_jtbd:
    '区分 violet / indigo / purple 三种紫色光环的语义，回答"我是不是真的在感知还是在脑补"的根本焦虑，给一个不夸大 psychic power 的诚实答案',
  content_angle:
    'frame purple aura as an interpretive convention often linked to crown chakra (Sahasrara) and/or third eye (Ajna) — emphasize introspection / spiritual orientation; explicit disclaimer that perceiving aura color is a subjective interpretive practice, NOT a measurable EM phenomenon; provide shade differentiation + lifestyle implication + when this framework helps vs hurts',
  internal_link_rule:
    'all → pillar page on aura colors overview + sibling entries on blue aura / indigo aura / white aura + crown chakra and third eye references',
  cta_text: 'Take the 60-second Aura Reading Quiz to see how your colors map',
  cta_target_url: 'https://astrologywiki.com/tools/aura-reading-quiz',
  tier_gate_block: `## Tier Gate（T2 Definition）

- 必读 Friction（col J）: 用户搜 'purple aura meaning' 经常处在三种状态：(1) 在不同来源看到 violet / indigo / purple 名字混着用，分不清；(2) 自己疑似 "看到" 紫色 aura 但不确定是不是想象，担心被算成 "delusion"；(3) 文章把紫色光环吹成 "psychic mastery" / "old soul" 让普通人觉得自己不够"高频"。需要诚实定义 + 不夸张的 lifestyle 暗示 + 明确说这是 interpretive framework
- 必读 Logic（col K）: Purple aura 在主流光环传统里 commonly associated with crown chakra (Sahasrara) 和 third eye (Ajna)，象征 introspection / spiritual orientation / intuitive process；按 shade 区分：light purple / violet 偏 empath + sensitivity，dark purple / indigo 偏 inner pattern recognition + 与 daily life 脱节风险；不是 measurable EM 现象，是 interpretive convention
- T2 = 标准版 — 字数 1500-1800，结构严格按 7 sections`,
  rl6_hint:
    '不要写让脆弱读者觉得"自己是 old soul 但格格不入是宿命"的命定语言；不要暗示 purple aura = clinical depression / dissociation；保持 framework-oriented + agency-oriented framing',
  friction_themes: [
    {
      theme: 'shade_confusion',
      scrubbed_quote: 'is purple the same as violet the same as indigo when reading auras or are they totally different categories that everyone is using interchangeably',
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 7,
    },
    {
      theme: 'am_i_imagining',
      scrubbed_quote: 'sometimes i see what looks like a purple haze around people but i can never tell if i am actually seeing it or just expecting it because i read about it last week',
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 9,
    },
    {
      theme: 'mystical_overclaim',
      scrubbed_quote: 'every purple aura article tells me i am psychic and old soul and crystal child but in real life i am exhausted and confused not enlightened so what gives',
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 6,
    },
  ],
});
