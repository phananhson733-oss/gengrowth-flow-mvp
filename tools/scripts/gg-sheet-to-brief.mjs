#!/usr/bin/env node
// gg-sheet-to-brief.mjs — Sheet 选题登记表 → v8 brief override JSON 桥
//
// 上游"data → 关键词 → brief"链路的关键一步：把 21 列选题登记表 + 主题集群表 +
// CTA Map 三张表 join 起来，派生出 gg-render-batch 需要的 13 个 cfg 字段，
// 写成 .gg-cache/overrides/<batch-id>.json。
//
// 派生规则：
//   target_keyword / associated_keywords / search_volume / entity / tier / template
//                                          ← brief（直通 8 个字段）
//   content_angle  ← page.content_angle || cluster.content_angle
//   cluster_jtbd   ← cluster_table[cluster_id].jtbd
//   internal_link_rule  ← cluster_table[cluster_id].internal_link_rule
//   cta_text + cta_target_url  ← CTA Map[(page_role, track)]
//   tier_gate_block  ← 模板化拼接(tier, template, friction_brief, logic_brief, entity)
//   rl6_hint  ← psych_safety_flag === 'Y' ? PSYCH_SAFETY_RL6_HINT : STANDARD_RL6_HINT
//   friction_themes  ← 优先读 .gg-cache/<page_id>/friction-mine.rag.json
//                       fallback：用 brief.friction_brief 生成 3 条 TODO
//   child_entities  ← Pillar template 时从 cluster.child_entities 拿
//
// 用法：
//   node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7
//   node tools/scripts/gg-sheet-to-brief.mjs --row 3 --out path/to/override.json
//   node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7 --skip-non-v8  # 跳过 template != Pillar/Definition
//   node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7 --dry-run     # 只 stdout 不写文件
//
// 输出形如 .gg-cache/overrides/<batch-id>.json，直接喂给 gg-batch-synth.mjs / gg-render-batch.mjs。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/_oauth-token.mjs';
import {
  loadEnv,
  fetchTab,
  parseSlice,
  mapRowToBrief,
  resolvePageId,
  classifyRow,
} from './gg-sheet-pull.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

export const SCHEMA_VERSION = '1';
export const PAGES_TAB = '选题登记表';
export const CLUSTERS_TAB = '主题集群表';
export const CTA_TAB = 'CTA Map';

export const STANDARD_RL6_HINT =
  '不要用 clinical / treatment / cure / disorder / syndrome 类语言。把内容写成 interpretive framework，' +
  '不要把 entity 写成医学/心理诊断标签。';

export const PSYCH_SAFETY_RL6_HINT =
  '⚠️ psych-safety=Y：本页含 healing / trauma / relationship-wound / anxiety 等敏感主题。\n' +
  '必须包含明确的免责声明（如 "This is not a clinical interpretation or medical advice"），' +
  '并严格禁用 healing / therapy / diagnose(s) / treat(s) / cure(s) / remedy / prescribe(s) / ' +
  'prescription / disorder / syndrome 等 RL6 黑名单词。改用 reflection / journaling / ' +
  'self-awareness / interpretive framework 类语言。';

// ---------- pure helpers (exported for tests) ----------

// header-name → 字段名（主题集群表）。`page_assets` / `child_entities` 是逗号分隔列表。
const CLUSTER_HEADER_MAP = {
  cluster_id: 'cluster_id',
  cluster_name: 'cluster_name',
  track: 'track',
  content_layer: 'content_layer',
  business_role: 'business_role',
  primary_entity: 'primary_entity',
  jtbd: 'jtbd',
  content_angle: 'content_angle',
  us_share: 'us_share',
  pillar_page: 'pillar_page',
  series_pattern: 'series_pattern',
  keywords_included: 'keywords_included',
  page_assets: 'page_assets',
  internal_link_rule: 'internal_link_rule',
  cta_primary: 'cta_primary',
  psych_safety_flag: 'psych_safety_flag',
  priority: 'priority',
  week: 'week',
  success_metric: 'success_metric',
  // optional v0.18+ extension — used to populate Pillar child_entities.
  child_entities: 'child_entities',
};

// header-name → 字段名（CTA Map）。
const CTA_HEADER_MAP = {
  cta_id: 'cta_id',
  page_role: 'page_role',
  cta_文案: 'cta_text',
  target_url: 'target_url',
  ga4_event_name: 'ga4_event_name',
  track: 'track',
};

