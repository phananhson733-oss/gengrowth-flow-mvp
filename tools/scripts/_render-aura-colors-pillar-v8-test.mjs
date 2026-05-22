// One-off renderer: Aura Colors Pillar × T1 × Pillar × v8 prompt.
// First Pillar template smoke test. Covers 7 main aura colors as a hub page.

import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

renderAuraPrompt({
  page_id: 'page_aura_colors_pillar',
  entity: 'aura colors',
  target_keyword: 'aura colors meaning',
  associated_keywords: ['aura colors chart', 'aura color meanings', 'how to read auras'],
  template: 'Pillar',
  tier: 'T1',
  child_entities: ['red aura', 'orange aura', 'yellow aura', 'green aura', 'blue aura', 'purple aura', 'white aura'],
  child_count: 7,
  search_volume: '49500',
  cluster_jtbd:
    '1 篇 pillar 帮读者一次性理解 7 种主要 aura colors 的全貌，知道每种代表什么、与 chakra 系统怎么对应、为什么不同 source 在不同 shade 上说法不一，然后从这里跳到单色深度页',
  content_angle:
    'frame the article as a hub overview of the aura-color framework — 7 main colors mapped to chakras as interpretive convention, not measurable physics. Give a comparison table, then 80-120w brief per color with link out to its Definition page, then a meta layer on shade / combination / cross-lineage variation, then honest framework limits. Avoid horoscope-cosplay tone; treat readers like adults exploring a vocabulary.',
  internal_link_rule:
    'all → each child Definition page (red/orange/yellow/green/blue/purple/white aura explainers) + chakra system overview + aura reading guide',
  cta_text: 'Take the 60-second Aura Reading Quiz to see how your colors map',
  cta_target_url: 'https://astrologywiki.com/tools/aura-reading-quiz',
  tier_gate_block: `## Tier Gate（T1 Pillar）

- 必读 Friction（col J）: 用户搜 'aura colors meaning' 想一次性看到所有主要颜色的对照表 + 知道哪个对应自己，但市面上文章要么把 7 色当 "天选体质" 心理测试式贴标签（毫无 framework 诚信），要么 22 / 25 色混排让人晕，要么 chakra 系统跟 color 的映射没说透。读者真正的痛点：(1) "我到底要不要相信这个 framework"、(2) "shade 和 combination 怎么算"、(3) "不同 source 说不一致时听谁的"
- 必读 Logic（col K）: aura-color framework 在主流 subtle-energy 传统中是 7 主色 mapped to 7 main chakra centers 的 interpretive convention，不是可测物理场。每个 color 有 default core meaning + shade-state sensitivity（bright vs muddy / light vs deep）+ combination 多色互动。Pillar 页应：先给整个 system overview（这是什么 + 为什么有用 + 不是诊断），再用表格 quick-scan 7 色，再给 80-120w per color brief（链到 Definition 深度页），再讲 shade / combination / lineage 差异 meta layer，最后给框架局限和常见误读
- T1 = Hub 页 — 字数 2500-3500，结构严格按 9 sections，**Quick Reference 表的 Energy Center 列每行用对应 chakra 名（root / sacral / solar plexus / heart / throat / third eye / crown）**`,
  rl6_hint:
    '不要用判断性语言（"你必须有 X aura"）逼读者认领某色；保持 interpretive / framework-oriented framing；明确说 aura 不是可测物理场而是 self-reflection vocabulary；不要把 chakra 写成机械组织',
  friction_themes: [
    {
      theme: 'system_credibility',
      scrubbed_quote:
        "every aura color site reads like a buzzfeed personality quiz and i can't tell if there's any actual framework underneath or it's just vibes for instagram",
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 11,
    },
    {
      theme: 'shade_and_combination',
      scrubbed_quote:
        "i keep seeing different aura color photos showing 2-3 colors at once and the articles just pick one as 'your aura' — what about people who actually have green-blue or yellow-orange combos",
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 8,
    },
    {
      theme: 'cross_lineage_inconsistency',
      scrubbed_quote:
        "one site says purple aura means psychic, another says it means anxiety and overthinking, a third doesn't even list purple — how do i know which tradition is the 'real' one",
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 7,
    },
  ],
});
