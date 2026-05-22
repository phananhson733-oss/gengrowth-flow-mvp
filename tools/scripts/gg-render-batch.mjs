#!/usr/bin/env node
// gg-render-batch.mjs — 读 batch fixture（gg-sheet-pull 输出）→ 每行调 renderAuraPrompt → 写 v8 prompt + sidecar
//
// 用法：
//   node tools/scripts/gg-render-batch.mjs --batch .gg-cache/batches/<batch>.json
//   node tools/scripts/gg-render-batch.mjs --batch <path> --slice 3-5
//   node tools/scripts/gg-render-batch.mjs --batch <path> --row 3 \
//        --overrides path/to/overrides.json
//
// 设计：renderAuraPrompt 要 13 个 cfg 字段，brief 只有 ~5 个（target_keyword / entity /
// associated_keywords / search_volume / content_angle / cta_target_url）。其余字段
// （cluster_jtbd / internal_link_rule / cta_text / tier_gate_block / rl6_hint /
// friction_themes）暂时在 Sheet 里没列，要么写在 overrides.json，要么 row 被 skip。
//
// overrides.json 形状（每个 page_id 一个 entry，merge 到 brief 上面）：
//   {
//     "page_aura_colors": {
//       "cluster_jtbd": "...",
//       "internal_link_rule": "...",
//       "cta_text": "...",
//       "tier_gate_block": "## Tier Gate (T1 Pillar)\n- 必读 Friction: ...\n...",
//       "rl6_hint": "...",
//       "friction_themes": [ { "theme": "...", "scrubbed_quote": "...", ... }, ... ]
//     }
//   }
//
// 还要 .gg-cache/<page_id>/{entity-passport,obsidian-rag}.rag.json 提前跑好（gg-entity-passport / gg-obsidian-rag）。
// SERP cache 缺失不阻塞（renderer 自动降级注释）。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

// renderAuraPrompt 直接 plug 到 template 的字段。少哪个 → 行被 skip。
export const REQUIRED_CFG_FIELDS = [
  'page_id',
  'entity',
  'target_keyword',
  'associated_keywords',
  'search_volume',
  'cluster_jtbd',
  'content_angle',
  'internal_link_rule',
  'cta_text',
  'cta_target_url',
  'tier_gate_block',
  'rl6_hint',
  'friction_themes',
];

// renderAuraPrompt 渲染前必读的 RAG cache。缺哪个 → skip + hint。
// SERP cache 缺失不阻塞（renderer 自己写 `<!-- SERP cache missing -->`）。
export const REQUIRED_RAG_CACHES = ['entity-passport.rag.json', 'obsidian-rag.json'];

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

export function inSlice(sourceRow, slice) {
  if (!slice) return true;
  const single = /^(\d+)$/.exec(String(slice));
  if (single) return sourceRow === Number(single[1]);
  const range = /^(\d+)\s*-\s*(\d+)$/.exec(String(slice));
  if (range) return sourceRow >= Number(range[1]) && sourceRow <= Number(range[2]);
  throw new Error(`invalid slice: ${slice}`);
}

// Parse Tier string. "Tier 1 (重装)" → "T1"; "T2" → "T2"; "Tier 2" → "T2"; "" → null
export function parseTier(raw) {
  if (!raw) return null;
  const m = /(?:tier\s*)?(\d)/i.exec(String(raw));
  return m ? `T${m[1]}` : null;
}

// Normalize template string from Sheet → renderAuraPrompt's expected value.
// renderAuraPrompt accepts: 'Pillar' (case-insensitive) or anything else = 'definition'.
// We pass 'Pillar' or 'Definition' through; flag Tutorial as a known gap (no template).
export function normalizeTemplate(raw) {
  if (!raw) return { value: 'Definition', warning: null };
  const s = String(raw).trim().toLowerCase();
  if (s === 'pillar') return { value: 'Pillar', warning: null };
  if (s === 'definition') return { value: 'Definition', warning: null };
  if (s === 'tutorial') {
    return {
      value: 'Definition',
      warning: 'template=Tutorial requested but renderAuraPrompt only ships pillar/definition — falling back to Definition',
    };
  }
  return { value: 'Definition', warning: `unknown template "${raw}" — falling back to Definition` };
}

// Compose final renderAuraPrompt cfg from brief + per-page override.
// override.page_id (if set) aliases row.page_id — lets row 3 (slug
// page_aura_colors) point to the pre-existing page_aura_colors_pillar
// RAG cache without renaming directories.
export function composeCfg(row, override) {
  const b = row.brief || {};
  const o = override || {};
  const tpl = normalizeTemplate(o.template || b.template);
  const tier = o.tier || parseTier(b.tier) || 'T2';
  const cfg = {
    page_id: o.page_id || row.page_id,
    entity: o.entity || b.entity,
    target_keyword: o.target_keyword || b.target_keyword,
    associated_keywords: o.associated_keywords || b.associated_keywords || [],
    search_volume: o.search_volume || b.search_volume || '',
    cluster_jtbd: o.cluster_jtbd,
    content_angle: o.content_angle || b.content_angle,
    internal_link_rule: o.internal_link_rule,
    cta_text: o.cta_text,
    cta_target_url: o.cta_target_url || b.cta_target_url,
    tier_gate_block: o.tier_gate_block,
    rl6_hint: o.rl6_hint,
    friction_themes: o.friction_themes,
    template: tpl.value,
    tier,
    prompt_version: o.prompt_version || 'v8',
    psych_safety_flag: o.psych_safety_flag,
    word_range: o.word_range,
    kw_count_range: o.kw_count_range,
    expected_h2: o.expected_h2,
    child_entities: o.child_entities,
    child_count: o.child_count,
  };
  return { cfg, warnings: [tpl.warning].filter(Boolean) };
}

