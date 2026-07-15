import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeTargetRepairAgent } from './seo-repair-controller.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPTS = resolve(LIB_DIR, '..');
const DEFAULT_FLOW = resolve(DEFAULT_SCRIPTS, '../..');
const ASSET_RE = /\.(?:svg|png|jpe?g|webp|gif)$/i;

function absoluteWorktreeFile(worktree, file) {
  return isAbsolute(file) ? resolve(file) : resolve(worktree, file);
}

export async function buildAstrologyRepairTarget(event, context) {
  const changedFiles = (context.changedFiles || []).map((file) => absoluteWorktreeFile(context.worktree, file));
  return {
    site: 'astrologywiki',
    pageId: event.pageId,
    slug: event.slug || '',
    stage: event.stage,
    errorKind: event.errorKind,
    branch: context.branch,
    worktree: context.worktree,
    articleFile: absoluteWorktreeFile(context.worktree, context.articleFile),
    changedFiles,
    assetFiles: changedFiles.filter((file) => ASSET_RE.test(file)),
    verifiedLinkCandidates: context.verifiedLinkCandidates || [],
    linkCandidates: context.linkCandidates || [],
    gateEvidence: [event.summary, event.stderr].filter(Boolean).join('\n'),
    allowedActions: context.allowedActions || [],
    terminalVerifier: context.terminalVerifier || [],
  };
}

export async function verifyInternalLinkCandidate(slug, deps = {}) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ''))) return false;
  let hasRoute = false;
  let inSitemap = false;
  try { hasRoute = await deps.routeExists(slug); } catch {}
  try { inSitemap = await deps.sitemapContains(slug); } catch {}
  if (!hasRoute && !inSitemap) return false;
  try {
    const response = await deps.fetchDocument(`https://www.astrologywiki.com/en/wiki/${slug}`);
    return response?.ok === true && response?.status === 200;
  } catch { return false; }
}

function run(argv, { cwd, env = process.env, timeout = 600_000 } = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    code: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    timedOut: result.error?.code === 'ETIMEDOUT',
  };
}

function worktreeDiff(worktree) {
  const dirty = run(['git', '-C', worktree, 'status', '--porcelain'], { cwd: worktree, timeout: 60_000 });
  if (!dirty.ok) throw new Error(`cannot inspect astrology worktree: ${dirty.stderr || dirty.code}`);
  if (dirty.stdout.trim()) throw new Error(`refusing dirty astrology worktree: ${worktree}`);
  const diff = run(['git', '-C', worktree, 'diff', '--name-only', 'origin/main...HEAD'], { cwd: worktree, timeout: 60_000 });
  if (!diff.ok) throw new Error(`cannot inspect reviewed diff: ${diff.stderr || diff.code}`);
  return diff.stdout.trim().split('\n').filter(Boolean);
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'gg-seo-repair-controller/2' },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok ? await response.text() : '';
  } catch { return ''; }
}

