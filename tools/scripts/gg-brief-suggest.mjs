#!/usr/bin/env node
// gg-brief-suggest.mjs — LLM-suggest defaults for the 21 选题登记表 columns.
//
// Stage 4 of docs/PIPELINE.md (L137 table): human fills 21 cols per page. Most
// are derivable from {page_id, cluster_id, target_keyword, entity}. This tool
// produces an LLM JSON suggestion the human reviews + tweaks (or writes to
// Sheet via --write-sheet).
// Schema source: tools/scripts/gg-sheet-pull.mjs HEADER_MAP (~L144).
//
// Usage:
//   node tools/scripts/gg-brief-suggest.mjs --page-id page_X \
//     --target-keyword "Y" --cluster-id fam-Z \
//     [--entity "X"] [--llm claude|codex|hermes] \
//     [--dry-run] [--write-file] [--write-sheet] [--batch <file>]
//
// FRONTIER-ONLY (wzb 2026-05-23): never Sonnet/Haiku/mini. Default claude-opus-4-7.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from './lib/_oauth-token.mjs';
import { gFetch, loadEnv, redactNote } from './lib/gg-shared.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

// ─── 1. Constants ─────────────────────────────────────────────────────────────

const PAGES_TAB = '选题登记表';
const CLUSTERS_TAB = '主题集群表';
export const PAGE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

// Tier enum — strict allow-list (Sheet uses Chinese-suffixed labels).
const ALLOWED_TIERS = new Set(['Tier 1 (重装)', 'Tier 2 (标准)']);
const ALLOWED_TEMPLATES = new Set(['Pillar', 'Tutorial', 'Definition']);
const ALLOWED_PSYCH = new Set(['Y', 'N']);

// 21 fields, canonical order — matches HEADER_MAP semantics in gg-sheet-pull.mjs.
// Safe-to-write cols (PIPELINE.md L137): F G H I J K P Q R S T U.
// A is set by promote; B-E are KD/volume; L-O are status/url/audit (formulas).
export const FIELD_SPEC = Object.freeze([
  { key: 'target_keyword',      col: 'A', writable: false, sheet_header: 'Target Keyword' },
  { key: 'associated_keywords', col: 'B', writable: false, sheet_header: 'Associated Keywords' },
  { key: 'search_volume',       col: 'C', writable: false, sheet_header: '月搜索量' },
  { key: 'kd',                  col: 'D', writable: false, sheet_header: 'KD' },
  { key: 'intent',              col: 'E', writable: false, sheet_header: 'Intent' },
  { key: 'tier',                col: 'F', writable: true,  sheet_header: 'Tier' },
  { key: 'template',            col: 'G', writable: true,  sheet_header: 'Template' },
  { key: 'entity',              col: 'H', writable: true,  sheet_header: 'Entity' },
  { key: 'friction',            col: 'I', writable: true,  sheet_header: 'Friction' },
  { key: 'logic',               col: 'J', writable: true,  sheet_header: 'Logic' },
  { key: 'cta',                 col: 'K', writable: true,  sheet_header: 'CTA' },
  { key: 'gsc_keywords',        col: 'L', writable: false, sheet_header: 'GSC Keywords' },
  { key: 'status',              col: 'M', writable: false, sheet_header: 'Status' },
  { key: 'publish_url',         col: 'N', writable: false, sheet_header: 'URL' },
  { key: 'last_audit',          col: 'O', writable: false, sheet_header: 'Last Audit' },
  { key: 'page_id',             col: 'P', writable: true,  sheet_header: 'page_id' },
  { key: 'cluster_id',          col: 'Q', writable: true,  sheet_header: 'cluster_id' },
  { key: 'page_role',           col: 'R', writable: true,  sheet_header: 'page_role' },
  { key: 'content_angle',       col: 'S', writable: true,  sheet_header: 'content_angle' },
  { key: 'psych_safety_flag',   col: 'T', writable: true,  sheet_header: 'psych_safety_flag' },
  { key: 'journal_prompts',     col: 'U', writable: true,  sheet_header: 'journal_prompts' },
]);

