import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invokeTargetRepairAgent } from './seo-repair-controller.mjs';
import {
  inspectBoundRepairDraft,
  repairDraftRoot,
} from './seo-repair-bindings.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCRIPTS = resolve(LIB_DIR, '..');
const DEFAULT_FLOW = resolve(DEFAULT_SCRIPTS, '../..');
const ASSET_RE = /\.(?:svg|png|jpe?g|webp|gif)$/i;

function absoluteWorktreeFile(worktree, file) {
  return isAbsolute(file) ? resolve(file) : resolve(worktree, file);
}

export async function buildAstrologyRepairTarget(event, context) {
  const changedFiles = [
    ...(context.changedFiles || []),
    ...(context.targetAssetFiles || []),
  ].map((file) => absoluteWorktreeFile(context.worktree, file));
  const slug = event.slug || '';
  const supportPlan = resolve(context.worktree, 'scripts', 'plans', `auto-${slug}.json`);
  const supportFiles = [
    ...(context.supportFiles || []),
    ...(changedFiles.includes(supportPlan) ? [supportPlan] : []),
  ].map((file) => absoluteWorktreeFile(context.worktree, file));
  return {
    site: 'astrologywiki',
    pageId: event.pageId,
    slug,
    stage: event.stage,
    errorKind: event.errorKind,
    branch: context.branch,
    worktree: context.worktree,
    originalWorktree: context.originalWorktree || null,
    headRefOid: context.headRefOid || null,
    articleFile: absoluteWorktreeFile(context.worktree, context.articleFile),
    changedFiles: [...new Set(changedFiles)],
    assetFiles: changedFiles.filter((file) => ASSET_RE.test(file)),
    supportFiles: [...new Set(supportFiles.filter((file) => file === supportPlan))],
    draftFile: context.draftFile || null,
    draftSha256: context.draftSha256 || null,
    verifiedLinkCandidates: context.verifiedLinkCandidates || [],
    linkCandidates: context.linkCandidates || [],
    gateEvidence: [event.summary, event.stderr].filter(Boolean).join('\n'),
    allowedActions: context.allowedActions || [],
    terminalVerifier: context.terminalVerifier || [],
  };
}

function safeDraftSegment(value, fallback) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '_');
  return cleaned || fallback;
}

