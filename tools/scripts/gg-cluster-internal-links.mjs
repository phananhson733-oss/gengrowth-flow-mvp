#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getAccessToken } from './lib/_oauth-token.mjs';
import { CLUSTERS_TAB, DEFAULT_TAB, fetchTab, loadEnv } from './gg-sheet-pull.mjs';

const START = '<!-- gg-cluster-links:start -->';
const END = '<!-- gg-cluster-links:end -->';
const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function text(value) {
  return String(value || '').trim();
}

function role(value) {
  const normalized = text(value).toLowerCase();
  return /^(hub|pillar)$/.test(normalized) ? 'hub' : 'spoke';
}

function published(value) {
  return value === true || /^(published|live|done|已发布)$/i.test(text(value));
}

function validPage(page) {
  return text(page?.page_id) && text(page?.cluster_id) && text(page?.slug) && text(page?.title) && published(page?.published);
}

function stablePages(items) {
  return [...items].sort((a, b) => text(a.page_id).localeCompare(text(b.page_id)));
}

export function validateClusterLinkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('cluster link input must be an object');
  }
  if (input.version !== 1) throw new Error('cluster link input version must be 1');
  if (!SNAPSHOT_ID_RE.test(text(input.snapshot_id))) {
    throw new Error('cluster link input snapshot_id must be a sha256');
  }
  if (!Array.isArray(input.approved_cluster_ids) || !input.approved_cluster_ids.length) {
    throw new Error('cluster link input approved_cluster_ids are required');
  }
  if (!Array.isArray(input.pages)) throw new Error('cluster link input pages are required');
  const approved = new Set(input.approved_cluster_ids.map(text).filter(Boolean));
  if (approved.size !== input.approved_cluster_ids.length) {
    throw new Error('cluster link input approved_cluster_ids must be unique and non-empty');
  }
  const pageIds = new Set();
  const slugs = new Set();
  for (const page of input.pages) {
    const pageId = text(page?.page_id);
    const clusterId = text(page?.cluster_id);
    const slug = text(page?.slug);
    if (!pageId) throw new Error('cluster link input page_id is required');
    if (pageIds.has(pageId)) throw new Error(`duplicate page_id ${pageId}`);
    pageIds.add(pageId);
    if (!approved.has(clusterId)) throw new Error(`${pageId} has unapproved cluster_id "${clusterId}"`);
    if (!SLUG_RE.test(slug)) throw new Error(`${pageId} has invalid slug "${slug}"`);
    if (slugs.has(slug)) throw new Error(`duplicate slug ${slug}`);
    slugs.add(slug);
    if (!text(page?.title)) throw new Error(`${pageId} title is required`);
    if (!published(page?.published)) throw new Error(`${pageId} is not published`);
  }
  return input;
}

function columnIndex(header, name) {
  return (header || []).findIndex((cell) => text(cell) === name);
}

function approvedClusterIds(clustersRaw) {
  if (!Array.isArray(clustersRaw) || !Array.isArray(clustersRaw[0])) {
    throw new Error('canonical Cluster rows are required');
  }
  const clusterIndex = columnIndex(clustersRaw[0], 'cluster_id');
  if (clusterIndex < 0) throw new Error('canonical Cluster rows are missing cluster_id');
  const ids = [];
  const rowsById = new Map();
  for (const [index, row] of clustersRaw.slice(1).entries()) {
    const id = text(row?.[clusterIndex]);
    if (!id) continue;
    if (!rowsById.has(id)) rowsById.set(id, []);
    rowsById.get(id).push(index + 2);
    ids.push(id);
  }
  const duplicates = [...rowsById.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([id, rows]) => `${id} (rows ${rows.join(', ')})`)
    .sort();
  if (duplicates.length) throw new Error(`canonical Cluster rows have duplicate cluster_id: ${duplicates.join('; ')}`);
  if (!ids.length) throw new Error('canonical Cluster rows have no approved cluster_id');
  return [...rowsById.keys()].sort();
}

