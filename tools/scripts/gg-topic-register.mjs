#!/usr/bin/env node
// gg-topic-register.mjs — 选题登记表空/缺字段行 → cluster/page_id/preprocessor-prompt/task/notify 编排器。
//
// Default is dry-run. Use --apply to write Google Sheets, update the matching
// gengrowth-ops task plan, and notify the SEO 技术群 through gg-lark-notify.sh.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnv, getAccessToken, gFetch, redactNote } from './lib/gg-shared.mjs';
import {
  parsePreprocessorSheetFields,
  parsePreprocessorV1Fields,
  renderPreprocessorPrompt,
  renderPreprocessorV1FallbackPrompt,
} from './lib/preprocessor-prompt.mjs';
import { defaultPsychFlag, defaultTemplate, defaultTier, callLLM as callBriefLLM } from './gg-brief-suggest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const LARK_NOTIFY = join(__dirname, 'gg-lark-notify.sh');

export const PAGES_TAB = '选题登记表';
export const CLUSTERS_TAB = '主题集群表';
export const PAGE_REQUIRED_FIELDS = Object.freeze([
  'Associated Keywords',
  'Intent',
  'Tier',
  'Template',
  'Entity',
  'Friction',
  'Logic',
  'page_id',
  'cluster_id',
  'page_role',
  'content_angle',
  'psych_safety_flag',
]);

export const CLUSTER_FIELDS = Object.freeze([
  'cluster_id', 'cluster_name', 'track', 'content_layer', 'business_role',
  'primary_entity', 'jtbd', 'content_angle', 'us_share', 'pillar_page',
  'series_pattern', 'keywords_included', 'page_assets', 'internal_link_rule',
  'cta_primary', 'psych_safety_flag', 'priority', 'week', 'success_metric',
]);

export const PRODUCT_PROFILES = Object.freeze({
  astrologywiki: Object.freeze({
    key: 'astrologywiki',
    label: 'astrologywiki.com',
    workbookEnv: 'GG_SHEETS_ASTROLOGY_WORKBOOK_ID',
    fallbackWorkbookEnv: 'GG_SHEETS_FLOW_MVP_WORKBOOK_ID',
    taskPlan: '/Users/awayer_mini/gengrowth-ops/inbox/06-tasks/tasks/2026-05-27-W22-blog-output-plan.md',
    defaults: Object.freeze({
      track: '精修线',
      content_layer: 'Wiki Support',
      business_role: 'Traffic',
      us_share: '中',
      cta_primary: '星盘页',
      priority: 'P2',
      week: 'Backlog',
      success_metric: 'organic sessions + indexed URLs',
    }),
  }),
  gengrowth: Object.freeze({
    key: 'gengrowth',
    label: 'gengrowth.ai',
    workbookEnv: 'GG_SHEETS_GENGROWTH_WORKBOOK_ID',
    fallbackWorkbookEnv: '',
    taskPlan: '/Users/awayer_mini/gengrowth-ops/inbox/06-tasks/tasks/2026-06-16-W25-gengrowth-blog-output-plan.md',
    defaults: Object.freeze({
      track: '精修线',
      content_layer: 'Audience Education',
      business_role: 'Top-of-Funnel Acquisition',
      us_share: '高',
      cta_primary: '免费试用',
      priority: 'P2',
      week: 'Backlog',
      success_metric: 'qualified trials or consult requests',
    }),
  }),
});

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'without',
  'what', 'why', 'how', 'is', 'are', 'best', 'free', 'online', 'guide', 'meaning',
  'definition', 'services', 'service',
  'vs', 'versus',
]);

const PREFIX_STOPWORDS = new Set(['and', 'or', 'the', 'for', 'of', 'in', 'to']);
const REQUIRED_PREPROCESSOR_FIELDS = Object.freeze(['Entity', 'Friction', 'Logic', 'Content_Angle']);
const REQUIRED_PREPROCESSOR_V1_FIELDS = Object.freeze(['Friction', 'Content_Angle']);
const PREPROCESSOR_WRITABLE_FIELDS = Object.freeze(['Entity', 'Friction', 'Logic', 'content_angle']);
const SHEET_INTENT_VALUES = new Set(['Info', 'Compare', 'Tutorial', 'Utility', 'Experience', 'BOFU']);
const SHEET_TEMPLATE_VALUES = new Set(['Definition', 'Comparison', 'Tutorial', 'Programmatic', 'Case Study']);
const SHEET_PAGE_ROLES = new Set(['Pillar', 'Series', 'Support', 'Tool', 'Wiki', 'Strategic']);
const PAGE_WRITABLE_FIELDS = Object.freeze(['Associated Keywords', 'Intent', 'Tier', 'Template', 'Entity', 'Friction', 'Logic', 'CTA', 'Status', 'page_id', 'cluster_id', 'page_role', 'content_angle', 'psych_safety_flag', 'journal_prompts', 'target_keyword_zh']);
const PAGE_TAXONOMY_WRITABLE_FIELDS = Object.freeze(PAGE_WRITABLE_FIELDS.filter((field) => !PREPROCESSOR_WRITABLE_FIELDS.includes(field)));
const CLOSED_PAGE_STATUSES = new Set(['已发布', '已刷新', '已合并', '暂停', '不写', '暂时不写']);
const COUNTRY_TERMS = new Set([
  'argentina', 'brazil', 'colombia', 'portugal', 'spain', 'france', 'germany', 'italy',
  'england', 'mexico', 'usa', 'united', 'states', 'uruguay', 'chile', 'peru', 'ecuador',
  'jordan', 'morocco', 'ghana', 'senegal', 'japan', 'korea', 'australia', 'canada',
  'netherlands', 'belgium', 'croatia', 'serbia', 'switzerland', 'denmark', 'poland',
]);
const DEFAULT_RUN_BUDGET_START_RESERVE_MS = 30000;
const DEFAULT_APPLY_START_RESERVE_MS = 15000;
const MIN_PREPROCESSOR_SERP_TITLES = 3;

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

function finitePositiveInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function createRunBudget({
  budgetMs = 0,
  startedAtMs = Date.now(),
  now = () => Date.now(),
  startReserveMs = DEFAULT_RUN_BUDGET_START_RESERVE_MS,
} = {}) {
  const parsedBudgetMs = finitePositiveInt(budgetMs);
  const parsedReserveMs = finitePositiveInt(startReserveMs) || DEFAULT_RUN_BUDGET_START_RESERVE_MS;
  if (!parsedBudgetMs) {
    return {
      enabled: false,
      deadlineMs: 0,
      remainingMs: () => Number.POSITIVE_INFINITY,
      canStart: () => true,
      exhaustedSummary: () => null,
    };
  }
  const deadlineMs = Number(startedAtMs) + parsedBudgetMs;
  const remainingMs = () => Math.max(0, Math.floor(deadlineMs - now()));
  return {
    enabled: true,
    deadlineMs,
    remainingMs,
    canStart: (requiredMs = parsedReserveMs) => remainingMs() > (finitePositiveInt(requiredMs) || parsedReserveMs),
    exhaustedSummary: (stage, requiredMs = parsedReserveMs) => ({
      status: 'budget_exhausted',
      stage,
      remaining_ms: remainingMs(),
      required_ms: finitePositiveInt(requiredMs) || parsedReserveMs,
    }),
  };
}

function budgetCanStart(budget, requiredMs) {
  return !budget || typeof budget.canStart !== 'function' || budget.canStart(requiredMs);
}

function budgetExhaustedSummary(budget, stage, requiredMs) {
  if (budget && typeof budget.exhaustedSummary === 'function') return budget.exhaustedSummary(stage, requiredMs);
  return { status: 'budget_exhausted', stage };
}

function llmStartReserveMs() {
  const timeoutMs = finitePositiveInt(process.env.GG_TOPIC_REGISTER_LLM_TIMEOUT_MS)
    || finitePositiveInt(process.env.GG_LLM_TIMEOUT_MS)
    || 120000;
  return timeoutMs + 5000;
}

function headerIndex(header) {
  const idx = {};
  for (let i = 0; i < (header || []).length; i++) {
    const h = String(header[i] || '').trim();
    if (h && idx[h] == null) idx[h] = i;
  }
  return idx;
}

export function rowsToObjects(header, rows) {
  const out = [];
  for (const row of rows || []) {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      const h = String(header[i] || '').trim();
      if (!h) continue;
      obj[h] = row && row[i] != null ? String(row[i]).trim() : '';
    }
    out.push(obj);
  }
  return out;
}

function normText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function words(value, { keepStopwords = false } = {}) {
  return normText(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => keepStopwords || (!STOPWORDS.has(w) && w.length > 1));
}

function slugifyId(value) {
  return normText(value).replace(/\s+/g, '_').replace(/^_+|_+$/g, '');
}

