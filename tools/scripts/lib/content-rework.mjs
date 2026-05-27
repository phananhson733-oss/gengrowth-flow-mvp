// content-rework.mjs — turn a Phase 2 validation FAILURE into a ready-to-paste
// "rework prompt" that feeds the exact failures back to the LLM.
//
// Why this exists (architecture note):
//   gg-content-draft generation is human-in-loop — Phase 1 renders a prompt, a human
//   pastes it to the LLM, saves the output, and Phase 2 ingests + validates it.
//   Before this module, a Phase 2 fail only emitted exit codes 11/12 + recordFail
//   lines; the operator had to manually translate "red line RL5 failed" into a
//   corrective instruction and re-prompt. That manual diagnosis step is where quality
//   stability leaks. This module compresses it to a single paste: original draft +
//   the specific failed checks + targeted fix directives → corrected draft.
//
// Pure / dep-free: input the same rl + sc result objects runPhase2 already computed,
// output a markdown string. No disk, no Sheets, no run state — unit-testable in
// isolation (matches red-lines.mjs / content-draft-util.mjs conventions).

// Soft bound on the rework loop. Past this the operator should stop re-prompting and
// hand the page to manual review — a draft that fails N times usually has a brief /
// source problem, not a wording problem. Caller decides what to do with max_reached.
export const MAX_REWORK_ITERATIONS = 3;

// Per-red-line corrective directives. Keyed by the rule id red-lines.mjs emits.
// Each value is the specific fix the LLM should apply — never "try again", always
// "do X". WARN-only rules (rl11/rl12-(d)) never reach here because they pass.
const RL_FIX_HINTS = Object.freeze({
  rl1_no_clinical_claim:
    '删除或改写任何医疗主张（诊断 / 治疗 / 治愈 / 开处方类）。改为反思性语言，如 "can be used as a reflective lens" / "some people explore this theme"。',
  rl2_no_competitor_smear:
    '移除对竞品（Cafe Astrology / Astro-Seek / Co-Star 等）的任何负面或贬损评价。改为中性陈述，或直接删除该提及。',
  rl3_no_serp_plagiarism:
    '改写与 SERP top-3 结果连续重合超过阈值的长句。用你自己的表达重述同一信息，不要逐字搬运。',
  rl4_keyword_anchored:
    '让漂移的 H2 小节重新回扣 target_keyword / entity：在该段落内加入与主关键词直接相关的具体内容，而不是泛泛而谈。',
  rl5_no_keyword_stuffing:
    'target_keyword 出现次数超限。删减重复，用同义词、代词或自然改写替换一部分，保持语义自然、不堆砌。',
  rl6_psych_safety_disclaimer:
    '补回结尾的 disclaimer 行（"This is not a clinical interpretation or mental health advice."）；移除 healing / therapy / diagnose / treat / cure / disorder / syndrome 等黑词；全文改用反思性、非临床语言。',
  rl7_author_banned_tokens:
    '移除当前作者人设的禁用词。换成符合该作者 voice 的等义表达，不改变结构。',
  rl8_no_scientific_endorsement:
    '删除"科学证明 / 研究表明 / 经科学验证"类伪科学背书。改为 "传统上 / 有些人认为 / 在占星语境中" 这类不主张科学性的措辞。',
  rl9_atom_label_leak:
    '删除任何内部标注 / 模板标签 / 字段名泄漏到正文（如 atom label、<field> 残留、占位符）。只保留干净的文章正文。',
  rl10_depersonalization:
    '减少对读者的过度断言式人称指控（"you are X because…"）。改为开放、邀请式的反思表达。',
  rl12_citation_hallucination:
    '删除任何编造的外部 URL 或引用。只保留 CTA 允许的链接，或权威白名单内真实存在的实体 / 人名。',
});

// Structure issues are free-text strings from structureCheck. Match by pattern → directive.
// Order matters: first match wins; falls through to the raw issue text if nothing matches.
const STRUCTURE_FIX_RULES = Object.freeze([
  [/missing H1/i, '在文章开头加一个 H1 标题（`# ...`）。'],
  [/H2 sections|expected \d+ H2|H2 count/i,
    '把 H2 小节数量调整到模板要求：Tutorial = 8 节，Definition = 7 节。不要增删正文信息，只调整分节。'],
  [/Step count/i, 'Tutorial 正文需要至少 3 个明确编号的步骤（Step 1 / Step 2 / Step 3 …）+ 至少一个有序列表。'],
  [/ordered list/i, '加入至少一个有序列表（`1.` `2.` …）承载操作步骤。'],
  [/table or bullet/i, 'Definition 至少需要 1 个 markdown 表格或 bullet 列表来组织信息。'],
  [/CTA anchor/i, '确保结尾 CTA 段落包含指定的 cta 文案或目标链接（或一个 `## CTA` 小节）。'],
  [/disclaimer/i, '补回 psych-safety disclaimer 行："This is not a clinical interpretation or mental health advice."'],
  // 清单 v4.0 §3 Atomic GEO Layout — 段落原子化（SC3）。
  [/SC3|段落过长|paragraph too long|≤\s*4\s*行|wall of text/i,
    '把过长的 prose 段落拆成多个原子段：每段只承载「事实金句 / 机制 / 实例」之一，控制在 ≤4 行（英文 ≤~70 词，中文 ≤~150 字），段间用空行分隔。不要改动表格、编号列表与已通过的小节结构。'],
  // 清单 v4.0 §2 Link Master — 内链分布 / 首链优先权（SC4）。
  [/SC4|内链.*分布|link distribution|首链优先/i,
    '内链不要全堆在结尾 Related Reading / 延伸阅读：至少把 1 条 pillar / spoke 内链自然内联织进正文前段的句子里（首链优先权），中段再内联 1 条，其余链接才留在延伸阅读小节。保持 `[[<TBD-internal-link: ...>]]` 占位格式。'],
]);