export function ensureAstrologyRepairDraft({
  sourceFile,
  draftRoot = repairDraftRoot(),
  site,
  pageId,
  attemptId,
}) {
  try {
    if (!sourceFile || !existsSync(sourceFile)) {
      throw new Error(`source staging draft missing: ${sourceFile || '<missing>'}`);
    }
    const directory = join(
      resolve(draftRoot),
      safeDraftSegment(site, 'astrologywiki'),
      safeDraftSegment(pageId, 'unknown-page'),
    );
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const draftFile = join(directory, `${safeDraftSegment(attemptId, 'attempt')}.md`);
    if (!existsSync(draftFile)) {
      const bytes = readFileSync(sourceFile);
      if (bytes.length === 0) throw new Error('source staging draft is empty');
      const temporary = `${draftFile}.tmp.${process.pid}`;
      writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      renameSync(temporary, draftFile);
    }
    const bytes = readFileSync(draftFile);
    if (bytes.length === 0) throw new Error('controller repair draft is empty');
    return {
      ok: true,
      sourceFile: resolve(sourceFile),
      draftFile,
      bytes: bytes.length,
      draftSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    return {
      ok: false,
      reason: `cannot materialize controller repair draft: ${error?.message || String(error)}`,
    };
  }
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
  const head = run(['git', '-C', worktree, 'rev-parse', 'HEAD'], { cwd: worktree, timeout: 60_000 });
  if (!head.ok || !/^[0-9a-f]{40}$/i.test(head.stdout.trim())) {
    throw new Error(`cannot resolve clean repair head for ${event.pageId}`);
  }
  const sourceDraft = join(
    process.env.GG_FLOW_REPO || DEFAULT_FLOW,
    '_staging',
    `${event.pageId}-en.md`,
  );
  const repairedDraft = ensureAstrologyRepairDraft({
    sourceFile: sourceDraft,
    site: 'astrologywiki',
    pageId: event.pageId,
    attemptId: `${event.eventId || event.runId || 'attempt'}-g${event.generation ?? 0}`,
  });
  if (!repairedDraft.ok) throw new Error(repairedDraft.reason);
  const slug = claim.slug || event.slug;
  const assetDirectory = join(worktree, 'public', 'images', 'blog');
  const targetAssetFiles = existsSync(assetDirectory)
    ? readdirSync(assetDirectory)
      .filter((name) => (
        name.startsWith(`${slug}.`) || name.startsWith(`${slug}-`)
      ))
      .filter((name) => ASSET_RE.test(name))
      .map((name) => join(assetDirectory, name))
    : [];
  const supportPlan = join(worktree, 'scripts', 'plans', `auto-${slug}.json`);
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
    headRefOid: head.stdout.trim(),
    articleFile,
    changedFiles,
    targetAssetFiles,
    supportFiles: existsSync(supportPlan) ? [supportPlan] : [],
    draftFile: repairedDraft.draftFile,
    draftSha256: repairedDraft.draftSha256,
    sourceDraftFile: repairedDraft.sourceFile,
    linkCandidates: await collectLinkCandidates(worktree, claim.slug || event.slug),
    allowedActions: [
      ['node', join(DEFAULT_SCRIPTS, 'gg-seo-autopilot.mjs'), '--retry-failed', '--branch', claim.branch],
      [
        'node', join(DEFAULT_SCRIPTS, 'gg-preview-gate.mjs'),
        '--branch', claim.branch,
        '--worktree', worktree,
        '--head-ref-oid', head.stdout.trim(),
        '--draft', repairedDraft.draftFile,
        '--draft-sha256', repairedDraft.draftSha256,
      ],
    ],
    terminalVerifier: [
      'node', join(DEFAULT_SCRIPTS, 'gg-seo-repair-verify.mjs'),
      '--site', 'astrologywiki', '--page-id', event.pageId, '--slug', claim.slug || event.slug, '--json',
    ],
  };
}

export function astrologyRegateCommands(target, scriptsDir = DEFAULT_SCRIPTS) {
  const headRefOid = target.persistedHeadRefOid || target.headRefOid;
  return [
    [
      'node', join(scriptsDir, 'gg-seo-autopilot.mjs'),
      '--retry-failed', '--branch', target.branch,
    ],
    [
      'node', join(scriptsDir, 'gg-preview-gate.mjs'),
      '--branch', target.branch,
      '--worktree', target.worktree,
      '--head-ref-oid', headRefOid,
      '--draft', target.draftFile,
      '--draft-sha256', target.draftSha256,
    ],
  ];
}

function runBeforeDeadline(argv, {
  cwd,
  capMs,
  deadlineMs = Number.POSITIVE_INFINITY,
  nowMs = Date.now,
} = {}) {
  const remainingMs = deadlineMs - nowMs();
  if (remainingMs <= 0) {
    return {
      ok: false,
      code: 124,
      stdout: '',
      stderr: 'repair deadline exhausted',
      timedOut: true,
      deadlineExhausted: true,
    };
  }
  return run(argv, {
    cwd,
    timeout: Math.max(1, Math.min(capMs, remainingMs)),
  });
}

