#!/usr/bin/env node
// gg-classify-unsorted.mjs — embedding-based classifier for heterogeneous buckets.
//
// Routes the ind-001 (71-word unassigned) and ind-002 (50-word "astrology 其它")
// buckets documented in docs/CLUSTER_AUDIT_2026-05-23.md §九 into the existing
// fam-* / ind-* publishable units using OpenAI text-embedding-3-small + cosine
// similarity. Reuses the embedding + cache infrastructure from gg-cluster-init.mjs.
//
// Cost: ~$0.00003 per pass (475 words × ~3 tokens × $0.020/1M).
//
// env required:
//   OPENAI_API_KEY  (fail-loud; never logged)
//   GG_SHEETS_FLOW_MVP_WORKBOOK_ID  +  ~/.config/gg/gg-writer-sa.json

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

// Dynamic imports inside main() so this module is safe to import for unit tests
// without triggering gg-cluster-init.mjs's CLI-arg side effects. Tests that need
// l2normalize / cosDist / embedWords can call await loadDeps() first.
let getAccessToken, gFetch, loadEnv, embedWords, l2normalize, cosDist;

async function loadDeps() {
  if (cosDist) return;
  ({ getAccessToken, gFetch, loadEnv } = await import('./lib/gg-shared.mjs'));
  ({ embedWords, l2normalize, cosDist } = await import('./gg-cluster-init.mjs'));
}

const CLUSTER_SHEET = '主题集群表';
const SUGGEST_DIR = join(process.cwd(), '.gg-cache', 'classify-suggestions');

function parseCliArgs(argv) {
  const has = (f) => argv.includes(f);
  const arg = (f, def = null) => (has(f) ? argv[argv.indexOf(f) + 1] : def);
  if (has('--help') || has('-h')) {
    console.log(`gg-classify-unsorted.mjs — route ind-001 / ind-002 words into existing clusters via embeddings

  --target X              ind-001 | ind-002 | both   (required)
  --cosine-threshold X    similarity cutoff for auto-assign (default 0.55)
  --dry-run               compute + write JSON only (default; safe)
  --write-sheet           apply: append words to target cluster L col, remove from source bucket
  --write-file            write JSON to .gg-cache/classify-suggestions/<target>.json (default ON)
  --embed-model X         embedding model (default text-embedding-3-small)
  --workbook X            flow-mvp (default) | legacy | <sheet-id>
`);
    process.exit(0);
  }
  const TARGET = arg('--target', null);
  if (!TARGET || !['ind-001', 'ind-002', 'both'].includes(TARGET)) {
    console.error('ERR: --target must be one of: ind-001, ind-002, both');
    process.exit(2);
  }
  const COSINE_THRESHOLD = parseFloat(arg('--cosine-threshold', '0.55'));
  if (!Number.isFinite(COSINE_THRESHOLD) || COSINE_THRESHOLD <= 0 || COSINE_THRESHOLD >= 1) {
    console.error(`ERR: --cosine-threshold must be in (0, 1), got ${COSINE_THRESHOLD}`);
    process.exit(2);
  }
  const EMBED_BACKEND = arg(
    '--embed-backend',
    process.env.OPENAI_API_KEY ? 'openai' : 'ollama',
  );
  const DEFAULT_MODEL_BY_BACKEND = {
    openai: 'text-embedding-3-small',
    ollama: 'nomic-embed-text',
  };
  return {
    TARGET,
    COSINE_THRESHOLD,
    WRITE_SHEET: has('--write-sheet'),
    DRY_RUN: !has('--write-sheet') || has('--dry-run'),
    WRITE_FILE: true,
    EMBED_BACKEND,
    EMBED_MODEL: arg('--embed-model', DEFAULT_MODEL_BY_BACKEND[EMBED_BACKEND] || 'nomic-embed-text'),
    OLLAMA_HOST: arg('--ollama-host', process.env.OLLAMA_HOST || 'http://localhost:11434'),
    WORKBOOK: arg('--workbook', 'flow-mvp'),
  };
}

