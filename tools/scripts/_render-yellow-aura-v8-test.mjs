// One-off renderer: Yellow Aura × T2 × Definition × v8 prompt.

import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

renderAuraPrompt({
  page_id: 'page_yellow_aura_meaning',
  entity: 'Yellow Aura',
  target_keyword: 'yellow aura meaning',
  associated_keywords: ['yellow aura', 'yellow aura personality', 'what does yellow aura mean'],
  search_volume: '9900',
  cluster_jtbd:
    '回答"yellow aura 是好兆头还是 burnout 信号"的核心摩擦，区分明亮 / 金色 / 暗淡黄三种 shade 的语义，给可执行的 lifestyle 暗示而不是含糊正能量话术',
  content_angle:
    'frame yellow aura as commonly associated with solar plexus (Manipura) and intellect / confidence / optimism archetype — show that the SAME color reads differently by shade and life-phase: bright yellow = healthy vitality, muddy yellow = strain / anxiety / burnout signal; honest disclaimer that aura reading is interpretive not clinical; give "how to read this in yourself" + "when this framework helps you make a real decision"',
  internal_link_rule:
    'all → pillar page on aura colors overview + sibling entries on blue aura / orange aura + solar plexus chakra reference',
  cta_text: 'Take the 60-second Aura Reading Quiz to see how your colors map',
  cta_target_url: 'https://astrologywiki.com/tools/aura-reading-quiz',
  tier_gate_block: `## Tier Gate（T2 Definition）

- 必读 Friction（col J）: 用户搜 'yellow aura meaning' 常处在两种状态：(1) 不同来源对黄色给完全相反的答案——一组说 "joyful / optimist / intellect"，另一组说 "burnout / anxiety / nervous system overdrive"，不知道信哪个；(2) 读完不知道如何把这个标签转成生活决定（要不要换工作、要不要放慢、要不要 self-care）。需要 shade-aware 解释 + 决策提示
- 必读 Logic（col K）: Yellow aura 在主流光环传统中 commonly associated with solar plexus (Manipura)，象征 intellect / self-esteem / confidence / optimism；明亮黄 = healthy vitality + creative flow；暗淡 / 浑浊黄 = strain / anxiety / over-thinking 信号；金色 / metallic 黄 = teaching / mentoring 倾向；不是可测电磁场，是 interpretive convention 用作 self-reflection 工具
- T2 = 标准版 — 字数 1500-1800，结构严格按 7 sections`,
  rl6_hint:
    '不要把 "muddy yellow" 写成临床 burnout 诊断或暗示读者去 fix 医疗问题；不要用 "operational" 一族词；不要把 solar plexus chakra 写成机械器官；保持 framework-oriented + 决策导向',
  friction_themes: [
    {
      theme: 'contradictory_meanings',
      scrubbed_quote: 'half the yellow aura articles say it means i am joyful and creative the other half say it means i am burned out and anxious which one is correct',
      source_id: 'reddit#1',
      domain: 'old.reddit.com',
      mention_count: 9,
    },
    {
      theme: 'so_what_lifestyle',
      scrubbed_quote: 'ok so apparently my aura is yellow now what do i do with that information do i need to slow down or am i just supposed to be happy about it',
      source_id: 'reddit#2',
      domain: 'old.reddit.com',
      mention_count: 6,
    },
    {
      theme: 'shade_confusion',
      scrubbed_quote: 'is muddy yellow really a different aura than bright yellow or is everyone just inventing categories to sound more credible than the next person',
      source_id: 'reddit#3',
      domain: 'old.reddit.com',
      mention_count: 5,
    },
  ],
});