async function defaultRegate(target, {
  deadlineMs = Number.POSITIVE_INFINITY,
  nowMs = Date.now,
  runCommand = null,
  scriptsDir = DEFAULT_SCRIPTS,
} = {}) {
  const execute = async (argv, capMs) => {
    if (runCommand) {
      const remainingMs = deadlineMs - nowMs();
      if (remainingMs <= 0) {
        return {
          ok: false,
          code: 124,
          stdout: '',
          stderr: 'repair deadline exhausted',
          timedOut: true,
          deadlineExhausted: true,
        };
      }
      const result = await runCommand(argv, {
        timeoutMs: Math.max(1, Math.min(capMs, remainingMs)),
      });
      return {
        ...result,
        ok: result?.ok === true || (result?.code === 0 && result?.timedOut !== true),
      };
    }
    return runBeforeDeadline(argv, {
      cwd: DEFAULT_FLOW,
      capMs,
      deadlineMs,
      nowMs,
    });
  };
  const [retryCommand, gateCommand] = astrologyRegateCommands(target, scriptsDir);
  const reset = await execute(retryCommand, 180_000);
  if (!reset.ok && isAlreadyPublishedRetryFailure(reset)) {
    return { ok: true, alreadyPublished: true, reset };
  }
  if (!reset.ok && !isAlreadyRegatableRetryFailure(reset)) return reset;
  return execute(gateCommand, 45 * 60 * 1000);
}

export function isAlreadyRegatableRetryFailure(result) {
  if (result?.ok === true) return false;
  return /cannot retry\s+\S+\s+from status "pushed-preview"\s+[^\n]*expected needs_human/i
    .test(`${result?.stdout || ''}\n${result?.stderr || ''}`);
}

export function isAlreadyPublishedRetryFailure(result) {
  if (result?.ok === true) return false;
  return /cannot retry\s+\S+\s+from status "done"\s+[^\n]*expected needs_human/i
    .test(`${result?.stdout || ''}\n${result?.stderr || ''}`);
}

async function defaultInvokeAgent(target, {
  record,
  strategy,
  timeoutMs = 12 * 60 * 1000,
}) {
  const timeoutSeconds = Math.floor((timeoutMs - 30_000) / 1000);
  if (timeoutSeconds < 1) {
    return {
      ok: false,
      evidence: { type: 'repair_deadline_exhausted' },
    };
  }
  return invokeTargetRepairAgent(
    { target, record, strategy },
    { timeoutSeconds },
  );
}

function statusPath(line) {
  const raw = String(line || '').slice(3);
  const path = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return path.replace(/^"|"$/g, '');
}