const WRITABLE_COLS = new Set(['F', 'G', 'H', 'I', 'J', 'K', 'P', 'Q', 'R', 'S', 'T', 'U']);
const PSYCH_TRIGGER_RE = /(past\s*life|shadow|trauma|death|lilith)/i;

// LLM registry — frontier-only (no Sonnet/Haiku/mini). hermes uses --prompt file.
const LLM_REGISTRY = {
  claude: { label: 'claude-opus-4-7', bin: 'claude', args: ['-p', '--model', 'claude-opus-4-7'], stdinPrompt: true },
  codex:  { label: 'gpt-5.5-high',    bin: 'codex',  args: ['exec', '-c', 'model=gpt-5.5', '-c', 'reasoning_effort=high', '-'], stdinPrompt: true },
  hermes: { label: 'hermes-3-405b',   bin: 'node',   args: [join(__dirname, '_call-hermes.mjs')], stdinPrompt: false },
};

// ─── 2. CLI parsing ───────────────────────────────────────────────────────────

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

// ─── 3. Pure helpers (exported for tests) ─────────────────────────────────────

export function defaultTier(/* targetKeyword, volume */) {
  // Spec: Tier 1 only if search_volume ≥10000. We don't have volume → default T2.
  return 'Tier 2 (标准)';
}

export function defaultTemplate(targetKeyword, entity) {
  const tk = String(targetKeyword || '').toLowerCase();
  const ent = String(entity || '').trim();
  if (/^how\s+to\b|^how\s+do\s+i\b/.test(tk)) return 'Tutorial';
  if (/\bwhat\s+is\b|\bmeaning\b|\bdefinition\b/.test(tk)) return 'Definition';
  // Short single-word entity → likely Pillar (e.g. "Aura", "Chakra")
  if (ent && ent.split(/\s+/).length === 1) return 'Pillar';
  return 'Definition';
}

export function defaultPsychFlag(entity, targetKeyword) {
  const probe = `${entity || ''} ${targetKeyword || ''}`;
  return PSYCH_TRIGGER_RE.test(probe) ? 'Y' : 'N';
}

// Strict per-field validator. Returns { ok, fixed, reason }.
export function validateField(key, value, ctx = {}) {
  const v = value == null ? '' : String(value).trim();
  switch (key) {
    case 'tier':
      return ALLOWED_TIERS.has(v) ? { ok: true, fixed: v } : { ok: false, fixed: defaultTier(), reason: `tier ∉ {${[...ALLOWED_TIERS].join(',')}}` };
    case 'template':
      return ALLOWED_TEMPLATES.has(v) ? { ok: true, fixed: v } : { ok: false, fixed: defaultTemplate(ctx.target_keyword, ctx.entity), reason: `template ∉ {${[...ALLOWED_TEMPLATES].join(',')}}` };
    case 'psych_safety_flag':
      return ALLOWED_PSYCH.has(v) ? { ok: true, fixed: v } : { ok: false, fixed: defaultPsychFlag(ctx.entity, ctx.target_keyword), reason: 'psych_safety_flag must be Y or N' };
    case 'page_id':
      return PAGE_ID_REGEX.test(v) ? { ok: true, fixed: v } : { ok: false, fixed: ctx.page_id || '', reason: `page_id must match ${PAGE_ID_REGEX}` };
    case 'cluster_id':
      return v ? { ok: true, fixed: v } : { ok: false, fixed: ctx.cluster_id || '', reason: 'cluster_id empty' };
    case 'entity':
      if (!v) return { ok: false, fixed: ctx.entity || '', reason: 'entity empty' };
      // PIPELINE.md L142: use short name ("Blue Aura" not "Aura / Blue Aura").
      if (v.includes('/')) return { ok: false, fixed: v.split('/').pop().trim(), reason: 'entity has "/", use short name' };
      return { ok: true, fixed: v };
    case 'friction': case 'logic': case 'content_angle':
      return v ? { ok: true, fixed: v } : { ok: false, fixed: '', reason: `${key} empty — needs human input` };
    case 'page_role':
      return v ? { ok: true, fixed: v } : { ok: false, fixed: ctx.cluster_cta_primary || '', reason: 'page_role empty → cluster.cta_primary' };
    case 'cta': case 'journal_prompts':
      return { ok: true, fixed: v }; // optional
    default:
      return { ok: true, fixed: v };
  }
}

