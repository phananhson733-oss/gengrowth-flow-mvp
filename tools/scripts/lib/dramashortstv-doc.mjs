// DramaShortsTV document-only content contract.
// Pure helpers here never touch Google Sheets, Git, Oracle, publishers, or media.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DRAMA_WORKBOOK_ID = '1-Qbv2MLRbiHDHdSi2csdatIVqxqCwkfcclkuGFN1dos';
export const DRAMA_OUTPUT_SUBDIR = 'inbox-maboyang/05-blog/dramashortstv';

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIRACY_RE = /\b(?:dailymotion|free\s+coins?|mod\s+apk|unlimited\s+coins?|without\s+paying)\b|免费看不付费/iu;
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)|<img\b|https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:[?#]\S*)?/iu;
const PLACEHOLDER_RE = /\b(?:TBD|TODO)\b|\[\[</u;

const TYPE_RULES = Object.freeze({
  'safety-guide': { label: '安全指南聚合页', faq: false, marker: /safe|legit|avoid|payment|paywall/iu },
  'app-profile': { label: 'App 档案页', faq: true, marker: /profile|subscription|owner|review|price/iu },
  comparison: { label: '对比测评', faq: true, marker: /at a glance|compar|versus|\bvs\b/iu },
  'brand-playlist': { label: '品牌剧单', faq: false, marker: /watch|drama|series|playlist|list/iu },
  'actor-profile': { label: '演员/角色内容', faq: false, marker: /quick facts|dramas|roles|works/iu },
  'reader-bridge': { label: '题材枢纽页/读者视角桥接', faq: false, marker: /reader|watched|picks|recommend/iu },
});

function text(value) {
  return value == null ? '' : String(value).trim();
}

function extractTierGateField(block, label) {
  const line = String(block || '').split(/\r?\n/).find((item) => item.includes(`必读 ${label}`));
  if (!line) return '';
  const colon = line.indexOf(':');
  return colon === -1 ? '' : line.slice(colon + 1).trim();
}

function isKeywordMetadata(value) {
  const valueText = text(value);
  if (!valueText) return true;
  if (/^[（(]|[)）]$/u.test(valueText)) return true;
  return /(不在.*主表|仅供参考|未找到|搜索量|同名人污染|页面流量数据)/u.test(valueText);
}

function stripFrontmatter(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return normalized.trim();
  const end = normalized.indexOf('\n---\n', 4);
  return end === -1 ? normalized.trim() : normalized.slice(end + 5).trim();
}

function h1Title(markdown) {
  const match = stripFrontmatter(markdown).match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function proseParagraphs(markdown) {
  const body = stripFrontmatter(markdown).replace(/```[\s\S]*?```/g, '');
  return body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/u.test(part));
}

export function contentTypeFor({ clusterId, template }) {
  const cluster = text(clusterId);
  const templateName = text(template);
  if (cluster === 'clu_app_trust' && templateName === 'Definition') return 'safety-guide';
  if (cluster === 'clu_app_profiles' && templateName === 'Definition') return 'app-profile';
  if (templateName === 'Comparison') return 'comparison';
  if (templateName === 'Brand Playlist') return 'brand-playlist';
  if (cluster === 'clu_actor_gallery' && templateName === 'Case Study') return 'actor-profile';
  if (['Reader Bridge', 'Topic Hub'].includes(templateName)) return 'reader-bridge';
  throw new Error(`unsupported DramaShortsTV content mapping: ${cluster || '(missing)'}/${templateName || '(missing)'}`);
}

export function normalizeDramaBrief(payload) {
  const rows = Object.entries(payload || {})
    .filter(([key, value]) => !key.startsWith('_') && value && typeof value === 'object' && !Array.isArray(value));
  if (rows.length !== 1) {
    throw new Error(`expected exactly one DramaShortsTV Sheet row, got ${rows.length}`);
  }
  const [, row] = rows[0];
  const required = {
    page_id: text(row.page_id),
    target_keyword: text(row.target_keyword),
    entity: text(row.entity),
    cluster_id: text(row.cluster_id),
    page_role: text(row.page_role),
    template: text(row.template),
    content_angle: text(row.content_angle),
  };
  for (const [name, value] of Object.entries(required)) {
    if (!value) throw new Error(`DramaShortsTV Sheet row missing required ${name}`);
  }
  if (!PAGE_ID_RE.test(required.page_id)) throw new Error(`unsafe page_id: ${required.page_id}`);

  const removedKeywordNotes = [];
  const associatedKeywords = (Array.isArray(row.associated_keywords) ? row.associated_keywords : [])
    .map(text)
    .filter((value) => {
      if (!isKeywordMetadata(value)) return true;
      if (value) removedKeywordNotes.push(value);
      return false;
    });
  const friction = extractTierGateField(row.tier_gate_block, 'Friction')
    || text(row.friction_themes?.[0]?.scrubbed_quote);
  const logic = extractTierGateField(row.tier_gate_block, 'Logic');
  if (!friction) throw new Error('DramaShortsTV Sheet row missing required Friction');
  if (!logic) throw new Error('DramaShortsTV Sheet row missing required Logic');

  return {
    pageId: required.page_id,
    contentType: contentTypeFor({ clusterId: required.cluster_id, template: required.template }),
    targetKeyword: required.target_keyword,
    associatedKeywords,
    entity: required.entity,
    friction,
    logic,
    contentAngle: required.content_angle,
    clusterId: required.cluster_id,
    pageRole: required.page_role,
    template: required.template,
    searchVolume: text(row.search_volume).replace(/^未找到$/u, ''),
    sourceRow: Number.parseInt(String(payload?._source?.slice || '').split('-')[0], 10) || null,
    notes: removedKeywordNotes,
  };
}

export function buildDramaPrompt({ brief, sopText }) {
  if (!brief || !TYPE_RULES[brief.contentType]) throw new Error('invalid normalized DramaShortsTV brief');
  if (!text(sopText)) throw new Error('DramaShortsTV SOP is empty');
  return [
    '# DramaShortsTV Document Authoring Task',
    '',
    'Create exactly one English Markdown document. The supplied SOP is authoritative for structure, safety, and QA.',
    'Do not generate or reference any hero or image asset. Do not publish to any website or write any publishing history.',
    'Do not output raw TBD/TODO placeholders. Put uncertain facts in a clearly labeled content-team note.',
    '',
    '## Authoritative SOP',
    '',
    String(sopText).trim(),
    '',
    `## Selected Content Type: ${TYPE_RULES[brief.contentType].label}`,
    '',
    '## Normalized Sheet Brief',
    '',
    '```json',
    JSON.stringify(brief, null, 2),
    '```',
    '',
    '## Output Contract',
    '',
    '- Return only the Markdown document, beginning with one H1.',
    '- Follow the selected SOP template and keep every prose paragraph at 60 words or fewer.',
    '- Include sources and content-team verification notes where facts can change.',
    '- Do not include frontmatter; the deterministic formatter adds it after QA.',
  ].join('\n');
}

export function validateDramaDraft({ markdown, contentType }) {
  const errors = [];
  const body = stripFrontmatter(markdown);
  const rule = TYPE_RULES[contentType];
  if (!rule) errors.push(`unsupported content type: ${contentType}`);
  const h1s = body.match(/^#\s+.+$/gm) || [];
  if (h1s.length !== 1) errors.push(`expected exactly one H1, got ${h1s.length}`);
  const h2s = body.match(/^##\s+.+$/gm) || [];
  if (h2s.length < 2) errors.push(`expected at least two H2 sections, got ${h2s.length}`);
  if (!/^\|.+\|$/m.test(body) && !/^[-*+]\s+\S/m.test(body) && !/^\d+[.)]\s+\S/m.test(body)) {
    errors.push('missing decision-support table or list');
  }
  if (PIRACY_RE.test(body)) errors.push('piracy-related term is forbidden');
  if (IMAGE_RE.test(body)) errors.push('image or media asset syntax is forbidden');
  if (PLACEHOLDER_RE.test(body)) errors.push('raw placeholder is forbidden');
  if (rule && !rule.marker.test(body)) errors.push(`missing ${rule.label} structure marker`);
  if (rule?.faq && !/^##\s+.*(?:FAQ|Frequently Asked|Questions)/im.test(body)) {
    errors.push(`${rule.label} requires a FAQ section`);
  }
  if (!/^##\s+.*(?:Sources|Content Team Notes)/im.test(body)) {
    errors.push('missing sources or content-team notes section');
  }
  for (const paragraph of proseParagraphs(body)) {
    const words = paragraph.split(/\s+/).filter(Boolean).length;
    if (words > 60) {
      errors.push(`prose paragraph exceeds 60 words (${words})`);
      break;
    }
    if (/\b\d[\d,.]*(?:%|[KMB]\+?)?\b/u.test(paragraph)
      && !/(?:according to|source|official|app[ -]store|Google Play|Apple|IMDb|Fandom|\]\(https?:\/\/)/iu.test(paragraph)) {
      errors.push('unsourced factual number in prose');
      break;
    }
  }
  const bodyLines = body.split('\n');
  for (let index = 0; index < bodyLines.length; index++) {
    if (/^###\s+.*\?\s*$/u.test(bodyLines[index]) && bodyLines[index + 1] !== '') {
      errors.push('FAQ question must be followed by a blank line before its answer');
      break;
    }
  }
  if (contentType === 'actor-profile') {
    const firstH1 = bodyLines.findIndex((line) => /^#\s+/.test(line));
    const nextHeading = bodyLines.findIndex((line, index) => index > firstH1 && /^##\s+/.test(line));
    const opening = bodyLines.slice(firstH1, nextHeading === -1 ? bodyLines.length : nextHeading).join(' ');
    if (!/ReelShort\s+actor/iu.test(opening)) errors.push('actor profile missing same-name qualifier "ReelShort actor" in H1/opening');
  }
  return { ok: errors.length === 0, errors };
}

export function formatDramaDocument({ draft, brief, date }) {
  if (!DATE_RE.test(String(date || ''))) throw new Error(`invalid document date: ${date}`);
  const body = stripFrontmatter(draft);
  const title = h1Title(body);
  if (!title) throw new Error('cannot format DramaShortsTV document without H1 title');
  const aliases = [...new Set([title, brief.entity].map(text).filter(Boolean))];
  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `date: ${date}`,
    `updated: ${date}`,
    'type: article',
    'status: draft',
    `target_keyword: ${yamlString(brief.targetKeyword)}`,
    `page_id: ${yamlString(brief.pageId)}`,
    'tags:',
    '  - dramashortstv',
    '  - blog',
    `  - ${brief.contentType}`,
    'aliases:',
    ...aliases.map((alias) => `  - ${yamlString(alias)}`),
    '---',
    '',
    body,
    '',
  ];
  return lines.join('\n');
}

export function resolveDramaOutputPath({ opsDir, date, topicSlug }) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!DATE_RE.test(String(date || ''))) throw new Error(`invalid output date: ${date}`);
  if (!SLUG_RE.test(String(topicSlug || ''))) throw new Error(`unsafe topic slug: ${topicSlug}`);
  const base = resolve(opsDir, DRAMA_OUTPUT_SUBDIR);
  const target = resolve(base, `${date}-dramashortstv-blog-${topicSlug}.md`);
  if (!target.startsWith(`${base}${sep}`) || !target.endsWith('.md')) {
    throw new Error(`unsafe DramaShortsTV output path: ${target}`);
  }
  return target;
}

export function atomicWriteDramaDocument({ targetPath, content }) {
  if (!targetPath || !targetPath.endsWith('.md')) throw new Error('targetPath must be a Markdown file');
  const bytes = String(content);
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath, 'utf8');
    if (current === bytes) return { status: 'unchanged' };
    throw new Error(`refusing to overwrite existing DramaShortsTV document: ${targetPath}`);
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = openSync(tempPath, 'wx', 0o644);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, targetPath);
    return { status: 'created' };
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}
