import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  const slug = event.slug || '';
  const supportPlan = resolve(context.worktree, 'scripts', 'plans', `auto-${slug}.json`);
  return {
    site: 'astrologywiki',
    pageId: event.pageId,
    slug,
    stage: event.stage,
    errorKind: event.errorKind,
    branch: context.branch,
    worktree: context.worktree,
    originalWorktree: context.originalWorktree || null,
    articleFile: absoluteWorktreeFile(context.worktree, context.articleFile),
    changedFiles,
    assetFiles: changedFiles.filter((file) => ASSET_RE.test(file)),
    supportFiles: changedFiles.filter((file) => file === supportPlan),
    verifiedLinkCandidates: context.verifiedLinkCandidates || [],
    linkCandidates: context.linkCandidates || [],
    gateEvidence: [event.summary, event.stderr].filter(Boolean).join('\n'),
    allowedActions: context.allowedActions || [],
    terminalVerifier: context.terminalVerifier || [],
  };
}

export function editableAstrologyFiles(target) {
  return [...new Set([
    target.articleFile,
    ...(target.assetFiles || []),
    ...(target.supportFiles || []),
  ].map((file) => relative(target.worktree, file))
    .filter((file) => file && file !== '..' && !file.startsWith(`..${sep}`) && !isAbsolute(file)))];
}

export function isSafeAstrologyMergeIndex(target, state) {
  const editable = new Set(editableAstrologyFiles(target));
  return Boolean(state?.mergeHead)
    && state.mergeHead === state.originMain
    && Array.isArray(state.unmergedFiles)
    && state.unmergedFiles.length === 0
    && Array.isArray(state.unstagedFiles)
    && state.unstagedFiles.length === 0
    && Array.isArray(state.diffAgainstMain)
    && state.diffAgainstMain.every((file) => editable.has(file));
}

export function selectAstrologyChangedFiles({ reviewedFiles = [], dirtyFiles = [], mergeState = null } = {}) {
  if (mergeState?.mergeHead && Array.isArray(mergeState.diffAgainstMain)) {
    return [...new Set(mergeState.diffAgainstMain)];
  }
  return [...new Set([...reviewedFiles, ...dirtyFiles])];
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
  const diff = run(['git', '-C', worktree, 'diff', '--name-only', 'origin/main...HEAD'], { cwd: worktree, timeout: 60_000 });
  if (!diff.ok) throw new Error(`cannot inspect reviewed diff: ${diff.stderr || diff.code}`);
  return diff.stdout.trim().split('\n').filter(Boolean);
}

export function parseGitStatusPaths(output) {
  return String(output || '').split(/\r?\n/)
    .filter((line) => line.length >= 4)
    .map(statusPath);
}

export function isSafeAstrologyTargetPath(file, slug) {
  const targetSlug = String(slug || '');
  const path = String(file || '');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(targetSlug)) return false;
  if (!path || isAbsolute(path) || path.split('/').includes('..')) return false;
  if (path === `data/articles/${targetSlug}.ts`) return true;
  if (path === `scripts/plans/auto-${targetSlug}.json`) return true;
  const assetPrefix = `public/images/blog/${targetSlug}`;
  if (!path.startsWith(assetPrefix) || !ASSET_RE.test(path)) return false;
  const suffix = path.slice(assetPrefix.length);
  return suffix.startsWith('.') || suffix.startsWith('-');
}