const TITLE_CASE_ACRONYMS = Object.freeze(new Set(['ai', 'api', 'cta', 'dr', 'gsc', 'kd', 'llm', 'rag', 'seo', 'uk', 'us', 'usa', 'fifa']));
const TITLE_CASE_SMALL_WORDS = Object.freeze(new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']));

export function titleCase(value) {
  return words(value, { keepStopwords: true })
    .map((w, i) => {
      if (TITLE_CASE_ACRONYMS.has(w)) return w.toUpperCase();
      if (i > 0 && TITLE_CASE_SMALL_WORDS.has(w)) return w;
      return w[0].toUpperCase() + w.slice(1);
    })
    .join(' ');
}

function clusterCorpus(cluster) {
  return [
    cluster.cluster_id,
    cluster.cluster_name,
    cluster.primary_entity,
    cluster.jtbd,
    cluster.content_angle,
    cluster.keywords_included,
  ].filter(Boolean).join('\n');
}

function seedPhrases(cluster) {
  return String(cluster.keywords_included || '')
    .split(/[,，、\n]+/)
    .map((s) => normText(s))
    .filter((s) => s.length >= 4);
}

function looksLikeCelebrityPair(value) {
  return /\b[A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}\s+and\s+[A-Z][A-Za-z.'-]+/.test(String(value || ''));
}

function looksLikeCountryVs(value) {
  const raw = String(value || '');
  if (!/\b(?:vs|versus)\b/i.test(raw)) return false;
  const terms = words(raw);
  return terms.filter((term) => COUNTRY_TERMS.has(term)).length >= 2;
}

function looksExplicitWorldCupTopic(value) {
  return /\b(world\s*cup|fifa|football|soccer|national\s+team|country\s+vs\s+country)\b/i.test(String(value || ''));
}

function looksLikePersonAstrologyTopic(value) {
  const norm = normText(value);
  const match = /^(.*?)\b(?:birth chart|natal chart|zodiac sign)\b/.exec(norm);
  if (!match) return false;
  const prefixWords = match[1]
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((word) => !STOPWORDS.has(word));
  if (prefixWords.length < 2 || prefixWords.length > 4) return false;
  const genericLead = new Set(['vedic', 'western', 'free', 'online', 'celebrity', 'athlete', 'player', 'football', 'soccer']);
  return !genericLead.has(prefixWords[0]);
}

function categoryScore(keyword, cluster) {
  const corpus = normText(clusterCorpus(cluster));
  if (looksLikePersonAstrologyTopic(keyword) && !looksExplicitWorldCupTopic(keyword)) {
    if (/\b(celebrity|pop culture|zodiac profiles?|birth chart breakdowns?|athlete zodiac|athlete birth chart)\b/.test(corpus)) return 0.9;
    if (/\b(vedic|jyotish|indian astrology basics)\b/.test(corpus)) return 0.05;
    if (/\b(world cup|football|soccer|team national|zodiac based team)\b/.test(corpus)) return 0.18;
  }
  if (looksLikeCelebrityPair(keyword)) {
    if (/\b(celebrity|pop culture|zodiac profiles?|birth chart breakdowns?)\b/.test(corpus)) return 0.72;
    if (/\b(synastry|compatibility|relationship astrology|composite chart)\b/.test(corpus)) return 0.55;
  }
  if (looksLikeCountryVs(keyword) || looksExplicitWorldCupTopic(keyword)) {
    if (/\b(world cup|football|soccer|team national|zodiac based team|players?)\b/.test(corpus)) return 0.72;
  }
  return 0;
}

function isAutoSingletonCluster(keyword, cluster) {
  const kwNorm = normText(keyword);
  const cid = normText(cluster.cluster_id || '').replace(/\s+/g, '_');
  const keywordId = slugifyId(keyword);
  const seeds = seedPhrases(cluster);
  return cid === keywordId
    && seeds.length === 1
    && seeds[0] === kwNorm
    && !String(cluster.pillar_page || '').trim()
    && !String(cluster.series_pattern || '').trim();
}

export function scoreClusterKeyword(keyword, cluster) {
  const kwNorm = normText(keyword);
  const kwWords = words(keyword);
  if (!kwNorm || kwWords.length === 0) return 0;

  const corpus = clusterCorpus(cluster);
  const corpusNorm = normText(corpus);
  const corpusWords = new Set(words(corpus));
  const overlap = kwWords.filter((w) => corpusWords.has(w)).length;
  let score = overlap / kwWords.length;

  const cidPhrase = normText(cluster.cluster_id || '').replace(/_/g, ' ');
  if (cidPhrase && (kwNorm.includes(cidPhrase) || cidPhrase.includes(kwNorm))) score += 0.25;
  for (const phrase of seedPhrases(cluster)) {
    if (kwNorm.includes(phrase) || phrase.includes(kwNorm)) {
      score += 0.35;
      break;
    }
  }
  const primary = normText(cluster.primary_entity || '');
  if (primary && (kwNorm.includes(primary) || corpusNorm.includes(kwNorm))) score += 0.1;
  score = Math.max(score, categoryScore(keyword, cluster));
  return Math.min(1, Number(score.toFixed(4)));
}

export function chooseClusterForKeyword(keyword, clusters, { minScore = 0.3 } = {}) {
  let best = null;
  let bestEstablished = null;
  for (const cluster of clusters || []) {
    if (!cluster || !cluster.cluster_id) continue;
    const score = scoreClusterKeyword(keyword, cluster);
    if (!best || score > best.score) best = { cluster, score };
    if (!isAutoSingletonCluster(keyword, cluster) && (!bestEstablished || score > bestEstablished.score)) {
      bestEstablished = { cluster, score };
    }
  }
  if (bestEstablished && bestEstablished.score >= Math.max(minScore, 0.55)) best = bestEstablished;
  if (best && best.score >= minScore) {
    return {
      kind: 'existing',
      cluster_id: best.cluster.cluster_id,
      score: best.score,
      cluster: best.cluster,
    };
  }
  const existingIds = new Set((clusters || []).map((c) => c.cluster_id).filter(Boolean));
  const cluster_id = uniqueId(slugifyId(keyword), existingIds);
  return {
    kind: 'new',
    cluster_id,
    score: best ? best.score : 0,
    nearest_cluster_id: best?.cluster?.cluster_id || '',
    nearest_cluster: best?.cluster || null,
  };
}

function uniqueId(base, existingIds) {
  const safeBase = base || 'new_topic';
  if (!existingIds.has(safeBase)) return safeBase;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${safeBase}_${i}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  throw new Error(`cannot allocate unique cluster_id for ${safeBase}`);
}

export function buildNewClusterRow({ product = 'astrologywiki', keyword, existingClusters = [] }) {
  const profile = PRODUCT_PROFILES[product] || PRODUCT_PROFILES.astrologywiki;
  const existingIds = new Set((existingClusters || []).map((c) => c.cluster_id).filter(Boolean));
  const cluster_id = uniqueId(slugifyId(keyword), existingIds);
  const name = titleCase(keyword);
  const d = profile.defaults;
  const isAstro = profile.key === 'astrologywiki';
  const row = {
    cluster_id,
    cluster_name: name,
    track: d.track,
    content_layer: d.content_layer,
    business_role: d.business_role,
    primary_entity: name,
    jtbd: isAstro
      ? `Understand ${name} as a reflective astrology topic`
      : `Evaluate ${name} with practical buying and workflow criteria`,
    content_angle: isAstro
      ? `Frame ${name} as a symbolic, interpretive guide with clear anti-overclaim boundaries.`
      : `Explain ${name} through decision criteria, workflow trade-offs, and proof points instead of generic SEO advice.`,
    us_share: d.us_share,
    pillar_page: '',
    series_pattern: '',
    keywords_included: String(keyword || '').trim(),
    page_assets: '',
    internal_link_rule: isAstro
      ? 'Link to the nearest pillar and sibling definition pages in the same cluster.'
      : 'Link to the nearest product, comparison, and workflow pages in the same cluster.',
    cta_primary: d.cta_primary,
    psych_safety_flag: defaultPsychFlag(name, keyword),
    priority: d.priority,
    week: d.week,
    success_metric: d.success_metric,
  };
  for (const key of CLUSTER_FIELDS) if (row[key] == null) row[key] = '';
  return row;
}

function pageIdParts(pageId) {
  const m = /^PG-([A-Z0-9]+)-(\d+)$/.exec(String(pageId || '').trim());
  return m ? { prefix: m[1], number: Number(m[2]), width: m[2].length } : null;
}

function prefixFromClusterId(clusterId) {
  const parts = String(clusterId || '')
    .split(/[^A-Za-z0-9]+/)
    .map((p) => p.trim())
    .filter((p) => p && !PREFIX_STOPWORDS.has(p.toLowerCase()));
  if (!parts.length) return 'NEW';
  if (parts.length === 1) return parts[0].slice(0, 3).toUpperCase().padEnd(3, 'X');
  return parts.slice(0, 4).map((p) => p[0].toUpperCase()).join('');
}

export function inferNextPageId({ clusterId, pages, product = 'astrologywiki' }) {
  const sameCluster = (pages || []).filter((p) => String(p.cluster_id || p.clusterId || '').trim() === clusterId);
  const prefixCounts = new Map();
  for (const p of sameCluster) {
    const parts = pageIdParts(p.page_id || p.pageId);
    if (!parts) continue;
    prefixCounts.set(parts.prefix, (prefixCounts.get(parts.prefix) || 0) + 1);
  }
  let prefix = '';
  if (prefixCounts.size) {
    prefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  } else {
    prefix = prefixFromClusterId(clusterId);
  }

  let max = 0;
  let width = 3;
  for (const p of pages || []) {
    const parts = pageIdParts(p.page_id || p.pageId);
    if (!parts || parts.prefix !== prefix) continue;
    max = Math.max(max, parts.number);
    width = Math.max(width, parts.width);
  }
  // Both products use PG-* ids today; keep the product arg for future format splits.
  void product;
  return `PG-${prefix}-${String(max + 1).padStart(width, '0')}`;
}

export function findCandidateRows(rows, { requiredFields = PAGE_REQUIRED_FIELDS, blankOnly = false } = {}) {
  if (!rows || rows.length < 2) return [];
  const header = rows[0] || [];
  const idx = headerIndex(header);
  const kwIdx = idx['Target Keyword'] ?? idx['关键词'];
  if (kwIdx == null) throw new Error('选题登记表 header 缺 Target Keyword/关键词');
  const pageIdx = idx.page_id;
  const statusIdx = idx.Status;
  const onlyPageIds = arguments[1]?.onlyPageIds instanceof Set ? arguments[1].onlyPageIds : new Set();
  const onlyKeywords = arguments[1]?.onlyKeywords instanceof Set ? arguments[1].onlyKeywords : new Set();
  const excludePageIds = arguments[1]?.excludePageIds instanceof Set ? arguments[1].excludePageIds : new Set();
  const explicitSelection = onlyPageIds.size > 0 || onlyKeywords.size > 0;
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const target = String(row[kwIdx] || '').trim();
    if (!target || /^#{1,6}\s+/.test(target)) continue;
    const pageId = pageIdx == null ? '' : String(row[pageIdx] || '').trim();
    if (onlyPageIds.size && !onlyPageIds.has(pageId)) continue;
    if (onlyKeywords.size && !onlyKeywords.has(normText(target))) continue;
    const status = statusIdx == null ? '' : String(row[statusIdx] || '').trim();
    if (!explicitSelection && pageId && excludePageIds.has(pageId)) continue;
    if (!explicitSelection && CLOSED_PAGE_STATUSES.has(status)) continue;
    const missing = requiredFields.filter((field) => {
      const c = idx[field];
      return c == null || !String(row[c] || '').trim();
    });
    if (!explicitSelection && blankOnly && missing.length !== requiredFields.length) continue;
    if (explicitSelection || missing.length) {
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[String(header[c] || '').trim()] = row[c] == null ? '' : String(row[c]).trim();
      out.push({ row: i + 1, target_keyword: target, missing, values: obj });
    }
  }
  return out;
}

function isExistingIncompleteCandidate(candidate, requiredFields = PAGE_REQUIRED_FIELDS) {
  if (!candidate || !Array.isArray(candidate.missing) || !candidate.missing.length) return false;
  const values = candidate.values || {};
  const presentRequired = requiredFields.length - candidate.missing.length;
  return presentRequired > 0
    || Boolean(String(values.page_id || '').trim())
    || Boolean(String(values.cluster_id || '').trim())
    || Boolean(String(values.Status || '').trim());
}

export function selectCandidateRowsForPlan(rows, {
  requiredFields = PAGE_REQUIRED_FIELDS,
  includeIncomplete = false,
  onlyPageIds = new Set(),
  onlyKeywords = new Set(),
  excludePageIds = new Set(),
  limit = 0,
} = {}) {
  const explicitSelection = onlyPageIds.size > 0 || onlyKeywords.size > 0;
  const take = (items) => items.slice(0, limit || undefined);
  if (explicitSelection || includeIncomplete) {
    const candidates = take(findCandidateRows(rows, {
      requiredFields,
      blankOnly: false,
      onlyPageIds,
      onlyKeywords,
      excludePageIds,
    }));
    return {
      mode: explicitSelection ? 'explicit_repair' : 'include_incomplete',
      candidates,
      audit_incomplete: candidates.filter((row) => isExistingIncompleteCandidate(row, requiredFields)).length,
    };
  }

  const allMissingRows = findCandidateRows(rows, {
    requiredFields,
    blankOnly: false,
    excludePageIds,
  });
  const auditRows = allMissingRows.filter((row) => isExistingIncompleteCandidate(row, requiredFields));
  if (auditRows.length) {
    return {
      mode: 'audit_repair',
      candidates: take(auditRows),
      audit_incomplete: auditRows.length,
    };
  }

  return {
    mode: 'generate',
    candidates: take(findCandidateRows(rows, {
      requiredFields,
      blankOnly: true,
      excludePageIds,
    })),
    audit_incomplete: 0,
  };
}

export function buildTaskLine({ pageId, keyword }) {
  return `- [ ] \`${pageId}\` ${keyword}`;
}

const WEEKDAYS_CN = Object.freeze(['周日', '周一', '周二', '周三', '周四', '周五', '周六']);

function monthDay(date) {
  const d = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return date;
  return `${d.getMonth() + 1}月${d.getDate()}日 (${WEEKDAYS_CN[d.getDay()]})`;
}

function waitingStatusLine(count, source = '自动补充选题') {
  return `**状态**：\`等待输出\` (${source}，共 ${count} 篇)`;
}

function taskSectionBlock({ date, title, lines, source }) {
  return [
    `## ⚪ ${monthDay(date)} - ${title}`,
    waitingStatusLine(lines.length, source),
    ...lines,
    '',
  ].join('\n');
}

function insertBeforeGeneratedPath(text, block) {
  const marker = /\n\*生成的计划文件路径/.exec(text);
  if (!marker) return `${text.replace(/\s*$/, '')}\n\n---\n${block}`;
  const before = text.slice(0, marker.index).replace(/\s*$/, '');
  const separator = /\n---$/.test(before) || before === '---' ? '\n' : '\n\n---\n';
  return `${before}${separator}${block}${text.slice(marker.index)}`;
}

export function appendTaskLines(markdown, { date, title = '待写作', lines, source = '自动补充选题' }) {
  const uniqueLines = [...new Set((lines || []).filter(Boolean))];
  if (!uniqueLines.length) return markdown;
  let text = String(markdown || '');
  const missing = uniqueLines.filter((line) => {
    if (text.includes(line)) return false;
    const m = /`?(PG-[A-Z0-9]+-\d+)`?/.exec(line);
    if (m && text.includes(m[1])) return false;
    return true;
  });
  if (!missing.length) return text;

  const heading = `## ⚪ ${monthDay(date)} - ${title}`;
  if (text.includes(heading)) {
    return text.replace(new RegExp(`(${escapeRegExp(heading)}[\\s\\S]*?\\n)(---\\n|\\*生成的计划文件路径)`, 'm'), (m, head, tail) => {
      const existingCount = (head.match(/^\s*-\s+\[[ x]\]\s+`?PG-[A-Z0-9]+-\d+/gm) || []).length;
      const status = waitingStatusLine(existingCount + missing.length, source);
      const updatedHead = /^\*\*状态\*\*：`等待输出`.*$/m.test(head)
        ? head.replace(/^\*\*状态\*\*：`等待输出`.*$/m, status)
        : head.replace(`${heading}\n`, `${heading}\n${status}\n`);
      const spacer = updatedHead.endsWith('\n') ? '' : '\n';
      return `${updatedHead}${spacer}${missing.join('\n')}\n\n${tail}`;
    });
  }

  return insertBeforeGeneratedPath(text, taskSectionBlock({
    date,
    title,
    source,
    lines: missing,
  }));
}

export function replaceTaskLines(markdown, { replacements = [] } = {}) {
  let text = String(markdown || '');
  for (const replacement of replacements || []) {
    const oldPageId = String(replacement.oldPageId || '').trim();
    const newLine = String(replacement.newLine || '').trim();
    if (!oldPageId || !newLine) continue;
    const lineRe = new RegExp(`^.*${escapeRegExp(oldPageId)}.*$`, 'm');
    if (lineRe.test(text)) text = text.replace(lineRe, newLine);
  }
  return text;
}

export function checkedTaskPageIds(markdown) {
  const ids = new Set();
  const re = /^\s*-\s+\[[xX]\]\s+`?(PG-[A-Z0-9]+-\d+)`?/gm;
  let match;
  while ((match = re.exec(String(markdown || '')))) ids.add(match[1]);
  return ids;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function deterministicFrictionForPage({ targetKeyword, entity }) {
  const target = String(targetKeyword || '');
  const name = String(entity || titleCase(target) || target).trim();
  const lower = normText(target);
  if (lower.includes('birth chart')) {
    return `Readers need ${name} framed as an interpretive profile, not a claim that astrology verifies biography or outcomes.`;
  }
  if (lower.includes('zodiac sign')) {
    return `Readers need ${name} separated from full-chart analysis, celebrity biography, and deterministic personality claims.`;
  }
  if (lower.includes('compatibility') || looksLikeCelebrityPair(target)) {
    return `Readers need ${name} framed as symbolic compatibility, not a deterministic relationship verdict.`;
  }
  if (looksLikeCountryVs(target) || lower.includes('world cup')) {
    return `Readers need ${name} framed as symbolic match context, not a prediction of sports outcomes.`;
  }
  return `Readers need ${name} explained with clear interpretive boundaries instead of broad claims or adjacent-topic blending.`;
}

function pageRowFields({ targetKeyword, pageId, cluster, product, sourceValues = {} }) {
  const entity = titleCase(targetKeyword);
  const rawTemplate = defaultTemplate(targetKeyword, entity);
  const taxonomy = decideSheetTaxonomy({
    targetKeyword,
    rawTemplate,
    rawTier: defaultTier(targetKeyword),
    searchVolume: sourceValues['月搜索量'],
    cluster,
    product,
  });
  const contentAngle = cluster.content_angle || (PRODUCT_PROFILES[product]?.defaults.content_angle || '');
  const cta = cluster.cta_primary || PRODUCT_PROFILES[product]?.defaults.cta_primary || '';
  const psych = cluster.psych_safety_flag || defaultPsychFlag(entity, targetKeyword);
  const friction = deterministicFrictionForPage({ targetKeyword, entity });
  const topology = `${entity} ↔ ${cluster.primary_entity || cluster.cluster_name || entity} ↔ practical interpretation`;
  const logic = `${topology}. Treat ${entity} as an interpretive framework rather than a deterministic claim. The page should explain what the topic helps readers compare, where the framing stops, and which adjacent concepts should not be blended.`;
  return {
    'Associated Keywords': associatedKeywordsForPage({ targetKeyword, cluster, product }),
    Intent: taxonomy.Intent,
    Tier: taxonomy.Tier,
    Template: taxonomy.Template,
    Entity: entity,
    Friction: friction,
    Logic: logic,
    CTA: cta,
    Status: '待写',
    page_id: pageId,
    cluster_id: cluster.cluster_id,
    page_role: taxonomy.page_role,
    content_angle: contentAngle,
    psych_safety_flag: psych,
    journal_prompts: '',
    target_keyword_zh: '',
  };
}

export function decideSheetTaxonomy({
  targetKeyword,
  rawTemplate = '',
  rawTier = '',
  searchVolume = '',
  cluster = {},
  product = 'astrologywiki',
} = {}) {
  const target = String(targetKeyword || '');
  const targetNorm = normText(target);
  const clusterId = String(cluster?.cluster_id || '');
  const rawTemplateNorm = String(rawTemplate || '').trim();
  const caseStudy = isCaseStudyKeyword({ targetKeyword: target, cluster });
  const utility = /\b(calculator|tool|generator|checker|tracker|audit|app)\b/i.test(target);
  const tutorial = /^how\s+to\b|^how\s+do\s+i\b/i.test(target);
  const commercial = /\b(pricing|price|cost|software|service|buy|trial|demo|best)\b/i.test(target);
  const comparison = !caseStudy && /\b(vs|versus|compare|comparison|alternative|alternatives)\b/i.test(target);
  const definition = /\bwhat\s+is\b|\bmeaning\b|\bdefinition\b/i.test(target);
  const pillar = /^pillar$/i.test(rawTemplateNorm);
  const celebrityOrWorldCupSeries = ['celebrity_zodiac_trending', 'worldcup2026_astro'].includes(clusterId);

  let keywordType = 'definition';
  let intent = 'Info';
  let template = normalizeSheetTemplate(rawTemplateNorm);
  let pageRole = 'Support';

  if (caseStudy) {
    keywordType = 'case_study';
    intent = 'Info';
    template = 'Case Study';
    pageRole = 'Series';
  } else if (utility) {
    keywordType = 'utility';
    intent = 'Utility';
    template = 'Programmatic';
    pageRole = 'Tool';
  } else if (tutorial) {
    keywordType = 'tutorial';
    intent = 'Tutorial';
    template = 'Tutorial';
    pageRole = 'Support';
  } else if (commercial) {
    keywordType = 'commercial';
    intent = 'BOFU';
    template = /\b(best|compare|comparison|alternative|alternatives|vs|versus)\b/i.test(target)
      ? 'Comparison'
      : normalizeSheetTemplate(rawTemplateNorm);
    pageRole = product === 'gengrowth' ? 'Strategic' : 'Support';
  } else if (comparison) {
    keywordType = 'comparison';
    intent = 'Compare';
    template = 'Comparison';
    pageRole = 'Support';
  } else if (pillar) {
    keywordType = 'pillar';
    intent = 'Info';
    template = 'Definition';
    pageRole = 'Pillar';
  } else if (definition || targetNorm) {
    keywordType = 'definition';
    intent = 'Info';
    template = normalizeSheetTemplate(rawTemplateNorm);
    pageRole = product === 'astrologywiki' ? 'Wiki' : 'Support';
  }

  if (celebrityOrWorldCupSeries && keywordType === 'definition' && !definition) {
    pageRole = 'Series';
  }

  return {
    keyword_type: keywordType,
    Intent: normalizeSheetIntent(intent),
    Tier: decideSheetTier({ rawTier, searchVolume }),
    Template: normalizeSheetTemplate(template),
    page_role: normalizeSheetPageRole(pageRole),
  };
}

function isCaseStudyKeyword({ targetKeyword, cluster }) {
  const target = String(targetKeyword || '');
  const clusterId = String(cluster?.cluster_id || '');
  return (
    looksLikeCelebrityPair(target)
    || looksLikeCountryVs(target)
    || (clusterId === 'celebrity_zodiac_trending' && /\b(zodiac sign|birth chart|compatibility|synastry|wedding)\b/i.test(target))
    || (clusterId === 'worldcup2026_astro' && /\b(zodiac sign|birth chart|world cup|astrology|vs|versus)\b/i.test(target))
  );
}

function decideSheetTier({ rawTier = '', searchVolume = '' } = {}) {
  const volume = Number(String(searchVolume || '').replace(/[^\d.]+/g, ''));
  if (Number.isFinite(volume) && volume >= 10000) return 'T1';
  return normalizeSheetTier(rawTier || defaultTier());
}

function normalizeSheetIntent(value) {
  const v = String(value || '').trim();
  return SHEET_INTENT_VALUES.has(v) ? v : 'Info';
}

function normalizeSheetTier(value) {
  const v = String(value || '').trim();
  if (/^T[123]$/i.test(v)) return v.toUpperCase();
  const m = /^Tier\s*([123])\b/i.exec(v);
  return m ? `T${m[1]}` : 'T2';
}

function normalizeSheetTemplate(value) {
  const v = String(value || '').trim();
  if (SHEET_TEMPLATE_VALUES.has(v)) return v;
  return 'Definition';
}

function normalizeSheetPageRole(value) {
  const v = String(value || '').trim();
  return SHEET_PAGE_ROLES.has(v) ? v : 'Support';
}

function associatedKeywordsForPage({ targetKeyword, cluster, product }) {
  const target = compactLine(targetKeyword);
  const targetNorm = normText(target);
  if (!targetNorm) return '';
  const seen = new Set([targetNorm]);
  const out = [];
  const add = (phrase) => {
    const value = compactLine(phrase);
    const key = normText(value);
    if (!value || !key || seen.has(key)) return;
    seen.add(key);
    out.push(value);
  };
  const addSuffix = (suffix) => {
    if (normText(target).includes(normText(suffix))) return;
    add(`${target} ${suffix}`);
  };

  if (looksLikeCelebrityPair(target)) {
    for (const suffix of ['astrology', 'compatibility', 'zodiac signs', 'birth chart', 'synastry']) addSuffix(suffix);
  } else if (looksLikeCountryVs(target)) {
    for (const suffix of ['astrology', 'world cup 2026 astrology', 'zodiac prediction', 'match astrology', 'team astrology']) addSuffix(suffix);
  } else if (product === 'gengrowth') {
    for (const suffix of ['comparison', 'pricing', 'software', 'tool', 'workflow']) addSuffix(suffix);
  } else {
    for (const suffix of ['meaning', 'astrology', 'birth chart', 'zodiac', 'interpretation']) addSuffix(suffix);
  }

  for (const phrase of seedPhrases(cluster || {})) add(phrase);
  return out.slice(0, 5).join(', ');
}

function ensureSentence(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  return /[.!?。！？]$/.test(s) ? s : `${s}.`;
}

export function applyPreprocessorSheetFields(baseFields, preprocessorFields = {}) {
  const out = { ...(baseFields || {}) };
  const entity = String(preprocessorFields.Entity || '').trim();
  const friction = String(preprocessorFields.Friction || '').trim();
  const logic = String(preprocessorFields.Logic || '').trim();
  const topology = String(preprocessorFields.Entity_Topology || '').trim();
  const contentAngle = String(preprocessorFields.Content_Angle || preprocessorFields.content_angle || '').trim();

  if (entity) out.Entity = entity;
  if (friction) out.Friction = friction;
  if (logic || topology) {
    const logicBody = logic || out.Logic || '';
    const needsTopologyLead = topology && !String(logicBody).includes(topology);
    out.Logic = needsTopologyLead
      ? [ensureSentence(topology), logicBody].filter(Boolean).join(' ')
      : logicBody;
  }
  if (contentAngle) out.content_angle = contentAngle;
  return out;
}

function applyPreprocessorV1Fields(baseFields, preprocessorFields = {}) {
  const out = { ...(baseFields || {}) };
  const friction = String(preprocessorFields.Friction || '').trim();
  const contentAngle = String(preprocessorFields.Content_Angle || preprocessorFields.content_angle || '').trim();
  if (friction) out.Friction = friction;
  if (contentAngle) out.content_angle = contentAngle;
  return out;
}

function preprocessorOutputFor({ targetKeyword, pageId, preprocessorOutputsByKeyword, preprocessorOutputsByPageId }) {
  if (preprocessorOutputsByKeyword instanceof Map && preprocessorOutputsByKeyword.has(targetKeyword)) {
    return preprocessorOutputsByKeyword.get(targetKeyword);
  }
  if (preprocessorOutputsByPageId instanceof Map && preprocessorOutputsByPageId.has(pageId)) {
    return preprocessorOutputsByPageId.get(pageId);
  }
  return null;
}

function missingPreprocessorFields(fields) {
  return REQUIRED_PREPROCESSOR_FIELDS.filter((field) => {
    const value = String(fields?.[field] || '').trim();
    return !value || isPreprocessorPlaceholder(value);
  });
}

function missingPreprocessorV1Fields(fields) {
  return REQUIRED_PREPROCESSOR_V1_FIELDS.filter((field) => {
    const value = String(fields?.[field] || '').trim();
    return !value || isPreprocessorPlaceholder(value);
  });
}

function isPreprocessorPlaceholder(value) {
  const s = String(value || '').trim();
  return /\bNOT GENERATED\b|\bNeeds More Evidence\b|证据不足|未生成|\bnot\s+synthesi[sz]ed\b|\binsufficient\s+input\b/i.test(s)
    || /^[-–—]+(?:\s*\([^)]*\))?$/.test(s);
}

function blankPreprocessorWritableFields(fields) {
  for (const field of PREPROCESSOR_WRITABLE_FIELDS) fields[field] = '';
}

function preprocessorReviewStatus(text) {
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/[`*_]+/g, '')
      .trim();
    const m = /^Status\s*:\s*(.+)$/i.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`invalid JSON cache ${path}: ${e.message}`);
  }
}

function compactLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(Number.parseInt(code, 16)));
}

function stripHtml(value) {
  return compactLine(decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' ')));
}

