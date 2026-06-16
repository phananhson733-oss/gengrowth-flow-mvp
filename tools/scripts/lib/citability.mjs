// citability — 可引用性确定性特征提取 + 透明加权分（clean-room，零 AI，零依赖）
//
// Ported verbatim into flow-mvp from sibling repo gengrowth-geo
// (measurement/lib/citability.mjs, citability-geo-heuristic-v1). Kept identical
// so the deterministic clean-room logic and its provenance stay intact. Used by
// the gengrowth (B2B SEO+GEO) profile's SC-GEO check (lib/structure-checks.geo.mjs);
// the oracle line never imports it.
//
// @input 一段文本（自有页 markdown 或采样答案）→ @output {score, features, weights, method, basis, caveat}
//
// clean-room 依据：特征杠杆独立推导自公开论文
//   GEO: Generative Engine Optimization (Aggarwal, Murahari et al., KDD 2024, arXiv:2311.09735)。
//   实证最有效杠杆 = Cite Sources / Quotation Addition / Statistics Addition (+Fluency)，
//   Keyword Stuffing 无效/有害。不 vendor/复制任何无 license 源码，仅按公开发现选确定性特征 + 透明启发权重。
// 数据层纪律：score 为确定性可复现的加权特征计数（同输入同输出），权重是启发式、未经校准，
//   定位为编辑优先级信号，非测量数字、非已证因果。caveat 字段显式标注。

export const CITABILITY_VERSION = "citability-geo-heuristic-v1";

// 启发权重（GEO 论文 top 杠杆权重更高）。和 = 1.0。真实采样后再校准。
export const DEFAULT_WEIGHTS = Object.freeze({
  statistics: 0.22,
  citations: 0.22,
  quotations: 0.18,
  definitions: 0.14,
  structure: 0.12,
  excerptability: 0.07,
  fluency: 0.05,
});

// 每特征饱和目标（count 达此值即归一到 1.0）。启发常量。
const SATURATION = Object.freeze({
  statistics: 5,
  citations: 4,
  quotations: 3,
  definitions: 3,
  structure: 10,
});

const sat = (count, target) => Math.min(count / target, 1);
const round = (v) => Math.round(v * 1e4) / 1e4;

// 统计/数字主张：百分比、千分位大数、带单位数字（GEO「Statistics Addition」）。
function countStatistics(t) {
  const pct = t.match(/\b\d+(?:\.\d+)?\s?%/g) || [];
  const big = t.match(/\b\d{1,3}(?:,\d{3})+\b/g) || [];
  const unit = t.match(/\b\d+(?:\.\d+)?[\s-]?(?:times|x|years?|months?|days?|percent|million|billion|thousand|hours?|minutes?)\b/gi) || [];
  return pct.length + big.length + unit.length;
}

// 引用来源：外链 + 「according to/research/study/report by」+ 方括号编号引用（GEO「Cite Sources」）。
function countCitations(t) {
  const ext = t.match(/\]\(https?:\/\//g) || [];
  const bareUrl = t.match(/(?<!\]\()\bhttps?:\/\/\S+/g) || [];
  const phrases = t.match(/\b(?:according to|per a|research by|study by|report by|cited by|source:)\b/gi) || [];
  const numRefs = t.match(/\[\d+\]/g) || [];
  return ext.length + bareUrl.length + phrases.length + numRefs.length;
}

// 引述：成对直引号（>2 词）+ markdown 引用块（GEO「Quotation Addition」）。
function countQuotations(t) {
  const dq = t.match(/[""][^""]{8,}?[""]/g) || [];
  const sq = t.match(/"[^"\n]{8,}?"/g) || [];
  const block = t.match(/^>\s+\S/gm) || [];
  return dq.length + sq.length + block.length;
}

// 直答/定义句：「X is/are/refers to/means/is defined as ...」（提升可摘录直答）。
function countDefinitions(t) {
  const m = t.match(/\b[A-Z][\w'’\- ]{1,40}?\s(?:is|are|refers to|means|is defined as|describes)\s/g) || [];
  return m.length;
}

// 结构：列表项 + 表分隔行 + 标题（结构化利于摘录）。
function countStructure(t) {
  const lists = t.match(/^\s*(?:[-*+]|\d+\.)\s+\S/gm) || [];
  const tables = t.match(/^\s*\|[\s:|-]+\|\s*$/gm) || [];
  const headings = t.match(/^#{1,6}\s+\S/gm) || [];
  return lists.length + tables.length + headings.length;
}

// 可摘录性：短段落（<=60 词）占比。短段落更易被整段引用。
function excerptability(t) {
  const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0 && !/^[#|>\-*]/.test(p));
  if (paras.length === 0) return 0;
  const shortish = paras.filter((p) => (p.match(/\S+/g) || []).length <= 60).length;
  return shortish / paras.length;
}

// fluency 代理：句均词数落在 ~10-24 带内得分高（过长难摘录、过短信息少）。弱代理，权重最低。
function fluencyProxy(t) {
  const sentences = t.replace(/\n+/g, " ").split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length === 0) return 0;
  const lens = sentences.map((s) => (s.match(/\S+/g) || []).length).filter((n) => n > 0);
  if (lens.length === 0) return 0;
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  if (avg >= 10 && avg <= 24) return 1;
  if (avg < 10) return Math.max(0, avg / 10);
  return Math.max(0, 1 - (avg - 24) / 24); // 越超 24 越低，48 词归 0
}

// 纯函数：提取确定性特征（原始计数 + 归一 0-1）。
export function extractCitabilityFeatures(text) {
  const t = typeof text === "string" ? text : "";
  const raw = {
    statistics: countStatistics(t),
    citations: countCitations(t),
    quotations: countQuotations(t),
    definitions: countDefinitions(t),
    structure: countStructure(t),
  };
  const normalized = {
    statistics: round(sat(raw.statistics, SATURATION.statistics)),
    citations: round(sat(raw.citations, SATURATION.citations)),
    quotations: round(sat(raw.quotations, SATURATION.quotations)),
    definitions: round(sat(raw.definitions, SATURATION.definitions)),
    structure: round(sat(raw.structure, SATURATION.structure)),
    excerptability: round(excerptability(t)),
    fluency: round(fluencyProxy(t)),
  };
  return { raw, normalized };
}

// 纯函数：citability 加权分 0-1 + 特征 + 元信息。weights 可覆盖（须和归一权重一致语义）。
export function scoreCitability(text, weights = DEFAULT_WEIGHTS) {
  const { raw, normalized } = extractCitabilityFeatures(text);
  let score = 0;
  let wsum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (typeof normalized[k] === "number") {
      score += normalized[k] * w;
      wsum += w;
    }
  }
  return {
    score: round(wsum > 0 ? score / wsum : 0),
    features: { raw, normalized },
    weights,
    method: CITABILITY_VERSION,
    basis: "GEO paper Aggarwal et al. KDD2024 (arXiv:2311.09735) public findings; clean-room, no vendored code",
    caveat: "启发式编辑信号，非测量数字、非已证因果；权重未经校准，不可作影响用户决策的权威分",
  };
}