async function defaultPersistRepair(target, {
  deadlineMs = Number.POSITIVE_INFINITY,
  nowMs = Date.now,
} = {}) {
  const execute = (argv, capMs, cwd = target.worktree) => runBeforeDeadline(argv, {
    cwd,
    capMs,
    deadlineMs,
    nowMs,
  });
  if (!/^seo\/auto\/[A-Za-z0-9._/-]+$/.test(String(target.branch || ''))) {
    return { ok: false, stderr: `unsafe astrology branch: ${target.branch || ''}` };
  }
  let draftBeforePersist = null;
  if (target.draftFile) {
    try {
      const bytes = readFileSync(target.draftFile);
      const draftSha256 = createHash('sha256').update(bytes).digest('hex');
      const inspected = inspectBoundRepairDraft({
        draftFile: target.draftFile,
        expectedSha256: draftSha256,
      });
      if (!inspected.ok) return { ok: false, stderr: inspected.reason };
      draftBeforePersist = inspected;
    } catch (error) {
      return {
        ok: false,
        stderr: `cannot validate repaired draft before persist: ${error?.message || String(error)}`,
      };
    }
  }
  const editable = new Set(editableAstrologyFiles(target));
  const status = execute([
    'git', '-C', target.worktree, 'status', '--porcelain=v1', '--untracked-files=all',
  ], 60_000);
  if (!status.ok) return { ...status, ok: false };
  const dirty = parseGitStatusPaths(status.stdout);
  const mergeHeadResult = execute([
    'git', '-C', target.worktree, 'rev-parse', '-q', '--verify', 'MERGE_HEAD',
  ], 60_000);
  const mergeInProgress = mergeHeadResult.ok && mergeHeadResult.stdout.trim() !== '';
  if (mergeInProgress) {
    const originMain = execute([
      'git', '-C', target.worktree, 'rev-parse', 'origin/main',
    ], 60_000);
    const unmerged = execute([
      'git', '-C', target.worktree, 'diff', '--name-only', '--diff-filter=U',
    ], 60_000);
    const unstaged = execute([
      'git', '-C', target.worktree, 'diff', '--name-only',
    ], 60_000);
    const diffAgainstMain = execute([
      'git', '-C', target.worktree, 'diff', '--cached', '--name-only', 'origin/main',
    ], 60_000);
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
    const committed = execute([
      'git', '-C', target.worktree, 'commit', '-m', `fix(seo-repair): ${target.pageId} merge current main`,
    ], 180_000);
    if (!committed.ok) return { ...committed, ok: false };
  } else {
    const forbidden = dirty.filter((file) => (
      !editable.has(file) && !isSafeAstrologyTargetPath(file, target.slug)
    ));
    if (forbidden.length) {
      return { ok: false, stderr: `Agent changed files outside target allowlist: ${forbidden.join(', ')}` };
    }
  }
  if (!mergeInProgress && dirty.length > 0) {
    const staged = execute(['git', '-C', target.worktree, 'add', '--', ...dirty], 60_000);
    if (!staged.ok) return { ...staged, ok: false };
    const committed = execute([
      'git', '-C', target.worktree, 'commit', '-m', `fix(seo-repair): ${target.pageId} target gate`,
    ], 180_000);
    if (!committed.ok) return { ...committed, ok: false };
  }
  const head = execute(['git', '-C', target.worktree, 'rev-parse', 'HEAD'], 60_000);
  if (!head.ok) return { ...head, ok: false };
  const commit = head.stdout.trim();
  const pushed = execute([
    'git', '-C', target.worktree, 'push', 'origin', `HEAD:refs/heads/${target.branch}`,
  ], 180_000);
  if (!pushed.ok) return { ...pushed, ok: false, commit };
  let draftSha = null;
  if (draftBeforePersist) {
    const draftAfterPush = inspectBoundRepairDraft({
      draftFile: target.draftFile,
      expectedSha256: draftBeforePersist.sha256,
    });
    if (!draftAfterPush.ok) {
      return {
        ok: false,
        commit,
        pushed: true,
        stderr: `repaired draft changed during persist: ${draftAfterPush.reason}`,
      };
    }
    draftSha = draftAfterPush.sha256;
  }
  let originalWorktreeAdvance = null;
  if (target.originalWorktree) {
    const advanced = execute([
      'git', '-C', target.originalWorktree, 'merge', '--ff-only', commit,
    ], 180_000, target.originalWorktree);
    originalWorktreeAdvance = {
      ok: advanced.ok,
      code: advanced.code,
      stderr: advanced.stderr,
    };
  }
  return {
    ok: true,
    noChanges: dirty.length === 0,
    commit,
    changedFiles: dirty,
    ...(draftSha ? { draftSha } : {}),
    ...(originalWorktreeAdvance ? { originalWorktreeAdvance } : {}),
  };
}

async function defaultVerifyTerminal(event, target, {
  scriptsDir,
  runCommand,
  timeoutMs = 120_000,
}) {
  const result = await runCommand([
    'node',
    join(scriptsDir, 'gg-seo-repair-verify.mjs'),
    '--site', 'astrologywiki',
    '--page-id', event.pageId,
    '--slug', target.slug,
    '--json',
  ], { timeoutMs });
  for (const line of String(result.stdout || '').trim().split('\n').reverse()) {
    try {
      const output = JSON.parse(line);
      return output?.results?.[0] || output;
    } catch {}
  }
  return { ok: false, terminal: 'pending', reason: result.stderr || `verifier exited ${result.code}` };
}

