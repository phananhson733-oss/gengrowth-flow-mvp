#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stateDir } from './lib/flow-state.mjs';
import { getAccessToken } from './lib/_oauth-token.mjs';
import {
  fetchTab,
  loadEnv,
  mapRowToBrief,
  resolvePageId,
} from './gg-sheet-pull.mjs';
import {
  buildClusterMap,
  buildCtaMap,
  composeOverride,
  CLUSTERS_TAB,
  CTA_TAB,
  PAGES_TAB,
} from './gg-sheet-to-brief.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(SCRIPT);
const FLOW = resolve(SCRIPTS, '../..');
const OPS = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const DEFAULT_CLAIMS = join(OPS, 'inbox/06-tasks/tasks/.autopilot-claims.json');
const DEFAULT_PUBLISH_LOG = join(OPS, 'inbox/06-tasks/seo-autopilot-publish-log.md');
const LIVE_BASE = 'https://www.astrologywiki.com/en/wiki/';
const SITEMAP = 'https://www.astrologywiki.com/sitemap.xml';

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function canonicalHref(html) {
  for (const tag of String(html || '').match(/<link\b[^>]*>/gi) || []) {
    const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (!rel.split(/\s+/).some((part) => part.toLowerCase() === 'canonical')) continue;
    return tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
  }
  return '';
}

function normalizedLink(value, base) {
  try {
    const parsed = new URL(String(value || '').replace(/&amp;/gi, '&'), base);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
    parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return parsed.toString();
  } catch {
    return '';
  }
}

function pageLinksTo(html, expected, base) {
  const target = normalizedLink(expected, base);
  if (!target) return false;
  for (const tag of String(html || '').match(/<a\b[^>]*>/gi) || []) {
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    if (normalizedLink(href, base) === target) return true;
  }
  return false;
}

function containsArticleType(value) {
  if (Array.isArray(value)) return value.some(containsArticleType);
  if (!value || typeof value !== 'object') return false;
  const type = value['@type'];
  if (type === 'Article' || (Array.isArray(type) && type.includes('Article'))) return true;
  return Object.values(value).some(containsArticleType);
}

function hasArticleJsonLd(html) {
  const scripts = String(html || '').matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try { if (containsArticleType(JSON.parse(match[1]))) return true; } catch { /* invalid JSON-LD fails this block */ }
  }
  return false;
}

