// Fail-closed document-level Git delivery for DramaShortsTV.
// This module never repairs repository state and never stages more than one file.

import { execFileSync } from 'node:child_process';
import { isAbsolute, normalize, sep } from 'node:path';

const OUTPUT_PREFIX = ['inbox-maboyang', '05-blog', 'dramashortstv'].join('/');
const SHA_RE = /^[0-9a-f]{40}$/i;

function defaultRunGit(opsDir, args) {
  return execFileSync('git', ['-C', opsDir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitRunner(opsDir, runGit) {
  return (args) => (runGit ? String(runGit(opsDir, args) ?? '').trim() : defaultRunGit(opsDir, args));
}

function commandError(label, error) {
  const detail = String(error?.stderr || error?.stdout || error?.message || error).trim().split('\n').slice(-3).join(' | ');
  return new Error(`${label}${detail ? `: ${detail}` : ''}`);
}

function parseDivergence(raw) {
  const values = String(raw || '').trim().split(/\s+/).map(Number);
  if (values.length !== 2 || values.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`unparseable HEAD...origin/main divergence: ${raw}`);
  }
  return { ahead: values[0], behind: values[1] };
}

function validateRelativePath(relativePath) {
  const raw = String(relativePath || '').replaceAll('\\', '/');
  const normalized = normalize(raw).replaceAll(sep, '/');
  if (!raw || isAbsolute(raw) || raw !== normalized || raw.includes('\0')
    || !raw.startsWith(`${OUTPUT_PREFIX}/`) || !raw.endsWith('.md')) {
    throw new Error(`unsafe DramaShortsTV Git path: ${relativePath}`);
  }
  return raw;
}

function remoteHead(git, remote = 'origin') {
  const raw = git(['ls-remote', remote, 'refs/heads/main']);
  const sha = raw.split(/\s+/)[0] || '';
  if (!SHA_RE.test(sha)) throw new Error(`unverifiable remote main SHA: ${raw}`);
  return sha;
}

function verifyDeliveredBlob(git, relativePath, commitSha) {
  const blobSha = git(['rev-parse', `${commitSha}:${relativePath}`]);
  const fileBlobSha = git(['hash-object', '--', relativePath]);
  if (!SHA_RE.test(blobSha) || blobSha !== fileBlobSha) {
    throw new Error(`remote commit blob does not match local document: ${relativePath}`);
  }
  return blobSha;
}

function verifyRepositoryIdentity(git, expectedRemote) {
  if (!expectedRemote) throw new Error('expectedRemote is required');
  const branch = git(['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`DramaShortsTV Git delivery requires branch main, got ${branch || '(detached)'}`);
  const fetchUrl = git(['remote', 'get-url', 'origin']);
  const pushUrl = git(['remote', 'get-url', '--push', 'origin']);
  if (fetchUrl !== expectedRemote || pushUrl !== expectedRemote) {
    throw new Error(`DramaShortsTV Git remote mismatch: fetch=${fetchUrl} push=${pushUrl} expected=${expectedRemote}`);
  }
  return { branch, fetchUrl, pushUrl };
}

export function preflightDramaOpsRepo({ opsDir, expectedRemote, runGit = null }) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!expectedRemote) throw new Error('expectedRemote is required');
  const git = gitRunner(opsDir, runGit);
  const { branch, fetchUrl } = verifyRepositoryIdentity(git, expectedRemote);
  try {
    git(['fetch', '--prune', 'origin']);
  } catch (error) {
    throw commandError('Git fetch failed', error);
  }
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error(`DramaShortsTV Ops worktree must be clean before generation: ${status.split('\n')[0]}`);
  const { ahead, behind } = parseDivergence(git(['rev-list', '--left-right', '--count', 'HEAD...origin/main']));
  if (ahead !== 0 || behind !== 0) {
    throw new Error(`DramaShortsTV Ops must be synchronized: ahead=${ahead} behind=${behind}`);
  }
  const head = git(['rev-parse', 'HEAD']);
  if (!SHA_RE.test(head)) throw new Error(`invalid local HEAD: ${head}`);
  return { branch, remoteUrl: fetchUrl, ahead, behind, head };
}

export function findDeliveredDramaDocument({
  opsDir,
  pageId,
  expectedRemote,
  runGit = null,
}) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(pageId || ''))) {
    throw new Error(`unsafe DramaShortsTV page_id: ${pageId}`);
  }
  const git = gitRunner(opsDir, runGit);
  verifyRepositoryIdentity(git, expectedRemote);
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new Error(`cannot inspect delivered page_id in dirty Ops repository: ${status.split('\n')[0]}`);
  const commitSha = git(['rev-parse', 'HEAD']);
  const remoteSha = remoteHead(git, expectedRemote);
  if (commitSha !== remoteSha) {
    throw new Error(`cannot inspect delivered page_id with divergent remote: local=${commitSha} remote=${remoteSha}`);
  }
  let matches = [];
  try {
    matches = git([
      'grep', '-l', '-F', `page_id: "${pageId}"`, 'HEAD', '--', OUTPUT_PREFIX,
    ]).split('\n').filter(Boolean).map((match) => match.replace(/^HEAD:/, ''));
  } catch (error) {
    if (error?.status !== 1) throw commandError('Git page_id lookup failed', error);
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`multiple DramaShortsTV documents found for page_id ${pageId}: ${matches.join(', ')}`);
  }
  const relativePath = validateRelativePath(matches[0]);
  const blobSha = verifyDeliveredBlob(git, relativePath, commitSha);
  return { status: 'already-delivered', commitSha, remoteSha, relativePath, blobSha };
}