function indexByHeader(headerRow, mapping) {
  const idx = {};
  for (let i = 0; i < headerRow.length; i++) {
    const h = String(headerRow[i] || '').trim();
    if (mapping[h]) idx[mapping[h]] = i;
  }
  return idx;
}

export function buildClusterMap(rows) {
  // rows[0] = header. Returns Map<cluster_id, cluster-row-object>.
  const out = new Map();
  if (!rows.length) return out;
  const idx = indexByHeader(rows[0], CLUSTER_HEADER_MAP);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const id = idx.cluster_id != null ? String(r[idx.cluster_id] || '').trim() : '';
    if (!id) continue;
    const obj = {};
    for (const [field, colIdx] of Object.entries(idx)) {
      obj[field] = String(r[colIdx] || '').trim();
    }
    if (obj.child_entities) {
      obj.child_entities = obj.child_entities
        .split(/[,，、\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      obj.child_entities = [];
    }
    out.set(id, obj);
  }
  return out;
}

// CTA 是否合法（target_url 不能是占位符）。Newsletter 待搭建 → target_url 含 "待搭建" / "TBD" /
// "placeholder" / 纯括号注释 → 视为占位，不应当作有效 CTA 喂给 LLM。
export function isCtaUsable(cta) {
  if (!cta || !cta.target_url) return false;
  const u = String(cta.target_url).trim();
  if (!u) return false;
  if (/^\s*[\(（]/.test(u)) return false; // starts with "（...）" 注释
  if (/待搭建|TBD|placeholder|TODO/i.test(u)) return false;
  return true;
}

export function buildCtaMap(rows) {
  // Returns Map<"page_role||track", cta-row-object>. Track empty = 量产线 (default).
  // 同 (role, track) 多行时第一行胜出 (insert-order stable)，而不是后行覆盖 —— 避免
  // 顺序依赖导致同 Sheet 在不同时间产出不同 CTA。Sheet 维护方应该确保每对 (role, track)
  // 只有一行，否则我们用第一行 + warning。
  const out = new Map();
  const dupes = [];
  if (!rows.length) return { map: out, dupes };
  const idx = indexByHeader(rows[0], CTA_HEADER_MAP);
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const role = idx.page_role != null ? String(r[idx.page_role] || '').trim() : '';
    const track = idx.track != null ? String(r[idx.track] || '').trim() : '';
    if (!role) continue;
    const key = `${role}||${track || '量产线'}`;
    const obj = {};
    for (const [field, colIdx] of Object.entries(idx)) {
      obj[field] = String(r[colIdx] || '').trim();
    }
    if (out.has(key)) {
      dupes.push({ key, row: i + 1 });
      continue;
    }
    out.set(key, obj);
  }
  return { map: out, dupes };
}

// CTA 主键查找。优先级（明确，不依赖 Map 迭代顺序）：
//   1. 精确 (page_role, track) 命中且 isCtaUsable → 用它
//   2. (page_role, 量产线) 默认 fallback 且 isCtaUsable → 用它（量产线工具页是最稳的默认）
//   3. 其他任何 page_role 行（按 track 字典序，确定性）且 isCtaUsable → 用它
//   4. 全部不可用 → null（让 composeOverride 报 warning 而不是塞占位 URL）
// 旧版"任意 ctaMap.entries() 命中即用"会被 Map 迭代顺序影响，且会用占位 URL，已替换。
export function lookupCta(ctaMap, pageRole, track) {
  if (!pageRole) return null;
  const map = ctaMap instanceof Map ? ctaMap : ctaMap.map; // accept {map,dupes} or bare Map
  if (!map) return null;
  const exact = map.get(`${pageRole}||${track || '量产线'}`);
  if (exact && isCtaUsable(exact)) return exact;
  const defaultTrack = map.get(`${pageRole}||量产线`);
  if (defaultTrack && isCtaUsable(defaultTrack)) return defaultTrack;
  // Last resort, deterministic order by sorting the keys.
  const matchingKeys = Array.from(map.keys()).filter((k) => k.startsWith(`${pageRole}||`)).sort();
  for (const k of matchingKeys) {
    const v = map.get(k);
    if (isCtaUsable(v)) return v;
  }
  return null;
}

// 用 brief 的 friction 列 + logic 列 + tier/template + entity 生成 tier_gate_block markdown。
// 这个 block 直接注入 prompt 的 "{{TIER_GATE_BLOCK}}" 槽位。
export function buildTierGateBlock({ tier, template, entity, friction_brief, logic_brief, target_keyword }) {
  const isPillar = template === 'Pillar';
  const wordRange = isPillar ? '2500-3500' : '1500-1800';
  const sectionCount = isPillar ? '9 sections' : '7 sections';
  const tierLabel = tier === 'T1' ? 'Hub / 重装' : (tier === 'T3' ? '极长尾占位' : '标准版');
  const frictionLine = friction_brief && friction_brief.trim()
    ? `- 必读 Friction（col J）: ${friction_brief.trim()}`
    : `- 必读 Friction（col J）: TODO — 3 个用户搜 "${target_keyword || entity}" 时常见的状态/痛点`;
  const logicLine = logic_brief && logic_brief.trim()
    ? `- 必读 Logic（col K）: ${logic_brief.trim()}`
    : `- 必读 Logic（col K）: TODO — 主流 source 怎么写 ${entity}，shade/variant 分别什么含义，为什么是 interpretive framework`;
  return [
    `## Tier Gate（${tier || 'T2'} ${template || 'Definition'}）`,
    '',
    frictionLine,
    logicLine,
    `- ${tier || 'T2'} = ${tierLabel} — 字数 ${wordRange}，结构严格按 ${sectionCount}`,
  ].join('\n');
}

// 从 brief.friction_brief 生成 3 条 TODO friction_themes（fallback，无真实 RAG 数据时）。
export function fallbackFrictionThemes(friction_brief, target_keyword) {
  const trimmed = friction_brief ? String(friction_brief).trim() : '';
  const themeName = trimmed
    ? trimmed.split(/[,，、\n.;]+/)[0].trim().toLowerCase().replace(/\s+/g, '_').slice(0, 30) || 'theme_1'
    : 'theme_1';
  const quote = trimmed
    ? `Reddit-style scrubbed quote capturing: ${trimmed.slice(0, 100)}`
    : `TODO: scrubbed Reddit quote about searching "${target_keyword}"`;
  return [
    { theme: themeName, scrubbed_quote: quote, source_id: 'reddit#1', domain: 'old.reddit.com', mention_count: 5 },
    { theme: `${themeName}_b`, scrubbed_quote: `TODO: 2nd scrubbed quote (frustration with current top-10 results)`, source_id: 'reddit#2', domain: 'old.reddit.com', mention_count: 4 },
    { theme: `${themeName}_c`, scrubbed_quote: `TODO: 3rd scrubbed quote (specific question users keep asking)`, source_id: 'reddit#3', domain: 'old.reddit.com', mention_count: 3 },
  ];
}

// 优先用真实 friction-mine.rag.json（Step 4 修正路径后产出的）；缺则 fallback。
export function loadFrictionThemes(repo, pageId, brief) {
  if (!pageId) return fallbackFrictionThemes(brief.friction_brief, brief.target_keyword);
  const cachePath = join(repo, '.gg-cache', pageId, 'friction-mine.rag.json');
  if (existsSync(cachePath)) {
    try {
      const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (Array.isArray(raw.themes) && raw.themes.length > 0) {
        // expected shape: { themes: [{ theme, scrubbed_quote, source_id, domain, mention_count }, ...] }
        return raw.themes.slice(0, 3);
      }
    } catch {
      // fall through to fallback
    }
  }
  return fallbackFrictionThemes(brief.friction_brief, brief.target_keyword);
}

// 单个 row → override entry（核心派生逻辑）
// 返回 { entry: ... , warnings: [...] } 或 { skip: true, reason: '...' }。
export function composeOverride(row, { clusterMap, ctaMap, repo, skipNonV8 = false }) {
  const brief = row.brief || {};
  const pageId = row.page_id;
  if (!pageId) return { skip: true, reason: 'no page_id (sheet col 16 empty and target_keyword blank)' };

  const template = (brief.template || '').trim();
  if (skipNonV8 && template && !/^pillar$|^definition$/i.test(template)) {
    return { skip: true, reason: `template "${template}" not yet supported by v8 (only Pillar/Definition)` };
  }

  const clusterId = String(brief.cluster_id || '').trim();
  const cluster = clusterId ? clusterMap.get(clusterId) : null;

  const pageRole = String(brief.page_role || '').trim();
  const track = cluster ? cluster.track : '';
  const cta = lookupCta(ctaMap, pageRole, track);

  // psych_safety = page OR cluster (codex review: cluster-level psych flag must not be silently dropped).
  // 任一 Y 都 → Y。空 / N / 无效都视作 N。
  const pagePsych = String(brief.psych_safety_flag || '').trim().toUpperCase();
  const clusterPsych = cluster ? String(cluster.psych_safety_flag || '').trim().toUpperCase() : '';
  const psychFlag = (pagePsych === 'Y' || clusterPsych === 'Y') ? 'Y' : 'N';
  const rl6Hint = psychFlag === 'Y' ? PSYCH_SAFETY_RL6_HINT : STANDARD_RL6_HINT;

  const warnings = [];
  // joinFailures — main() converts these to FATAL + fuzzy suggestions unless --allow-missing-* set.
  const joinFailures = [];
  if (clusterId && !cluster) {
    warnings.push(`cluster_id "${clusterId}" not found in 主题集群表`);
    joinFailures.push({ kind: 'cluster_id', missing: clusterId });
  }
  if (pageRole && !cta) {
    warnings.push(`page_role "${pageRole}" (track=${track || '?'}) not found in CTA Map`);
    joinFailures.push({ kind: 'page_role', missing: pageRole, track });
  }
  if (template && !/^pillar$|^definition$/i.test(template) && !skipNonV8) {
    warnings.push(`template "${template}" not yet supported by v8 — will fall back to Definition`);
  }

  const tierGateBlock = buildTierGateBlock({
    tier: brief.tier && /T\d/.test(brief.tier) ? brief.tier.match(/T\d/)[0] : null,
    template: template || 'Definition',
    entity: brief.entity,
    friction_brief: brief.friction_brief,
    logic_brief: brief.logic_brief,
    target_keyword: brief.target_keyword,
  });

  const entry = {
    page_id: pageId,
    entity: brief.entity || null,
    target_keyword: brief.target_keyword || null,
    associated_keywords: Array.isArray(brief.associated_keywords) ? brief.associated_keywords : [],
    search_volume: brief.search_volume || '',
    cluster_jtbd: cluster ? cluster.jtbd : '',
    content_angle: brief.content_angle || (cluster ? cluster.content_angle : ''),
    internal_link_rule: cluster ? cluster.internal_link_rule : '',
    cta_text: cta ? cta.cta_text : '',
    cta_target_url: cta ? cta.target_url : (brief.cta_target_url || ''),
    tier_gate_block: tierGateBlock,
    rl6_hint: rl6Hint,
    friction_themes: loadFrictionThemes(repo, pageId, brief),
    tier: brief.tier || 'T2',
    template: template || 'Definition',
    psych_safety_flag: psychFlag,
    // Pillar child_entities — pull from cluster table if template=Pillar
    ...(template === 'Pillar' && cluster && cluster.child_entities.length
      ? { child_entities: cluster.child_entities, child_count: cluster.child_entities.length }
      : {}),
    _ai_draft: true,
    _review_status: 'needs_human_review_before_publish',
  };

  return { entry, warnings, joinFailures };
}

// ---------- fuzzy-match diagnostics ----------
// 3-way join failures (cluster_id / page_role) → top-3 candidates by Levenshtein distance ≤ 3
// so the user catches case/whitespace/typo issues without crawling the Sheet by hand.

// Classic DP edit-distance, single-row rolling. O(n*m) — fine for our short keys (<40 chars).
export function levenshtein(a, b) {
  const s = String(a == null ? '' : a);
  const t = String(b == null ? '' : b);
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  const m = s.length;
  const n = t.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const si = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = si === t.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Normalize for fuzzy matching: trim + lowercase (so "FAM-AURA" matches "fam-aura" at dist 0).
function normalizeForFuzzy(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

// Top N candidates with normalized distance ≤ maxDist. candidates: [{key, label}]. Returns
// [{key, label, dist}] sorted by dist asc, then key asc for determinism.
export function suggestMatches(missingKey, candidates, opts = {}) {
  const maxDist = opts.maxDist != null ? opts.maxDist : 3;
  const limit = opts.limit != null ? opts.limit : 3;
  const norm = normalizeForFuzzy(missingKey);
  const scored = [];
  for (const c of candidates) {
    if (!c || !c.key) continue;
    const d = levenshtein(norm, normalizeForFuzzy(c.key));
    if (d <= maxDist) scored.push({ key: c.key, label: c.label || '', dist: d });
  }
  scored.sort((a, b) => a.dist - b.dist || a.key.localeCompare(b.key));
  return scored.slice(0, limit);
}

// Render a "Did you mean" block for stderr. No trailing newline.
export function formatSuggestionBlock(missingKey, sheetName, suggestions, fixHint) {
  const lines = [`FATAL: ${sheetName} key "${missingKey}" not found`, ''];
  if (suggestions.length === 0) {
    lines.push('Did you mean: (no candidates within edit distance 3 — typo too large or wrong sheet)');
  } else {
    lines.push('Did you mean:');
    const maxKeyLen = Math.max(...suggestions.map((s) => s.key.length));
    for (const s of suggestions) {
      const pad = ' '.repeat(Math.max(1, maxKeyLen - s.key.length + 2));
      const labelStr = s.label ? `, ${s.label}` : '';
      lines.push(`  ${s.key}${pad}(dist=${s.dist}${labelStr})`);
    }
  }
  if (fixHint) {
    lines.push('');
    lines.push(`Fix: ${fixHint}`);
  }
  return lines.join('\n');
}

export function clusterCandidates(clusterMap) {
  const out = [];
  for (const [key, val] of clusterMap.entries()) {
    out.push({ key, label: val && val.cluster_name ? val.cluster_name : '' });
  }
  return out;
}

// CTA keys are "page_role||track" — dedupe to one entry per page_role (first row wins, matching
// buildCtaMap's insert-order semantics).
export function ctaCandidates(ctaMap) {
  const seen = new Map();
  for (const [key, val] of ctaMap.entries()) {
    const role = String(key).split('||')[0];
    if (!role) continue;
    if (!seen.has(role)) {
      seen.set(role, { key: role, label: val && val.cta_text ? val.cta_text : '' });
    }
  }
  return Array.from(seen.values());
}

// Validates a user-supplied --out path. Returns { ok, resolved, reason }.
//   Requirements:
//     1. Resolved path (after `..` collapse) must end in .json
//     2. Resolved path must be inside <repo>/.gg-cache/overrides/ OR <repo>/_staging/
//   The repo root must be passed in; we do NOT close over the module-level REPO so this
//   helper is unit-testable against arbitrary jail roots.
export function validateOutPath(rawPath, repoRoot) {
  if (!rawPath) return { ok: true, resolved: null, reason: 'no --out specified, will use default' };
  const sep = '/';
  const candidate = rawPath.startsWith('/') ? rawPath : join(repoRoot, rawPath);
  const resolved = pathResolve(candidate);
  if (!resolved.endsWith('.json')) {
    return { ok: false, resolved, reason: `path must end in .json, got "${rawPath}"` };
  }
  const overridesJail = pathResolve(join(repoRoot, '.gg-cache', 'overrides')) + sep;
  const stagingJail = pathResolve(join(repoRoot, '_staging')) + sep;
  if (!resolved.startsWith(overridesJail) && !resolved.startsWith(stagingJail)) {
    return {
      ok: false,
      resolved,
      reason: `path "${rawPath}" must be inside .gg-cache/overrides/ or _staging/ (resolved to ${resolved})`,
    };
  }
  return { ok: true, resolved };
}

// ---------- CLI arg parser ----------
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

// ---------- main ----------
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`gg-sheet-to-brief — Sheet 选题登记表 → v8 brief override JSON

usage:
  node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7
  node tools/scripts/gg-sheet-to-brief.mjs --row 3 --out path/to/override.json
  node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7 --skip-non-v8
  node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7 --dry-run
  node tools/scripts/gg-sheet-to-brief.mjs --rows 3-7 --suggest-fix-script .gg-cache/overrides/fix.json

flags:
  --allow-missing-cluster      downgrade missing-cluster_id FATAL to warning
  --allow-missing-cta          downgrade missing-page_role FATAL to warning
  --suggest-fix-script <file>  on FAIL, write [{row,col,old,new,confidence}] JSON

env:
  GG_SHEETS_WORKBOOK_ID + OAuth (via oauth-init.mjs)
`);
    return 0;
  }
  loadEnv();
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    console.error('GG_SHEETS_WORKBOOK_ID missing in env');
    return 2;
  }

  const token = await getAccessToken();

  // Pull 3 tabs in parallel. cluster / CTA fetch failures are non-fatal by default
  // but exit code reflects them unless explicitly allowed.
  let clusterFetchFailed = false;
  let ctaFetchFailed = false;
  const [pagesRaw, clustersRaw, ctaRaw] = await Promise.all([
    fetchTab(workbookId, PAGES_TAB, token),
    fetchTab(workbookId, CLUSTERS_TAB, token).catch((e) => {
      console.error(`error: cluster tab fetch failed (${e.message}) — cluster_jtbd / internal_link_rule will be blank`);
      clusterFetchFailed = true;
      return [];
    }),
    fetchTab(workbookId, CTA_TAB, token).catch((e) => {
      console.error(`error: CTA Map fetch failed (${e.message}) — cta_text / cta_target_url will be blank`);
      ctaFetchFailed = true;
      return [];
    }),
  ]);

  if (!pagesRaw.length) {
    console.error(`tab "${PAGES_TAB}" empty`);
    return 2;
  }
  // Fail-loud unless --allow-missing-cluster / --allow-missing-cta explicitly set.
  if (clusterFetchFailed && !args.allow_missing_cluster) {
    console.error('FATAL: cluster tab fetch failed and --allow-missing-cluster not set');
    return 2;
  }
  if (ctaFetchFailed && !args.allow_missing_cta) {
    console.error('FATAL: CTA Map fetch failed and --allow-missing-cta not set');
    return 2;
  }

  const clusterMap = buildClusterMap(clustersRaw);
  const ctaBuildResult = buildCtaMap(ctaRaw);
  const ctaMap = ctaBuildResult.map;
  if (ctaBuildResult.dupes && ctaBuildResult.dupes.length) {
    console.error(`warn: CTA Map has ${ctaBuildResult.dupes.length} duplicate (page_role, track) pairs — first row wins:`);
    for (const d of ctaBuildResult.dupes) console.error(`  - row ${d.row}: ${d.key}`);
  }

  const header = pagesRaw[0];
  const dataRows = pagesRaw.slice(1);
  const slice = parseSlice(args.row || args.rows, dataRows.length);
  const startIdx = Math.max(0, slice.start - 2);
  const endIdx = Math.min(dataRows.length - 1, slice.end - 2);
  if (startIdx > endIdx) {
    console.error(`slice ${slice.start}-${slice.end} out of range`);
    return 2;
  }

  const overrides = {};
  const skipped = [];
  const allWarnings = [];
  // joinFailures: { source_row, page_id, col, kind, missing, track? } per failed row.
  // col letters per the 21-col 选题登记表 schema — fed to --suggest-fix-script for patcher.
  const joinFailures = [];
  let readyCount = 0;
  const SHEET_COL_FOR = { cluster_id: 'Q', page_role: 'P' };

  for (let i = startIdx; i <= endIdx; i++) {
    const row = dataRows[i] || [];
    const sheetRow = i + 2;
    const { brief } = mapRowToBrief(header, row);
    const status = classifyRow(row[0], brief);
    if (status !== 'ready' && status !== 'incomplete') continue;

    const pageId = resolvePageId(brief, true);
    const rowObj = { source_row: sheetRow, page_id: pageId, brief };
    const result = composeOverride(rowObj, {
      clusterMap,
      ctaMap,
      repo: REPO,
      skipNonV8: !!args.skip_non_v8,
    });
    if (result.skip) {
      skipped.push({ source_row: sheetRow, page_id: pageId, reason: result.reason });
      continue;
    }
    overrides[result.entry.page_id] = result.entry;
    readyCount++;
    if (result.warnings && result.warnings.length) {
      allWarnings.push(...result.warnings.map((w) => `row ${sheetRow} (${pageId}): ${w}`));
    }
    if (result.joinFailures && result.joinFailures.length) {
      for (const jf of result.joinFailures) {
        joinFailures.push({
          source_row: sheetRow,
          page_id: pageId,
          col: SHEET_COL_FOR[jf.kind] || '?',
          ...jf,
        });
      }
    }
  }

  // Fuzzy-suggestion FATAL: any join failure not explicitly allowed becomes a hard fail with
  // top-3 candidates. Lists are small (~24 clusters, ~10 CTA roles) so levenshtein is sub-ms.
  const clusterFailures = joinFailures.filter((f) => f.kind === 'cluster_id');
  const ctaFailures = joinFailures.filter((f) => f.kind === 'page_role');
  const blockingFailures = [];
  if (clusterFailures.length && !args.allow_missing_cluster) blockingFailures.push(...clusterFailures);
  if (ctaFailures.length && !args.allow_missing_cta) blockingFailures.push(...ctaFailures);

  if (blockingFailures.length) {
    const clusterCands = clusterCandidates(clusterMap);
    const ctaCands = ctaCandidates(ctaMap);
    const fixScript = [];
    process.stderr.write('\n');
    for (const f of blockingFailures) {
      const isCluster = f.kind === 'cluster_id';
      const cands = isCluster ? clusterCands : ctaCands;
      const sheetName = isCluster ? '主题集群表 cluster_id' : 'CTA Map page_role';
      const suggestions = suggestMatches(f.missing, cands);
      const fixHint = suggestions.length
        ? `update 选题登记表 row ${f.source_row} col ${f.col} from "${f.missing}" to "${suggestions[0].key}".`
        : `check 选题登记表 row ${f.source_row} col ${f.col} — no close candidate in ${sheetName}; verify source sheet.`;
      process.stderr.write(formatSuggestionBlock(f.missing, sheetName, suggestions, fixHint) + '\n\n');
      if (suggestions.length) {
        const best = suggestions[0];
        const sameAfterNormalize = normalizeForFuzzy(f.missing) === normalizeForFuzzy(best.key);
        const confidence = sameAfterNormalize || best.dist <= 1 ? 'high' : best.dist <= 2 ? 'medium' : 'low';
        fixScript.push({ row: f.source_row, col: f.col, old: f.missing, new: best.key, confidence });
      } else {
        fixScript.push({ row: f.source_row, col: f.col, old: f.missing, new: null, confidence: 'none' });
      }
    }
    if (args.suggest_fix_script) {
      const fixCheck = validateOutPath(args.suggest_fix_script, REPO);
      if (!fixCheck.ok) {
        process.stderr.write(`warn: --suggest-fix-script path invalid (${fixCheck.reason}) — skipping write\n`);
      } else {
        mkdirSync(dirname(fixCheck.resolved), { recursive: true });
        writeFileSync(fixCheck.resolved, JSON.stringify(fixScript, null, 2) + '\n');
        process.stderr.write(`fix-script written: ${fixCheck.resolved}\n`);
      }
    }
    process.stderr.write(`FATAL: ${blockingFailures.length} join failure(s). Pass --allow-missing-cluster / --allow-missing-cta to downgrade to warnings.\n`);
    return 2;
  }

  const generatedAt = new Date().toISOString();
  const sliceTag = slice.start === slice.end ? `row-${slice.start}` : `rows-${slice.start}-${slice.end}`;
  const isoCompact = generatedAt.replace(/[-:.]/g, '').slice(0, 15);
  const batchId = `${isoCompact}-sheet-to-brief-${sliceTag}`;
  const overridesDir = join(REPO, '.gg-cache', 'overrides');
  const defaultOut = join(overridesDir, `${batchId}.json`);
  let outPath = args.out || defaultOut;
  if (args.out) {
    const check = validateOutPath(args.out, REPO);
    if (!check.ok) {
      console.error(`FATAL: ${check.reason}`);
      return 2;
    }
    outPath = check.resolved;
  }

  const payload = {
    _schema_version: SCHEMA_VERSION,
    _generated_at: generatedAt,
    _source: { tab: PAGES_TAB, slice: `${slice.start}-${slice.end}` },
    _ready_count: readyCount,
    _skipped: skipped,
    _warnings: allWarnings,
    ...overrides,
  };

  const summary = `ready=${readyCount} skipped=${skipped.length} warnings=${allWarnings.length}`;
  if (args.dry_run) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    process.stderr.write(summary + '\n');
  } else {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
    process.stderr.write(`overrides written: ${outPath}\n`);
    process.stderr.write(summary + '\n');
    if (allWarnings.length) {
      process.stderr.write('warnings:\n');
      for (const w of allWarnings) process.stderr.write(`  - ${w}\n`);
    }
    if (skipped.length) {
      process.stderr.write('skipped rows:\n');
      for (const s of skipped) process.stderr.write(`  - row ${s.source_row} (${s.page_id || '?'}): ${s.reason}\n`);
    }
  }
  // Exit non-zero if no overrides were produced — masks ops failures otherwise.
  if (readyCount === 0) {
    console.error('FATAL: 0 override rows produced (all skipped or empty range)');
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    console.error('fatal:', e.message);
    process.exit(1);
  });
}

export { main };
