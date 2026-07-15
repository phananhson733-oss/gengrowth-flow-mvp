#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stateDir } from './lib/flow-state.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const SCRIPTS = dirname(SCRIPT);
const FLOW = resolve(SCRIPTS, '../..');
const OPS = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
const DEFAULT_CLAIMS = join(OPS, 'inbox/06-tasks/tasks/.autopilot-claims.json');
const DEFAULT_PUBLISH_LOG = join(OPS, 'inbox/06-tasks/seo-autopilot-publish-log.md');
const SHEET_PULL = join(SCRIPTS, 'gg-sheet-pull.mjs');
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

function loadSheetRows(args) {
  if (args['sheet-fixture']) {
    const fixture = readJson(args['sheet-fixture'], []);
    return fixture.rows || fixture;
  }
  const out = '.gg-cache/batches/seo-repair-verify-sheet.json';
  const result = spawnSync('node', [SHEET_PULL, '--rows', '2-1600', '--limit', '1700', '--out', out], {
    cwd: FLOW,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  const parsed = readJson(join(FLOW, out), []);
  return parsed.rows || parsed;
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
  const sheetRows = targets.some((target) => target.terminal !== 'archived') ? loadSheetRows(args) : [];
  const results = [];
  for (const target of targets) {
    const verified = await verifyRepairTarget(target, {
      claim: claims[target.pageId],
      planText,
      publishLogText,
      sheetRow: findSheetRow(target, sheetRows),
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
