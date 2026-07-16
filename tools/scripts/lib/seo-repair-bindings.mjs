import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const HEAD_REF_OID_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export function repairWorktreeRoot() {
  return resolve(process.env.GG_SEO_REPAIR_ORACLE_WORKTREE_ROOT
    || join(homedir(), 'oracle-worktrees', 'seo-repair-controller'));
}

export function repairDraftRoot() {
  const stateRoot = process.env.GG_FLOW_STATE_DIR
    || join(homedir(), 'gengrowth-agents', 'flow-state');
  return resolve(stateRoot, 'seo-repair-drafts');
}

function containedRealpath(path, root, kind) {
  if (!isAbsolute(String(path || ''))) {
    throw new Error(`${kind} path must be absolute`);
  }
  const resolvedRoot = resolve(root);
  if (lstatSync(resolvedRoot).isSymbolicLink()) {
    throw new Error(`${kind} controller root must not be a symlink`);
  }
  const rootRealpath = realpathSync(resolvedRoot);
  const pathRealpath = realpathSync(resolve(path));
  const rel = relative(rootRealpath, pathRealpath);
  if (!rel || rel === '.') {
    throw new Error(`${kind} path must be below its controller root`);
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${kind} realpath is outside its controller root`);
  }
  return { rootRealpath, pathRealpath };
}

function gitInspect(worktree, args) {
  const result = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    ok: result.status === 0 && !result.error,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || result.error?.message || ''),
    code: result.status ?? 1,
  };
}

export function inspectBoundRepairWorktree({
  worktree,
  expectedHead,
  remoteHead,
  root = repairWorktreeRoot(),
}) {
  try {
    if (!HEAD_REF_OID_RE.test(String(expectedHead || ''))) {
      throw new Error('repair worktree expected head must be a 40-hex SHA');
    }
    if (!HEAD_REF_OID_RE.test(String(remoteHead || ''))) {
      throw new Error('repair worktree remote head must be a 40-hex SHA');
    }
    if (String(remoteHead).toLowerCase() !== String(expectedHead).toLowerCase()) {
      throw new Error(`remote head ${remoteHead} does not match expected head ${expectedHead}`);
    }
    if (lstatSync(resolve(worktree)).isSymbolicLink()) {
      throw new Error('repair worktree path must not be a symlink');
    }
    const { pathRealpath } = containedRealpath(worktree, root, 'repair worktree');
    if (!statSync(pathRealpath).isDirectory()) {
      throw new Error('repair worktree must be a directory');
    }
    const head = gitInspect(pathRealpath, ['rev-parse', 'HEAD']);
    if (!head.ok) {
      throw new Error(`repair worktree HEAD unavailable: ${head.stderr || `exit ${head.code}`}`);
    }
    const actualHead = head.stdout.trim();
    if (actualHead.toLowerCase() !== String(expectedHead).toLowerCase()) {
      throw new Error(`repair worktree HEAD mismatch: ${actualHead || '?'} != ${expectedHead}`);
    }
    const status = gitInspect(pathRealpath, [
      'status', '--porcelain=v1', '--untracked-files=all',
    ]);
    if (!status.ok) {
      throw new Error(`repair worktree status unavailable: ${status.stderr || `exit ${status.code}`}`);
    }
    if (status.stdout.trim()) {
      throw new Error(`repair worktree has uncommitted changes: ${status.stdout.trim().split('\n')[0]}`);
    }
    return {
      ok: true,
      realpath: pathRealpath,
      headRefOid: actualHead.toLowerCase(),
      dirty: false,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `repair worktree binding failed: ${error?.message || String(error)}`,
    };
  }
}

export function inspectBoundRepairDraft({
  draftFile,
  expectedSha256,
  root = repairDraftRoot(),
}) {
  try {
    if (!SHA256_RE.test(String(expectedSha256 || ''))) {
      throw new Error('repair draft expected SHA-256 must be 64 hex characters');
    }
    const { pathRealpath } = containedRealpath(draftFile, root, 'repair draft');
    if (!lstatSync(resolve(draftFile)).isFile() || !statSync(pathRealpath).isFile()) {
      throw new Error('repair draft must be a regular file');
    }
    const bytes = readFileSync(pathRealpath);
    if (bytes.length === 0) throw new Error('repair draft must not be empty');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== String(expectedSha256).toLowerCase()) {
      throw new Error(`repair draft digest mismatch: ${sha256} != ${expectedSha256}`);
    }
    return {
      ok: true,
      exists: true,
      realpath: pathRealpath,
      bytes: bytes.length,
      sha256,
    };
  } catch (error) {
    return {
      ok: false,
      reason: `repair draft binding failed: ${error?.message || String(error)}`,
    };
  }
}