function worktreeDirtyPaths(worktree) {
  const status = run([
    'git', '-C', worktree, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { cwd: worktree, timeout: 60_000 });
  if (!status.ok) throw new Error(`cannot inspect repair worktree: ${status.stderr || status.code}`);
  return parseGitStatusPaths(status.stdout);
}

function inspectAstrologyMergeState(worktree) {
  const mergeHead = run([
    'git', '-C', worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD',
  ], { cwd: worktree, timeout: 60_000 });
  if (!mergeHead.ok || !mergeHead.stdout.trim()) return null;
  const originMain = run([
    'git', '-C', worktree, 'rev-parse', 'origin/main',
  ], { cwd: worktree, timeout: 60_000 });
  const unmerged = run([
    'git', '-C', worktree, 'diff', '--name-only', '--diff-filter=U',
  ], { cwd: worktree, timeout: 60_000 });
  const unstaged = run([
    'git', '-C', worktree, 'diff', '--name-only',
  ], { cwd: worktree, timeout: 60_000 });
  const diffAgainstMain = run([
    'git', '-C', worktree, 'diff', '--cached', '--name-only', 'origin/main',
  ], { cwd: worktree, timeout: 60_000 });
  if (!originMain.ok || !unmerged.ok || !unstaged.ok || !diffAgainstMain.ok) {
    throw new Error('cannot inspect staged astrology merge index');
  }
  return {
    mergeHead: mergeHead.stdout.trim(),
    originMain: originMain.stdout.trim(),
    unmergedFiles: unmerged.stdout.trim().split('\n').filter(Boolean),
    unstagedFiles: unstaged.stdout.trim().split('\n').filter(Boolean),
    diffAgainstMain: diffAgainstMain.stdout.trim().split('\n').filter(Boolean),
  };
}

function repairWorktreeName(event) {
  const id = String(event.eventId || 'event').replace(/[^A-Za-z0-9]/g, '').slice(0, 12) || 'event';
  return `${String(event.pageId).replace(/[^A-Za-z0-9._-]/g, '_')}-${id}`;
}

function prepareRepairWorktree(event, claim, originalWorktree) {
  const root = resolve(process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT
    || join(homedir(), 'oracle-worktrees', 'seo-repair-controller'));
  const worktree = join(root, repairWorktreeName(event));
  if (!existsSync(worktree)) {
    mkdirSync(root, { recursive: true });
    const added = run([
      'git', '-C', originalWorktree, 'worktree', 'add', '--detach', worktree, 'HEAD',
    ], { cwd: originalWorktree, timeout: 180_000 });
    if (!added.ok) throw new Error(`cannot create clean repair worktree: ${added.stderr || added.code}`);
  }
  const dirtyPaths = worktreeDirtyPaths(worktree);
  const targetSlug = claim.slug || event.slug;
  const mergeState = inspectAstrologyMergeState(worktree);
  if (mergeState) {
    const provisionalTarget = {
      worktree,
      articleFile: join(worktree, 'data', 'articles', `${targetSlug}.ts`),
      assetFiles: mergeState.diffAgainstMain
        .filter((file) => isSafeAstrologyTargetPath(file, targetSlug) && ASSET_RE.test(file))
        .map((file) => join(worktree, file)),
      supportFiles: mergeState.diffAgainstMain
        .filter((file) => file === `scripts/plans/auto-${targetSlug}.json`)
        .map((file) => join(worktree, file)),
    };
    if (!isSafeAstrologyMergeIndex(provisionalTarget, mergeState)) {
      throw new Error(`repair worktree has unsafe staged merge: ${worktree}`);
    }
  } else {
    const unsafePaths = dirtyPaths.filter((file) => !isSafeAstrologyTargetPath(file, targetSlug));
    if (unsafePaths.length) {
      throw new Error(`repair worktree has non-target changes: ${unsafePaths.join(', ')}`);
    }
  }
  const sourceHead = run(['git', '-C', originalWorktree, 'rev-parse', 'HEAD'], { cwd: originalWorktree, timeout: 60_000 });
  const repairHead = run(['git', '-C', worktree, 'rev-parse', 'HEAD'], { cwd: worktree, timeout: 60_000 });
  if (!sourceHead.ok || !repairHead.ok) throw new Error(`cannot resolve repair branch head for ${event.pageId}`);
  if (sourceHead.stdout.trim() !== repairHead.stdout.trim()) {
    const sourceContainsRepair = run([
      'git', '-C', worktree, 'merge-base', '--is-ancestor', repairHead.stdout.trim(), sourceHead.stdout.trim(),
    ], { cwd: worktree, timeout: 60_000 });
    if (sourceContainsRepair.code === 0) {
      const advanced = run([
        'git', '-C', worktree, 'merge', '--ff-only', sourceHead.stdout.trim(),
      ], { cwd: worktree, timeout: 60_000 });
      if (!advanced.ok) throw new Error(`cannot advance clean repair worktree: ${advanced.stderr || advanced.code}`);
    } else {
      const repairContainsSource = run([
        'git', '-C', worktree, 'merge-base', '--is-ancestor', sourceHead.stdout.trim(), repairHead.stdout.trim(),
      ], { cwd: worktree, timeout: 60_000 });
      if (repairContainsSource.code !== 0) throw new Error(`repair worktree diverged for ${event.pageId}`);
    }
  }
  return worktree;
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
  const originalWorktree = claim.worktree
    || join(worktreeRoot, String(claim.branch).replace(/[^A-Za-z0-9._-]+/g, '__'));
  if (!existsSync(originalWorktree)) throw new Error(`astrology worktree missing: ${originalWorktree}`);
  const worktree = prepareRepairWorktree(event, claim, originalWorktree);
  const articleFile = join(worktree, 'data', 'articles', `${claim.slug || event.slug}.ts`);
  if (!existsSync(articleFile)) throw new Error(`astrology article missing: ${articleFile}`);
  const changedFiles = selectAstrologyChangedFiles({
    reviewedFiles: worktreeDiff(worktree),
    dirtyFiles: worktreeDirtyPaths(worktree),
    mergeState: inspectAstrologyMergeState(worktree),
  });
  return {
    claim,
    branch: claim.branch,
    worktree,
    originalWorktree,
    articleFile,
    changedFiles,
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
  if (!reset.ok && !isAlreadyRegatableRetryFailure(reset)) return reset;
  return run([
    'node',
    join(DEFAULT_SCRIPTS, 'gg-preview-gate.mjs'),
    '--branch',
    target.branch,
  ], { cwd: DEFAULT_FLOW, timeout: 45 * 60 * 1000 });
}

export function isAlreadyRegatableRetryFailure(result) {
  if (result?.ok === true) return false;
  return /cannot retry\s+\S+\s+from status "pushed-preview"\s+[^\n]*expected needs_human/i
    .test(`${result?.stdout || ''}\n${result?.stderr || ''}`);
}

async function defaultInvokeAgent(target, { record, strategy }) {
  return invokeTargetRepairAgent({ target, record, strategy });
}

function statusPath(line) {
  const raw = String(line || '').slice(3);
  const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return path.replace(/^"|"$/g, '');
}

async function defaultPersistRepair(target) {
  if (!/^seo\/auto\/[A-Za-z0-9._/-]+$/.test(String(target.branch || ''))) {
    return { ok: false, stderr: `unsafe astrology branch: ${target.branch || ''}` };
  }
  const editable = new Set(editableAstrologyFiles(target));
  const status = run([
    'git', '-C', target.worktree, 'status', '--porcelain=v1', '--untracked-files=all',
  ], { cwd: target.worktree, timeout: 60_000 });
  if (!status.ok) return { ...status, ok: false };
  const dirty = parseGitStatusPaths(status.stdout);
  const mergeHeadResult = run([
    'git', '-C', target.worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD',
  ], { cwd: target.worktree, timeout: 60_000 });
  const mergeInProgress = mergeHeadResult.ok && mergeHeadResult.stdout.trim() !== '';
  if (mergeInProgress) {
    const originMain = run([
      'git', '-C', target.worktree, 'rev-parse', 'origin/main',
    ], { cwd: target.worktree, timeout: 60_000 });
    const unmerged = run([
      'git', '-C', target.worktree, 'diff', '--name-only', '--diff-filter=U',
    ], { cwd: target.worktree, timeout: 60_000 });
    const unstaged = run([
      'git', '-C', target.worktree, 'diff', '--name-only',
    ], { cwd: target.worktree, timeout: 60_000 });
    const diffAgainstMain = run([
      'git', '-C', target.worktree, 'diff', '--cached', '--name-only', 'origin/main',
    ], { cwd: target.worktree, timeout: 60_000 });
    if (!originMain.ok || !unmerged.ok || !unstaged.ok || !diffAgainstMain.ok) {
      return { ok: false, stderr: 'cannot validate staged astrology merge index' };
    }
    const mergeState = {
      mergeHead: mergeHeadResult.stdout.trim(),
      originMain: originMain.stdout.trim(),
      unmergedFiles: unmerged.stdout.trim().split('\n').filter(Boolean),
      unstagedFiles: unstaged.stdout.trim().split('\n').filter(Boolean),
      diffAgainstMain: diffAgainstMain.stdout.trim().split('\n').filter(Boolean),
    };
    if (!isSafeAstrologyMergeIndex(target, mergeState)) {
      return {
        ok: false,
        stderr: `unsafe astrology merge index: ${JSON.stringify(mergeState)}`,
      };
    }
    const committed = run([
      'git', '-C', target.worktree, 'commit', '-m', `fix(seo-repair): ${target.pageId} merge current main`,
    ], { cwd: target.worktree, timeout: 180_000 });
    if (!committed.ok) return { ...committed, ok: false };
  } else {
    const forbidden = dirty.filter((file) => !editable.has(file));
    if (forbidden.length) {
      return { ok: false, stderr: `Agent changed files outside target allowlist: ${forbidden.join(', ')}` };
    }
  }
  if (!mergeInProgress && dirty.length > 0) {
    const staged = run(['git', '-C', target.worktree, 'add', '--', ...dirty], { cwd: target.worktree, timeout: 60_000 });
    if (!staged.ok) return { ...staged, ok: false };
    const committed = run([
      'git', '-C', target.worktree, 'commit', '-m', `fix(seo-repair): ${target.pageId} target gate`,
    ], { cwd: target.worktree, timeout: 180_000 });
    if (!committed.ok) return { ...committed, ok: false };
  }
  const head = run(['git', '-C', target.worktree, 'rev-parse', 'HEAD'], { cwd: target.worktree, timeout: 60_000 });
  if (!head.ok) return { ...head, ok: false };
  const commit = head.stdout.trim();
  const pushed = run([
    'git', '-C', target.worktree, 'push', 'origin', `HEAD:refs/heads/${target.branch}`,
  ], { cwd: target.worktree, timeout: 180_000 });
  if (!pushed.ok) return { ...pushed, ok: false, commit };
  if (target.originalWorktree) {
    const advanced = run([
      'git', '-C', target.originalWorktree, 'merge', '--ff-only', commit,
    ], { cwd: target.originalWorktree, timeout: 180_000 });
    if (!advanced.ok) return { ...advanced, ok: false, commit };
  }
  return { ok: true, noChanges: dirty.length === 0, commit, changedFiles: dirty };
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
  const persistRepair = deps.persistRepair || defaultPersistRepair;
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
        const persisted = await persistRepair(target, { record, strategy, repaired });
        if (persisted?.ok !== true) {
          return {
            ok: false,
            evidence: { type: 'persist_repair_failed', result: persisted || null },
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