async function collectLinkCandidates(worktree, currentSlug) {
  const articleDir = join(worktree, 'data', 'articles');
  let slugs = [];
  try {
    slugs = readdirSync(articleDir)
      .filter((name) => name.endsWith('.ts') && name !== 'index.ts')
      .map((name) => name.replace(/\.ts$/, ''))
      .filter((slug) => slug !== currentSlug && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
  } catch { return []; }
  const sitemap = await fetchText('https://www.astrologywiki.com/sitemap.xml');
  const liveSlugs = new Set([...sitemap.matchAll(/<loc>https:\/\/(?:www\.)?astrologywiki\.com\/en\/wiki\/([a-z0-9-]+)<\/loc>/gi)]
    .map((match) => match[1]));
  return slugs
    .filter((slug) => liveSlugs.has(slug))
    .sort()
    .map((slug) => ({
      slug,
      url: `https://www.astrologywiki.com/en/wiki/${slug}`,
      anchorIntent: slug.replace(/-/g, ' '),
      evidence: ['repo_route', 'production_sitemap'],
    }));
}

async function defaultResolveContext(event) {
  const ops = process.env.GG_OPS_DIR || join(homedir(), 'gengrowth-ops');
  const claimsPath = process.env.GG_AUTOPILOT_CLAIMS
    || join(ops, 'inbox/06-tasks/tasks/.autopilot-claims.json');
  let claims;
  try { claims = JSON.parse(readFileSync(claimsPath, 'utf8')); }
  catch (error) { throw new Error(`cannot read astrology claims: ${error.message}`); }
  const claim = claims?.[event.pageId];
  if (!claim?.branch) throw new Error(`claim branch missing for ${event.pageId}`);
  const worktreeRoot = process.env.GG_ORACLE_WORKTREE_ROOT
    || join(homedir(), 'oracle-worktrees', 'seo-autopilot');
  const worktree = claim.worktree
    || join(worktreeRoot, String(claim.branch).replace(/[^A-Za-z0-9._-]+/g, '__'));
  if (!existsSync(worktree)) throw new Error(`astrology worktree missing: ${worktree}`);
  const articleFile = join(worktree, 'data', 'articles', `${claim.slug || event.slug}.ts`);
  if (!existsSync(articleFile)) throw new Error(`astrology article missing: ${articleFile}`);
  return {
    claim,
    branch: claim.branch,
    worktree,
    articleFile,
    changedFiles: worktreeDiff(worktree),
    linkCandidates: await collectLinkCandidates(worktree, claim.slug || event.slug),
    allowedActions: [
      ['node', join(DEFAULT_SCRIPTS, 'gg-seo-autopilot.mjs'), '--retry-failed', '--branch', claim.branch],
      ['node', join(DEFAULT_SCRIPTS, 'gg-preview-gate.mjs'), '--branch', claim.branch],
    ],
    terminalVerifier: [
      'node', join(DEFAULT_SCRIPTS, 'gg-seo-repair-verify.mjs'),
      '--site', 'astrologywiki', '--page-id', event.pageId, '--slug', claim.slug || event.slug, '--json',
    ],
  };
}

async function defaultRegate(target) {
  const reset = run([
    'node',
    join(DEFAULT_SCRIPTS, 'gg-seo-autopilot.mjs'),
    '--retry-failed',
    '--branch',
    target.branch,
  ], { cwd: DEFAULT_FLOW, timeout: 180_000 });
  if (!reset.ok) return reset;
  return run([
    'node',
    join(DEFAULT_SCRIPTS, 'gg-preview-gate.mjs'),
    '--branch',
    target.branch,
  ], { cwd: DEFAULT_FLOW, timeout: 45 * 60 * 1000 });
}

async function defaultInvokeAgent(target, { record, strategy }) {
  return invokeTargetRepairAgent({ target, record, strategy });
}

async function defaultVerifyTerminal(event, target, { scriptsDir, runCommand }) {
  const result = await runCommand([
    'node',
    join(scriptsDir, 'gg-seo-repair-verify.mjs'),
    '--site', 'astrologywiki',
    '--page-id', event.pageId,
    '--slug', target.slug,
    '--json',
  ]);
  for (const line of String(result.stdout || '').trim().split('\n').reverse()) {
    try {
      const output = JSON.parse(line);
      return output?.results?.[0] || output;
    } catch {}
  }
  return { ok: false, terminal: 'pending', reason: result.stderr || `verifier exited ${result.code}` };
}

export function createAstrologyWikiRepairAdapter(deps = {}) {
  const scriptsDir = resolve(deps.scriptsDir || DEFAULT_SCRIPTS);
  const runCommand = deps.runCommand || (async (argv) => run(argv, { cwd: DEFAULT_FLOW, timeout: 180_000 }));
  const resolveContext = deps.resolveContext || defaultResolveContext;
  const verifyLinkCandidate = deps.verifyLinkCandidate || (async (slug, context) => {
    const known = context.linkCandidates?.some((candidate) => candidate.slug === slug);
    return known === true;
  });
  const invokeAgent = deps.invokeAgent || defaultInvokeAgent;
  const regate = deps.regate || defaultRegate;
  const publish = deps.publish || (async () => ({ ok: true, ownedByRegate: true }));
  const verifyTerminal = deps.verifyTerminal
    || ((event, target) => defaultVerifyTerminal(event, target, { scriptsDir, runCommand }));

  return {
    async execute({ record, strategy }) {
      const event = record.event;
      if (event.errorKind === 'stale') {
        return {
          terminal: 'archived',
          evidence: { type: 'unpublishable', summary: event.summary, logFile: event.logFile },
        };
      }
      const context = await resolveContext(event);
      const verifiedLinkCandidates = [];
      for (const candidate of context.linkCandidates || []) {
        if (await verifyLinkCandidate(candidate.slug, context)) verifiedLinkCandidates.push(candidate);
      }
      const target = await buildAstrologyRepairTarget(event, {
        ...context,
        verifiedLinkCandidates,
      });

      const needsAgent = ['agent_content_asset_link', 'agent_diagnosis', 'agent_code_environment']
        .includes(strategy);
      if (needsAgent) {
        const repaired = await invokeAgent(target, { record, strategy });
        if (repaired?.ok !== true) {
          return {
            ok: false,
            evidence: repaired?.evidence || { type: 'agent_repair_failed' },
          };
        }
      }

      const gated = await regate(target, { record, strategy });
      if (gated?.ok !== true) {
        return { ok: false, evidence: { type: 'regate_failed', result: gated || null } };
      }
      const published = await publish(target, { record, strategy });
      if (published?.ok !== true) {
        return { ok: false, evidence: { type: 'publish_failed', result: published || null } };
      }
      const verified = await verifyTerminal(event, target);
      if (verified?.ok === true && verified?.terminal === 'published') {
        return { terminal: 'published', evidence: verified };
      }
      return {
        ok: false,
        evidence: { type: 'terminal_verifier_failed', verification: verified || null },
      };
    },
  };
}
