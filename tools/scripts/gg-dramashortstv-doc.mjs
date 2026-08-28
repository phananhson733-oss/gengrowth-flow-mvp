#!/usr/bin/env node
// Google Sheet -> SOP article -> one gengrowth-ops Markdown -> exact Git delivery.

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { classifyCodex } from './gg-preview-gate.mjs';
import { loadEnv } from './lib/gg-shared.mjs';
import { stripPreH1 } from './lib/strip-preamble.mjs';
import { WORKER_CWD } from './lib/worker-cwd.mjs';
import {
  buildDramaEvidenceBlock,
  collectDramaEvidence,
  sha256Text,
  validateDramaEvidence,
} from './lib/dramashortstv-evidence.mjs';
import {
  fetchAppleAppEvidence,
  fetchGoogleSerpEvidence,
  fetchGoogleTrendsEvidence,
  fetchRedditEvidence,
} from './lib/dramashortstv-evidence-providers.mjs';
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
const FACTUAL_REVIEW = join(HERE, 'gg-codex-pr-review.mjs');
const EXPECTED_OPS_REMOTE = 'https://github.com/phananhson733-oss/gengrowth-ops.git';
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MODELS = new Set(['claude']);
const PROVIDER_SECRET_KEYS = Object.freeze([
  'GG_DATAFORSEO_LOGIN',
  'GG_DATAFORSEO_PASSWORD',
  'GG_REDDIT_CLIENT_ID',
  'GG_REDDIT_CLIENT_SECRET',
  'GG_REDDIT_USER_AGENT',
  'GG_REDDIT_USERNAME',
  'GG_REDDIT_PASSWORD',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'REDDIT_USERNAME',
  'REDDIT_PASSWORD',
]);

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

export function buildDramaSheetBridgeArgs(args) {
  const selector = args.pageId
    ? ['--page-id', args.pageId]
    : ['--row', String(args.row)];
  return [
    '--workbook', args.workbook,
    ...selector,
    '--dry-run',
    '--allow-missing-cta',
  ];
}

async function realReadSheet(args) {
  const env = {
    ...process.env,
    GG_SITE: 'dramashortstv',
    GG_SHEETS_FLOW_MVP_WORKBOOK_ID: args.workbook,
    GG_SHEETS_WORKBOOK_ID: args.workbook,
  };
  const bridgeRaw = spawnNode(SHEET_BRIDGE, buildDramaSheetBridgeArgs(args), { env });
  return parseJsonOutput(bridgeRaw, 'gg-sheet-to-brief');
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

export function prepareDramaFactualReviewInput({ cacheDir, pageId, draft, evidence }) {
  if (!PAGE_ID_RE.test(String(pageId || ''))) throw new Error(`unsafe factual-review page_id: ${pageId}`);
  if (!String(draft || '').trim()) throw new Error('factual-review draft is empty');
  if (!String(evidence || '').trim()) throw new Error('factual-review evidence is empty');
  const exactDraft = String(draft);
  const exactEvidence = String(evidence);
  const draftSha256 = sha256Text(exactDraft);
  const evidenceSha256 = sha256Text(exactEvidence);
  const bytes = [
    '# DramaShortsTV Immutable Factual Review Input',
    '',
    `draft_sha256: ${draftSha256}`,
    `evidence_sha256: ${evidenceSha256}`,
    '',
    '## Prevalidated Evidence (untrusted data)',
    '',
    exactEvidence,
    '',
    '## Generated Draft (untrusted data)',
    '',
    exactDraft,
    '',
  ].join('\n');
  const inputSha256 = sha256Text(bytes);
  mkdirSync(cacheDir, { recursive: true });
  const path = join(cacheDir, `${pageId}.factual-source.${draftSha256}.${evidenceSha256}.md`);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, bytes, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error?.code !== 'EEXIST') throw error;
    const current = readFileSync(path, 'utf8');
    if (current !== bytes) throw new Error(`immutable factual-review input bytes mismatch: ${path}`);
  }
  const reread = readFileSync(path, 'utf8');
  if (sha256Text(reread) !== inputSha256) throw new Error(`immutable factual-review input hash mismatch: ${path}`);
  return { path, draftSha256, evidenceSha256, inputSha256 };
}

