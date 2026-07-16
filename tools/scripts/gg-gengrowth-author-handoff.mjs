#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = resolve(SCRIPT_DIR, '../..');
const PAGE_ID_RE = /^PG-[A-Z0-9]+-[0-9]+$/;
const WINNER_RE = /^[a-z0-9]+$/;

class HandoffError extends Error {
  constructor(reason, message, code = 1) {
    super(message || reason);
    this.reason = reason;
    this.exitCode = code;
  }
}

function output(value, code) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = code;
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--page-id') {
    throw new Error('exactly one --page-id is required');
  }
  return argv[1];
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function destinationIsSafe(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

async function fileExists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

async function passingReadyPair(draftPath, manifestPath) {
  if (!(await regularFile(draftPath)) || !(await regularFile(manifestPath))) return false;
  let manifest;
  let draft;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    draft = await readFile(draftPath, 'utf8');
  } catch {
    return false;
  }
  return manifest?.phase2_checks?.overall === 'pass'
    && draft.startsWith('---\n')
    && /^slug:\s*\S/m.test(draft)
    && draft.length > 400;
}

async function fsyncFile(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function fsyncDirectory(path) {
  try {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {}
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function acquireHandoffLock(path) {
  const token = randomUUID();
  const ownerPath = join(path, 'owner.json');
  const create = async () => {
    await mkdir(path);
    await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token })}\n`, {
      mode: 0o600,
    });
    await fsyncDirectory(path);
  };
  try {
    await create();
    return { path, ownerPath, token };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const owner = await readJson(ownerPath);
    if (owner && pidIsAlive(Number(owner.pid))) {
      throw new HandoffError('handoff_busy', 'another handoff process owns the target pair', 2);
    }
    if (!owner) {
      try {
        const ageMs = Date.now() - (await stat(path)).mtimeMs;
        if (ageMs < 5_000) {
          throw new HandoffError('handoff_busy', 'handoff lock owner is still being written', 2);
        }
      } catch (failure) {
        if (failure instanceof HandoffError) throw failure;
      }
    }
    const stalePath = `${path}.stale-${process.pid}-${Date.now()}`;
    try {
      await rename(path, stalePath);
      await rm(stalePath, { recursive: true, force: true });
      await create();
      return { path, ownerPath, token };
    } catch (failure) {
      if (failure?.code === 'EEXIST' || failure?.code === 'ENOENT') {
        throw new HandoffError('handoff_busy', 'handoff lock changed during recovery', 2);
      }
      throw failure;
    }
  }
}

async function releaseHandoffLock(lock) {
  const owner = await readJson(lock?.ownerPath);
  if (owner?.token !== lock?.token || Number(owner?.pid) !== process.pid) return;
  await rm(lock.path, { recursive: true, force: true });
}

function transactionPattern(pageId, winner) {
  return new RegExp(
    `^\\.handoff-${pageId}-${winner}-([A-Za-z0-9-]+)\\.(md\\.tmp|manifest\\.tmp|md\\.bak|manifest\\.bak)$`,
  );
}

async function recoverInterruptedHandoff({
  stagingDir,
  pageId,
  winner,
  targetMd,
  targetManifest,
}) {
  const pattern = transactionPattern(pageId, winner);
  const transactions = new Map();
  for (const name of await readdir(stagingDir)) {
    const match = name.match(pattern);
    if (!match) continue;
    const transaction = transactions.get(match[1]) || {};
    transaction[match[2]] = join(stagingDir, name);
    transactions.set(match[1], transaction);
  }
  if (transactions.size === 0) return;
  if (transactions.size > 1) {
    throw new HandoffError(
      'handoff_recovery_ambiguous',
      `multiple interrupted handoffs require inspection: ${[...transactions.keys()].join(', ')}`,
      2,
    );
  }
  const [[transactionId, files]] = transactions;
  for (const path of Object.values(files)) {
    if (!(await regularFile(path))) {
      throw new HandoffError(
        'handoff_recovery_unsafe',
        `interrupted handoff contains a non-regular file: ${path}`,
        2,
      );
    }
  }
  if (!(await destinationIsSafe(targetMd)) || !(await destinationIsSafe(targetManifest))) {
    throw new HandoffError(
      'handoff_recovery_unsafe',
      'interrupted handoff target is not a regular file or absent',
      2,
    );
  }
  if (await passingReadyPair(targetMd, targetManifest)) {
    for (const path of Object.values(files)) await rm(path, { force: true });
    await fsyncDirectory(stagingDir);
    return;
  }

  const backupMd = files['md.bak'];
  const backupManifest = files['manifest.bak'];
  const hasBackupMd = Boolean(backupMd);
  const hasBackupManifest = Boolean(backupManifest);
  try {
    if (hasBackupMd || hasBackupManifest) {
      if (hasBackupMd && hasBackupManifest) {
        await rm(targetManifest, { force: true });
        await rm(targetMd, { force: true });
        await rename(backupMd, targetMd);
        await fsyncFile(targetMd);
        await rename(backupManifest, targetManifest);
        await fsyncFile(targetManifest);
      } else if (!hasBackupMd
        && hasBackupManifest
        && await regularFile(targetMd)
        && !(await fileExists(targetManifest))) {
        await rename(backupManifest, targetManifest);
        await fsyncFile(targetManifest);
      } else {
        throw new HandoffError(
          'handoff_recovery_ambiguous',
          `interrupted handoff ${transactionId} has an incomplete backup pair`,
          2,
        );
      }
    } else {
      // No old pair existed. Remove any partially visible new pair and rebuild from source.
      await rm(targetManifest, { force: true });
      await rm(targetMd, { force: true });
    }
    await fsyncDirectory(stagingDir);
    for (const path of Object.values(files)) await rm(path, { force: true });
    await fsyncDirectory(stagingDir);
  } catch (error) {
    if (error instanceof HandoffError) throw error;
    throw new HandoffError(
      'handoff_recovery_failed',
      `interrupted handoff ${transactionId} could not be recovered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function handoffGengrowthAuthor({
  pageId,
  stagingDir = process.env.GG_GENGROWTH_STAGING_DIR || join(FLOW_DIR, '_staging'),
  winner = process.env.GG_WINNER_LLM || 'claude',
} = {}, {
  faultInjector,
  transactionId = randomUUID(),
  renameFile = rename,
} = {}) {
  pageId = String(pageId || '');
  winner = String(winner || '').toLowerCase();
  if (!PAGE_ID_RE.test(pageId)) {
    throw new HandoffError('invalid_page_id', `invalid page id: ${pageId}`, 2);
  }
  if (!WINNER_RE.test(winner)) {
    throw new HandoffError('invalid_winner', `invalid winner: ${winner}`, 2);
  }
  stagingDir = resolve(stagingDir);
  const sourceMd = resolve(stagingDir, `${pageId}-en.md`);
  const sourceManifest = resolve(stagingDir, `${pageId}-en.manifest.json`);
  const targetMd = resolve(stagingDir, `${pageId}-${winner}-v8.md`);
  const targetManifest = resolve(stagingDir, `${pageId}-${winner}-v8.manifest.json`);
  const transactionToken = String(transactionId).replace(/[^a-zA-Z0-9-]/g, '') || randomUUID();
  const prefix = `.handoff-${pageId}-${winner}-${transactionToken}`;
  const tempMd = join(stagingDir, `${prefix}.md.tmp`);
  const tempManifest = join(stagingDir, `${prefix}.manifest.tmp`);
  const backupMd = join(stagingDir, `${prefix}.md.bak`);
  const backupManifest = join(stagingDir, `${prefix}.manifest.bak`);
  const lockDir = join(stagingDir, `.handoff-lock-${pageId}-${winner}`);
  const paths = [
    sourceMd,
    sourceManifest,
    targetMd,
    targetManifest,
    tempMd,
    tempManifest,
    backupMd,
    backupManifest,
    lockDir,
  ];
  if (paths.some((path) => !path.startsWith(`${stagingDir}${sep}`))) {
    throw new HandoffError('unsafe_path', 'handoff path escaped staging directory', 2);
  }
  const lock = await acquireHandoffLock(lockDir);
  try {
    await recoverInterruptedHandoff({
      stagingDir,
      pageId,
      winner,
      targetMd,
      targetManifest,
    });
  if (!(await regularFile(sourceManifest))) {
    throw new HandoffError('manifest_not_pass');
  }
  let manifest;
  try { manifest = JSON.parse(await readFile(sourceManifest, 'utf8')); } catch { manifest = null; }
  if (manifest?.phase2_checks?.overall !== 'pass') {
    throw new HandoffError('manifest_not_pass');
  }
  if (!(await regularFile(sourceMd))) {
    throw new HandoffError('draft_not_sane');
  }
  let draft = '';
  try { draft = await readFile(sourceMd, 'utf8'); } catch {}
  if (!draft.startsWith('---\n') || !/^slug:\s*\S/m.test(draft) || draft.length <= 400) {
    throw new HandoffError('draft_not_sane');
  }
  if (!(await destinationIsSafe(targetMd)) || !(await destinationIsSafe(targetManifest))) {
    throw new HandoffError('unsafe_destination', 'target must be absent or a regular non-symlink file', 2);
  }

  const hadTargetMd = await regularFile(targetMd);
  const hadTargetManifest = await regularFile(targetManifest);
  if (hadTargetMd !== hadTargetManifest) {
    throw new HandoffError(
      'incomplete_existing_target',
      'incomplete existing target pair must be repaired before handoff',
      2,
    );
  }
  let draftCommitted = false;
  let manifestCommitted = false;
  let transactionCommitted = false;
  let rollbackComplete = false;
  let preserveBackups = false;
  try {
    await copyFile(sourceMd, tempMd);
    await copyFile(sourceManifest, tempManifest);
    await fsyncFile(tempMd);
    await fsyncFile(tempManifest);
    await fsyncDirectory(stagingDir);

    // Hide the passing manifest first, so the publisher cannot consume a mixed pair.
    if (hadTargetManifest) await renameFile(targetManifest, backupManifest);
    if (hadTargetMd) await renameFile(targetMd, backupMd);
    await renameFile(tempMd, targetMd);
    draftCommitted = true;
    if (typeof faultInjector === 'function') {
      await faultInjector('after-draft-before-manifest', { pageId, targetMd, targetManifest });
    }
    await renameFile(tempManifest, targetManifest);
    manifestCommitted = true;
    await fsyncDirectory(stagingDir);
    transactionCommitted = true;
    return {
      ok: true,
      handedOff: true,
      pageId,
      winner,
      draft: `${pageId}-${winner}-v8.md`,
      manifest: `${pageId}-${winner}-v8.manifest.json`,
    };
  } catch (error) {
    const rollbackErrors = [];
    try { if (manifestCommitted) await rm(targetManifest, { force: true }); } catch (failure) {
      rollbackErrors.push(failure);
    }
    try { if (draftCommitted) await rm(targetMd, { force: true }); } catch (failure) {
      rollbackErrors.push(failure);
    }
    let draftRestored = !hadTargetMd;
    if (hadTargetMd && await fileExists(backupMd)) {
      try {
        await renameFile(backupMd, targetMd);
        draftRestored = true;
      } catch (failure) {
        rollbackErrors.push(failure);
      }
    }
    // Restore the old passing manifest last, and only after its matching draft is back.
    let manifestRestored = !hadTargetManifest;
    if (hadTargetManifest && draftRestored && await fileExists(backupManifest)) {
      try {
        await renameFile(backupManifest, targetManifest);
        manifestRestored = true;
      } catch (failure) {
        rollbackErrors.push(failure);
      }
    }
    await fsyncDirectory(stagingDir);
    rollbackComplete = rollbackErrors.length === 0 && draftRestored && manifestRestored;
    if (!rollbackComplete) {
      preserveBackups = true;
      const detail = rollbackErrors
        .map((failure) => failure instanceof Error ? failure.message : String(failure))
        .join('; ');
      throw new HandoffError(
        'handoff_recovery_failed',
        `handoff recovery failed: ${detail || 'old pair was not fully restored'}; original: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    throw error;
  } finally {
    await rm(tempMd, { force: true });
    await rm(tempManifest, { force: true });
    if (!preserveBackups && (transactionCommitted || rollbackComplete)) {
      await rm(backupMd, { force: true });
      if (transactionCommitted && typeof faultInjector === 'function') {
        await faultInjector('after-backup-draft-cleanup', {
          pageId,
          targetMd,
          targetManifest,
        });
      }
      await rm(backupManifest, { force: true });
    }
  }
  } finally {
    await releaseHandoffLock(lock);
  }
}

async function main() {
  let pageId;
  try {
    pageId = parseArgs(process.argv.slice(2));
  } catch (error) {
    output({ ok: false, handedOff: false, reason: 'invalid_arguments', message: error.message }, 2);
    return;
  }
  const winner = String(process.env.GG_WINNER_LLM || 'claude').toLowerCase();
  const stagingDir = resolve(process.env.GG_GENGROWTH_STAGING_DIR || join(FLOW_DIR, '_staging'));
  try {
    output(await handoffGengrowthAuthor({ pageId, stagingDir, winner }), 0);
  } catch (error) {
    output({
      ok: false,
      handedOff: false,
      reason: error?.reason || 'handoff_error',
      pageId,
      message: error instanceof Error ? error.message : String(error),
    }, Number(error?.exitCode || 1));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    output({
      ok: false,
      handedOff: false,
      reason: 'handoff_error',
      message: error instanceof Error ? error.message : String(error),
    }, 1);
  });
}