export function commitAndPushDramaDocument({
  opsDir,
  relativePath,
  topicSlug,
  expectedRemote,
  runGit = null,
}) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(topicSlug || ''))) {
    throw new Error(`unsafe DramaShortsTV topic slug: ${topicSlug}`);
  }
  const safePath = validateRelativePath(relativePath);
  const git = gitRunner(opsDir, runGit);
  verifyRepositoryIdentity(git, expectedRemote);
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);

  if (!status) {
    const commitSha = git(['rev-parse', 'HEAD']);
    const remoteSha = remoteHead(git, expectedRemote);
    if (commitSha !== remoteSha) {
      throw new Error(`clean repository is not remotely delivered: local=${commitSha} remote=${remoteSha}`);
    }
    const blobSha = verifyDeliveredBlob(git, safePath, commitSha);
    return { status: 'already-delivered', commitSha, remoteSha, relativePath: safePath, blobSha };
  }

  const lines = status.split('\n').filter(Boolean);
  if (lines.length !== 1 || lines[0].slice(3) !== safePath || !['??', ' M'].includes(lines[0].slice(0, 2))) {
    throw new Error(`Git delivery requires exactly one target document change; found: ${lines.join(' | ')}`);
  }
  try {
    git(['diff', '--check', '--', safePath]);
    git(['add', '--', safePath]);
    git(['diff', '--cached', '--check', '--', safePath]);
  } catch (error) {
    throw commandError('Git staged document failed diff check or staging', error);
  }
  const cached = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (cached.length !== 1 || cached[0] !== safePath) {
    throw new Error(`Git staging escaped target document: ${cached.join(', ')}`);
  }
  const approvedBlobSha = git(['rev-parse', `:${safePath}`]);
  if (!SHA_RE.test(approvedBlobSha)) throw new Error(`invalid staged document blob: ${approvedBlobSha}`);
  const afterStage = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);
  if (afterStage.length !== 1 || afterStage[0].slice(3) !== safePath) {
    throw new Error(`unrelated changes appeared before commit: ${afterStage.join(' | ')}`);
  }
  verifyRepositoryIdentity(git, expectedRemote);
  try {
    git(['commit', '--only', '-m', `content(dramashortstv): add ${topicSlug}`, '--', safePath]);
  } catch (error) {
    throw commandError('Git commit failed', error);
  }
  const commitSha = git(['rev-parse', 'HEAD']);
  const committedBlobSha = git(['rev-parse', `${commitSha}:${safePath}`]);
  if (committedBlobSha !== approvedBlobSha) {
    throw new Error(`document bytes changed after staged QA; local commit preserved at ${commitSha}`);
  }
  const committedPaths = git(['show', '--format=', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  if (committedPaths.length !== 1 || committedPaths[0] !== safePath) {
    throw new Error(`Git commit escaped target document; local commit preserved at ${commitSha}: ${committedPaths.join(', ')}`);
  }
  const postCommitStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
  if (postCommitStatus) {
    throw new Error(`unrelated changes appeared after commit; local commit preserved at ${commitSha}: ${postCommitStatus.split('\n')[0]}`);
  }
  verifyRepositoryIdentity(git, expectedRemote);
  try {
    git(['push', expectedRemote, `${commitSha}:refs/heads/main`]);
  } catch (error) {
    throw commandError(`Git push failed; local commit preserved at ${commitSha}`, error);
  }
  const remoteSha = remoteHead(git, expectedRemote);
  if (commitSha !== remoteSha) {
    throw new Error(`Git remote verification failed: local=${commitSha} remote=${remoteSha}`);
  }
  const blobSha = verifyDeliveredBlob(git, safePath, commitSha);
  return { status: 'delivered', commitSha, remoteSha, relativePath: safePath, blobSha };
}