export async function verifyRepairTarget(target, deps = {}) {
  if (target?.terminal === 'archived') {
    return {
      ok: true,
      terminal: 'archived',
      checks: { archive_evidence: Boolean(target.terminalReason) },
      reason: target.terminalReason || 'archived',
    };
  }

  const slug = target?.slug || deps.claim?.slug || '';
  const url = `${LIVE_BASE}${slug}`;
  const checks = {};
  checks.ledger_done = deps.claim?.status === 'done';
  checks.branch_and_merge = Boolean(deps.claim?.branch && deps.claim?.mergedAt);

  let page = { ok: false, status: 0, text: '' };
  let sitemap = { ok: false, status: 0, text: '' };
  try { page = await deps.fetchDocument(url); } catch { /* fail closed below */ }
  try { sitemap = await deps.fetchDocument(SITEMAP); } catch { /* fail closed below */ }
  checks.http_200 = page?.ok === true && page?.status === 200;
  checks.canonical = checks.http_200 && canonicalHref(page.text) === url;
  checks.article_jsonld = checks.http_200 && hasArticleJsonLd(page.text);
  checks.sitemap = sitemap?.ok === true && sitemap?.status === 200
    && new RegExp(`<loc>\\s*${escapeRegex(url)}\\s*</loc>`, 'i').test(sitemap.text || '');
  checks.plan_checked = new RegExp(`^\\s*-\\s*\\[x\\]\\s*\`?${escapeRegex(target.pageId)}\`?`, 'm')
    .test(deps.planText || '');
  checks.publish_log = String(deps.publishLogText || '').includes(target.pageId)
    && String(deps.publishLogText || '').includes(slug);
  const sheetUrl = deps.sheetRow?.publish_url || deps.sheetRow?.published_url || deps.sheetRow?.url || '';
  checks.sheet_published = deps.sheetRow?.status === '已发布' && String(sheetUrl).includes(slug);
  checks.cta_audit = Boolean(
    deps.ctaAudit?.cta_id
    && deps.ctaAudit?.cta_target_url
    && deps.ctaAudit?.cta_intent_tags
    && deps.ctaAudit?.cta_selection_reason,
  );
  checks.cta_matches_map = checks.http_200 && checks.cta_audit
    && pageLinksTo(page.text, deps.ctaAudit.cta_target_url, url);
  checks.writeback_clear = !deps.pendingWriteback;

  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  return {
    ok: failed.length === 0,
    terminal: failed.length ? 'pending' : 'published',
    checks,
    reason: failed.join(','),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--json') args.json = true;
    else if (key.startsWith('--')) args[key.slice(2)] = argv[++i];
  }
  return args;
}

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function pendingWriteback(pageId) {
  const base = stateDir();
  if (!base) return { pageId, error: 'flow-state unavailable' };
  const path = join(base, 'pending-writeback', `${String(pageId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  return existsSync(path) ? readJson(path, { pageId, error: 'pending writeback unreadable' }) : null;
}

function normalizeSheetRow(row) {
  const brief = row?.brief || row || {};
  return {
    page_id: row?.page_id || brief.page_id || '',
    target_keyword: brief.target_keyword || row?.target_keyword || '',
    status: brief.status || row?.status || '',
    publish_url: brief.publish_url || row?.publish_url || brief.published_url || row?.published_url || '',
    cta_target_url: brief.cta_target_url || row?.cta_target_url || '',
  };
}

function findSheetRow(target, rows) {
  const keyword = String(target.keyword || '').trim().toLowerCase();
  return (rows || []).map(normalizeSheetRow).find((row) =>
    row.page_id === target.pageId
    || (keyword && String(row.target_keyword).trim().toLowerCase() === keyword)
    || (target.slug && String(row.publish_url).includes(target.slug)),
  ) || null;
}

function sheetRowsFromRaw(pagesRaw) {
  if (!Array.isArray(pagesRaw) || pagesRaw.length < 2) return [];
  const header = pagesRaw[0];
  return pagesRaw.slice(1).map((row) => {
    const { brief } = mapRowToBrief(header, row || []);
    return { page_id: resolvePageId(brief, true), brief };
  });
}

function matchesTarget(target, row) {
  const targetKeyword = String(target.keyword || '').trim().toLowerCase();
  const rowKeyword = String(row?.brief?.target_keyword || '').trim().toLowerCase();
  return row?.page_id === target.pageId
    || (targetKeyword && targetKeyword === rowKeyword)
    || (target.slug && String(row?.brief?.publish_url || '').includes(target.slug));
}

export function deriveCtaAudits(targets, { pagesRaw, clustersRaw, ctaRaw, repo = FLOW }) {
  const clusterMap = buildClusterMap(clustersRaw || []);
  const ctaBuild = buildCtaMap(ctaRaw || []);
  const audits = {};
  for (const target of targets || []) {
    const row = sheetRowsFromRaw(pagesRaw).find((candidate) => matchesTarget(target, candidate));
    if (!row) continue;
    const result = composeOverride(row, {
      clusterMap,
      ctaMap: ctaBuild,
      ctaRegistry: ctaBuild.registry,
      repo,
      authorMap: new Map(),
    });
    if (!result.entry) continue;
    audits[target.pageId] = {
      cta_id: result.entry.cta_id,
      cta_target_url: result.entry.cta_target_url,
      cta_intent_tags: result.entry.cta_intent_tags,
      cta_selection_reason: result.entry.cta_selection_reason,
    };
  }
  return audits;
}

async function loadSheetContext(args, targets) {
  if (args['sheet-fixture']) {
    const fixture = readJson(args['sheet-fixture'], []);
    return {
      rows: fixture.rows || fixture,
      ctaAudits: fixture.ctaAudits || {},
    };
  }
  try {
    loadEnv();
    const workbookId = String(
      process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID
      || process.env.GG_SHEETS_WORKBOOK_ID
      || '',
    ).trim();
    if (!workbookId) return { rows: [], ctaAudits: {} };
    const token = await getAccessToken();
    const [pagesRaw, clustersRaw, ctaRaw] = await Promise.all([
      fetchTab(workbookId, PAGES_TAB, token),
      fetchTab(workbookId, CLUSTERS_TAB, token),
      fetchTab(workbookId, CTA_TAB, token),
    ]);
    return {
      rows: sheetRowsFromRaw(pagesRaw),
      ctaAudits: deriveCtaAudits(targets, { pagesRaw, clustersRaw, ctaRaw }),
    };
  } catch {
    return { rows: [], ctaAudits: {} };
  }
}

async function fetchDocument(url) {
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'gg-seo-repair-verify/1' },
      signal: AbortSignal.timeout(15000),
    });
    return { ok: response.ok, status: response.status, text: await response.text() };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.targets || !args.plan) {
    process.stderr.write('gg-seo-repair-verify: --targets and --plan are required\n');
    process.exit(2);
  }
  const targets = readJson(args.targets, null);
  if (!Array.isArray(targets)) {
    process.stderr.write('gg-seo-repair-verify: targets JSON must be an array\n');
    process.exit(2);
  }
  const claims = readJson(args.claims || DEFAULT_CLAIMS, {});
  const planText = readFileSync(args.plan, 'utf8');
  const publishLogText = existsSync(args['publish-log'] || DEFAULT_PUBLISH_LOG)
    ? readFileSync(args['publish-log'] || DEFAULT_PUBLISH_LOG, 'utf8')
    : '';
  const activeTargets = targets.filter((target) => target.terminal !== 'archived');
  const sheetContext = activeTargets.length
    ? await loadSheetContext(args, activeTargets)
    : { rows: [], ctaAudits: {} };
  const results = [];
  for (const target of targets) {
    const verified = await verifyRepairTarget(target, {
      claim: claims[target.pageId],
      planText,
      publishLogText,
      sheetRow: findSheetRow(target, sheetContext.rows),
      ctaAudit: sheetContext.ctaAudits[target.pageId],
      pendingWriteback: pendingWriteback(target.pageId),
      fetchDocument,
    });
    results.push({ pageId: target.pageId, slug: target.slug || claims[target.pageId]?.slug || '', ...verified });
  }
  const output = { ok: results.every((result) => result.ok), results };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(output.ok ? 0 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  await main();
}