// Prompt: LLM must reply with one ```json block + a NEEDS_REVIEW: line.
export function buildPrompt({ pageId, targetKeyword, clusterId, entity, clusterRow }) {
  const keys = FIELD_SPEC.filter((f) => f.writable).map((f) => f.key);
  const cc = clusterRow
    ? `- cluster_id: ${clusterRow.cluster_id}\n- cluster_name: ${clusterRow.cluster_name || ''}\n- jtbd: ${clusterRow.jtbd || ''}\n- content_angle: ${clusterRow.content_angle || ''}\n- cta_primary: ${clusterRow.cta_primary || ''}\n- psych_safety_flag: ${clusterRow.psych_safety_flag || 'N'}`
    : '(cluster row context missing)';
  return [
    'You are filling Stage 4 of the GenGrowth content brief sheet (选题登记表).',
    `Produce a JSON object covering ONLY these keys: ${JSON.stringify(keys)}`,
    '',
    'Field rules (do NOT invent extra keys):',
    '- tier: one of ["Tier 1 (重装)", "Tier 2 (标准)"]. Default "Tier 2 (标准)" unless hub.',
    '- template: one of ["Pillar", "Tutorial", "Definition"]. "what is X"/"X meaning" → Definition; "how to" → Tutorial; short single-entity hub → Pillar.',
    '- entity: short canonical noun phrase (e.g. "Violet Aura", NOT "Aura / Violet Aura"). No "/".',
    '- friction: 3-5 plain-prose sentences on reader pain / what they keep failing to find. No bullets.',
    '- logic: ONE sentence — writing angle / differentiator vs top-10 SERP.',
    '- cta: optional URL or "". Leave "" unless you know a specific landing page.',
    '- page_id: MUST equal the input page_id exactly.',
    '- cluster_id: MUST equal the input cluster_id exactly.',
    '- page_role: CTA Map role label. If unsure, copy cluster.cta_primary.',
    '- content_angle: 1-2 sentences — interpretive-framework framing, NOT clinical.',
    '- psych_safety_flag: "Y" if entity touches past-life/shadow/trauma/death/Lilith/clinical-adjacent; else "N". Uppercase.',
    '- journal_prompts: optional. 2-4 reflective questions, "|"-separated single line. "" if not obvious.',
    '',
    'Output format:',
    '1. ONE JSON object inside a ```json fenced block.',
    '2. After the JSON: NEEDS_REVIEW: <key1>,<key2> (or "none").',
    '3. No preamble, no other prose.',
    '',
    '=== INPUT ===',
    `page_id        : ${pageId}`,
    `target_keyword : ${targetKeyword}`,
    `cluster_id     : ${clusterId}`,
    `entity (input) : ${entity || '(derive from target_keyword)'}`,
    '',
    'cluster context (from 主题集群表):',
    cc,
    '=== END INPUT ===',
  ].join('\n');
}

// Parse LLM response → { fields, needsReview }. Tolerates small format drift.
export function parseLLMResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('LLM response empty');
  const fence = text.match(/```json\s*([\s\S]*?)```/i);
  const brace = !fence ? text.match(/\{[\s\S]*\}/) : null;
  const jsonStr = fence ? fence[1].trim() : (brace ? brace[0] : null);
  if (!jsonStr) throw new Error('no JSON object in LLM response');
  let obj;
  try { obj = JSON.parse(jsonStr); }
  catch (e) { throw new Error(`LLM JSON parse failed: ${e.message}`); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('LLM JSON not an object');
  let needsReview = [];
  const nr = text.match(/NEEDS_REVIEW\s*:\s*([^\n]+)/i);
  if (nr && !/^none$/i.test(nr[1].trim())) {
    needsReview = nr[1].split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
  }
  return { fields: obj, needsReview };
}