function astrologyArtifactSha(target) {
  const worktree = resolve(target.worktree);
  let dirtyTargetFiles = [];
  try {
    dirtyTargetFiles = worktreeDirtyPaths(worktree)
      .filter((file) => isSafeAstrologyTargetPath(file, target.slug));
  } catch {}
  const candidates = [...new Set([
    target.articleFile,
    ...(target.changedFiles || []),
    ...dirtyTargetFiles,
  ].filter(Boolean).map((file) => absoluteWorktreeFile(worktree, file)))];
  const measured = candidates
    .map((file) => ({ file, path: relative(worktree, file) }))
    .filter(({ path }) => path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
    .filter(({ path }) => isSafeAstrologyTargetPath(path, target.slug))
    .sort((left, right) => left.path.localeCompare(right.path));
  const hash = createHash('sha256');
  let files = 0;
  for (const entry of measured) {
    try {
      const content = readFileSync(entry.file);
      hash.update(entry.path);
      hash.update('\0');
      hash.update(String(content.length));
      hash.update('\0');
      hash.update(content);
      hash.update('\0');
      files += 1;
    } catch {}
  }
  return files > 0 ? hash.digest('hex') : null;
}

export function createAstrologyWikiRepairAdapter(deps = {}) {
  const scriptsDir = resolve(deps.scriptsDir || DEFAULT_SCRIPTS);
  const runCommand = deps.runCommand || (async (argv, { timeoutMs = 180_000 } = {}) => (
    run(argv, { cwd: DEFAULT_FLOW, timeout: timeoutMs })
  ));
  const resolveContext = deps.resolveContext || defaultResolveContext;
  const verifyLinkCandidate = deps.verifyLinkCandidate || (async (slug, context) => {
    const known = context.linkCandidates?.some((candidate) => candidate.slug === slug);
    return known === true;
  });
  const invokeAgent = deps.invokeAgent || defaultInvokeAgent;
  const persistRepair = deps.persistRepair || defaultPersistRepair;
  const regate = deps.regate || ((target, options = {}) => defaultRegate(target, {
    ...options,
    runCommand,
    scriptsDir,
  }));
  const publish = deps.publish || (async () => ({ ok: true, ownedByRegate: true }));
  const verifyTerminal = deps.verifyTerminal
    || ((event, target, options = {}) => defaultVerifyTerminal(event, target, {
      scriptsDir,
      runCommand,
      timeoutMs: options.timeoutMs,
    }));
  const nowMs = deps.nowMs || Date.now;

  return {
    async execute({ record, strategy, attemptDeadlineAt }) {
      const event = record.event;
      const deadlineMs = Number.isFinite(Date.parse(attemptDeadlineAt || ''))
        ? Date.parse(attemptDeadlineAt)
        : nowMs() + (25 * 60 * 1000);
      const remainingTimeout = (capMs) => Math.max(0, Math.min(capMs, deadlineMs - nowMs()));
      const deadlineFailure = (agentMutationInvoked = false, target = null) => {
        const artifactSha = target ? astrologyArtifactSha(target) : null;
        return {
          ok: false,
          agentMutationInvoked,
          evidence: {
            type: 'repair_deadline_exhausted',
            ...(artifactSha ? { artifactSha } : {}),
          },
        };
      };
      if (event.errorKind === 'missing_authoritative_source') {
        return {
          terminal: 'human_only',
          agentMutationInvoked: false,
          evidence: {
            type: 'missing_authoritative_source',
            summary: event.summary,
            action: 'human_only',
          },
        };
      }
      if (event.errorKind === 'stale') {
        return {
          terminal: 'archived',
          agentMutationInvoked: false,
          evidence: { type: 'unpublishable', summary: event.summary, logFile: event.logFile },
        };
      }
      if (remainingTimeout(1) <= 0) return deadlineFailure();
      let target;
      try {
        const context = await resolveContext(event);
        const verifiedLinkCandidates = [];
        for (const candidate of context.linkCandidates || []) {
          if (remainingTimeout(1) <= 0) return deadlineFailure();
          if (await verifyLinkCandidate(candidate.slug, context)) verifiedLinkCandidates.push(candidate);
        }
        target = await buildAstrologyRepairTarget(event, {
          ...context,
          verifiedLinkCandidates,
        });
      } catch (error) {
        return {
          ok: false,
          agentMutationInvoked: false,
          evidence: {
            type: 'target_resolution_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }

      const needsAgent = ['agent_content_asset_link', 'agent_diagnosis', 'agent_code_environment']
        .includes(strategy);
      let agentMutationInvoked = false;
      const failure = (evidence) => {
        const artifactSha = astrologyArtifactSha(target);
        return {
          ok: false,
          agentMutationInvoked,
          evidence: {
            ...(evidence || {}),
            ...(artifactSha ? { artifactSha } : {}),
          },
        };
      };
      try {
        if (needsAgent) {
          const agentTimeoutMs = remainingTimeout(12 * 60 * 1000);
          if (agentTimeoutMs <= 30_000) return deadlineFailure(false, target);
          agentMutationInvoked = true;
          const repaired = await invokeAgent(target, {
            record,
            strategy,
            timeoutMs: agentTimeoutMs,
            attemptDeadlineAt,
          });
          if (repaired?.ok !== true) {
            return failure(repaired?.evidence || { type: 'agent_repair_failed' });
          }
          const persistTimeoutMs = remainingTimeout(6 * 60 * 1000);
          if (persistTimeoutMs <= 0) return deadlineFailure(agentMutationInvoked, target);
          const persisted = await persistRepair(target, {
            record,
            strategy,
            repaired,
            timeoutMs: persistTimeoutMs,
            deadlineMs,
            nowMs,
            attemptDeadlineAt,
          });
          if (persisted?.ok !== true) {
            if (persisted?.deadlineExhausted === true) {
              return deadlineFailure(agentMutationInvoked, target);
            }
            return failure({ type: 'persist_repair_failed', result: persisted || null });
          }
          const persistedChangedFiles = Array.isArray(persisted.changedFiles)
            ? persisted.changedFiles.map(String)
            : [];
          const unsafePersistedFiles = persistedChangedFiles
            .filter((file) => !isSafeAstrologyTargetPath(file, target.slug));
          if (unsafePersistedFiles.length > 0) {
            return failure({
              type: 'persist_repair_failed',
              reason: 'unsafe_persisted_target_files',
              files: unsafePersistedFiles,
            });
          }
          target.changedFiles = [...new Set([
            ...(target.changedFiles || []),
            ...persistedChangedFiles.map((file) => absoluteWorktreeFile(target.worktree, file)),
          ])];
          target.assetFiles = target.changedFiles.filter((file) => ASSET_RE.test(file));
          if (persisted.commit) target.persistedHeadRefOid = persisted.commit;
          if (persisted.draftSha) target.draftSha256 = persisted.draftSha;
        }

        const regateTimeoutMs = remainingTimeout(8 * 60 * 1000);
        if (regateTimeoutMs <= 0) return deadlineFailure(agentMutationInvoked, target);
        const gated = await regate(target, {
          record,
          strategy,
          timeoutMs: regateTimeoutMs,
          deadlineMs,
          nowMs,
          attemptDeadlineAt,
        });
        if (gated?.ok !== true) {
          if (gated?.deadlineExhausted === true) {
            return deadlineFailure(agentMutationInvoked, target);
          }
          return failure({ type: 'regate_failed', result: gated || null });
        }
        const publishTimeoutMs = remainingTimeout(4 * 60 * 1000);
        if (publishTimeoutMs <= 0) return deadlineFailure(agentMutationInvoked, target);
        const published = await publish(target, {
          record,
          strategy,
          timeoutMs: publishTimeoutMs,
          attemptDeadlineAt,
        });
        if (published?.ok !== true) {
          return failure({ type: 'publish_failed', result: published || null });
        }
        const verifierTimeoutMs = remainingTimeout(2 * 60 * 1000);
        if (verifierTimeoutMs <= 0) return deadlineFailure(agentMutationInvoked, target);
        const verified = await verifyTerminal(event, target, {
          timeoutMs: verifierTimeoutMs,
          attemptDeadlineAt,
        });
        if (verified?.ok === true && verified?.terminal === 'published') {
          return {
            terminal: 'published',
            agentMutationInvoked,
            evidence: verified,
          };
        }
        return failure({ type: 'terminal_verifier_failed', verification: verified || null });
      } catch (error) {
        return failure({
          type: 'adapter_execution_failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