function normalizeBingUrl(href) {
  const raw = decodeHtmlEntities(href);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://www.bing.com');
    const u = parsed.searchParams.get('u');
    if (u && /^https?:\/\//i.test(u)) return u;
    if (u && /^a1[a-z0-9_-]+$/i.test(u)) {
      const encoded = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      if (/^https?:\/\//i.test(decoded)) return decoded;
    }
    return /^https?:\/\//i.test(parsed.href) ? parsed.href : '';
  } catch {
    return /^https?:\/\//i.test(raw) ? raw : '';
  }
}

function normalizeDuckDuckGoUrl(href) {
  const raw = decodeHtmlEntities(href);
  if (!raw) return '';
  try {
    const parsed = new URL(raw, 'https://duckduckgo.com');
    const uddg = parsed.searchParams.get('uddg');
    if (uddg && /^https?:\/\//i.test(uddg)) return uddg;
    return /^https?:\/\//i.test(parsed.href) && !/duckduckgo\.com\/l\//i.test(parsed.href) ? parsed.href : '';
  } catch {
    return /^https?:\/\//i.test(raw) ? raw : '';
  }
}

export function parseBingResults(html) {
  const out = [];
  const text = String(html || '');
  const blockRe = /<li\b[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)(?=<li\b[^>]*class="[^"]*\bb_algo\b|<\/ol>|$)/gi;
  let blockMatch;
  while ((blockMatch = blockRe.exec(text)) && out.length < 10) {
    const block = blockMatch[1] || '';
    const linkMatch = /<h2[^>]*>\s*<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i.exec(block)
      || /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!linkMatch) continue;
    const url = normalizeBingUrl(linkMatch[1]);
    const title = stripHtml(linkMatch[2]);
    if (!url || !title) continue;
    const snippetMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({
      position: out.length + 1,
      title,
      url,
      domain: domainFromUrl(url),
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
    });
  }
  return out;
}

