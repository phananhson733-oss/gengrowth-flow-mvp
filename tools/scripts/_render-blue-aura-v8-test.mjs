// One-off renderer: Blue Aura × T2 × Definition × v8 prompt.
// Uses existing .gg-cache/page_blue_aura_meaning/ from B'.1 entity-passport run.

import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

renderAuraPrompt({
  page_id: 'page_blue_aura_meaning',
  entity: 'Blue Aura',
  target_keyword: 'blue aura meaning',
  associated_keywords: ['blue aura', 'blue aura personality', 'what does blue aura mean'],
  search_volume: '12100',
  cluster_jtbd:
    '1 分钟搞懂 blue aura 在主流光环传统里到底代表什么，区分浅蓝 / 深蓝 / indigo 三种语义，说出 lifestyle 含义而不是装腔作势的伪物理',
  content_angle:
    'frame blue aura as an interpretive convention in aura traditions (associated with throat chakra / communication archetype), not a measurable electromagnetic fact — give shade differentiation + practical "what this might mean for me" guidance + an honest caveat that aura readings are subjective frameworks',
  internal_link_rule:
    'all → pillar page on aura colors overview + sibling entries on purple aura / yellow aura + throat chakra reference',
  cta_text: 'Take the 60-second Aura Reading Quiz to see how your colors map',
  cta_target_url: 'https://astrologywiki.com/tools/aura-reading-quiz',
  tier_gate_block: `## Tier Gate（T2 Definition）

- 必读 Friction（col J）: 用户搜 'blue aura meaning' 想 1 分钟知道蓝色光环代表什么、自己有没有、不同蓝色 shade 差别在哪，但搜出来全是把光环当物理事实写的伪科学（"electromagnetic field"、"frequency wavelength"），或者把 throat chakra 当机械器官的临床式判断，没人讲传统本身是 interpretive framework
- 必读 Logic（col K）: Blue aura 在主流光环传统中常 associated with throat chakra（Vishuddha）和 communication / truth-seeking / clear expression 原型；浅蓝偏 calm + sensitivity，indigo / 深蓝偏 inner intuition + spiritual maturity；这是 interpretive convention（不是可测物理场），文章应该写成"这是 X 传统怎么看这个颜色 + 它如何被解读 + 实操层面对生活的暗示"
- T2 = 标准版 — 字数 1500-1800，结构严格按 7 sections`,
  rl6_hint:
    '不要用判断性语言（你必须 / 你是 X 型人）逼读者认领某种颜色或缺陷；保持 interpretive / framework-oriented framing；不要把 throat chakra 写成机械组织',
  friction_themes: [
    {
      theme: 'shade_confusion',
      scrubbed_quote: 'i keep seeing different blue auras in different photos — light blue then indigo — does it mean different things or am i just imagining shifts',
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 8,
    },
    {
      theme: 'over_claim_anxiety',
      scrubbed_quote: 'every blue aura article tells me i am a psychic communicator and a healer but i feel like a regular introvert is the whole framework just astrology cosplay',
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 6,
    },
    {
      theme: 'lifestyle_actionability',
      scrubbed_quote: 'ok so my aura is reportedly blue what am i supposed to do with that information practically — does it change how i should work or who i should date',
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 5,
    },
  ],
});
