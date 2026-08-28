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

function remoteHead(git) {
  const raw = git(['ls-remote', 'origin', 'refs/heads/main']);
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

export function preflightDramaOpsRepo({ opsDir, expectedRemote, runGit = null }) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!expectedRemote) throw new Error('expectedRemote is required');
  const git = gitRunner(opsDir, runGit);
  const branch = git(['branch', '--show-current']);
  if (branch !== 'main') throw new Error(`DramaShortsTV Git delivery requires branch main, got ${branch || '(detached)'}`);
  const fetchUrl = git(['remote', 'get-url', 'origin']);
  const pushUrl = git(['remote', 'get-url', '--push', 'origin']);
  if (fetchUrl !== expectedRemote || pushUrl !== expectedRemote) {
    throw new Error(`DramaShortsTV Git remote mismatch: fetch=${fetchUrl} push=${pushUrl} expected=${expectedRemote}`);
  }
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

export function commitAndPushDramaDocument({
  opsDir,
  relativePath,
  topicSlug,
  runGit = null,
}) {
  if (!opsDir) throw new Error('opsDir is required');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(topicSlug || ''))) {
    throw new Error(`unsafe DramaShortsTV topic slug: ${topicSlug}`);
  }
  const safePath = validateRelativePath(relativePath);
  const git = gitRunner(opsDir, runGit);
  const status = git(['status', '--porcelain=v1', '--untracked-files=all']);

  if (!status) {
    const commitSha = git(['rev-parse', 'HEAD']);
    const remoteSha = remoteHead(git);
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
  } catch (error) {
    throw commandError('Git staging failed', error);
  }
  const cached = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (cached.length !== 1 || cached[0] !== safePath) {
    throw new Error(`Git staging escaped target document: ${cached.join(', ')}`);
  }
  const afterStage = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);
  if (afterStage.length !== 1 || afterStage[0].slice(3) !== safePath) {
    throw new Error(`unrelated changes appeared before commit: ${afterStage.join(' | ')}`);
  }
  try {
    git(['commit', '-m', `content(dramashortstv): add ${topicSlug}`]);
  } catch (error) {
    throw commandError('Git commit failed', error);
  }
  const commitSha = git(['rev-parse', 'HEAD']);
  try {
    git(['push', 'origin', 'main']);
  } catch (error) {
    throw commandError(`Git push failed; local commit preserved at ${commitSha}`, error);
  }
  const remoteSha = remoteHead(git);
  if (commitSha !== remoteSha) {
    throw new Error(`Git remote verification failed: local=${commitSha} remote=${remoteSha}`);
  }
  const blobSha = verifyDeliveredBlob(git, safePath, commitSha);
  return { status: 'delivered', commitSha, remoteSha, relativePath: safePath, blobSha };
}