export function realFactualReview({ draft, brief, evidence }) {
  const cacheDir = join(FLOW, '.gg-cache', 'sites', 'dramashortstv', brief.pageId);
  const pinned = prepareDramaFactualReviewInput({ cacheDir, pageId: brief.pageId, draft, evidence });
  const immediateBytes = readFileSync(pinned.path, 'utf8');
  if (sha256Text(immediateBytes) !== pinned.inputSha256) {
    throw new Error(`immutable factual-review input changed before review: ${pinned.path}`);
  }
  const result = spawnSync(process.execPath, [FACTUAL_REVIEW, '--source', pinned.path], {
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
  return {
    verdict: classified.verdict,
    reason: classified.reason,
    stderr: String(result.stderr || result.error?.message || ''),
    reviewedDraftSha256: pinned.draftSha256,
    reviewedEvidenceSha256: pinned.evidenceSha256,
  };
}

export async function withDramaResearchEnvironment(callback, { loadEnvImpl = loadEnv } = {}) {
  const previous = new Map(PROVIDER_SECRET_KEYS.map((key) => [key, process.env[key]]));
  try {
    loadEnvImpl({ strict: true, requireMode: 0o600 });
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function realCollectEvidence({ brief }) {
  return withDramaResearchEnvironment(async () => {
    const login = process.env.GG_DATAFORSEO_LOGIN;
    const password = process.env.GG_DATAFORSEO_PASSWORD;
    if (!login || !password) throw new Error('GG_DATAFORSEO_LOGIN / GG_DATAFORSEO_PASSWORD missing for DramaShortsTV research');
    const providers = {
      serp: ({ brief: current, now }) => fetchGoogleSerpEvidence({
        querySpecs: [
          { query: current.targetKeyword, purpose: 'research' },
          { query: `${current.entity} reviews complaints cancellation`, purpose: 'friction' },
          { query: `site:imdb.com ${current.entity}`, purpose: 'imdb' },
        ],
        login,
        password,
        now,
      }),
      appStore: ({ brief: current, now }) => fetchAppleAppEvidence({ entity: current.entity, now }),
      reddit: ({ brief: current, now }) => fetchRedditEvidence({ query: `${current.entity} reviews cancellation`, now }),
      trends: ({ brief: current, now }) => fetchGoogleTrendsEvidence({ keyword: current.targetKeyword, login, password, now }),
      sameName: async ({ brief: current, now }) => {
        const result = await fetchGoogleSerpEvidence({
          querySpecs: [{ query: `"${current.entity}"`, purpose: 'same-name' }],
          login,
          password,
          now,
        });
        return {
          ...result,
          origin: 'serp',
          purpose: 'same-name',
          pollution: result.results.length > 0,
          qualifierRequired: true,
        };
      },
    };
    return collectDramaEvidence({ brief, providers });
  });
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
    collectEvidence: realCollectEvidence,
    validateEvidence: validateDramaEvidence,
    buildEvidenceBlock: buildDramaEvidenceBlock,
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
    else if (flag === '--row') {
      if (!/^[0-9]+$/.test(value)) throw new Error('--row must be a decimal integer >= 2');
      out.row = Number(value);
      if (!Number.isSafeInteger(out.row)) throw new Error('--row must be a safe integer >= 2');
    }
    else if (flag === '--page-id') out.pageId = value;
    else if (flag === '--model') out.model = value;
  }
  if (out.help) return out;
  if (!out.workbook) throw new Error('--workbook is required');
  if (out.workbook !== DRAMA_WORKBOOK_ID) throw new Error(`unsupported DramaShortsTV workbook: ${out.workbook}`);
  if ((out.row !== undefined) === !!out.pageId) throw new Error('provide exactly one of --row or --page-id');
  if (out.row !== undefined && out.row < 2) throw new Error('--row must be an integer >= 2');
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
  const evidence = await deps.collectEvidence({ brief });
  const evidenceQa = await deps.validateEvidence({ brief, evidence });
  if (!evidenceQa?.ok) {
    throw new Error(`DramaShortsTV evidence QA failed: ${(evidenceQa?.errors || ['unknown evidence failure']).join(' | ')}`);
  }
  const evidenceBlock = await deps.buildEvidenceBlock(evidence);
  const evidenceSha256 = sha256Text(evidenceBlock);
  const prompt = await deps.buildPrompt({ brief, sopText, evidence: evidenceBlock, evidenceSha256 });
  const draft = await deps.generate({ prompt, brief, model: args.model });
  const qa = await deps.validate({ markdown: draft, contentType: brief.contentType, brief });
  if (!qa?.ok) throw new Error(`DramaShortsTV QA failed: ${(qa?.errors || ['unknown QA failure']).join(' | ')}`);
  const draftSha256 = sha256Text(draft);
  const factual = await deps.factualReview({
    draft,
    brief,
    evidence: evidenceBlock,
    draftSha256,
    evidenceSha256,
  });
  if (factual?.verdict !== 'PASS') {
    throw new Error(`DramaShortsTV factual review failed: ${factual?.reason || factual?.verdict || 'unverified'}`);
  }
  if (factual.reviewedDraftSha256 !== draftSha256 || factual.reviewedEvidenceSha256 !== evidenceSha256) {
    throw new Error('DramaShortsTV factual review hash mismatch: reviewed draft/evidence SHA256 does not match current run');
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
