#!/usr/bin/env node
// Google Sheet -> SOP article -> one gengrowth-ops Markdown -> exact Git delivery.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyCodex } from './gg-preview-gate.mjs';
import { stripPreH1 } from './lib/strip-preamble.mjs';
import { WORKER_CWD } from './lib/worker-cwd.mjs';
import {
  DRAMA_WORKBOOK_ID,
  atomicWriteDramaDocument,
  buildDramaPrompt,
  formatDramaDocument,
  normalizeDramaBrief,
  resolveDramaOutputPath,
  validateDramaDraft,
} from './lib/dramashortstv-doc.mjs';
import {
  commitAndPushDramaDocument,
  findDeliveredDramaDocument,
  preflightDramaOpsRepo,
} from './lib/dramashortstv-git.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOW = resolve(HERE, '..', '..');
const HOME = homedir();
const SHEET_BRIDGE = join(HERE, 'gg-sheet-to-brief.mjs');
const SHEET_PULL = join(HERE, 'gg-sheet-pull.mjs');
const FACTUAL_REVIEW = join(HERE, 'gg-codex-pr-review.mjs');
const EXPECTED_OPS_REMOTE = 'https://github.com/phananhson733-oss/gengrowth-ops.git';
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODELS = new Set(['claude']);

function usage() {
  return `gg-dramashortstv-doc.mjs — read-only Sheet to exact gengrowth-ops Markdown/Git delivery

Usage:
  node tools/scripts/gg-dramashortstv-doc.mjs \\
    --workbook ${DRAMA_WORKBOOK_ID} --row 4 [--model claude] [--apply] [--json]
  node tools/scripts/gg-dramashortstv-doc.mjs \\
    --workbook ${DRAMA_WORKBOOK_ID} --page-id page_dramabox_vs_reelshort [--apply] [--json]

Default is dry-run: reads Sheet data and prints the planned document path without LLM, Ops, or Git writes.
`;
}

function spawnNode(script, args, { env = process.env, timeout = 120000 } = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: FLOW,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim().split('\n').slice(-5).join(' | ');
    throw new Error(`${script.split('/').pop()} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '');
}

function parseJsonOutput(raw, label) {
  try {
    return JSON.parse(String(raw || ''));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON: ${error.message}`);
  }
}

function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function topicSlug(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error(`cannot derive safe topic slug from: ${value}`);
  return slug;
}

function filterPayloadToPageId(payload, pageId) {
  const row = payload?.[pageId];
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`page_id not found in normalized Sheet bridge: ${pageId}`);
  }
  return { ...(payload._source ? { _source: payload._source } : {}), [pageId]: row };
}

async function realReadSheet(args) {
  let row = args.row;
  const env = {
    ...process.env,
    GG_SITE: 'dramashortstv',
    GG_SHEETS_FLOW_MVP_WORKBOOK_ID: args.workbook,
    GG_SHEETS_WORKBOOK_ID: args.workbook,
  };
  if (args.pageId) {
    const pullRaw = spawnNode(SHEET_PULL, [
      '--tab', '选题登记表', '--rows', '2-1000', '--limit', '1000', '--dry-run',
    ], { env });
    const pull = parseJsonOutput(pullRaw, 'gg-sheet-pull');
    const matches = (pull.rows || []).filter((entry) => entry?.page_id === args.pageId);
    if (matches.length !== 1) throw new Error(`expected exactly one Sheet row for ${args.pageId}, got ${matches.length}`);
    row = matches[0].source_row;
  }
  const bridgeRaw = spawnNode(SHEET_BRIDGE, [
    '--workbook', args.workbook,
    '--row', String(row),
    '--dry-run',
    '--allow-missing-cta',
  ], { env });
  const payload = parseJsonOutput(bridgeRaw, 'gg-sheet-to-brief');
  return args.pageId ? filterPayloadToPageId(payload, args.pageId) : payload;
}