export function parseDuckDuckGoResults(html) {
  const out = [];
  const text = String(html || '');
  const linkRe = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = linkRe.exec(text)) && out.length < 10) {
    const block = text.slice(match.index, Math.min(text.length, match.index + 2400));
    const url = normalizeDuckDuckGoUrl(match[1]);
    const title = stripHtml(match[2]);
    if (!url || !title) continue;
    const snippetMatch = /<[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block);
    out.push({
      position: out.length + 1,
      title,
      url,
      domain: domainFromUrl(url),
      snippet: snippetMatch ? stripHtml(snippetMatch[1]) : '',
    });
  }
  return out;
}

function distinctSearchStats(organic) {
  const titles = new Set();
  const domains = new Set();
  for (const row of organic || []) {
    const title = compactLine(row?.title);
    const domain = compactLine(row?.domain) || domainFromUrl(row?.url);
    if (title) titles.add(normText(title));
    if (domain) domains.add(domain);
  }
  return { distinctTitles: titles.size, distinctDomains: domains.size };
}

function dedupeSearchRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = [
      normText(row?.title),
      compactLine(row?.domain) || domainFromUrl(row?.url),
    ].join('|');
    if (!key.trim() || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

const EVIDENCE_GENERIC_TERMS = new Set([
  ...STOPWORDS,
  'astrology', 'zodiac', 'sign', 'signs', 'birth', 'chart', 'charts',
  'compatibility', 'synastry', 'wedding', 'dating', 'meaning',
  'world', 'cup', '2026',
]);

function evidenceTargetTerms(targetKeyword) {
  const target = compactLine(targetKeyword);
  const rawTerms = words(target).filter((term) => !EVIDENCE_GENERIC_TERMS.has(term));
  const countryTerms = looksLikeCountryVs(target)
    ? rawTerms.filter((term) => COUNTRY_TERMS.has(term))
    : [];
  const terms = countryTerms.length >= 2 ? countryTerms : rawTerms;
  return [...new Set(terms)];
}

function searchResultMatchesTarget(row, targetKeyword) {
  const requiredTerms = evidenceTargetTerms(targetKeyword);
  if (!requiredTerms.length) return true;
  const haystack = new Set(words([
    row?.title,
    row?.snippet,
    row?.url,
    row?.domain,
  ].filter(Boolean).join(' '), { keepStopwords: true }));
  return requiredTerms.every((term) => haystack.has(term));
}

function preprocessorEvidencePaths({ pageId, cacheRoot = join(REPO, '.gg-cache') } = {}) {
  const safePageId = compactLine(pageId);
  return {
    safePageId,
    serpPath: safePageId ? join(cacheRoot, 'serp', `${safePageId}.json`) : '',
    ragPath: safePageId ? join(cacheRoot, safePageId, 'friction-mine.rag.json') : '',
  };
}

function removePreprocessorEvidenceCache({ pageId, cacheRoot = join(REPO, '.gg-cache') } = {}) {
  const { serpPath, ragPath } = preprocessorEvidencePaths({ pageId, cacheRoot });
  if (serpPath) rmSync(serpPath, { force: true });
  if (ragPath) rmSync(ragPath, { force: true });
}

function cachedEvidenceMatchesTarget({ pageId, targetKeyword, cacheRoot = join(REPO, '.gg-cache') } = {}) {
  const { serpPath, ragPath } = preprocessorEvidencePaths({ pageId, cacheRoot });
  const serp = readJsonIfExists(serpPath);
  const rag = readJsonIfExists(ragPath);
  const rows = organicRows(serp);
  const stats = serpStats(serp);
  const relevantRows = rows.filter((row) => searchResultMatchesTarget(row, targetKeyword));
  const hasConcreteRag = Boolean(formatFrictionEvidenceForPreprocessor(rag));
  return {
    ok: stats.distinctTitles >= MIN_PREPROCESSOR_SERP_TITLES
      && hasConcreteRag
      && relevantRows.length >= MIN_PREPROCESSOR_SERP_TITLES,
    exists: Boolean(serp || rag),
    distinctSerpTitles: stats.distinctTitles,
    distinctSerpDomains: stats.distinctDomains,
    relevantRows: relevantRows.length,
  };
}

export function buildTrendEvidenceCache({
  cacheRoot = join(REPO, '.gg-cache'),
  pageId,
  targetKeyword,
  query,
  source = 'bing_html',
  generatedAt = new Date().toISOString(),
  organic = [],
} = {}) {
  const safePageId = compactLine(pageId);
  const cleanedRows = dedupeSearchRows((organic || [])
    .filter((row) => row && compactLine(row.title) && (compactLine(row.url) || compactLine(row.domain)))
    .map((row, idx) => ({
      position: Number.isFinite(row.position) ? row.position : idx + 1,
      title: compactLine(row.title),
      url: compactLine(row.url),
      domain: compactLine(row.domain) || domainFromUrl(row.url),
      snippet: compactLine(row.snippet),
    })));
  const requiredTerms = evidenceTargetTerms(targetKeyword);
  const rows = cleanedRows
    .filter((row) => searchResultMatchesTarget(row, targetKeyword))
    .slice(0, 10);
  const stats = distinctSearchStats(rows);
  if (!safePageId || stats.distinctTitles < MIN_PREPROCESSOR_SERP_TITLES) {
    return {
      ok: false,
      pageId: safePageId,
      ...stats,
      inputResults: cleanedRows.length,
      relevanceTerms: requiredTerms,
      written: [],
    };
  }

  const serpDir = join(cacheRoot, 'serp');
  const pageDir = join(cacheRoot, safePageId);
  mkdirSync(serpDir, { recursive: true });
  mkdirSync(pageDir, { recursive: true });

  const serp = {
    schema_version: '1',
    page_id: safePageId,
    evidence_kind: 'serp_news_title_friction',
    query: compactLine(query) || compactLine(targetKeyword),
    generated_at: generatedAt,
    source,
    relevance: {
      target_keyword: compactLine(targetKeyword),
      required_terms: requiredTerms,
      input_results: cleanedRows.length,
      retained_results: rows.length,
    },
    raw: { organic: rows },
  };
  const serpPath = join(serpDir, `${safePageId}.json`);
  writeFileSync(serpPath, `${JSON.stringify(serp, null, 2)}\n`);

  const themes = rows.slice(0, 5).map((row, idx) => ({
    theme: 'serp_news_intent_split',
    source_id: `serp#${idx + 1}`,
    domain: row.domain,
    scrubbed_quote: `SERP/news titles for "${targetKeyword}" surface "${row.title}"${row.snippet ? ` — ${row.snippet}` : ''}`,
    mention_count: 1,
  }));
  const rag = {
    schema_version: '1',
    page_id: safePageId,
    evidence_kind: 'serp_news_title_friction',
    entity: compactLine(targetKeyword),
    target_keyword: compactLine(targetKeyword),
    generated_at: generatedAt,
    relevance: {
      required_terms: requiredTerms,
      input_results: cleanedRows.length,
      retained_results: rows.length,
    },
    themes,
    pii_audit: { status: 'not_applicable', reason: 'SERP/news title evidence, not user PII' },
    _synth: false,
  };
  const ragPath = join(pageDir, 'friction-mine.rag.json');
  writeFileSync(ragPath, `${JSON.stringify(rag, null, 2)}\n`);
  return {
    ok: true,
    pageId: safePageId,
    ...stats,
    inputResults: cleanedRows.length,
    relevanceTerms: requiredTerms,
    written: [serpPath, ragPath],
  };
}

function asciiFold(value) {
  return compactLine(String(value || '').normalize('NFKD').replace(/\p{M}+/gu, ''));
}

function quoteSearchPhrase(value) {
  return `"${compactLine(value).replace(/"/g, '')}"`;
}

function evidenceSearchQueries({ targetKeyword, fields = {} } = {}) {
  const target = compactLine(targetKeyword);
  const parts = target
    .split(/\s+(?:and|vs|versus)\s+/i)
    .map(compactLine)
    .filter(Boolean);
  const asciiParts = parts.map(asciiFold);
  const queries = [];
  const push = (query) => {
    const q = compactLine(query);
    if (q && !queries.includes(q)) queries.push(q);
  };
  if (looksLikeCountryVs(target) && parts.length >= 2) {
    push(`${parts.map(quoteSearchPhrase).join(' ')} "World Cup 2026"`);
    push(`${asciiParts.join(' ')} World Cup 2026`);
    push(`${asciiParts[0]} vs ${asciiParts[1]} World Cup 2026`);
    push(`${asciiParts.join(' ')} astrology`);
    return queries;
  }
  if (looksLikeCelebrityPair(target) && parts.length >= 2) {
    push(`${parts.map(quoteSearchPhrase).join(' ')} astrology`);
    push(`${asciiParts.map(quoteSearchPhrase).join(' ')} astrology`);
    push(`${asciiParts.map(quoteSearchPhrase).join(' ')} compatibility astrology`);
    push(`${asciiParts.join(' ')} astrology`);
    push(`${asciiParts.join(' ')} zodiac compatibility`);
    return queries;
  }
  if (String(fields.Template || '').trim() === 'Case Study') {
    push(`${quoteSearchPhrase(target)} astrology`);
    push(`${asciiFold(target)} astrology`);
    return queries;
  }
  push(target);
  return queries;
}

function evidenceSearchQuery(opts = {}) {
  return evidenceSearchQueries(opts)[0] || compactLine(opts.targetKeyword);
}

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBingSearchResults(query, { limit = 10, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for Bing evidence discovery');
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  }, timeoutMs);
  if (!res.ok) throw new Error(`Bing evidence fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  return { source: 'bing_html', organic: parseBingResults(html).slice(0, limit) };
}

export async function fetchDuckDuckGoSearchResults(query, { limit = 10, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for DuckDuckGo evidence discovery');
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetchWithTimeout(fetchImpl, url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
    },
  }, timeoutMs);
  if (!res.ok) throw new Error(`DuckDuckGo evidence fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  return { source: 'duckduckgo_html', organic: parseDuckDuckGoResults(html).slice(0, limit) };
}

export async function fetchGoogleCustomSearchResults(query, {
  limit = 10,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8000,
  apiKey = process.env.GG_TOPIC_REGISTER_GOOGLE_CSE_KEY || process.env.GG_GOOGLE_CSE_KEY || '',
  cx = process.env.GG_TOPIC_REGISTER_GOOGLE_CSE_CX || process.env.GG_GOOGLE_CSE_CX || '',
} = {}) {
  if (!apiKey || !cx) {
    return { source: 'google_cse', skipped: true, organic: [] };
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable for Google evidence discovery');
  const url = new URL('https://customsearch.googleapis.com/customsearch/v1');
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.min(10, Math.max(1, Number(limit) || 10))));
  url.searchParams.set('gl', process.env.GG_TOPIC_REGISTER_SEARCH_GL || 'us');
  url.searchParams.set('hl', process.env.GG_TOPIC_REGISTER_SEARCH_HL || 'en');
  const res = await fetchWithTimeout(fetchImpl, url.toString(), {
    headers: { accept: 'application/json' },
  }, timeoutMs);
  if (!res.ok) throw new Error(`Google CSE evidence fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    source: 'google_cse',
    organic: items.slice(0, limit).map((item, idx) => ({
      position: idx + 1,
      title: compactLine(item.title),
      url: compactLine(item.link),
      domain: domainFromUrl(item.link),
      snippet: compactLine(item.snippet),
    })).filter((row) => row.title && row.url),
  };
}

function evidenceSearchProviders(value = process.env.GG_TOPIC_REGISTER_SEARCH_PROVIDERS || 'google,duckduckgo') {
  return String(value || '')
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);
}

export async function fetchEvidenceSearchResults(query, {
  limit = 10,
  fetchImpl = globalThis.fetch,
  timeoutMs = Number(process.env.GG_TOPIC_REGISTER_SEARCH_TIMEOUT_MS || 8000),
  providers = evidenceSearchProviders(),
  googleApiKey,
  googleCx,
} = {}) {
  const errors = [];
  for (const provider of providers) {
    try {
      let result = null;
      if (provider === 'google' || provider === 'google_cse') {
        result = await fetchGoogleCustomSearchResults(query, {
          limit,
          fetchImpl,
          timeoutMs,
          apiKey: googleApiKey ?? process.env.GG_TOPIC_REGISTER_GOOGLE_CSE_KEY ?? process.env.GG_GOOGLE_CSE_KEY ?? '',
          cx: googleCx ?? process.env.GG_TOPIC_REGISTER_GOOGLE_CSE_CX ?? process.env.GG_GOOGLE_CSE_CX ?? '',
        });
        if (result.skipped) continue;
      } else if (provider === 'duckduckgo' || provider === 'ddg') {
        result = await fetchDuckDuckGoSearchResults(query, { limit, fetchImpl, timeoutMs });
      } else if (provider === 'bing') {
        result = await fetchBingSearchResults(query, { limit, fetchImpl, timeoutMs });
      }
      if (result && Array.isArray(result.organic) && result.organic.length) return result;
    } catch (e) {
      errors.push(`${provider}: ${redactNote(e)}`);
    }
  }
  if (errors.length) throw new Error(`all evidence search providers failed: ${errors.join('; ')}`);
  return { source: 'none', organic: [] };
}

export function formatFrictionEvidenceForPreprocessor(rag) {
  if (!rag || typeof rag !== 'object' || rag._synth) return '';
  const lines = [];
  for (const theme of Array.isArray(rag.themes) ? rag.themes : []) {
    const quote = compactLine(theme?.scrubbed_quote);
    if (!quote || /\bTODO\b/i.test(quote)) continue;
    const sourceId = compactLine(theme?.source_id) || 'source';
    const domain = compactLine(theme?.domain);
    const themeName = compactLine(theme?.theme);
    const mentionCount = Number.isFinite(theme?.mention_count) ? theme.mention_count : '';
    const meta = [
      themeName ? `theme=${themeName}` : '',
      mentionCount !== '' ? `mentions=${mentionCount}` : '',
    ].filter(Boolean).join('; ');
    lines.push(`- ${[sourceId, domain].filter(Boolean).join(' ')}: ${quote}${meta ? ` (${meta})` : ''}`);
  }
  return lines.length ? ['Friction evidence from sourced user complaints:', ...lines].join('\n') : '';
}

function domainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function organicRows(serp) {
  const organic = serp?.raw?.organic || serp?.organic || [];
  return Array.isArray(organic) ? organic.filter((item) => item && typeof item === 'object') : [];
}

function serpStats(serp) {
  const rows = organicRows(serp);
  const titles = new Set();
  const domains = new Set();
  for (const row of rows) {
    const title = compactLine(row.title);
    const domain = compactLine(row.domain) || domainFromUrl(row.url);
    if (title) titles.add(normText(title));
    if (domain) domains.add(domain);
  }
  return { rows, distinctTitles: titles.size, distinctDomains: domains.size };
}

export function formatSerpSnapshotForPreprocessor(serp) {
  if (!serp || typeof serp !== 'object') return '';
  const { rows, distinctTitles, distinctDomains } = serpStats(serp);
  if (!rows.length) return '';
  const header = [
    `source=${compactLine(serp.source) || 'unknown'}`,
    `generated_at=${compactLine(serp.generated_at) || 'unknown'}`,
    `distinct_titles=${distinctTitles}`,
    `distinct_domains=${distinctDomains}`,
    `query="${compactLine(serp.query)}"`,
  ].join(' ');
  const lines = rows.slice(0, 10).map((row, idx) => {
    const pos = Number.isFinite(row.position) ? row.position : idx + 1;
    const title = compactLine(row.title) || '(untitled)';
    const snippet = compactLine(row.snippet);
    const domain = compactLine(row.domain) || domainFromUrl(row.url) || 'unknown-domain';
    return `[${pos}] ${title}${snippet ? ` — ${snippet}` : ''} (${domain})`;
  });
  return ['SERP evidence snapshot:', header, ...lines].join('\n');
}

export function loadPreprocessorEvidence({ pageId, cacheRoot = join(REPO, '.gg-cache') } = {}) {
  const safePageId = compactLine(pageId);
  if (!safePageId) {
    return {
      rawFriction: '',
      serpSnapshot: '',
      hasConcreteFriction: false,
      distinctSerpTitles: 0,
      distinctSerpDomains: 0,
    };
  }
  const rag = readJsonIfExists(join(cacheRoot, safePageId, 'friction-mine.rag.json'));
  const serp = readJsonIfExists(join(cacheRoot, 'serp', `${safePageId}.json`));
  const rawFriction = formatFrictionEvidenceForPreprocessor(rag);
  const serpSnapshot = formatSerpSnapshotForPreprocessor(serp);
  const stats = serpStats(serp);
  return {
    rawFriction,
    serpSnapshot,
    hasConcreteFriction: Boolean(rawFriction),
    distinctSerpTitles: stats.distinctTitles,
    distinctSerpDomains: stats.distinctDomains,
  };
}

function buildPreprocessorPrompt({ targetKeyword, fields, cluster, evidence = {} }) {
  return renderPreprocessorPrompt({
    targetKeyword,
    tier: fields.Tier,
    template: fields.Template,
    clusterContext: [
      cluster.cluster_name,
      cluster.jtbd,
      cluster.content_angle,
    ].filter(Boolean).join(' | '),
    rawFriction: evidence.rawFriction || fields.Friction,
    draftAngle: fields.content_angle,
    serpSnapshot: evidence.serpSnapshot || '[not supplied by gg-topic-register; add SERP top 5-10 before final editorial approval]',
  });
}

function buildPreprocessorV1FallbackPromptForItem(item) {
  const evidence = item?.preprocessorEvidence || {};
  const fields = item?.fields || {};
  return renderPreprocessorV1FallbackPrompt({
    targetKeyword: item?.target_keyword,
    rawFriction: evidence.rawFriction || fields.Friction,
    draftAngle: fields.content_angle,
    serpSnapshot: evidence.serpSnapshot || '',
  });
}

export async function discoverPreprocessorEvidenceForPlan(plan, {
  cacheRoot = plan?.cacheRoot || join(REPO, '.gg-cache'),
  fetchSearchResults = fetchEvidenceSearchResults,
  limit = 10,
  budget = null,
} = {}) {
  const promptByPageId = new Map((plan.promptWrites || []).map((item) => [item.pageId, item]));
  const summaries = [];
  const searchReserveMs = (finitePositiveInt(process.env.GG_TOPIC_REGISTER_SEARCH_TIMEOUT_MS) || 8000) + 5000;
  for (const item of plan.updates || []) {
    if (!budgetCanStart(budget, searchReserveMs)) {
      const summary = {
        pageId: item.pageId,
        ...budgetExhaustedSummary(budget, 'evidence_discovery', searchReserveMs),
      };
      item.preprocessorEvidenceBudget = summary;
      summaries.push(summary);
      continue;
    }
    const existing = loadPreprocessorEvidence({ pageId: item.pageId, cacheRoot });
    const cacheStatus = cachedEvidenceMatchesTarget({
      pageId: item.pageId,
      targetKeyword: item.target_keyword,
      cacheRoot,
    });
    if (cacheStatus.ok) {
      item.preprocessorEvidence = existing;
      summaries.push({ pageId: item.pageId, status: 'cached', distinctSerpTitles: existing.distinctSerpTitles });
      continue;
    }
    if (cacheStatus.exists) {
      removePreprocessorEvidenceCache({ pageId: item.pageId, cacheRoot });
    }
    const queries = evidenceSearchQueries({
      targetKeyword: item.target_keyword,
      fields: item.fields,
      cluster: item.cluster,
    });
    const usedQueries = [];
    const combinedOrganic = [];
    let built = {
      ok: false,
      pageId: item.pageId,
      distinctTitles: 0,
      distinctDomains: 0,
      written: [],
    };
    try {
      const usedSources = new Set();
      for (const query of queries) {
        if (!budgetCanStart(budget, searchReserveMs)) {
          built = {
            ok: false,
            pageId: item.pageId,
            distinctTitles: 0,
            distinctDomains: 0,
            written: [],
            budgetExhausted: budgetExhaustedSummary(budget, 'evidence_discovery_query', searchReserveMs),
          };
          break;
        }
        usedQueries.push(query);
        const fetched = await fetchSearchResults(query, { limit });
        const organic = Array.isArray(fetched) ? fetched : (Array.isArray(fetched?.organic) ? fetched.organic : []);
        const source = Array.isArray(fetched) ? 'custom_search' : compactLine(fetched?.source);
        if (source) usedSources.add(source);
        combinedOrganic.push(...organic);
        built = buildTrendEvidenceCache({
          cacheRoot,
          pageId: item.pageId,
          targetKeyword: item.target_keyword,
          query: usedQueries.join(' | '),
          source: [...usedSources].join('+') || 'search_provider',
          organic: dedupeSearchRows(combinedOrganic),
        });
        if (built.ok) break;
      }
      item.preprocessorEvidence = loadPreprocessorEvidence({ pageId: item.pageId, cacheRoot });
      const promptItem = promptByPageId.get(item.pageId);
      if (promptItem) {
        promptItem.prompt = buildPreprocessorPrompt({
          targetKeyword: item.target_keyword,
          fields: item.fields,
          cluster: item.cluster,
          evidence: item.preprocessorEvidence,
        });
      }
      summaries.push({
        pageId: item.pageId,
        ...(built.budgetExhausted || { status: built.ok ? 'ok' : 'insufficient' }),
        query: usedQueries[usedQueries.length - 1] || queries[0] || '',
        queries: usedQueries,
        distinctSerpTitles: built.distinctTitles,
        distinctSerpDomains: built.distinctDomains,
      });
    } catch (e) {
      summaries.push({ pageId: item.pageId, status: 'failed', query: usedQueries[usedQueries.length - 1] || queries[0] || '', queries: usedQueries, error: redactNote(e) });
    }
  }
  plan.evidenceDiscovery = summaries;
  return summaries;
}

async function runPreprocessorV1FallbackForItem(item, {
  llm,
  callLLM,
  budget = null,
  reserveMs,
  reason = {},
} = {}) {
  const detail = {
    fallback: 'v1',
    ...(reason.missing?.length ? { v2_missing: reason.missing } : {}),
    ...(reason.reviewStatus ? { v2_review_status: reason.reviewStatus } : {}),
    ...(reason.error ? { v2_error: reason.error } : {}),
    ...(reason.model ? { v2_model: reason.model } : {}),
  };
  const prompt = buildPreprocessorV1FallbackPromptForItem(item);

  if (budgetCanStart(budget, reserveMs)) {
    try {
      const response = await callLLM({ llm, prompt });
      const parsed = parsePreprocessorV1Fields(response.stdout || '');
      const missing = missingPreprocessorV1Fields(parsed);
      if (!missing.length) {
        item.fields = applyPreprocessorV1Fields(item.fields, parsed);
        item.preprocessor = {
          status: 'v1_fallback',
          llm: response.model || llm,
          ...detail,
          fields: ['Friction', 'content_angle'],
        };
        return;
      }
      item.preprocessor = {
        status: 'v1_deterministic_fallback',
        llm: response.model || llm,
        ...detail,
        v1_missing: missing,
      };
      return;
    } catch (e) {
      item.preprocessor = {
        status: 'v1_deterministic_fallback',
        llm,
        ...detail,
        v1_error: redactNote(e),
      };
      return;
    }
  }

  item.preprocessor = {
    status: 'v1_deterministic_fallback',
    llm,
    ...detail,
    budget: budgetExhaustedSummary(budget, 'preprocessor_v1_fallback', reserveMs),
  };
}

export async function runPreprocessorForPlan(plan, {
  llm = 'codex',
  callLLM = callBriefLLM,
  allowFallback = true,
  budget = null,
} = {}) {
  const promptByPageId = new Map((plan.promptWrites || []).map((item) => [item.pageId, item.prompt]));
  const reserveMs = llmStartReserveMs();
  for (const item of plan.updates || []) {
    const prompt = promptByPageId.get(item.pageId);
    if (!budgetCanStart(budget, reserveMs)) {
      item.preprocessor = {
        ...budgetExhaustedSummary(budget, 'preprocessor_llm', reserveMs),
        llm,
      };
      continue;
    }
    try {
      if (!prompt) throw new Error(`missing preprocessor prompt for ${item.pageId}`);
      const response = await callLLM({ llm, prompt });
      const parsed = parsePreprocessorSheetFields(response.stdout || '');
      const missing = missingPreprocessorFields(parsed);
      const reviewStatus = preprocessorReviewStatus(response.stdout);
      if (missing.length || /Needs More Evidence/i.test(reviewStatus)) {
        if (allowFallback) {
          await runPreprocessorV1FallbackForItem(item, {
            llm,
            callLLM,
            budget,
            reserveMs,
            reason: { missing, reviewStatus, model: response.model },
          });
          continue;
        }
        blankPreprocessorWritableFields(item.fields);
        item.preprocessor = {
          status: /Needs More Evidence/i.test(reviewStatus) ? 'needs_evidence' : 'invalid_output',
          llm: response.model || llm,
          missing,
          review_status: reviewStatus,
        };
        continue;
      }
      item.fields = applyPreprocessorSheetFields(item.fields, parsed);
      item.preprocessor = {
        status: 'ok',
        llm: response.model || llm,
        fields: Object.keys(parsed),
      };
    } catch (e) {
      if (allowFallback) {
        await runPreprocessorV1FallbackForItem(item, {
          llm,
          callLLM,
          budget,
          reserveMs,
          reason: { error: redactNote(e) },
        });
      } else {
        blankPreprocessorWritableFields(item.fields);
        item.preprocessor = {
          status: 'failed',
          llm,
          error: redactNote(e),
        };
      }
    }
  }
  return plan;
}

function clusterRowToValues(row) {
  return CLUSTER_FIELDS.map((field) => row[field] == null ? '' : String(row[field]));
}

export function valuesBatchForPageRow({ tab, rowNumber, header, fields, existingValues = {}, overwrite = false, taxonomyOnly = false }) {
  const idx = headerIndex(header);
  const writable = taxonomyOnly ? PAGE_TAXONOMY_WRITABLE_FIELDS : PAGE_WRITABLE_FIELDS;
  const data = [];
  for (const field of writable) {
    if (!Object.hasOwn(fields, field)) continue;
    if (!overwrite && String(existingValues[field] || '').trim()) continue;
    const c = idx[field];
    if (c == null) continue;
    data.push({
      range: `${tab}!${colLetter(c)}${rowNumber}`,
      values: [[fields[field] == null ? '' : String(fields[field])]],
    });
  }
  return data;
}

export function colLetter(n) {
  let s = '';
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

async function fetchValues(workbookId, range, token) {
  const res = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}?majorDimension=ROWS`,
    token,
  );
  return res.values || [];
}