export function buildClusterLinkInput({ pagesRaw, clustersRaw, publishedArticles }) {
  if (!Array.isArray(pagesRaw) || !Array.isArray(pagesRaw[0])) {
    throw new Error('canonical Pages rows are required');
  }
  if (!Array.isArray(publishedArticles)) throw new Error('published articles are required');
  const approved = approvedClusterIds(clustersRaw);
  const approvedSet = new Set(approved);
  const header = pagesRaw[0];
  const indexes = {
    page_id: columnIndex(header, 'page_id'),
    cluster_id: columnIndex(header, 'cluster_id'),
    page_role: columnIndex(header, 'page_role'),
    title: columnIndex(header, 'Target Keyword'),
  };
  for (const [field, index] of Object.entries(indexes)) {
    if (index < 0) throw new Error(`canonical Pages rows are missing ${field}`);
  }
  const publishedById = new Map();
  for (const article of publishedArticles) {
    const pageId = text(article?.page_id);
    if (!pageId || !SLUG_RE.test(text(article?.slug)) || !text(article?.title)) {
      throw new Error('published article requires page_id, valid slug, and title');
    }
    if (publishedById.has(pageId)) throw new Error(`published articles have duplicate page_id ${pageId}`);
    publishedById.set(pageId, article);
  }
  const pages = [];
  const found = new Set();
  for (const row of pagesRaw.slice(1)) {
    const pageId = text(row?.[indexes.page_id]);
    if (!pageId || !publishedById.has(pageId)) continue;
    if (found.has(pageId)) throw new Error(`canonical Pages rows have duplicate page_id ${pageId}`);
    found.add(pageId);
    const clusterId = text(row?.[indexes.cluster_id]);
    if (!clusterId) throw new Error(`${pageId} has missing cluster_id`);
    if (!approvedSet.has(clusterId)) throw new Error(`${pageId} has unknown cluster_id "${clusterId}"`);
    const article = publishedById.get(pageId);
    pages.push({
      page_id: pageId,
      cluster_id: clusterId,
      page_role: text(row?.[indexes.page_role]),
      slug: text(article.slug),
      title: text(article.title),
      published: true,
    });
  }
  for (const pageId of publishedById.keys()) {
    if (!found.has(pageId)) throw new Error(`published ${pageId} is missing from canonical Pages rows`);
  }
  pages.sort((a, b) => a.page_id.localeCompare(b.page_id));
  const snapshot = {
    version: 1,
    approved_cluster_ids: approved,
    pages,
  };
  const snapshot_id = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return validateClusterLinkInput({ ...snapshot, snapshot_id });
}

export function parsePublishedArticleLog(markdown) {
  const records = [];
  const seen = new Set();
  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (!/^\|/.test(line) || !/\|\s*$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => text(cell));
    if (cells.length < 7 || text(cells[1]).toLowerCase() === 'pg-id') continue;
    const [,, slug, title,,, status] = cells;
    const page_id = text(cells[1]);
    if (!/^(published|live|已发布)$/i.test(status)) continue;
    if (!page_id || !SLUG_RE.test(slug) || !title) {
      throw new Error('published register row requires page_id, valid slug, and title');
    }
    if (seen.has(page_id)) throw new Error(`duplicate published page_id ${page_id}`);
    seen.add(page_id);
    records.push({ page_id, slug, title });
  }
  return records.sort((a, b) => a.page_id.localeCompare(b.page_id));
}

function englishWikiSlug(pathname) {
  const match = text(pathname).match(/^\/en\/wiki\/([a-z0-9][a-z0-9-]*)$/);
  return match ? match[1] : '';
}

function permanentEnglishRedirects(oracleDir) {
  const config = join(oracleDir, 'vercel.json');
  if (!existsSync(config)) return new Map();
  let redirects;
  try {
    redirects = JSON.parse(readFileSync(config, 'utf8')).redirects;
  } catch {
    throw new Error('Oracle vercel.json is not valid JSON');
  }
  if (redirects === undefined) return new Map();
  if (!Array.isArray(redirects)) throw new Error('Oracle vercel.json redirects must be an array');
  const aliases = new Map();
  for (const redirect of redirects) {
    if (redirect?.permanent !== true) continue;
    const source = englishWikiSlug(redirect.source);
    const destination = englishWikiSlug(redirect.destination);
    if (!source || !destination || source === destination) continue;
    if (aliases.has(source) && aliases.get(source) !== destination) {
      throw new Error(`Oracle permanent redirect is ambiguous for slug ${source}`);
    }
    aliases.set(source, destination);
  }
  return aliases;
}

export function resolveOraclePublishedArticles(oracleDir, articles) {
  const aliases = permanentEnglishRedirects(oracleDir);
  return articles.map((article) => {
    const seen = new Set();
    let slug = text(article?.slug);
    while (aliases.has(slug)) {
      if (seen.has(slug)) throw new Error(`Oracle permanent redirect cycle for slug ${slug}`);
      seen.add(slug);
      slug = aliases.get(slug);
    }
    return { ...article, slug };
  });
}

export async function readCanonicalClusterRows({ readRows = null } = {}) {
  let reader = readRows;
  if (!reader) {
    loadEnv();
    const workbookId = text(process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID)
      || text(process.env.GG_SHEETS_WORKBOOK_ID);
    if (!workbookId) throw new Error('canonical workbook id is missing');
    const token = await getAccessToken();
    reader = (tab) => fetchTab(workbookId, tab, token);
  }
  const [pagesRaw, clustersRaw] = await Promise.all([
    reader(DEFAULT_TAB),
    reader(CLUSTERS_TAB),
  ]);
  return { pagesRaw, clustersRaw };
}

