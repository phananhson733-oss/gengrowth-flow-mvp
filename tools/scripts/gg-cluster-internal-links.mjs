#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const START = '<!-- gg-cluster-links:start -->';
const END = '<!-- gg-cluster-links:end -->';

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

function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write('usage: --input <pages.json> --oracle <clean-oracle-dir> [--apply]\n');
    return;
  }
  if (typeof args.input !== 'string' || typeof args.oracle !== 'string') {
    throw new Error('--input and --oracle are required');
  }
  const oracleDir = resolve(args.oracle);
  const payload = JSON.parse(readFileSync(resolve(args.input), 'utf8'));
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
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`cluster internal links failed: ${String(error?.message || error)}\n`);
    process.exit(1);
  }
}
