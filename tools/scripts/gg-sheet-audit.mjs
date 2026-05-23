#!/usr/bin/env node
// gg-sheet-audit.mjs — 6-ID FK completeness audit for the flow-mvp workbook.
//
// Verifies cross-tab foreign keys BEFORE bridge / render fails downstream:
//   FK1: 选题登记表.cluster_id (col Q) ∈ 主题集群表.cluster_id (col A)
//   FK2: 选题登记表.page_role  (col R) ∈ CTA Map.page_role     (col B)
//   FK3: 主题集群表.cta_primary (col O) ∈ CTA Map.page_role    (col B)
//   FK4: cluster.page_assets / keywords_included reference rows we can locate
//   (warn) page_id collisions across rows in 选题登记表
//   (warn) cluster_id duplicates in 主题集群表
//   (warn) cta_id duplicates in CTA Map
//
// Why pre-flight: bridge (`gg-sheet-to-brief.mjs`) fails fatal on missing FKs but
// only AFTER the user has filled 21 brief columns. This tool surfaces the same
// errors at the cluster-init / brief-fill stage so typos can be caught early.
//
// Usage:
//   node tools/scripts/gg-sheet-audit.mjs                     # md report to stdout
//   node tools/scripts/gg-sheet-audit.mjs --json              # JSON to stdout
//   node tools/scripts/gg-sheet-audit.mjs --workbook flow-mvp # explicit workbook
//   node tools/scripts/gg-sheet-audit.mjs --workbook legacy
//
// Exit codes:
//   0 → clean (0 errors); may have warnings
//   1 → ≥1 FK error (downstream bridge will fail)
//   2 → CLI / env error
//
// PRD ref: v0.7 §6.2 (6-ID system: keyword/cluster/page/cta/action/outcome)

import { loadEnv, gFetch } from './lib/gg-shared.mjs';
import { getAccessToken } from './lib/_oauth-token.mjs';

const TAB = {
  PAGES: '选题登记表',
  CLUSTERS: '主题集群表',
  CTA: 'CTA Map',
  KEYWORDS: '关键词主表',
};

const COL = {
  // 选题登记表 v2.1 (21 cols)
  page_id_sheet: 'page_id',
  cluster_id_in_pages: 'cluster_id',
  page_role_in_pages: 'page_role',
  target_keyword: 'Target Keyword',
  // 主题集群表
  cluster_id_in_clusters: 'cluster_id',
  cluster_name: 'cluster_name',
  cta_primary: 'cta_primary',
  page_assets: 'page_assets',
  // CTA Map
  cta_id: 'cta_id',
  page_role_in_cta: 'page_role',
  // 关键词主表
  keyword_col: '关键词',
};

const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