export function missingFields(cfg) {
  const missing = [];
  for (const f of REQUIRED_CFG_FIELDS) {
    const v = cfg[f];
    if (v == null || v === '') missing.push(f);
    else if (Array.isArray(v) && v.length === 0) missing.push(f);
  }
  return missing;
}

export function missingRagCaches(pageId, repoRoot = REPO) {
  const dir = join(repoRoot, '.gg-cache', pageId);
  const missing = [];
  for (const f of REQUIRED_RAG_CACHES) {
    if (!existsSync(join(dir, f))) missing.push(f);
  }
  return missing;
}

// ---------- main ----------
async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 28).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return 0;
  }
  if (!args.batch) {
    process.stderr.write('missing --batch <path>\n');
    return 2;
  }
  const batchPath = args.batch;
  if (!existsSync(batchPath)) {
    process.stderr.write(`batch not found: ${batchPath}\n`);
    return 2;
  }
  const batch = JSON.parse(readFileSync(batchPath, 'utf8'));
  if (batch.schema_version !== '1') {
    process.stderr.write(`unsupported batch schema_version: ${batch.schema_version}\n`);
    return 2;
  }

  let overrides = {};
  if (args.overrides) {
    if (!existsSync(args.overrides)) {
      process.stderr.write(`overrides not found: ${args.overrides}\n`);
      return 2;
    }
    overrides = JSON.parse(readFileSync(args.overrides, 'utf8'));
  }

  const slice = args.row || args.slice || null;
  const continueOnError = !!args.continue_on_error;
  const dryRun = !!args.dry_run;

  const report = { batch_id: batch.batch_id, total: 0, rendered: 0, skipped: 0, errored: 0, details: [] };

  for (const row of batch.rows) {
    if (row.status !== 'ready') continue;
    if (!inSlice(row.source_row, slice)) continue;
    report.total += 1;
    const detail = { source_row: row.source_row, page_id: row.page_id, outcome: null, reason: null, warnings: [] };

    if (!row.page_id) {
      detail.outcome = 'skipped';
      detail.reason = 'no page_id (target_keyword missing)';
      report.skipped += 1;
      report.details.push(detail);
      continue;
    }

    const { cfg, warnings } = composeCfg(row, overrides[row.page_id]);
    detail.warnings = warnings;
    if (cfg.page_id !== row.page_id) {
      detail.page_id = `${row.page_id} → ${cfg.page_id}`;
    }

    const miss = missingFields(cfg);
    if (miss.length) {
      detail.outcome = 'skipped';
      detail.reason = `missing cfg fields: ${miss.join(', ')} (add to overrides.json[${row.page_id}])`;
      report.skipped += 1;
      report.details.push(detail);
      continue;
    }

    const missRag = missingRagCaches(cfg.page_id);
    if (missRag.length) {
      detail.outcome = 'skipped';
      detail.reason = `missing RAG: ${missRag.join(', ')} (run gg-entity-passport / gg-obsidian-rag for ${cfg.page_id})`;
      report.skipped += 1;
      report.details.push(detail);
      continue;
    }

    if (dryRun) {
      detail.outcome = 'would-render';
      detail.reason = `cfg ready (template=${cfg.template}, tier=${cfg.tier})`;
      report.rendered += 1;
      report.details.push(detail);
      continue;
    }

    try {
      // renderAuraPrompt logs to console; redirect-style capture not needed for v0.
      console.log(`\n━━━ row ${row.source_row} → ${row.page_id} ━━━`);
      renderAuraPrompt(cfg);
      detail.outcome = 'rendered';
      detail.reason = `prompt + fixture written to .gg-cache/prompts/${cfg.page_id}.${cfg.prompt_version}-*`;
      report.rendered += 1;
    } catch (e) {
      detail.outcome = 'errored';
      detail.reason = String(e.message || e);
      report.errored += 1;
      if (!continueOnError) {
        report.details.push(detail);
        process.stderr.write(`\n❌ row ${row.source_row} failed: ${detail.reason}\n(use --continue-on-error to keep going)\n`);
        emitReport(report);
        return 1;
      }
    }
    report.details.push(detail);
  }

  emitReport(report);
  return report.errored ? 1 : 0;
}

function emitReport(report) {
  process.stderr.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
  process.stderr.write(`batch ${report.batch_id}\n`);
  process.stderr.write(`  total=${report.total} rendered=${report.rendered} skipped=${report.skipped} errored=${report.errored}\n`);
  for (const d of report.details) {
    const tag = d.outcome === 'rendered' ? '✅' : d.outcome === 'would-render' ? '🟡' : d.outcome === 'errored' ? '❌' : '⏭';
    process.stderr.write(`  ${tag} row ${String(d.source_row).padStart(3)} ${d.page_id || '-'}: ${d.outcome} — ${d.reason}\n`);
    for (const w of d.warnings || []) process.stderr.write(`      ⚠️  ${w}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { main };
