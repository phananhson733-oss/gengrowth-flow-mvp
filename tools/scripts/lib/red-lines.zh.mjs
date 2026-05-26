// red-lines.zh.mjs — bilingual-v9: Chinese-language red-line checks for
// phase2 validator. Paired with red-lines.mjs (EN); dispatched in
// _phase2-validate.mjs by ctx.language.
//
// Scope:
//   - RL1 (clinical claims): 中医违规话术 (调理 / 治愈 / 打通经络 / 排毒 ...)
//                            + 大陆《广告法》§9 绝对禁词 (最 / 第一 / 100% ...)
//   - RL2 (competitor smear): 中文圈灵性 / 占星 / 命理 app + KOL 名字
//   - RL6 (psych safety):     中文心理 disclaimer + 神秘学营销话术
//                             (改运 / 招财 / 化解灾难 / 开光 / 加持 ...)
//
// RL3 (SERP plagiarism) + RL4 (anchored) + RL5 (stuffing) share EN
// algorithms but with ZH-aware keyword. See _phase2-validate.mjs for the
// dispatcher logic.

// ─── RL1 ──────────────────────────────────────────────────────────────
// 中医违规话术 (《中医药法》§19 + 《医疗广告管理办法》):
// 任一与灵性 / 气场 / 脉轮 / 能量等概念共现都视为变相中医宣传。
// 暂用 broad keyword scan (无 context window) — false-positive 风险存在
// (如 "调息" 不该误中 "调理")。每个词都做了 boundary 处理。

export const RL1_ZH_CLINICAL_TERMS = Object.freeze([
  // 治疗 / 去除症状
  '治愈', '痊愈', '痊可', '治好',
  // 「治疗」要做精确：避免误中「治疗师」「自我治疗」等正常表述
  // → 用 「治疗 + 名词」组合 (单字 「治疗」 太广，先用 「治疗效果 / 治疗作用 / 治疗方法」)
  '治疗效果', '治疗作用', '治疗方法', '疗效',
  '疗法', '康复',
  '祛除', '根除', '去病',
  // 重塑 / 排毒 / 打通 (灵性圈高发)
  '排毒', '净化身体', '净化血液', '清理毒素', '清除毒素',
  '打通经络', '打通气脉', '疏通经络', '疏通气脉',
  // 中药功效语
  '补气', '补血', '养肝', '护肾', '安神', '宁心',
  // 「健脾」、「益肺」 太常见可能误中 「身心健脾胃」、「益于肺部健康」 — 略保守
  // 生理 / 病症
  '降血压', '降血糖', '降血脂',
  '提升免疫力', '抗衰老', '抗癌', '防癌',
  // 阴阳失衡 + 气血不足 单独使用还 ok（中医文献语），但与灵性概念共现就是变相宣传
  // 这里不 ban，留给 prompt + 人审
]);

// 《广告法》§9 绝对禁词（中文圈封号 / 罚款头号原因）
// 这些是「极限程度词」+「程度强化词」+「承诺式」+「伪权威背书」
export const RL1_ZH_AD_LAW_TERMS = Object.freeze([
  // 极限程度
  '国家级', '最高级', '最佳', '第一', '唯一', '首选', 'No.1',
  // 等级声誉
  '最权威', '最专业', '最准确',
  // 程度强化 — 「最」单字太广，要与下面具体词组组合
  '100%', '绝对的', '彻底', '根治', '全网最', '史上最',
  // 承诺式
  '保证', '承诺', '确保', '包治', '包过', '包准',
  // 伪权威
  '国家认证', '官方推荐', '专家推荐', '权威机构', '央视推荐',
  // 独占式
  '独家', '绝无仅有', '前所未有', '史无前例',
]);

export function checkRL1Zh(draft) {
  const allTerms = [...RL1_ZH_CLINICAL_TERMS, ...RL1_ZH_AD_LAW_TERMS];
  for (const term of allTerms) {
    // Chinese has no word boundaries, so we do simple substring scan.
    // ASCII terms (100% / No.1) still substring-scan correctly.
    if (draft.includes(term)) {
      const idx = draft.indexOf(term);
      const ctx = draft.slice(Math.max(0, idx - 30), Math.min(draft.length, idx + term.length + 30));
      const category = RL1_ZH_CLINICAL_TERMS.includes(term) ? '中医违规话术' : '《广告法》§9 禁词';
      return {
        id: 'rl1_no_clinical_claim',
        pass: false,
        note: `${category} "${term}" matched. context: "...${ctx.replace(/\s+/g, ' ').trim()}..."`,
      };
    }
  }
  return { id: 'rl1_no_clinical_claim', pass: true, note: `扫描 ${allTerms.length} 个中医 + 广告法禁词，0 命中` };
}