// Merge LLM fields + defaults + validation. Output includes all 21 fields.
// needs_review = LLM-self-reported ∪ validator-flagged ∪ default-filled keys.
export function assembleFields({ llmFields, llmNeedsReview, ctx }) {
  const out = {};
  const needs = new Set(llmNeedsReview || []);

  for (const spec of FIELD_SPEC) {
    if (!spec.writable) {
      out[spec.key] = spec.key === 'target_keyword' ? (ctx.target_keyword || '') : '';
      continue;
    }
    let raw = llmFields[spec.key];
    if (raw == null || (typeof raw === 'string' && !raw.trim())) {
      // Fall back to deterministic defaults; mark for review (unless optional).
      if (spec.key === 'tier') raw = defaultTier();
      else if (spec.key === 'template') raw = defaultTemplate(ctx.target_keyword, ctx.entity);
      else if (spec.key === 'entity') raw = ctx.entity || '';
      else if (spec.key === 'page_id') raw = ctx.page_id;
      else if (spec.key === 'cluster_id') raw = ctx.cluster_id;
      else if (spec.key === 'page_role') raw = ctx.cluster_cta_primary || '';
      else if (spec.key === 'psych_safety_flag') raw = defaultPsychFlag(ctx.entity, ctx.target_keyword);
      else raw = '';
      if (spec.key !== 'cta' && spec.key !== 'journal_prompts') needs.add(spec.key);
    }
    const { ok, fixed, reason } = validateField(spec.key, raw, ctx);
    out[spec.key] = fixed;
    if (!ok) {
      needs.add(spec.key);
      if (process.env.GG_BRIEF_SUGGEST_DEBUG) process.stderr.write(`[brief-suggest] coerce "${spec.key}": ${reason}\n`);
    }
  }
  // Security: page_id flows to file paths — force input value, not LLM-supplied.
  out.page_id = ctx.page_id;
  out.cluster_id = ctx.cluster_id;
  return { fields: out, needs_review: [...needs].sort() };
}