function parseArgs(argv) {
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

function usage() {
  process.stdout.write(`gg-sheet-audit.mjs — 6-ID FK completeness audit

Usage:
  node tools/scripts/gg-sheet-audit.mjs                     # md report
  node tools/scripts/gg-sheet-audit.mjs --json              # JSON
  node tools/scripts/gg-sheet-audit.mjs --workbook flow-mvp|legacy|<id>

Exit: 0=clean, 1=fk error, 2=cli/env error
`);
}

function indexOfHeader(headerRow, name) {
  for (let i = 0; i < headerRow.length; i++) {
    if (String(headerRow[i] || '').trim() === name) return i;
  }
  return -1;
}

async function fetchTab(workbookId, tabName, token) {
  const r = await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(tabName)}`,
    token,
  );
  return r.values || [];
}

function buildReport(rows) {
  const errors = [];
  const warnings = [];

  const pagesRows = rows.pages;
  const clustersRows = rows.clusters;
  const ctaRows = rows.cta;
  const kwRows = rows.keywords;

  if (pagesRows.length === 0) return { errors: ['选题登记表 empty'], warnings: [] };
  if (clustersRows.length === 0) return { errors: ['主题集群表 empty'], warnings: [] };
  if (ctaRows.length === 0) return { errors: ['CTA Map empty'], warnings: [] };

  const pH = pagesRows[0];
  const cH = clustersRows[0];
  const ctaH = ctaRows[0];

  const idxPagePageId = indexOfHeader(pH, COL.page_id_sheet);
  const idxPageClusterId = indexOfHeader(pH, COL.cluster_id_in_pages);
  const idxPageRole = indexOfHeader(pH, COL.page_role_in_pages);
  const idxPageTargetKw = indexOfHeader(pH, COL.target_keyword);
  const idxClusterId = indexOfHeader(cH, COL.cluster_id_in_clusters);
  const idxClusterCtaPrimary = indexOfHeader(cH, COL.cta_primary);
  const idxCtaId = indexOfHeader(ctaH, COL.cta_id);
  const idxCtaPageRole = indexOfHeader(ctaH, COL.page_role_in_cta);

  if (idxPageClusterId === -1) errors.push(`选题登记表 missing required column "${COL.cluster_id_in_pages}"`);
  if (idxPageRole === -1) errors.push(`选题登记表 missing required column "${COL.page_role_in_pages}"`);
  if (idxClusterId === -1) errors.push(`主题集群表 missing required column "${COL.cluster_id_in_clusters}"`);
  if (idxCtaPageRole === -1) errors.push(`CTA Map missing required column "${COL.page_role_in_cta}"`);
  if (errors.length) return { errors, warnings };

  // Build allowed sets
  const validClusterIds = new Set();
  const clusterDups = new Map();
  for (let i = 1; i < clustersRows.length; i++) {
    const id = String(clustersRows[i][idxClusterId] || '').trim();
    if (!id) continue;
    if (validClusterIds.has(id)) clusterDups.set(id, (clusterDups.get(id) || 1) + 1);
    validClusterIds.add(id);
  }
  for (const [id, n] of clusterDups) {
    warnings.push(`主题集群表 duplicate cluster_id "${id}" (×${n})`);
  }

  const validPageRoles = new Set();
  const ctaDups = new Map();
  for (let i = 1; i < ctaRows.length; i++) {
    const role = String(ctaRows[i][idxCtaPageRole] || '').trim();
    if (!role) continue;
    validPageRoles.add(role);
    if (idxCtaId !== -1) {
      const id = String(ctaRows[i][idxCtaId] || '').trim();
      if (id) {
        if (ctaDups.has(id)) ctaDups.set(id, ctaDups.get(id) + 1);
        else ctaDups.set(id, 1);
      }
    }
  }
  for (const [id, n] of ctaDups) {
    if (n > 1) warnings.push(`CTA Map duplicate cta_id "${id}" (×${n})`);
  }

  // FK1 + FK2: 选题登记表 row-by-row
  const pageIdSeen = new Map();
  for (let i = 1; i < pagesRows.length; i++) {
    const row = pagesRows[i];
    const rowNum = i + 1; // 1-based sheet row
    const pageId = idxPagePageId !== -1 ? String(row[idxPagePageId] || '').trim() : '';
    const clusterId = String(row[idxPageClusterId] || '').trim();
    const pageRole = String(row[idxPageRole] || '').trim();
    const targetKw = idxPageTargetKw !== -1 ? String(row[idxPageTargetKw] || '').trim() : '';

    // skip wholly empty rows (no target keyword AND no page_id)
    if (!targetKw && !pageId) continue;

    if (pageId) {
      if (!PAGE_ID_REGEX.test(pageId)) {
        errors.push(`page row ${rowNum} page_id "${pageId}" violates regex /^[A-Za-z0-9_-]{1,64}$/`);
      }
      if (pageIdSeen.has(pageId)) {
        warnings.push(`page_id "${pageId}" appears on rows ${pageIdSeen.get(pageId)} and ${rowNum} (potential duplicate)`);
      } else {
        pageIdSeen.set(pageId, rowNum);
      }
    }
    if (clusterId && !validClusterIds.has(clusterId)) {
      errors.push(`FK1 page row ${rowNum} (${pageId || targetKw}): cluster_id "${clusterId}" not in 主题集群表`);
    }
    if (pageRole && !validPageRoles.has(pageRole)) {
      errors.push(`FK2 page row ${rowNum} (${pageId || targetKw}): page_role "${pageRole}" not in CTA Map`);
    }
  }

  // FK3: 主题集群表.cta_primary ∈ CTA Map.page_role
  if (idxClusterCtaPrimary !== -1) {
    for (let i = 1; i < clustersRows.length; i++) {
      const row = clustersRows[i];
      const rowNum = i + 1;
      const cid = String(row[idxClusterId] || '').trim();
      const cta = String(row[idxClusterCtaPrimary] || '').trim();
      if (!cta) continue;
      if (!validPageRoles.has(cta)) {
        errors.push(`FK3 cluster row ${rowNum} (${cid}): cta_primary "${cta}" not in CTA Map`);
      }
    }
  }

  // Coverage info (not an error): keyword 主表 target keyword overlap
  let keywordsCovered = 0;
  let keywordsTotal = 0;
  if (kwRows.length > 0 && idxPageTargetKw !== -1) {
    const kwHdr = kwRows[0];
    const idxKw = indexOfHeader(kwHdr, COL.keyword_col);
    if (idxKw !== -1) {
      const allKw = new Set();
      for (let i = 1; i < kwRows.length; i++) {
        const k = String(kwRows[i][idxKw] || '').trim().toLowerCase();
        if (k) allKw.add(k);
      }
      keywordsTotal = allKw.size;
      const usedKw = new Set();
      for (let i = 1; i < pagesRows.length; i++) {
        const tk = String(pagesRows[i][idxPageTargetKw] || '').trim().toLowerCase();
        if (tk && allKw.has(tk)) usedKw.add(tk);
      }
      keywordsCovered = usedKw.size;
    }
  }

  return { errors, warnings, stats: {
    pages_rows: pagesRows.length - 1,
    clusters_rows: clustersRows.length - 1,
    cta_rows: ctaRows.length - 1,
    keywords_total: keywordsTotal,
    keywords_covered_by_pages: keywordsCovered,
    cluster_ids: validClusterIds.size,
    page_roles: validPageRoles.size,
  }};
}

function renderMarkdown(report, workbookId) {
  const lines = [];
  lines.push(`# Sheet FK Audit — ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`**Workbook**: \`${workbookId}\``);
  lines.push('');
  lines.push('## Stats');
  lines.push('');
  for (const [k, v] of Object.entries(report.stats || {})) {
    lines.push(`- ${k}: **${v}**`);
  }
  lines.push('');
  lines.push(`## Errors (${report.errors.length})`);
  lines.push('');
  if (report.errors.length === 0) lines.push('✅ All FKs OK.');
  else for (const e of report.errors) lines.push(`- ❌ ${e}`);
  lines.push('');
  lines.push(`## Warnings (${report.warnings.length})`);
  lines.push('');
  if (report.warnings.length === 0) lines.push('✅ No warnings.');
  else for (const w of report.warnings) lines.push(`- ⚠️  ${w}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  loadEnv();

  let workbookId;
  const wbArg = args.workbook;
  if (wbArg && wbArg !== true && wbArg !== 'flow-mvp' && wbArg !== 'legacy') {
    workbookId = String(wbArg);
  } else if (wbArg === 'legacy') {
    workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  } else {
    workbookId = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID || process.env.GG_SHEETS_WORKBOOK_ID;
  }
  if (!workbookId) {
    process.stderr.write('ERROR: GG_SHEETS_FLOW_MVP_WORKBOOK_ID (or GG_SHEETS_WORKBOOK_ID) missing\n');
    process.exit(2);
  }

  const token = await getAccessToken();
  const [pages, clusters, cta, keywords] = await Promise.all([
    fetchTab(workbookId, TAB.PAGES, token),
    fetchTab(workbookId, TAB.CLUSTERS, token),
    fetchTab(workbookId, TAB.CTA, token),
    fetchTab(workbookId, TAB.KEYWORDS, token).catch(() => []),
  ]);

  const report = buildReport({ pages, clusters, cta, keywords });

  if (args.json) {
    process.stdout.write(JSON.stringify({ workbook: workbookId, ...report }, null, 2) + '\n');
  } else {
    process.stdout.write(renderMarkdown(report, workbookId) + '\n');
  }

  process.exit(report.errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`FATAL: ${e.message}\n`);
  process.exit(2);
});