// ─── RL2 ──────────────────────────────────────────────────────────────
// 中文圈灵性 / 占星 / 命理产品 + KOL 名字。
// 与 EN 一样用 ±200 char 窗口扫贬低情感词；命中即 fail。

export const RL2_ZH_COMPETITORS = Object.freeze([
  // 主流命理 / 星座 app
  '测测星座', '同道大叔', '闹闹女巫', '准了', 'Co-Star', 'Costar',
  '星座屋', '科技紫微', '紫微大师', '准了 App',
  // 大 V / KOL (公众号 / 微博 / 小红书层级)
  '陶白白', 'Alex 大叔', 'Alex是大叔', '苏珊米勒', 'Susan Miller',
  // 命理 / 玄学服务平台
  '占心', '占星之门', '新浪星座',
]);

export const RL2_ZH_SENTIMENT_REGEX =
  /(不专业|不准|不靠谱|骗钱|割韭菜|智商税|圈钱|不要去|避雷|踩雷|拉黑|黑名单|骗子|假货|抄袭|抄)/g;

export const RL2_ZH_WINDOW_CHARS = 200;

export function checkRL2Zh(draft) {
  for (const comp of RL2_ZH_COMPETITORS) {
    let idx = 0;
    while (true) {
      const found = draft.indexOf(comp, idx);
      if (found === -1) break;
      const start = Math.max(0, found - RL2_ZH_WINDOW_CHARS);
      const end = Math.min(draft.length, found + comp.length + RL2_ZH_WINDOW_CHARS);
      const window = draft.slice(start, end);
      const sentMatch = window.match(RL2_ZH_SENTIMENT_REGEX);
      if (sentMatch) {
        return {
          id: 'rl2_no_competitor_smear',
          pass: false,
          note: `中文竞品 "${comp}" 出现在 ±${RL2_ZH_WINDOW_CHARS} 字内含贬低词 "${sentMatch[0]}"`,
        };
      }
      idx = found + comp.length;
    }
  }
  return {
    id: 'rl2_no_competitor_smear',
    pass: true,
    note: `扫描 ${RL2_ZH_COMPETITORS.length} 个中文竞品名 + ±${RL2_ZH_WINDOW_CHARS} 字窗口`,
  };
}

// ─── RL6 ──────────────────────────────────────────────────────────────
// 中文心理安全 + 神秘学营销红线
// 中文 disclaimer 形式: 「本文不构成临床建议」/「本文不是心理咨询意见」

export const RL6_ZH_DISCLAIMER_REGEX =
  /(本文|以下内容)(不构成|不是|非)(临床|心理咨询|心理治疗|医疗)(意见|建议|诊断)/;

// 神秘学营销红线（站点封号下架头号原因）
export const RL6_ZH_FORBIDDEN_TERMS = Object.freeze([
  // 改运 / 转运
  '改运', '转运', '旺运', '催运', '助运', '调运', '增运',
  // 招纳财禄
  '招财', '旺财', '招桃花', '旺夫', '旺子',
  // 化解灾祸
  '化解灾难', '化煞', '破煞', '挡灾', '趋吉避凶',
  // 前世业障
  '前世今生', '业障消除', '消业', '还阴债',
  // 驱邪开光
  '驱邪', '镇宅', '辟邪', '开光', '灌顶', '化解阴气',
  // 「加持」单字太广（佛教经文常用）暂不 ban
  // 预测改命
  '改命', '改八字', '算流年',
  // 「预测命运」「看相算命」单独说有时是介绍性质，不一定违规，留 prompt + 人审
  // 情感操控
  '避免离婚', '让 TA 回心转意', '复合服务', '挽回前任', '找到正缘',
  // 「连接更高的自己」「链接宇宙」「接通高我」是 spiritual 话术但部分用户接受
  // → 这里 ban 严重商业承诺式表达
]);

// 大陆心理 / 中医专业领域禁用承诺词（更严的 disclaimer 兜底）
export const RL6_ZH_FORBIDDEN_PHRASE_REGEX =
  /(诊断你的|治疗你的|治愈你的)(情绪|心理|焦虑|抑郁|创伤|心病)/;