// ─── 4. Sheet helpers ─────────────────────────────────────────────────────────
async function fetchTab(workbookId, tab, token) {
  const range = encodeURIComponent(`${tab}!A1:Z2000`);
  return (await gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${range}?majorDimension=ROWS`,
    token,
  )).values || [];
}

export function findClusterRow(clusterRows, clusterId) {
  if (!clusterRows.length) return null;
  const header = clusterRows[0].map((h) => String(h || '').trim());
  const idIdx = header.indexOf('cluster_id');
  if (idIdx < 0) return null;
  for (let i = 1; i < clusterRows.length; i++) {
    const r = clusterRows[i] || [];
    if (String(r[idIdx] || '').trim() === clusterId) {
      const obj = {};
      for (let c = 0; c < header.length; c++) {
        if (header[c]) obj[header[c]] = String(r[c] || '').trim();
      }
      return obj;
    }
  }
  return null;
}

export function findRowByTargetKeyword(pagesRows, targetKeyword) {
  if (!pagesRows.length) return -1;
  const tk = String(targetKeyword).trim().toLowerCase();
  for (let i = 1; i < pagesRows.length; i++) {
    const v = String((pagesRows[i] || [])[0] || '').trim().toLowerCase();
    if (v === tk) return i + 1; // sheet row (1-indexed)
  }
  return -1;
}

// Write the writable-subset of `fields` to the given sheet row.
// One values:batchUpdate call with one range per writable column (12 ranges).
async function writeFieldsToSheet({ workbookId, token, sheetRow, fields, tab = PAGES_TAB, dryRun = false }) {
  const data = [];
  for (const spec of FIELD_SPEC) {
    if (!spec.writable) continue;
    if (!WRITABLE_COLS.has(spec.col)) continue; // defence-in-depth
    const value = fields[spec.key] == null ? '' : String(fields[spec.key]);
    data.push({ range: `${tab}!${spec.col}${sheetRow}`, values: [[value]] });
  }
  if (dryRun) return { wouldUpdate: data.length, ranges: data.map((d) => d.range) };
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values:batchUpdate`;
  return gFetch(url, token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
}

// ─── 5. LLM caller ────────────────────────────────────────────────────────────

async function callLLM({ llm, prompt }) {
  const reg = LLM_REGISTRY[llm];
  if (!reg) throw new Error(`unknown llm: ${llm} (allowed: ${Object.keys(LLM_REGISTRY).join(', ')})`);

  // Hermes wrapper needs a file path — write the prompt to a temp file first.
  let args = [...reg.args];
  let stdinContent = null;
  let tmpPath = null;
  if (reg.stdinPrompt) {
    stdinContent = prompt;
  } else {
    const tmpDir = join(REPO, '.gg-cache', 'brief-suggestions', '_prompts');
    mkdirSync(tmpDir, { recursive: true });
    tmpPath = join(tmpDir, `prompt-${process.pid}-${Date.now()}.md`);
    writeFileSync(tmpPath, prompt);
    args = [...args, '--prompt', tmpPath];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(reg.bin, args, { cwd: REPO, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`spawn ${reg.bin} failed: ${err.code || err.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`${reg.bin} exited ${code}: ${stderr.slice(-300).trim()}`));
      }
      resolve({ stdout, stderr, model: reg.label });
    });
    if (stdinContent != null) {
      child.stdin.write(stdinContent);
    }
    child.stdin.end();
  });
}

// ─── 6. Per-request driver ────────────────────────────────────────────────────

async function suggestOne({ args, workbookId, token, clusterMap, pagesRows, request }) {
  const { page_id: pageId, target_keyword: targetKeyword, cluster_id: clusterId } = request;
  const entity = request.entity || null;
  const llmKey = (args.llm || 'claude').toLowerCase();

  // 1. Validate page_id
  if (!PAGE_ID_REGEX.test(pageId || '')) {
    throw new Error(`invalid page_id "${pageId}" — must match ${PAGE_ID_REGEX}`);
  }
  if (!targetKeyword) throw new Error('--target-keyword required');
  if (!clusterId) throw new Error('--cluster-id required');

  // 2. Validate cluster_id exists in 主题集群表 (fail-loud)
  const clusterRow = clusterMap[clusterId];
  if (!clusterRow) {
    throw new Error(`cluster_id "${clusterId}" not found in 主题集群表 — fix the sheet or pick an existing cluster`);
  }

  const ctx = {
    page_id: pageId,
    target_keyword: targetKeyword,
    cluster_id: clusterId,
    entity,
    cluster_cta_primary: clusterRow.cta_primary || '',
  };

  // 3. Build prompt + call LLM
  const prompt = buildPrompt({ pageId, targetKeyword, clusterId, entity, clusterRow });
  const t0 = Date.now();
  let llmResp;
  try {
    llmResp = await callLLM({ llm: llmKey, prompt });
  } catch (e) {
    throw new Error(`LLM call failed (${llmKey}): ${e.message}`);
  }
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stderr.write(`[brief-suggest] ${llmKey} responded in ${dt}s (${llmResp.stdout.length}B)\n`);

  // 4. Parse + validate
  const { fields: llmFields, needsReview: llmNeedsReview } = parseLLMResponse(llmResp.stdout);
  const { fields, needs_review } = assembleFields({ llmFields, llmNeedsReview, ctx });

  const payload = {
    page_id: pageId,
    target_keyword: targetKeyword,
    cluster_id: clusterId,
    fields,
    llm: llmResp.model,
    needs_review,
    suggested_at: new Date().toISOString(),
  };

  // 5. Output sink
  if (args.dry_run) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else if (args.write_sheet) {
    const sheetRow = findRowByTargetKeyword(pagesRows, targetKeyword);
    if (sheetRow < 0) {
      throw new Error(`target_keyword "${targetKeyword}" not found in ${PAGES_TAB} col A — promote first`);
    }
    const result = await writeFieldsToSheet({ workbookId, token, sheetRow, fields });
    process.stderr.write(`[brief-suggest] wrote row ${sheetRow} (${result.totalUpdatedCells ?? '?'} cells)\n`);
  } else {
    // default: --write-file
    const outDir = join(REPO, '.gg-cache', 'brief-suggestions');
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${pageId}.json`);
    writeFileSync(outPath, JSON.stringify(payload, null, 2));
    process.stderr.write(`[brief-suggest] wrote ${outPath}\n`);
  }
  return payload;
}

// ─── 7. main ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    process.stdout.write(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n') + '\n');
    return 0;
  }

  loadEnv();
  const workbookId = process.env.GG_SHEETS_WORKBOOK_ID;
  if (!workbookId) {
    process.stderr.write('GG_SHEETS_WORKBOOK_ID missing in env (~/.config/gg/_gg.env)\n');
    return 2;
  }

  // Build request list (single or batch)
  let requests = [];
  if (args.batch) {
    const batchPath = args.batch;
    if (!existsSync(batchPath)) {
      process.stderr.write(`batch file not found: ${batchPath}\n`);
      return 2;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(batchPath, 'utf8'));
    } catch (e) {
      process.stderr.write(`batch JSON parse failed: ${e.message}\n`);
      return 2;
    }
    if (!Array.isArray(parsed)) {
      process.stderr.write('batch file must contain a JSON array\n');
      return 2;
    }
    requests = parsed;
  } else {
    requests = [{
      page_id: args.page_id,
      target_keyword: args.target_keyword,
      cluster_id: args.cluster_id,
      entity: args.entity,
    }];
  }

  // Resolve auth + pull cluster / pages tabs ONCE (re-used per request).
  const token = await getAccessToken();
  const [clustersRaw, pagesRaw] = await Promise.all([
    fetchTab(workbookId, CLUSTERS_TAB, token),
    args.write_sheet ? fetchTab(workbookId, PAGES_TAB, token) : Promise.resolve([]),
  ]);
  if (!clustersRaw.length) {
    process.stderr.write(`tab "${CLUSTERS_TAB}" empty — cannot validate cluster_id\n`);
    return 2;
  }
  // Build cluster_id → row dict via findClusterRow primitive
  const clusterMap = {};
  for (let i = 1; i < clustersRaw.length; i++) {
    const row = findClusterRow([clustersRaw[0], clustersRaw[i]], String((clustersRaw[i] || [])[0] || '').trim());
    if (row && row.cluster_id) clusterMap[row.cluster_id] = row;
  }

  const results = [];
  let okCount = 0;
  let failCount = 0;
  for (const req of requests) {
    try {
      const payload = await suggestOne({ args, workbookId, token, clusterMap, pagesRows: pagesRaw, request: req });
      results.push({ ok: true, page_id: req.page_id, needs_review: payload.needs_review });
      okCount += 1;
    } catch (e) {
      const note = redactNote(e);
      process.stderr.write(`[brief-suggest] FAIL ${req.page_id || '(unknown)'}: ${note}\n`);
      results.push({ ok: false, page_id: req.page_id, error: note });
      failCount += 1;
    }
  }

  process.stderr.write(`[brief-suggest] done: ${okCount} ok, ${failCount} fail (of ${requests.length})\n`);
  return failCount === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => {
    process.stderr.write(`fatal: ${e.message}\n`);
    process.exit(1);
  });
}

export { main, callLLM, suggestOne, writeFieldsToSheet, fetchTab };