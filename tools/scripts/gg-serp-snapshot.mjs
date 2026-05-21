#!/usr/bin/env node
// gg-serp-snapshot.mjs — manual-paste SERP cache for RL3 plagiarism check.
//
// Closes the last RL3 waiver in Phase 2: when no SERP scraper is available,
// user pastes a normalized JSON of SERP top-10 organic + PAA + related,
// this tool validates + scrubs + writes to .gg-cache/serp/{page_id}.json
// in the exact shape loadSerpSnippets() in gg-content-draft.mjs expects.
//
// Usage:
//   node tools/scripts/gg-serp-snapshot.mjs \
//     --page-id page_blue_aura_meaning \
//     --entity "Blue Aura" \
//     --query "blue aura meaning" \
//     --paste /path/to/serp-paste.json \
//     [--out .gg-cache/serp/page_blue_aura_meaning.json] \
//     [--max-snippets 10] [--max-len 500] [--dry-run]
//
// Paste JSON schema (caller normalizes from any SERP source):
//   {
//     "organic": [
//       {"position": 1, "title": "...", "url": "...", "snippet": "..."},
//       ...
//     ],
//     "paa": ["question 1", ...],         // optional
//     "related": ["related search 1", ...] // optional
//   }
//
// Output JSON (matches loadSerpSnippets() contract: top-level `snippets` array):
//   {
//     "schema_version": "1",
//     "page_id": "...",
//     "entity": "...",
//     "query": "...",
//     "generated_at": "ISO",
//     "source": "manual_paste",
//     "content_sha256_short": "...",
//     "snippets": ["text 1", "text 2", ...],
//     "raw": {organic, paa, related}
//   }
//
// Exit codes:
//   0  = ok
//   1  = fatal
//   2  = CLI / argument error
//   13 = ingest path fail
//   14 = write fail

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  scrubPII,
  sanitize,
  validateIngestPath,
  validateWritePath,
} from './lib/gg-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const DEFAULT_SERP_DIR = join(REPO_ROOT, '.gg-cache', 'serp');

const PAGE_ID_RE = /^page_[a-z0-9_]{3,80}$/;
const MAX_PASTE_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_MAX_SNIPPETS = 10;
const DEFAULT_MAX_LEN = 500;

// ---------- CLI parsing ----------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { out.dryRun = true; continue; }
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

function die(code, msg) {
  process.stderr.write(`[gg-serp-snapshot] ERROR: ${msg}\n`);
  process.exit(code);
}

// ---------- core ----------

function readPaste(pastePath) {
  // Paste source jails: user home (Desktop/Downloads), per-user tmp, system /tmp
  // (macOS /tmp → /private/tmp via symlink; validateIngestPath realpath-resolves),
  // repo root. Symlinks rejected; realpath check.
  const allowedDirs = [homedir(), tmpdir(), '/tmp', REPO_ROOT].filter(Boolean);
  let real;
  try {
    real = validateIngestPath(pastePath, {
      maxBytes: MAX_PASTE_BYTES,
      allowedExtensions: ['.json'],
      allowedDirs,
    });
  } catch (e) {
    die(13, `ingest path rejected — ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(real, 'utf8'));
  } catch (e) {
    die(2, `paste file is not valid JSON — ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    die(2, 'paste JSON must be an object {organic, paa?, related?}');
  }
  return parsed;
}

function normalizeOrganic(organic, maxLen) {
  if (!Array.isArray(organic)) return [];
  return organic
    .filter((o) => o && typeof o === 'object')
    .map((o, idx) => ({
      position: Number.isFinite(o.position) ? o.position : idx + 1,
      title: typeof o.title === 'string' ? scrubPII(sanitize(o.title)).text.slice(0, maxLen) : '',
      url: typeof o.url === 'string' ? o.url.slice(0, 500) : '',
      snippet: typeof o.snippet === 'string' ? scrubPII(sanitize(o.snippet)).text.slice(0, maxLen) : '',
    }))
    .filter((o) => o.snippet || o.title);
}

function normalizeStringArray(arr, maxLen) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .map((s) => scrubPII(sanitize(s)).text.slice(0, maxLen));
}