function structureFixHint(issue) {
  for (const [pattern, hint] of STRUCTURE_FIX_RULES) {
    if (pattern.test(issue)) return hint;
  }
  return '按上面给出的问题描述修正。';
}

// Build the markdown rework prompt.
//
// @param {object} input
//   draftMd          — the ingested draft body (NFKC-normalized, no byline frontmatter)
//   redLineResult    — redLinesCheck() output: { all_pass, rules: [{id, pass, note?}] }
//   structureResult  — structureCheck() output: { ok, issues: [...] }
//   ctx              — { pageId, template, tier, targetKeyword, entity,
//                        effectivePsychSafety, iteration }
// @returns {string} markdown to paste back to the LLM
export function buildReworkPrompt({ draftMd, redLineResult, structureResult, ctx = {} } = {}) {
  const failedRedLines = (redLineResult && Array.isArray(redLineResult.rules))
    ? redLineResult.rules.filter((r) => !r.pass)
    : [];
  const structureIssues = (structureResult && Array.isArray(structureResult.issues) && !structureResult.ok)
    ? structureResult.issues
    : [];

  const iteration = Number.isInteger(ctx.iteration) && ctx.iteration > 0 ? ctx.iteration : 1;
  const maxReached = iteration > MAX_REWORK_ITERATIONS;

  const lines = [];
  lines.push('# 返工指令（Rework）— 上一稿未通过 Phase 2 校验');
  lines.push('');
  lines.push(`- page_id: \`${ctx.pageId || '(unknown)'}\``);
  lines.push(`- 模板 / Tier: ${ctx.template || '?'} / ${ctx.tier || '?'}`);
  if (ctx.targetKeyword) lines.push(`- target_keyword: ${ctx.targetKeyword}`);
  if (ctx.entity) lines.push(`- entity: ${ctx.entity}`);
  lines.push(`- 返工轮次: 第 ${iteration} 次${maxReached ? `（已超过软上限 ${MAX_REWORK_ITERATIONS}，建议转人工审核）` : ''}`);
  lines.push('');
  lines.push('## 你的任务');
  lines.push('');
  lines.push('下面是上一稿全文，以及它**未通过**的具体校验项。请输出**修订后的完整文章**：');
  lines.push('');
  lines.push('1. **只修复下列列出的问题**，不要改动已经通过的结构、作者 voice、字数区间。');
  lines.push('2. 保持原有的小节结构、标题层级、CTA 与内链不变（除非问题本身要求调整）。');
  lines.push('3. 直接输出修订后的完整 markdown 正文，不要附加解释、不要包裹代码块。');
  lines.push('');

  if (failedRedLines.length > 0) {
    lines.push(`## 未通过的红线（${failedRedLines.length} 项，必须全部修复）`);
    lines.push('');
    for (const r of failedRedLines) {
      const hint = RL_FIX_HINTS[r.id] || '按红线说明修正。';
      lines.push(`### ${r.id}`);
      if (r.note) lines.push(`- 检测到的问题：${r.note}`);
      lines.push(`- 修复方向：${hint}`);
      lines.push('');
    }
  }

  if (structureIssues.length > 0) {
    lines.push(`## 未通过的结构校验（${structureIssues.length} 项，必须全部修复）`);
    lines.push('');
    for (const issue of structureIssues) {
      lines.push(`- 问题：${issue}`);
      lines.push(`  - 修复方向：${structureFixHint(issue)}`);
    }
    lines.push('');
  }

  if (failedRedLines.length === 0 && structureIssues.length === 0) {
    // Defensive: caller should only invoke on failure, but never emit an empty task.
    lines.push('## 说明');
    lines.push('');
    lines.push('未检出具体失败项（可能是校验上下文缺失）。请按 Phase 2 红线 + 结构规则自查全文后重新输出完整草稿。');
    lines.push('');
  }

  lines.push('## 上一稿全文（待修订）');
  lines.push('');
  lines.push('````````markdown');
  lines.push(typeof draftMd === 'string' ? draftMd : '');
  lines.push('````````');
  lines.push('');

  return lines.join('\n');
}

export { RL_FIX_HINTS, structureFixHint };