export function buildDramaWorkerCommand({ model, effort }) {
  return {
    bin: 'claude',
    args: [
      '-p',
      '--model', model,
      '--effort', effort,
      '--tools', '',
      '--safe-mode',
      '--no-chrome',
      '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk',
      '--no-session-persistence',
      '--max-budget-usd', '5',
    ],
  };
}

function realGenerate({ prompt, brief, model }) {
  if (model !== 'claude') throw new Error(`unsupported DramaShortsTV generation provider: ${model}`);
  const cacheDir = join(FLOW, '.gg-cache', 'sites', 'dramashortstv', brief.pageId);
  mkdirSync(cacheDir, { recursive: true });
  const promptPath = join(cacheDir, `${brief.pageId}.prompt.md`);
  writeFileSync(promptPath, prompt);
  const command = buildDramaWorkerCommand({
    model: process.env.GG_DRAMASHORTSTV_CLAUDE_MODEL || 'claude-sonnet-4-6',
    effort: process.env.GG_DRAMASHORTSTV_CLAUDE_EFFORT || 'high',
  });
  const result = spawnSync(command.bin, command.args, {
    cwd: WORKER_CWD,
    input: prompt,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.error?.message || '').trim().split('\n').slice(-5).join(' | ');
    throw new Error(`DramaShortsTV text worker failed${detail ? `: ${detail}` : ''}`);
  }
  const draft = stripPreH1(String(result.stdout || '')).trim();
  if (!draft) throw new Error('DramaShortsTV text worker produced an empty draft');
  const draftPath = join(cacheDir, `${brief.pageId}-claude-v8.md`);
  writeFileSync(draftPath, `${draft}\n`);
  return draft;
}

