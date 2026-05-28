#!/usr/bin/env node
// gg-render-batch.mjs — 读 batch fixture（gg-sheet-pull 输出）→ 每行调 renderAuraPrompt → 写 v8 prompt + sidecar
//
// 用法：
//   node tools/scripts/gg-render-batch.mjs --batch .gg-cache/batches/<batch>.json
//   node tools/scripts/gg-render-batch.mjs --batch <path> --slice 3-5
//   node tools/scripts/gg-render-batch.mjs --batch <path> --row 3 \
//        --overrides path/to/overrides.json
//   node tools/scripts/gg-render-batch.mjs --batch <path> --row 3 --language zh
//   node tools/scripts/gg-render-batch.mjs --batch <path> --row 3 --language both
//
// bilingual-v9: --language en|zh|both
//   - en   (default if omitted; uses definition.prompt.md / pillar.prompt.md)
//   - zh   (uses definition.prompt.zh.md / pillar.prompt.zh.md — cultural
//          adaptation, NOT translation. ZH prompts auto-derive native Chinese
//          long-tail keywords from the same English target_keyword.)
//   - both (renders each ready row twice; outputs land at
//          .gg-cache/prompts/<page>.v8-prompt.md + <page>.v8.zh-prompt.md)
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
// SERP cache 缺失不阻塞（renderer 自动降级注释），但 phase2 RL3 plagiarism check 会 skip。
//
// SERP cache 自动补齐（v0.19+，--auto-serp-snapshot）：
//   传 --auto-serp-snapshot 时，render 前若 .gg-cache/serp/<page_id>.json 缺失，
//   会尝试 invoke `tools/scripts/gg-serp-snapshot.mjs --page-id X --entity Y --query Z
//   --paste .gg-cache/serp-pastes/<page_id>.json`（约定路径）。
//   snapshot 脚本目前是 manual-paste 模式（需要预先准备 paste JSON），所以若 paste 文件
//   不存在 → 打印 warning 并 skip（render 继续），不会阻塞链路。后续接 DataForSEO 抓取后
//   只需调整 spawn 参数。
//
// SERP cache check（--check-only）：
//   只 report 每个 page 的 SERP cache hit/miss，不 render。用于 ops dashboard。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { renderAuraPrompt } from './lib/_render-aura-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const SERP_SNAPSHOT_SCRIPT = join(__dirname, 'gg-serp-snapshot.mjs');

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
//
// bilingual-v9: cliLanguage (when provided) overrides override.language so
// `--language zh` at the batch level beats per-page override. When neither is
// set, downstream renderAuraPrompt defaults to 'en' for back-compat.
export function composeCfg(row, override, cliLanguage) {
  const b = row.brief || {};
  const o = override || {};
  const tpl = normalizeTemplate(o.template || b.template);
  const tier = o.tier || parseTier(b.tier) || 'T2';
  const language = cliLanguage || o.language || b.language || undefined;
  const cfg = {
    page_id: o.page_id || row.page_id,
    entity: o.entity || b.entity,
    target_keyword: o.target_keyword || b.target_keyword,
    associated_keywords: o.associated_keywords || b.associated_keywords || [],
    search_volume: o.search_volume || b.search_volume || '',
    cluster_jtbd: o.cluster_jtbd,
    content_angle: o.content_angle || b.content_angle,
    journal_prompts: o.journal_prompts || b.journal_prompts,
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
    // v4.4 schema: section count is fixed per template (Definition 9 / Pillar 11
    // / Tutorial 8 — FAQ + Sources added). Derive from template so a stale
    // per-row override can't pin the old 7/9 count into the fixture sidecar
    // (which _phase2-validate reads ahead of tplDef).
    expected_h2: o.expected_h2 || (tpl.value === 'Pillar' ? 11 : tpl.value === 'Tutorial' ? 8 : 11),
    child_entities: o.child_entities,
    child_count: o.child_count,
    ...(language ? { language } : {}),
    // author routing (Lane B / T3): the byline id resolved at pull time
    // (gg-sheet-pull). renderAuraPrompt writes it + banned_tokens into the fixture
    // so the batch publish path carries the persona through to the oracle. Omitted
    // when empty so EN fixtures without an author stay clean.
    ...(o.author_id || b.author ? { author_id: o.author_id || b.author } : {}),
    ...(o.author_source || b.author_source ? { author_source: o.author_source || b.author_source } : {}),
    // bilingual-v9: ZH main long-tail keyword (ops-filled in sheet col V).
    // When present, phase2 RL4/RL5 uses it instead of H1-derive. Omitted from
    // cfg when empty so renderAuraPrompt sidecar doesn't carry null fields.
    ...(o.target_keyword_zh || b.target_keyword_zh
      ? { target_keyword_zh: o.target_keyword_zh || b.target_keyword_zh }
      : {}),
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

// SERP cache lives at .gg-cache/serp/<page_id>.json (loadSerpSnippets contract).
// Match _render-aura-shared.mjs:128 — the renderer reads this exact path.
export function serpCachePath(pageId, repoRoot = REPO) {
  return join(repoRoot, '.gg-cache', 'serp', `${pageId}.json`);
}

export function hasSerpCache(pageId, repoRoot = REPO) {
  return existsSync(serpCachePath(pageId, repoRoot));
}

// Convention for manual-paste sidecar that gg-serp-snapshot.mjs needs.
// If a user / upstream scraper drops a normalized SERP JSON here, we auto-pick it up.
export function serpPastePath(pageId, repoRoot = REPO) {
  return join(repoRoot, '.gg-cache', 'serp-pastes', `${pageId}.json`);
}

// Auto-trigger gg-serp-snapshot.mjs. Returns { invoked, ok, durationMs, exitCode, reason }.
// dryRun=true prints the intended invocation and returns invoked=false, ok=null.
// Never throws — caller wants graceful degradation (render continues regardless).
export function autoSerpSnapshot({ pageId, entity, targetKeyword, repoRoot = REPO, dryRun = false, logger = console }) {
  const result = { invoked: false, ok: false, durationMs: 0, exitCode: null, reason: null };
  if (!pageId || !entity || !targetKeyword) {
    result.reason = `missing inputs (page_id=${!!pageId} entity=${!!entity} target_keyword=${!!targetKeyword})`;
    logger.error(`[auto-serp] ${pageId || '<no-page-id>'}: skip — ${result.reason}`);
    return result;
  }
  const pastePath = serpPastePath(pageId, repoRoot);
  if (!existsSync(pastePath)) {
    result.reason = `no paste file at ${pastePath} (gg-serp-snapshot.mjs is manual-paste; drop a normalized SERP JSON here or wire a DataForSEO fetcher)`;
    logger.error(`[auto-serp] ${pageId}: ❌ skip — ${result.reason}`);
    return result;
  }
  const cmd = process.execPath;
  const args = [
    SERP_SNAPSHOT_SCRIPT,
    '--page-id', pageId,
    '--entity', entity,
    '--query', targetKeyword,
    '--paste', pastePath,
  ];
  if (dryRun) {
    logger.log(`[auto-serp] ${pageId}: cache missing → would invoke: node ${args.join(' ')}`);
    result.reason = 'dry-run';
    return result;
  }
  logger.log(`[auto-serp] ${pageId}: cache missing → invoking gg-serp-snapshot...`);
  const t0 = Date.now();
  result.invoked = true;
  const child = spawnSync(cmd, args, { encoding: 'utf8', cwd: repoRoot });
  result.durationMs = Date.now() - t0;
  result.exitCode = child.status;
  if (child.status === 0 && hasSerpCache(pageId, repoRoot)) {
    result.ok = true;
    logger.log(`[auto-serp] ${pageId}: ✅ (took ${(result.durationMs / 1000).toFixed(1)}s)`);
  } else {
    result.ok = false;
    result.reason = `exit=${child.status ?? 'null'} stderr=${(child.stderr || '').slice(0, 200).trim()}`;
    logger.error(`[auto-serp] ${pageId}: ❌ (skipped, exit code ${child.status ?? 'null'}) — ${result.reason}`);
  }
  return result;
}

// --check-only report: enumerate ready rows, report SERP cache hit/miss.
// Returns 0 (always — informational). Prints a stable table to stdout.
export function checkOnlyReport(batch, slice, repoRoot = REPO, out = process.stdout) {
  const lines = [];
  let total = 0; let hit = 0; let miss = 0;
  lines.push(`SERP cache check — batch ${batch.batch_id}`);
  lines.push(`${'row'.padEnd(4)} ${'page_id'.padEnd(38)} ${'target_keyword'.padEnd(40)} status`);
  lines.push('-'.repeat(96));
  for (const row of batch.rows) {
    if (row.status !== 'ready') continue;
    if (!inSlice(row.source_row, slice)) continue;
    if (!row.page_id) continue;
    total += 1;
    const has = hasSerpCache(row.page_id, repoRoot);
    let tag;
    if (has) {
      hit += 1;
      let snippets = '?';
      try {
        const c = JSON.parse(readFileSync(serpCachePath(row.page_id, repoRoot), 'utf8'));
        snippets = Array.isArray(c.snippets) ? c.snippets.length : '?';
      } catch { /* corrupt — count as miss-like */ }
      tag = `✅ hit (${snippets} snippets)`;
    } else {
      miss += 1;
      tag = '❌ miss';
    }
    const kw = (row.brief?.target_keyword || '-').slice(0, 40);
    lines.push(`${String(row.source_row).padEnd(4)} ${String(row.page_id).padEnd(38)} ${kw.padEnd(40)} ${tag}`);
  }
  lines.push('-'.repeat(96));
  lines.push(`total=${total} hit=${hit} miss=${miss}`);
  out.write(lines.join('\n') + '\n');
  return { total, hit, miss };
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
  const autoSerp = !!args.auto_serp_snapshot;
  const checkOnly = !!args.check_only;

  // bilingual-v9: --language en|zh|both. Default = undefined → 'en' downstream
  // (back-compat). 'both' renders each ready row twice (EN then ZH), so the
  // EN pipeline is unchanged for callers that don't pass --language.
  const langArg = typeof args.language === 'string' ? args.language.toLowerCase() : null;
  if (langArg && !['en', 'zh', 'both'].includes(langArg)) {
    process.stderr.write(`invalid --language "${args.language}" — expected en|zh|both\n`);
    return 2;
  }
  const languages = langArg === 'both' ? ['en', 'zh'] : [langArg || null];

  // --check-only short-circuits: just report SERP cache hit/miss table and exit 0.
  if (checkOnly) {
    checkOnlyReport(batch, slice);
    return 0;
  }

  const report = { batch_id: batch.batch_id, total: 0, rendered: 0, skipped: 0, errored: 0, details: [] };

  for (const row of batch.rows) {
    if (row.status !== 'ready') continue;
    if (!inSlice(row.source_row, slice)) continue;

    if (!row.page_id) {
      report.total += 1;
      report.skipped += 1;
      report.details.push({
        source_row: row.source_row,
        page_id: row.page_id,
        outcome: 'skipped',
        reason: 'no page_id (target_keyword missing)',
        warnings: [],
      });
      continue;
    }

    // bilingual-v9: render once per language. languages=[null] for unset
    // (legacy EN-only behavior), [en, zh] for --language both. Each language
    // gets its own report row so smoke counts are accurate.
    for (const langChoice of languages) {
      report.total += 1;
      const detail = {
        source_row: row.source_row,
        page_id: row.page_id,
        language: langChoice || 'en',
        outcome: null,
        reason: null,
        warnings: [],
      };

      const { cfg, warnings } = composeCfg(row, overrides[row.page_id], langChoice);
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

      // Auto-trigger SERP snapshot if requested and cache is missing.
      // Quiet on cache-hit; only log when invoking or skipping. RAG is
      // language-agnostic, so we only invoke once per page (skip on 2nd lang).
      if (autoSerp && !hasSerpCache(cfg.page_id) && langChoice !== 'zh') {
        const r = autoSerpSnapshot({
          pageId: cfg.page_id,
          entity: cfg.entity,
          targetKeyword: cfg.target_keyword,
          dryRun,
        });
        if (r.invoked && !r.ok) {
          detail.warnings.push(`auto-serp failed: ${r.reason} (RL3 plagiarism will skip)`);
        } else if (!r.invoked && r.reason && !dryRun) {
          detail.warnings.push(`auto-serp skipped: ${r.reason}`);
        }
      }

      if (dryRun) {
        detail.outcome = 'would-render';
        detail.reason = `cfg ready (template=${cfg.template}, tier=${cfg.tier}, lang=${detail.language})`;
        report.rendered += 1;
        report.details.push(detail);
        continue;
      }

      try {
        console.log(`\n━━━ row ${row.source_row} → ${row.page_id} [${detail.language}] ━━━`);
        renderAuraPrompt(cfg);
        const langInfix = detail.language === 'zh' ? '.zh' : '';
        detail.outcome = 'rendered';
        detail.reason = `prompt + fixture written to .gg-cache/prompts/${cfg.page_id}.${cfg.prompt_version}${langInfix}-*`;
        report.rendered += 1;
      } catch (e) {
        detail.outcome = 'errored';
        detail.reason = String(e.message || e);
        report.errored += 1;
        if (!continueOnError) {
          report.details.push(detail);
          process.stderr.write(`\n❌ row ${row.source_row} [${detail.language}] failed: ${detail.reason}\n(use --continue-on-error to keep going)\n`);
          emitReport(report);
          return 1;
        }
      }
      report.details.push(detail);
    }
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
    const langTag = d.language ? ` [${d.language}]` : '';
    process.stderr.write(`  ${tag} row ${String(d.source_row).padStart(3)}${langTag} ${d.page_id || '-'}: ${d.outcome} — ${d.reason}\n`);
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