async function appendRows(workbookId, range, rows, token) {
  if (!rows.length) return { updates: { updatedRows: 0 } };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: rows }),
    },
  );
}

async function batchUpdateValues(workbookId, data, token) {
  if (!data.length) return { totalUpdatedCells: 0 };
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values:batchUpdate`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
    },
  );
}

function resolveProducts(arg) {
  const raw = arg || 'all';
  if (raw === 'all') return [PRODUCT_PROFILES.astrologywiki, PRODUCT_PROFILES.gengrowth];
  return String(raw).split(',').map((p) => {
    const profile = PRODUCT_PROFILES[p.trim()];
    if (!profile) throw new Error(`unknown --product "${p}" (use astrologywiki|gengrowth|all)`);
    return profile;
  });
}

function resolveWorkbook(profile) {
  const id = (process.env[profile.workbookEnv] || '').trim()
    || (profile.fallbackWorkbookEnv ? (process.env[profile.fallbackWorkbookEnv] || '').trim() : '');
  if (!id) throw new Error(`workbook id missing for ${profile.key}: ${profile.workbookEnv}`);
  return id;
}

function csvSet(value, { normalize = false } = {}) {
  if (!value || value === true) return new Set();
  return new Set(String(value)
    .split(',')
    .map((s) => (normalize ? normText(s) : String(s || '').trim()))
    .filter(Boolean));
}

function planRows({
  profile,
  pagesRaw,
  clustersRaw,
  limit,
  includeIncomplete = false,
  repairPageIds = new Set(),
  repairKeywords = new Set(),
  reassignExisting = false,
  completedPageIds = new Set(),
  preprocessorOutputsByKeyword = new Map(),
  preprocessorOutputsByPageId = new Map(),
  cacheRoot = join(REPO, '.gg-cache'),
}) {
  const pageHeader = pagesRaw[0] || [];
  const clusterHeader = clustersRaw[0] || [];
  const clusters = rowsToObjects(clusterHeader, clustersRaw.slice(1));
  const pages = rowsToObjects(pageHeader, pagesRaw.slice(1));
  const selected = selectCandidateRowsForPlan(pagesRaw, {
    includeIncomplete,
    onlyPageIds: repairPageIds,
    onlyKeywords: repairKeywords,
    excludePageIds: completedPageIds,
    limit,
  });
  const candidates = selected.candidates;
  const newClusters = new Map();
  const updates = [];
  const taskLines = [];
  const promptWrites = [];

  for (const candidate of candidates) {
    const existingClusterId = reassignExisting ? '' : candidate.values.cluster_id;
    let cluster = existingClusterId ? clusters.find((c) => c.cluster_id === existingClusterId) : null;
    let clusterDecision = null;
    if (!cluster) {
      clusterDecision = chooseClusterForKeyword(candidate.target_keyword, [...clusters, ...newClusters.values()]);
      if (clusterDecision.kind === 'existing') {
        cluster = clusterDecision.cluster;
      } else {
        cluster = buildNewClusterRow({
          product: profile.key,
          keyword: candidate.target_keyword,
          existingClusters: [...clusters, ...newClusters.values()],
        });
        newClusters.set(cluster.cluster_id, cluster);
      }
    }

    const pageId = reassignExisting
      ? inferNextPageId({
        product: profile.key,
        clusterId: cluster.cluster_id,
        pages: [...pages, ...updates.map((u) => ({ page_id: u.pageId, cluster_id: u.cluster.cluster_id }))],
      })
      : (candidate.values.page_id || inferNextPageId({
      product: profile.key,
      clusterId: cluster.cluster_id,
      pages: [...pages, ...updates.map((u) => ({ page_id: u.pageId, cluster_id: u.cluster.cluster_id }))],
    }));
    let fields = pageRowFields({
      targetKeyword: candidate.target_keyword,
      pageId,
      cluster,
      product: profile.key,
      sourceValues: candidate.values,
    });
    const preprocessorOutput = preprocessorOutputFor({
      targetKeyword: candidate.target_keyword,
      pageId,
      preprocessorOutputsByKeyword,
      preprocessorOutputsByPageId,
    });
    if (preprocessorOutput) {
      const parsed = typeof preprocessorOutput === 'string'
        ? parsePreprocessorSheetFields(preprocessorOutput)
        : preprocessorOutput;
      fields = applyPreprocessorSheetFields(fields, parsed);
    }
    const preprocessorEvidence = loadPreprocessorEvidence({ pageId, cacheRoot });
    const prompt = buildPreprocessorPrompt({
      targetKeyword: candidate.target_keyword,
      fields,
      cluster,
      evidence: preprocessorEvidence,
    });
    updates.push({
      product: profile.key,
      row: candidate.row,
      target_keyword: candidate.target_keyword,
      pageId,
      cluster,
      clusterDecision: clusterDecision || { kind: 'existing-present', cluster_id: cluster.cluster_id, score: 1 },
      fields,
      existingValues: candidate.values,
      missing: candidate.missing,
      preprocessorEvidence,
    });
    if (reassignExisting || !String(candidate.values.page_id || '').trim()) {
      taskLines.push(buildTaskLine({ pageId, keyword: candidate.target_keyword }));
    }
    promptWrites.push({ pageId, prompt });
  }

  return {
    pageHeader,
    clusters,
    pages,
    candidates,
    selectionMode: selected.mode,
    auditIncomplete: selected.audit_incomplete,
    newClusters: [...newClusters.values()],
    updates,
    taskLines,
    promptWrites,
    cacheRoot,
  };
}

function writePromptFiles(profile, prompts) {
  const outDir = join(REPO, '.gg-cache', 'topic-register', profile.key);
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const { pageId, prompt } of prompts) {
    const path = join(outDir, `${pageId}-preprocessor-v2.prompt.md`);
    writeFileSync(path, prompt);
    written.push(path);
  }
  return written;
}

async function runProduct(profile, { token, args, nowDate, budget = null }) {
  // Guard (2026-07-03): refuse to --apply un-enriched rows. Without --llm the preprocessor never
  // runs, so pageRowFields writes the template-scaffold Entity/Logic ("<x> ↔ <cluster> ↔ practical
  // interpretation. Treat <x> as an interpretive framework…") — thin, un-SERP-grounded briefs that
  // look enriched but are not. This was the root cause of the 2026-07 thin-brief batch. Enrich with
  // "--discover-evidence --llm claude" (DuckDuckGo/Bing HTML SERP, no creds), or pass
  // --allow-thin-brief to intentionally write the scaffold. The scheduled tick already passes
  // --llm, so it is unaffected. Fails fast, before any Sheets read/write.
  if (args.apply && !args.llm && !args.allow_thin_brief) {
    throw new Error(
      `${profile.key}: refusing --apply without --llm — would write template-scaffold thin briefs `
      + `(un-SERP-grounded Entity/Logic). Add "--discover-evidence --llm claude" to enrich, or `
      + `--allow-thin-brief to override intentionally.`,
    );
  }
  const workbookId = resolveWorkbook(profile);
  const [pagesRaw, clustersRaw] = await Promise.all([
    fetchValues(workbookId, `${PAGES_TAB}!A:W`, token),
    fetchValues(workbookId, `${CLUSTERS_TAB}!A:S`, token),
  ]);
  if (!pagesRaw.length) throw new Error(`${profile.key}: ${PAGES_TAB} empty`);
  if (!clustersRaw.length) throw new Error(`${profile.key}: ${CLUSTERS_TAB} empty`);
  const limit = args.limit ? Number(args.limit) : 0;
  const completedPageIds = profile.taskPlan && existsSync(profile.taskPlan)
    ? checkedTaskPageIds(readFileSync(profile.taskPlan, 'utf8'))
    : new Set();
  const plan = planRows({
    profile,
    pagesRaw,
    clustersRaw,
    limit,
    includeIncomplete: !!args.include_incomplete,
    repairPageIds: csvSet(args.repair_page_ids),
    repairKeywords: csvSet(args.repair_keywords, { normalize: true }),
    reassignExisting: !!args.reassign_existing,
    completedPageIds,
  });
  if (args.discover_evidence) {
    await discoverPreprocessorEvidenceForPlan(plan, { budget });
  }
  if (args.llm) {
    const llm = args.llm === true ? 'codex' : String(args.llm);
    await runPreprocessorForPlan(plan, {
      llm,
      allowFallback: !args.no_preprocessor_fallback,
      budget,
    });
  }

  if (!args.apply) {
    return { profile, workbookId, plan, applied: false, promptPaths: [] };
  }

  if (!budgetCanStart(budget, DEFAULT_APPLY_START_RESERVE_MS)) {
    plan.budgetExhausted = budgetExhaustedSummary(budget, 'apply_writes', DEFAULT_APPLY_START_RESERVE_MS);
    return {
      profile,
      workbookId,
      plan,
      applied: false,
      promptPaths: [],
      skippedApply: true,
      budgetExhausted: plan.budgetExhausted,
    };
  }

  const clusterRows = plan.newClusters.map(clusterRowToValues);
  if (clusterRows.length) {
    await appendRows(workbookId, `${CLUSTERS_TAB}!A:S`, clusterRows, token);
  }
  const pageData = [];
  for (const item of plan.updates) {
    pageData.push(...valuesBatchForPageRow({
      tab: PAGES_TAB,
      rowNumber: item.row,
      header: plan.pageHeader,
      fields: item.fields,
      existingValues: item.existingValues,
      overwrite: !!args.overwrite,
      taxonomyOnly: !!args.taxonomy_only,
    }));
  }
  await batchUpdateValues(workbookId, pageData, token);

  const promptPaths = writePromptFiles(profile, plan.promptWrites);

  if (profile.taskPlan && existsSync(profile.taskPlan) && plan.taskLines.length) {
    const before = readFileSync(profile.taskPlan, 'utf8');
    const repaired = args.reassign_existing
      ? replaceTaskLines(before, {
        replacements: plan.updates.map((u) => ({
          oldPageId: u.existingValues.page_id,
          newLine: buildTaskLine({ pageId: u.pageId, keyword: u.target_keyword }),
        })),
      })
      : before;
    const after = appendTaskLines(repaired, {
      date: nowDate,
      title: '待写作',
      lines: plan.taskLines,
    });
    if (after !== before) writeFileSync(profile.taskPlan, after);
  }

  if (!args.no_notify && plan.updates.length) {
    const msg = [
      `SEO 选题登记自动补齐完成：${profile.label}`,
      `补齐 ${plan.updates.length} 行；新增 cluster ${plan.newClusters.length} 个。`,
      `page_id: ${plan.updates.map((u) => u.pageId).join(', ')}`,
    ].join('\n');
    execFileSync(LARK_NOTIFY, [msg], { cwd: REPO, stdio: 'ignore' });
  }
  return { profile, workbookId, plan, applied: true, promptPaths };
}

export function summarizeProductResult(result, { args = {} } = {}) {
  const plan = result?.plan || {};
  const updates = Array.isArray(plan.updates) ? plan.updates : [];
  const preprocessor = updates.map((u) => u.preprocessor?.status || (args.llm ? 'not-run' : 'deterministic'));
  const evidenceDiscovery = Array.isArray(plan.evidenceDiscovery) ? plan.evidenceDiscovery : [];
  const budgetExhausted = Boolean(
    result?.budgetExhausted
    || plan.budgetExhausted
    || preprocessor.includes('budget_exhausted')
    || evidenceDiscovery.some((row) => row?.status === 'budget_exhausted'),
  );
  return {
    product: result?.profile?.key || '',
    applied: Boolean(result?.applied),
    candidates: Array.isArray(plan.candidates) ? plan.candidates.length : 0,
    updates: updates.length,
    new_clusters: Array.isArray(plan.newClusters) ? plan.newClusters.length : 0,
    page_ids: updates.map((u) => u.pageId),
    ...(plan.selectionMode ? { selection_mode: plan.selectionMode } : {}),
    ...(Number.isFinite(plan.auditIncomplete) ? { audit_incomplete: plan.auditIncomplete } : {}),
    preprocessor,
    evidence_discovery: evidenceDiscovery,
    ...(result?.skippedApply ? { skipped_apply: true } : {}),
    ...(budgetExhausted ? { budget_exhausted: true } : {}),
    ...(plan.budgetExhausted ? { budget: plan.budgetExhausted } : {}),
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(`gg-topic-register — fill selected topic rows from cluster/page rules

usage:
  node tools/scripts/gg-topic-register.mjs --product astrologywiki|gengrowth|all [--limit N]
  node tools/scripts/gg-topic-register.mjs --product gengrowth --apply

default:
  dry-run only. Use --apply to write Sheets, task plan files, prompt cache, and Feishu notice.

flags:
  --product <name>   astrologywiki | gengrowth | all (default all)
  --limit N          process at most N candidate rows per product
  --include-incomplete
                     process all incomplete rows in sheet order (default: audit existing incomplete rows before generating new blank rows)
  --repair-page-ids <ids>
                     comma-separated existing PG-* ids to re-evaluate even when rows are complete
  --repair-keywords <keywords>
                     comma-separated target keywords to re-evaluate even when rows are complete
  --reassign-existing
                     ignore existing page_id/cluster_id for selected repair rows and recompute both
  --llm <name>       run pre-processor v2 through codex | claude | hermes before writing fields
  --no-preprocessor-fallback
                     disable the default behavior of falling back to v1 (Friction + Content_Angle)
                     when v2 cannot return usable fields; by default v2 failure auto-runs v1
  --run-budget-ms N  internal graceful-stop budget; emits JSON summary before wrapper timeout
  --apply            perform writes
  --overwrite        overwrite existing writable cells (default: fill blanks only)
  --no-notify        skip Feishu notification during --apply
`);
    return 0;
  }

  loadEnv();
  const writerSa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(writerSa)) {
    process.stderr.write(`writer SA not found: ${writerSa}\n`);
    return 2;
  }
  const scopes = [args.apply ? 'https://www.googleapis.com/auth/spreadsheets' : 'https://www.googleapis.com/auth/spreadsheets.readonly'];
  const { token } = await getAccessToken(writerSa, scopes);
  const products = resolveProducts(args.product);
  const nowDate = process.env.GG_TOPIC_REGISTER_DATE || new Date().toISOString().slice(0, 10);
  const budget = createRunBudget({
    budgetMs: args.run_budget_ms || process.env.GG_TOPIC_REGISTER_RUN_BUDGET_MS,
  });
  const summaries = [];
  let failures = 0;
  for (const profile of products) {
    try {
      if (!budgetCanStart(budget, DEFAULT_RUN_BUDGET_START_RESERVE_MS)) {
        summaries.push({
          product: profile.key,
          applied: false,
          candidates: 0,
          updates: 0,
          new_clusters: 0,
          page_ids: [],
          preprocessor: [],
          evidence_discovery: [],
          budget_exhausted: true,
          skipped: true,
          budget: budgetExhaustedSummary(budget, 'product_start', DEFAULT_RUN_BUDGET_START_RESERVE_MS),
        });
        continue;
      }
      const result = await runProduct(profile, { token, args, nowDate, budget });
      summaries.push(summarizeProductResult(result, { args }));
    } catch (e) {
      failures += 1;
      summaries.push({ product: profile.key, ok: false, error: redactNote(e) });
    }
  }
  process.stdout.write(JSON.stringify({
    ok: failures === 0,
    dry_run: !args.apply,
    budget_exhausted: summaries.some((row) => row?.budget_exhausted),
    summaries,
  }, null, 2) + '\n');
  return failures ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${redactNote(e)}\n`);
    process.exit(1);
  });
}

export { main, planRows };