function realFactualReview({ draft, brief }) {
  const cacheDir = join(FLOW, '.gg-cache', 'sites', 'dramashortstv', brief.pageId);
  mkdirSync(cacheDir, { recursive: true });
  const reviewPath = join(cacheDir, `${brief.pageId}.factual-source.md`);
  writeFileSync(reviewPath, draft);
  const result = spawnSync(process.execPath, [FACTUAL_REVIEW, '--source', reviewPath], {
    cwd: FLOW,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const classified = classifyCodex({
    code: result.status ?? 1,
    stdout: result.stdout,
    timedOut,
  });
  return { verdict: classified.verdict, reason: classified.reason, stderr: String(result.stderr || result.error?.message || '') };
}

function realDependencies() {
  const opsDir = process.env.GG_DRAMASHORTSTV_OPS_DIR || join(HOME, 'gengrowth-ops');
  const sopPath = process.env.GG_DRAMASHORTSTV_SOP_PATH
    || join(opsDir, 'inbox-maboyang', '05-blog', 'dramashortstv', '2026-08-26-dramashortstv-blog写作SOP-v1.0.md');
  return {
    opsDir,
    today: () => shanghaiDate(),
    readSheet: realReadSheet,
    normalize: normalizeDramaBrief,
    resolveOutputPath: resolveDramaOutputPath,
    gitPreflight: () => preflightDramaOpsRepo({ opsDir, expectedRemote: EXPECTED_OPS_REMOTE }),
    findExisting: ({ brief }) => findDeliveredDramaDocument({
      opsDir,
      pageId: brief.pageId,
      expectedRemote: EXPECTED_OPS_REMOTE,
    }),
    readSop: () => readFileSync(sopPath, 'utf8'),
    buildPrompt: buildDramaPrompt,
    generate: realGenerate,
    validate: validateDramaDraft,
    factualReview: realFactualReview,
    format: formatDramaDocument,
    write: atomicWriteDramaDocument,
    gitDeliver: ({ targetPath, topicSlug: slug }) => commitAndPushDramaDocument({
      opsDir,
      relativePath: relative(opsDir, targetPath).replaceAll('\\', '/'),
      topicSlug: slug,
      expectedRemote: EXPECTED_OPS_REMOTE,
    }),
  };
}

export function parseDramaArgs(argv) {
  const out = { apply: false, json: false, model: 'claude' };
  const valueFlags = new Set(['--workbook', '--row', '--page-id', '--model']);
  const booleanFlags = new Set(['--apply', '--json', '--help', '-h']);
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (booleanFlags.has(flag)) {
      if (flag === '--apply') out.apply = true;
      else if (flag === '--json') out.json = true;
      else out.help = true;
      continue;
    }
    if (!valueFlags.has(flag)) throw new Error(`unknown flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--workbook') out.workbook = value;
    else if (flag === '--row') out.row = Number.parseInt(value, 10);
    else if (flag === '--page-id') out.pageId = value;
    else if (flag === '--model') out.model = value;
  }
  if (out.help) return out;
  if (!out.workbook) throw new Error('--workbook is required');
  if (out.workbook !== DRAMA_WORKBOOK_ID) throw new Error(`unsupported DramaShortsTV workbook: ${out.workbook}`);
  if (!!out.row === !!out.pageId) throw new Error('provide exactly one of --row or --page-id');
  if (out.row && (!Number.isInteger(out.row) || out.row < 2)) throw new Error('--row must be an integer >= 2');
  if (out.pageId && !PAGE_ID_RE.test(out.pageId)) throw new Error(`unsafe --page-id: ${out.pageId}`);
  if (!MODELS.has(out.model)) throw new Error(`unsupported --model: ${out.model}`);
  return out;
}

export async function runDramaShortsDelivery(args, deps = realDependencies()) {
  const payload = await deps.readSheet(args);
  const brief = await deps.normalize(payload);
  const date = deps.today();
  const slug = topicSlug(brief.targetKeyword);
  const targetPath = deps.resolveOutputPath({ opsDir: deps.opsDir, date, topicSlug: slug });
  if (!args.apply) {
    return {
      mode: 'dry-run',
      workbook: args.workbook,
      sourceRow: brief.sourceRow,
      pageId: brief.pageId,
      contentType: brief.contentType,
      targetPath,
    };
  }

  const preflight = await deps.gitPreflight({ targetPath, brief });
  const existing = await deps.findExisting({ targetPath, brief });
  if (existing) {
    return {
      mode: 'apply',
      workbook: args.workbook,
      sourceRow: brief.sourceRow,
      pageId: brief.pageId,
      contentType: brief.contentType,
      targetPath: resolve(deps.opsDir, existing.relativePath),
      preflight,
      write: { status: 'unchanged' },
      git: existing,
    };
  }
  const sopText = await deps.readSop({ brief });
  const prompt = await deps.buildPrompt({ brief, sopText });
  const draft = await deps.generate({ prompt, brief, model: args.model });
  const qa = await deps.validate({ markdown: draft, contentType: brief.contentType, brief });
  if (!qa?.ok) throw new Error(`DramaShortsTV QA failed: ${(qa?.errors || ['unknown QA failure']).join(' | ')}`);
  const factual = await deps.factualReview({ draft, brief });
  if (factual?.verdict !== 'PASS') {
    throw new Error(`DramaShortsTV factual review failed: ${factual?.reason || factual?.verdict || 'unverified'}`);
  }
  const document = await deps.format({ draft, brief, date });
  const writeResult = await deps.write({ opsDir: deps.opsDir, targetPath, content: document });
  const git = await deps.gitDeliver({ targetPath, topicSlug: slug, brief });
  return {
    mode: 'apply',
    workbook: args.workbook,
    sourceRow: brief.sourceRow,
    pageId: brief.pageId,
    contentType: brief.contentType,
    targetPath,
    preflight,
    write: writeResult,
    git,
  };
}

async function main() {
  try {
    const args = parseDramaArgs(process.argv.slice(2));
    if (args.help) {
      process.stdout.write(usage());
      return;
    }
    const result = await runDramaShortsDelivery(args);
    if (args.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`DramaShortsTV ${result.mode}: ${result.pageId} -> ${result.targetPath}\n`);
      if (result.git) process.stdout.write(`Git ${result.git.status}: ${result.git.commitSha}\n`);
    }
  } catch (error) {
    process.stderr.write(`gg-dramashortstv-doc ERROR: ${error.message}\n`);
    process.exitCode = 1;
  }
}

const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) await main();