// ============================================================ sheet io
async function fetchValues(token, sid, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE`;
  return ((await gFetch(url, token)).values) || [];
}

async function updateValues(token, sid, range, values, valueInputOption = 'RAW') {
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
    token,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    },
  );
}

// Load all clusters; returns [{ rowIndex (1-based sheet row), cluster_id, cluster_name, keywords[] }]
async function loadClusters(token, sid) {
  const rows = await fetchValues(token, sid, `${CLUSTER_SHEET}!A2:L1500`);
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const cluster_id = (r[0] || '').toString().trim();
    if (!cluster_id) continue;
    const cluster_name = (r[1] || '').toString().trim();
    const keywords = (r[11] || '')
      .toString()
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    out.push({ rowIndex: i + 2, cluster_id, cluster_name, keywords });
  }
  return out;
}

// ============================================================ centroid + cosine

// Mean of L2-normed vectors, re-normalized (spherical centroid).
function meanCentroidNormed(normedVecs) {
  if (!normedVecs.length) return null;
  const dim = normedVecs[0].length;
  const acc = new Array(dim).fill(0);
  for (const v of normedVecs) for (let i = 0; i < dim; i++) acc[i] += v[i];
  for (let i = 0; i < dim; i++) acc[i] /= normedVecs.length;
  return l2normalize(acc);
}

// Cosine SIMILARITY in [-1,1] for L2-normed vectors (gg-cluster-init exposes cosDist).
function cosSim(a, b) { return 1 - cosDist(a, b); }

// ============================================================ classification

// Build a centroid for every cluster not in sourceIds. Small ind- clusters (1-2 words)
// are kept as valid targets so e.g. ind-013 full-moon can still receive matches.
async function buildClusterCentroids(clusters, sourceIds, embedOpts) {
  const dests = clusters.filter((c) => !sourceIds.includes(c.cluster_id) && c.keywords.length >= 1);
  // Dedupe keywords across all destination clusters.
  const seen = new Set();
  const flat = [];
  for (const c of dests) {
    for (const k of c.keywords) {
      if (!seen.has(k)) { seen.add(k); flat.push(k); }
    }
  }
  console.log(`  embedding ${flat.length} unique destination keywords across ${dests.length} clusters via ${embedOpts.backend}/${embedOpts.model}...`);
  const { vectors, tokensUsed, cacheHits, apiCalls, totalMissing } = await embedWords(flat, embedOpts);
  console.log(`  embed done: cache=${cacheHits}/${flat.length}  api=${apiCalls} calls (${totalMissing} new), tokens=${tokensUsed}`);

  // Map keyword → normed vec.
  const vecByKw = new Map();
  for (let i = 0; i < flat.length; i++) vecByKw.set(flat[i], l2normalize(vectors[i]));

  const centroids = [];
  for (const c of dests) {
    const memberVecs = c.keywords.map((k) => vecByKw.get(k)).filter(Boolean);
    if (!memberVecs.length) continue;
    centroids.push({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      vec: meanCentroidNormed(memberVecs),
      size: c.keywords.length,
      rowIndex: c.rowIndex,
    });
  }
  return { centroids, embedStats: { tokensUsed, cacheHits, apiCalls, totalMissing, vocab: flat.length } };
}

// For each word, route to nearest centroid if sim ≥ threshold; else flag needs_new_cluster.
// Returns { suggestions, needs_new_cluster, perClusterCount } (perClusterCount used for over-broad detection).
async function classifyWords(words, centroids, threshold, embedOpts) {
  console.log(`  embedding ${words.length} bucket words via ${embedOpts.backend}/${embedOpts.model}...`);
  const { vectors, tokensUsed, cacheHits, apiCalls, totalMissing } = await embedWords(words, embedOpts);
  console.log(`  embed done: cache=${cacheHits}/${words.length}  api=${apiCalls} calls (${totalMissing} new), tokens=${tokensUsed}`);

  const suggestions = [];
  const needs_new_cluster = [];
  const perClusterCount = new Map();

  for (let i = 0; i < words.length; i++) {
    const v = l2normalize(vectors[i]);
    const scores = centroids.map((c) => ({
      cluster_id: c.cluster_id,
      cluster_name: c.cluster_name,
      sim: cosSim(v, c.vec),
    }));
    scores.sort((a, b) => b.sim - a.sim);
    const top3 = scores.slice(0, 3).map((s) => ({
      cluster: s.cluster_id,
      cluster_name: s.cluster_name,
      sim: Number(s.sim.toFixed(4)),
    }));
    const best = top3[0];
    if (best && best.sim >= threshold) {
      suggestions.push({
        word: words[i],
        target_cluster: best.cluster,
        target_cluster_name: best.cluster_name,
        sim: best.sim,
        top3,
      });
      perClusterCount.set(best.cluster, (perClusterCount.get(best.cluster) || 0) + 1);
    } else {
      needs_new_cluster.push({ word: words[i], top3 });
    }
  }
  return {
    suggestions,
    needs_new_cluster,
    perClusterCount,
    embedStats: { tokensUsed, cacheHits, apiCalls, totalMissing },
  };
}

// ============================================================ sheet writeback
//
// Schema: L col is '\n'-separated (matches gg-cluster-init.mjs:666 +
// gg-cluster-fields-suggest.mjs:272). We preserve that convention. Only L col
// is touched — A (cluster_id), B (name), and business cols C-K/M-S are left alone.
// valueInputOption=RAW so multi-line strings and any commas survive intact.
async function writeBackToSheet(token, sid, clusters, suggestions, sourceId) {
  const source = clusters.find((c) => c.cluster_id === sourceId);
  if (!source) throw new Error(`source cluster ${sourceId} not found on sheet`);

  // Build target → new-words map.
  const additions = new Map();
  const moved = new Set();
  for (const s of suggestions) {
    if (!additions.has(s.target_cluster)) additions.set(s.target_cluster, []);
    additions.get(s.target_cluster).push(s.word);
    moved.add(s.word);
  }

  // Update each target cluster's L column.
  let updates = 0;
  for (const [targetId, newWords] of additions.entries()) {
    const target = clusters.find((c) => c.cluster_id === targetId);
    if (!target) { console.warn(`  ⚠ target ${targetId} not found; skipping ${newWords.length} words`); continue; }
    const existing = new Set(target.keywords);
    const dedupedNew = newWords.filter((w) => !existing.has(w));
    if (!dedupedNew.length) continue;
    const merged = [...target.keywords, ...dedupedNew];
    const cell = `${CLUSTER_SHEET}!L${target.rowIndex}`;
    await updateValues(token, sid, cell, [[merged.join('\n')]], 'RAW');
    updates++;
    console.log(`  ✓ ${targetId.padEnd(14)} +${dedupedNew.length} words (now ${merged.length})`);
  }

  // Update source bucket: keep only words that weren't moved.
  const remaining = source.keywords.filter((w) => !moved.has(w));
  const sourceCell = `${CLUSTER_SHEET}!L${source.rowIndex}`;
  await updateValues(token, sid, sourceCell, [[remaining.join('\n')]], 'RAW');
  console.log(`  ✓ ${sourceId.padEnd(14)} ${source.keywords.length} → ${remaining.length} words (removed ${moved.size})`);

  return { targetUpdates: updates, sourceRemoved: moved.size };
}

// ============================================================ per-target driver + main

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

async function runForTarget(cfg, targetId, clusters, embedOpts, token, sid) {
  console.log(`\n━━━ ${targetId} ━━━`);
  const source = clusters.find((c) => c.cluster_id === targetId);
  if (!source) { console.error(`ERR: cluster ${targetId} not on sheet — skipping`); return null; }
  if (!source.keywords.length) { console.log(`  bucket empty; nothing to do`); return null; }
  console.log(`  source: ${source.cluster_name}  (${source.keywords.length} words)`);

  // Rebuild centroids per target so the source bucket can't pollute its own scoring.
  const { centroids } = await buildClusterCentroids(clusters, [targetId], embedOpts);
  console.log(`  built ${centroids.length} destination centroids`);
  const { suggestions, needs_new_cluster, perClusterCount } = await classifyWords(
    source.keywords, centroids, cfg.COSINE_THRESHOLD, embedOpts,
  );

  console.log(`\n  classified: ${suggestions.length} / ${source.keywords.length}  (${(100 * suggestions.length / source.keywords.length).toFixed(1)}%)`);
  console.log(`  needs_new : ${needs_new_cluster.length}`);

  const topRecipients = [...perClusterCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topRecipients.length) {
    console.log(`\n  top recipients:`);
    for (const [cid, n] of topRecipients) {
      const c = clusters.find((x) => x.cluster_id === cid);
      console.log(`    ${cid.padEnd(14)} +${String(n).padStart(3)} words  ${c?.cluster_name || ''}`);
    }
  }

  console.log(`\n  sample suggestions (top 5 by sim):`);
  for (const s of [...suggestions].sort((a, b) => b.sim - a.sim).slice(0, 5)) {
    console.log(`    "${s.word}" → ${s.target_cluster}  sim=${s.sim.toFixed(3)}`);
  }
  if (needs_new_cluster.length) {
    console.log(`\n  sample needs_new (top 3):`);
    for (const n of needs_new_cluster.slice(0, 3)) {
      const t = n.top3[0];
      console.log(`    "${n.word}"  best=${t.cluster}@${t.sim} (below ${cfg.COSINE_THRESHOLD})`);
    }
  }

  const payload = {
    target: targetId,
    target_name: source.cluster_name,
    input_count: source.keywords.length,
    classified_count: suggestions.length,
    needs_new_cluster_count: needs_new_cluster.length,
    threshold: cfg.COSINE_THRESHOLD,
    embed_model: cfg.EMBED_MODEL,
    generated_at: new Date().toISOString(),
    top_recipients: topRecipients.map(([cid, n]) => ({
      cluster: cid,
      added: n,
      cluster_name: clusters.find((c) => c.cluster_id === cid)?.cluster_name || '',
    })),
    suggestions,
    needs_new_cluster,
  };

  if (cfg.WRITE_FILE) {
    ensureDir(SUGGEST_DIR);
    const out = join(SUGGEST_DIR, `${targetId}.json`);
    writeFileSync(out, JSON.stringify(payload, null, 2));
    console.log(`\n  ✓ wrote ${out}`);
  }

  if (!cfg.DRY_RUN && cfg.WRITE_SHEET) {
    console.log(`\n  WRITE-SHEET: applying ${suggestions.length} classifications...`);
    await writeBackToSheet(token, sid, clusters, suggestions, targetId);
  }

  return payload;
}

async function main() {
  const cfg = parseCliArgs(process.argv.slice(2));
  await loadDeps();
  loadEnv();

  // Backend validation
  let apiKey = null;
  if (cfg.EMBED_BACKEND === 'openai') {
    apiKey = process.env.OPENAI_API_KEY || null;
    if (!apiKey) {
      console.error('ERR: --embed-backend openai requires OPENAI_API_KEY in env.');
      console.error('     Or use --embed-backend ollama (default if no key).');
      process.exit(2);
    }
  } else if (cfg.EMBED_BACKEND === 'ollama') {
    try {
      const r = await fetch(`${cfg.OLLAMA_HOST.replace(/\/+$/, '')}/api/tags`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const models = (j.models || []).map((m) => m.name);
      if (!models.some((m) => m === cfg.EMBED_MODEL || m.startsWith(cfg.EMBED_MODEL + ':'))) {
        console.error(`ERR: ollama model '${cfg.EMBED_MODEL}' not found on ${cfg.OLLAMA_HOST}.`);
        console.error(`     Pull it: ollama pull ${cfg.EMBED_MODEL}`);
        console.error(`     Installed: ${models.join(', ') || '(none)'}`);
        process.exit(2);
      }
    } catch (e) {
      console.error(`ERR: cannot reach ollama at ${cfg.OLLAMA_HOST}: ${e.message}`);
      console.error('     Start it: ollama serve');
      process.exit(2);
    }
  }
  const embedOpts = {
    backend: cfg.EMBED_BACKEND,
    apiKey,
    host: cfg.OLLAMA_HOST,
    model: cfg.EMBED_MODEL,
  };

  let sid;
  if (cfg.WORKBOOK === 'flow-mvp') sid = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  else if (cfg.WORKBOOK === 'legacy') sid = process.env.GG_SHEETS_WORKBOOK_ID;
  else sid = cfg.WORKBOOK;
  if (!sid) {
    console.error(`ERR: workbook "${cfg.WORKBOOK}" — set GG_SHEETS_FLOW_MVP_WORKBOOK_ID or pass --workbook <id>`);
    process.exit(2);
  }

  const sa = process.env.GG_WRITER_SA_JSON || join(homedir(), '.config', 'gg', 'gg-writer-sa.json');
  if (!existsSync(sa)) {
    console.error(`ERR: writer SA not found: ${sa}`);
    process.exit(2);
  }
  const auth = await getAccessToken(sa, ['https://www.googleapis.com/auth/spreadsheets']);
  const token = auth.token;

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Workbook : ${cfg.WORKBOOK} (${sid.slice(0, 12)}…)`);
  console.log(`Target   : ${cfg.TARGET}`);
  console.log(`Threshold: ${cfg.COSINE_THRESHOLD} (cosine similarity)`);
  console.log(`Backend  : ${cfg.EMBED_BACKEND}${cfg.EMBED_BACKEND === 'ollama' ? `  (${cfg.OLLAMA_HOST})` : ''}`);
  console.log(`Model    : ${cfg.EMBED_MODEL}`);
  console.log(`Mode     : ${cfg.DRY_RUN ? 'DRY-RUN' : 'WRITE-SHEET'}${cfg.WRITE_FILE ? ' + WRITE-FILE' : ''}`);

  console.log('\nloading 主题集群表 ...');
  const clusters = await loadClusters(token, sid);
  console.log(`  loaded ${clusters.length} clusters, ${clusters.reduce((n, c) => n + c.keywords.length, 0)} total keywords`);

  const targets = cfg.TARGET === 'both' ? ['ind-001', 'ind-002'] : [cfg.TARGET];
  const results = [];
  for (const t of targets) {
    const r = await runForTarget(cfg, t, clusters, embedOpts, token, sid);
    if (r) results.push(r);
    // For 'both' mode: reload clusters between targets when writing.
    if (!cfg.DRY_RUN && cfg.WRITE_SHEET && targets.length > 1) {
      console.log('\n  reloading clusters for next target...');
      const fresh = await loadClusters(token, sid);
      clusters.length = 0;
      clusters.push(...fresh);
    }
  }

  console.log('\n━━━ summary ━━━');
  for (const r of results) {
    console.log(`  ${r.target}  in=${r.input_count}  classified=${r.classified_count}  needs_new=${r.needs_new_cluster_count}  (threshold=${r.threshold})`);
  }
  if (cfg.DRY_RUN) console.log('\nDRY-RUN: no sheet writes. Re-run with --write-sheet to apply.');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
}

export {
  loadDeps,
  meanCentroidNormed,
  cosSim,
  buildClusterCentroids,
  classifyWords,
  parseCliArgs,
};