export function checkRL6Zh(draft, ctx) {
  const ePs = ctx.effectivePsychSafety;
  const ePsLegacy = ctx.psych_safety_flag;
  // 与 EN RL6 一致：strict wiring check
  if (ePs === undefined && ePsLegacy === undefined) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: 'RL6 wiring bug: caller passed neither effectivePsychSafety nor psych_safety_flag',
    };
  }
  const flag = ePs ?? ePsLegacy;
  if (flag !== 'Y' && flag !== 'N') {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: `RL6 wiring bug: psych_safety value "${flag}" not in {Y, N}`,
    };
  }

  // 神秘学营销红线 — 不管 psych_safety_flag，always-fail (任一命中)
  for (const term of RL6_ZH_FORBIDDEN_TERMS) {
    if (draft.includes(term)) {
      return {
        id: 'rl6_psych_safety_disclaimer',
        pass: false,
        note: `神秘学营销红线词 "${term}" 命中（《广告法》§9(7) 妨碍社会公共秩序）`,
      };
    }
  }

  // psych_safety=N → N/A (no disclaimer required)
  if (flag !== 'Y') {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: true,
      note: 'N/A (psych_safety=N) — 神秘学红线扫描 PASS',
    };
  }

  // psych_safety=Y → 必须有中文 disclaimer
  const hasDisclaimer = RL6_ZH_DISCLAIMER_REGEX.test(draft);
  if (!hasDisclaimer) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: '缺少中文心理安全 disclaimer 句式（应含「本文不构成临床/心理咨询建议」类表述）',
    };
  }

  // 检查 forbidden phrase
  const forbidden = draft.match(RL6_ZH_FORBIDDEN_PHRASE_REGEX);
  if (forbidden) {
    return {
      id: 'rl6_psych_safety_disclaimer',
      pass: false,
      note: `心理诊疗承诺式表达 "${forbidden[0]}" 命中`,
    };
  }

  return {
    id: 'rl6_psych_safety_disclaimer',
    pass: true,
    note: 'psych_safety=Y + 中文 disclaimer ✓ + 神秘学红线 ✓ + forbidden 句式 ✓',
  };
}

// ─── RL7 (作家黑词) ───────────────────────────────────────────────────────
// TODO(lane-c): 中文作家黑词清单暂未上线。Lane A 的作家 persona capsule 目前
// 仅产出英文 banned_tokens；中文 capsule 落地后在此实现 checkRL7Zh（注意中文
// 无 \b 词边界，需用域词典 / 子串 + 标点边界策略，不能照搬 EN 的 \b 方案）。
// 在此之前 _phase2-validate.mjs 对 zh 文章跳过 RL7（视为该作家无中文黑词）。

// ─── RL8 (科学背书红线) ───────────────────────────────────────────────────
// 全作家适用：占星 / 神秘学内容禁止把解释挂钩科学证明。子串匹配即可（中文无
// 词边界问题，这些短语本身足够具体，误伤风险低）。跳过 frontmatter + fenced
// code，与 EN RL8 对齐。
export const RL8_ZH_SCI_CLAIM_TERMS = Object.freeze([
  '研究表明',
  '研究显示',
  '科学研究表明',
  '科学证明',
  '科学证实',
  '临床证实',
  '临床证明',
  '数据证实',
  '有科学依据',
  '科学依据表明',
  '实验证明',
]);

function stripFrontmatterZh(md) {
  if (typeof md !== 'string') return '';
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

function stripFencedCodeZh(md) {
  return md.replace(/^[ \t]*(```|~~~)[\s\S]*?^[ \t]*\1[ \t]*$/gm, '');
}

export function checkRL8Zh(draft) {
  const body = stripFencedCodeZh(stripFrontmatterZh(typeof draft === 'string' ? draft : ''));
  const lines = body.split('\n');
  const evidence = [];
  for (let i = 0; i < lines.length; i++) {
    for (const term of RL8_ZH_SCI_CLAIM_TERMS) {
      if (lines[i].includes(term)) {
        evidence.push({ phrase: term, line: i + 1, context: lines[i].trim().slice(0, 160) });
        break;
      }
    }
  }
  if (evidence.length > 0) {
    return {
      id: 'rl8_no_scientific_endorsement',
      pass: false,
      note: `科学背书红线词命中: ${evidence.map((e) => `"${e.phrase}"`).join(', ')}`,
      evidence,
    };
  }
  return {
    id: 'rl8_no_scientific_endorsement',
    pass: true,
    note: `扫描 ${RL8_ZH_SCI_CLAIM_TERMS.length} 个科学背书短语, 无命中`,
  };
}
