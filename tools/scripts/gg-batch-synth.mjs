#!/usr/bin/env node
// gg-batch-synth.mjs — synthesize a gg-render-batch fixture for pages NOT
// in the Sheet (supplement / experimental / scratch pages). Bypasses the
// Sheet read entirely; reads per-page brief stub from an overrides.json
// (the same file consumed by gg-render-batch --overrides) and emits a
// batch JSON that gg-render-batch consumes directly.
//
// This is the lightweight alternative to gg-sheet-pull for pages whose
// canonical brief lives in .gg-cache/overrides/ rather than in the
// 选题登记表 Sheet. Used for supplement clusters where we补充新 page
// without round-tripping through ops.
//
// Pairs with step 3 of docs/PIPELINE.md.
//
// Usage:
//   node tools/scripts/gg-batch-synth.mjs \
//     --pages "page_orange_aura_meaning page_green_aura_meaning" \
//     --overrides .gg-cache/overrides/aura-related-batch.json \
//     [--out .gg-cache/batches/<auto>.json]
//
// Each page_id must exist as a key in the overrides JSON (with at least
// entity / target_keyword / tier / template). Other 13 cfg fields can stay
// in the overrides — composeCfg merges row.brief and overrides[page_id]
// with overrides winning.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

// Build a single batch row from an overrides entry. Mirrors gg-sheet-pull
// row shape (source_row / status / page_id / raw / brief / todo).
export function buildRow(sourceRow, pageId, override) {
  if (!override || typeof override !== 'object') {
    throw new Error(`overrides[${pageId}] missing or not an object — run gg-brief-init.mjs first`);
  }
  const requiredMinimal = ['entity', 'target_keyword', 'tier', 'template'];
  const missing = requiredMinimal.filter((f) => !override[f]);
  if (missing.length) {
    throw new Error(`overrides[${pageId}] missing minimum fields: ${missing.join(', ')}`);
  }
  return {
    source_row: sourceRow,
    status: 'ready',
    page_id: pageId,
    raw: { _synthetic: `supplement row for ${pageId}` },
    brief: {
      target_keyword: override.target_keyword,
      entity: override.entity,
      tier: override.tier,
      template: override.template,
    },
    todo: [],
  };
}

function emitDefaultBatchPath(pageIds) {
  const now = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', 'T');
  const slug = pageIds.length === 1
    ? pageIds[0].replace(/^page_/, '').replace(/_/g, '-')
    : `${pageIds.length}-pages`;
  return join(REPO, '.gg-cache', 'batches', `${now}-${slug}-synth.json`);
}

async function main(argv) {
  const args = parseArgs(argv);

  if (args.help || args.h) {
    process.stdout.write(`gg-batch-synth — synthesize a render-batch fixture from overrides JSON

usage:
  node tools/scripts/gg-batch-synth.mjs --pages "page_X page_Y" --overrides path/to/overrides.json

flags:
  --pages "<id1 id2 ...>"   required, whitespace-separated page_ids
  --overrides <path>        required, JSON with one entry per page_id
  --out <path>              default .gg-cache/batches/<YYYYMMDDThhmmss>-<slug>-synth.json
  --batch-id <id>           default derived from output basename
  --force                   overwrite existing output

Next: pipe the output path into gg-render-batch.mjs:
  node tools/scripts/gg-render-batch.mjs --batch <out> --overrides <overrides>
`);
    return 0;
  }

  if (!args.pages || args.pages === true) {
    process.stderr.write('missing --pages (run with --help)\n');
    return 2;
  }
  if (!args.overrides || args.overrides === true) {
    process.stderr.write('missing --overrides (run with --help)\n');
    return 2;
  }

  const pageIds = String(args.pages).split(/\s+/).filter(Boolean);
  if (pageIds.length === 0) {
    process.stderr.write('--pages parsed to empty list\n');
    return 2;
  }
  for (const pid of pageIds) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(pid)) {
      process.stderr.write(`invalid page_id "${pid}"\n`);
      return 2;
    }
  }

  if (!existsSync(args.overrides)) {
    process.stderr.write(`overrides file not found: ${args.overrides}\n`);
    return 2;
  }
  const overrides = JSON.parse(readFileSync(args.overrides, 'utf8'));

  const rows = [];
  for (let i = 0; i < pageIds.length; i++) {
    const pid = pageIds[i];
    try {
      rows.push(buildRow(i + 1, pid, overrides[pid]));
    } catch (e) {
      process.stderr.write(`✗ ${pid}: ${e.message}\n`);
      return 1;
    }
  }

  const outPath = args.out || emitDefaultBatchPath(pageIds);
  if (existsSync(outPath) && !args.force) {
    process.stderr.write(`output exists: ${outPath} — use --force to overwrite\n`);
    return 2;
  }

  const basename = outPath.split('/').pop().replace(/\.json$/, '');
  const batchId = args.batch_id || basename;

  const batch = {
    schema_version: '1',
    batch_id: batchId,
    workbook_id: 'synthetic',
    tab: 'supplement',
    header: ['Target Keyword', 'Tier', 'Template', 'Entity'],
    slice: { start: 1, end: pageIds.length },
    pulled_at: new Date().toISOString(),
    stats: { total: pageIds.length, ready: pageIds.length },
    rows,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(batch, null, 2) + '\n');
  process.stdout.write(`✓ wrote batch fixture: ${outPath}\n`);
  process.stdout.write(`  ${pageIds.length} ready row(s): ${pageIds.join(', ')}\n`);
  process.stdout.write(`  next: node tools/scripts/gg-render-batch.mjs --batch ${outPath} --overrides ${args.overrides}\n`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { main };
