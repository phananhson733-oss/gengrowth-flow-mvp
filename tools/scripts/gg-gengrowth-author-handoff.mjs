#!/usr/bin/env node

import { copyFile, lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = resolve(SCRIPT_DIR, '../..');
const PAGE_ID_RE = /^PG-[A-Z0-9]+-[0-9]+$/;
const WINNER_RE = /^[a-z0-9]+$/;

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

async function main() {
  let pageId;
  try {
    pageId = parseArgs(process.argv.slice(2));
  } catch (error) {
    output({ ok: false, handedOff: false, reason: 'invalid_arguments', message: error.message }, 2);
    return;
  }
  if (!PAGE_ID_RE.test(pageId)) {
    output({ ok: false, handedOff: false, reason: 'invalid_page_id', pageId }, 2);
    return;
  }
  const winner = String(process.env.GG_WINNER_LLM || 'claude').toLowerCase();
  if (!WINNER_RE.test(winner)) {
    output({ ok: false, handedOff: false, reason: 'invalid_winner', pageId }, 2);
    return;
  }
  const stagingDir = resolve(process.env.GG_GENGROWTH_STAGING_DIR || join(FLOW_DIR, '_staging'));
  const sourceMd = resolve(stagingDir, `${pageId}-en.md`);
  const sourceManifest = resolve(stagingDir, `${pageId}-en.manifest.json`);
  const targetMd = resolve(stagingDir, `${pageId}-${winner}-v8.md`);
  const targetManifest = resolve(stagingDir, `${pageId}-${winner}-v8.manifest.json`);
  const paths = [sourceMd, sourceManifest, targetMd, targetManifest];
  if (paths.some((path) => !path.startsWith(`${stagingDir}${sep}`))) {
    output({ ok: false, handedOff: false, reason: 'unsafe_path', pageId }, 2);
    return;
  }
  if (!(await regularFile(sourceManifest))) {
    output({ ok: false, handedOff: false, reason: 'manifest_not_pass', pageId }, 1);
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(sourceManifest, 'utf8'));
  } catch {
    manifest = null;
  }
  if (manifest?.phase2_checks?.overall !== 'pass') {
    output({ ok: false, handedOff: false, reason: 'manifest_not_pass', pageId }, 1);
    return;
  }
  if (!(await regularFile(sourceMd))) {
    output({ ok: false, handedOff: false, reason: 'draft_not_sane', pageId }, 1);
    return;
  }
  let draft = '';
  try { draft = await readFile(sourceMd, 'utf8'); } catch {}
  if (!draft.startsWith('---\n') || !/^slug:\s*\S/m.test(draft) || draft.length <= 400) {
    output({ ok: false, handedOff: false, reason: 'draft_not_sane', pageId }, 1);
    return;
  }
  if (!(await destinationIsSafe(targetMd)) || !(await destinationIsSafe(targetManifest))) {
    output({ ok: false, handedOff: false, reason: 'unsafe_destination', pageId }, 2);
    return;
  }
  await copyFile(sourceMd, targetMd);
  await copyFile(sourceManifest, targetManifest);
  output({
    ok: true,
    handedOff: true,
    pageId,
    winner,
    draft: `${pageId}-${winner}-v8.md`,
    manifest: `${pageId}-${winner}-v8.manifest.json`,
  }, 0);
}

main().catch((error) => {
  output({
    ok: false,
    handedOff: false,
    reason: 'handoff_error',
    message: error instanceof Error ? error.message : String(error),
  }, 1);
});