export function buildClusterLinkPlan(pages, { maxHubLinks = 3, maxSiblingLinks = 2 } = {}) {
  const groups = new Map();
  for (const page of pages || []) {
    if (!validPage(page)) continue;
    const clusterId = text(page.cluster_id);
    if (!groups.has(clusterId)) groups.set(clusterId, []);
    groups.get(clusterId).push(page);
  }
  const result = new Map();
  for (const members of groups.values()) {
    const ordered = stablePages(members);
    const hubs = ordered.filter((page) => role(page.page_role) === 'hub');
    const spokes = ordered.filter((page) => role(page.page_role) !== 'hub');
    for (const source of ordered) {
      let targets;
      if (hubs.length) {
        targets = role(source.page_role) === 'hub'
          ? spokes.slice(0, maxHubLinks)
          : hubs.slice(0, 1);
      } else {
        targets = ordered.filter((candidate) => candidate.page_id !== source.page_id).slice(0, maxSiblingLinks);
      }
      const unique = [];
      const slugs = new Set();
      for (const target of targets) {
        if (target.page_id === source.page_id || slugs.has(target.slug)) continue;
        slugs.add(target.slug);
        unique.push({ page_id: target.page_id, slug: target.slug, title: target.title });
      }
      if (unique.length) result.set(source.page_id, unique);
    }
  }
  return result;
}

export function renderManagedClusterLinks(links) {
  const normalized = (links || [])
    .filter((link) => text(link?.slug) && text(link?.title))
    .map((link) => `- [${text(link.title)}](/en/wiki/${text(link.slug)})`);
  if (!normalized.length) return '';
  return `${START}\n${normalized.join('\n')}\n${END}`;
}

export function replaceManagedClusterLinks(content, links) {
  const managed = renderManagedClusterLinks(links);
  let next = String(content || '').replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, 'g'), '\n');
  if (!managed) return next;
  const heading = /^## Related Reading\s*\n*/m;
  if (heading.test(next)) return next.replace(heading, () => `## Related Reading\n\n${managed}\n`);
  return `${next.replace(/\s*$/, '')}\n\n## Related Reading\n\n${managed}\n`;
}

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const name = key.slice(2).replace(/-/g, '_');
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) out[name] = true;
    else { out[name] = value; index += 1; }
  }
  return out;
}

function assertCleanOracle(oracleDir) {
  const status = execFileSync('git', ['-C', oracleDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
  if (status) throw new Error('Oracle baseline is dirty; refuse article link backfill');
}

export function assertRegisteredOracleArticles(oracleDir, articles) {
  const index = join(oracleDir, 'data', 'articles', 'index.ts');
  if (!existsSync(index)) throw new Error('Oracle article index is missing');
  const source = readFileSync(index, 'utf8');
  for (const article of articles) {
    const file = join(oracleDir, 'data', 'articles', `${article.slug}.ts`);
    if (!existsSync(file)) throw new Error(`${article.page_id} has no registered Oracle article file`);
    if (!source.includes(`from "./${article.slug}"`) && !source.includes(`from './${article.slug}'`)) {
      throw new Error(`${article.page_id} is not registered in Oracle article index`);
    }
  }
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write('usage: --input <attested-pages.json> --oracle <clean-oracle-dir> [--apply]\n');
    process.stdout.write('       --build-input --published-log <publish-log.md> --oracle <oracle-dir> --out <attested-pages.json>\n');
    return;
  }
  if (args.build_input) {
    if (typeof args.published_log !== 'string' || typeof args.oracle !== 'string' || typeof args.out !== 'string') {
      throw new Error('--build-input requires --published-log, --oracle, and --out');
    }
    const oracleDir = resolve(args.oracle);
    const publishedArticles = resolveOraclePublishedArticles(
      oracleDir,
      parsePublishedArticleLog(readFileSync(resolve(args.published_log), 'utf8')),
    );
    assertRegisteredOracleArticles(oracleDir, publishedArticles);
    const { pagesRaw, clustersRaw } = await readCanonicalClusterRows();
    const input = buildClusterLinkInput({ pagesRaw, clustersRaw, publishedArticles });
    const out = resolve(args.out);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(input, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ built_input: true, snapshot_id: input.snapshot_id, page_ids: input.pages.map((page) => page.page_id) })}\n`);
    return;
  }
  if (typeof args.input !== 'string' || typeof args.oracle !== 'string') {
    throw new Error('--input and --oracle are required');
  }
  const oracleDir = resolve(args.oracle);
  const payload = validateClusterLinkInput(JSON.parse(readFileSync(resolve(args.input), 'utf8')));
  assertRegisteredOracleArticles(oracleDir, payload.pages);
  const plan = buildClusterLinkPlan(payload.pages);
  const changes = [];
  for (const page of payload.pages || []) {
    const links = plan.get(page.page_id);
    if (!links) continue;
    const file = join(oracleDir, 'data', 'articles', `${page.slug}.ts`);
    if (!existsSync(file)) continue;
    const before = readFileSync(file, 'utf8');
    const after = replaceManagedClusterLinks(before, links);
    if (after !== before) changes.push({ page_id: page.page_id, file, after });
  }
  if (args.apply) {
    assertCleanOracle(oracleDir);
    for (const change of changes) writeFileSync(change.file, change.after);
  }
  process.stdout.write(`${JSON.stringify({ applied: Boolean(args.apply), changed: changes.map((change) => change.page_id) })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`cluster internal links failed: ${String(error?.message || error)}\n`);
    process.exit(1);
  });
}