function buildSnippets(organic, maxSnippets) {
  // RL3 uses these for n-gram overlap. Prefer snippet body, fall back to title.
  return organic
    .slice(0, maxSnippets)
    .map((o) => (o.snippet || o.title || '').trim())
    .filter(Boolean);
}

function atomicWriteJson(targetPath, obj) {
  // validateWritePath does parent-mkdir + symlink reject. It needs the parent
  // dir to exist (or set mustCreateParent), and returns {realParent, abs}.
  mkdirSync(DEFAULT_SERP_DIR, { recursive: true });
  let abs;
  try {
    ({ abs } = validateWritePath(targetPath, {
      allowedDirs: [DEFAULT_SERP_DIR],
      allowedExtensions: ['.json'],
    }));
  } catch (e) {
    die(14, `write path rejected — ${e.message}`);
  }
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  const body = JSON.stringify(obj, null, 2);
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, abs);
  return { path: abs, bytes: body.length };
}

// ---------- main ----------

function main() {
  const args = parseArgs(process.argv.slice(2));

  const pageId = args.page_id;
  const entity = args.entity;
  const query = args.query;
  const pastePath = args.paste;

  if (!pageId || typeof pageId !== 'string') die(2, '--page-id required');
  if (!PAGE_ID_RE.test(pageId)) {
    die(2, `--page-id "${pageId}" rejected (must match ${PAGE_ID_RE})`);
  }
  if (!entity || typeof entity !== 'string') die(2, '--entity required');
  if (!query || typeof query !== 'string') die(2, '--query required');
  if (!pastePath || typeof pastePath !== 'string') die(2, '--paste <file.json> required');

  const maxSnippets = Number.parseInt(args.max_snippets, 10) || DEFAULT_MAX_SNIPPETS;
  const maxLen = Number.parseInt(args.max_len, 10) || DEFAULT_MAX_LEN;
  if (maxSnippets < 1 || maxSnippets > 50) die(2, '--max-snippets must be 1..50');
  if (maxLen < 50 || maxLen > 2000) die(2, '--max-len must be 50..2000');

  const paste = readPaste(pastePath);
  const organic = normalizeOrganic(paste.organic, maxLen);
  const paa = normalizeStringArray(paste.paa, maxLen).slice(0, 20);
  const related = normalizeStringArray(paste.related, maxLen).slice(0, 20);

  if (organic.length === 0) {
    die(2, 'paste.organic must yield ≥1 entry with snippet|title');
  }

  const snippets = buildSnippets(organic, maxSnippets);
  const generatedAt = new Date().toISOString();
  const out = {
    schema_version: '1',
    page_id: pageId,
    entity,
    query,
    generated_at: generatedAt,
    source: 'manual_paste',
    snippets,
    raw: { organic, paa, related },
  };
  const sha = createHash('sha256').update(JSON.stringify({ snippets, raw: out.raw })).digest('hex').slice(0, 16);
  out.content_sha256_short = sha;

  const outPath = args.out
    ? (args.out.startsWith('/') ? args.out : join(REPO_ROOT, args.out))
    : join(DEFAULT_SERP_DIR, `${pageId}.json`);

  if (args.dryRun) {
    process.stdout.write(`[dry-run] would write ${outPath}\n`);
    process.stdout.write(`[dry-run] snippets=${snippets.length} paa=${paa.length} related=${related.length} sha=${sha}\n`);
    process.stdout.write(`[dry-run] preview (first 2 snippets):\n`);
    snippets.slice(0, 2).forEach((s, i) => process.stdout.write(`  [${i + 1}] ${s.slice(0, 120)}${s.length > 120 ? '…' : ''}\n`));
    return;
  }

  const { path, bytes } = atomicWriteJson(outPath, out);
  process.stdout.write(`[gg-serp-snapshot] wrote ${path} (${bytes} bytes)\n`);
  process.stdout.write(`  snippets=${snippets.length} paa=${paa.length} related=${related.length} sha=${sha}\n`);
}

try {
  main();
} catch (e) {
  die(1, e.stack || e.message);
}
