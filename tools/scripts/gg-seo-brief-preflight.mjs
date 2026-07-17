#!/usr/bin/env node

import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { parseArgs } from './gg-topic-register.mjs';

const PAGE_ID_PATTERN = /^PG-[A-Z0-9]+-\d+$/;
const ROOT_KEYS = ['budget_exhausted', 'dry_run', 'ok', 'proof', 'summaries'].sort();
const PROOF_KEYS = [
  'changed_page_ids',
  'cluster_repairs',
  'created_page_id_count',
  'cross_product_write_count',
  'mode',
  'new_cluster_count',
  'product',
  'requested_page_ids',
  'selected_page_ids',
  'status',
].sort();
const REPAIR_KEYS = ['from', 'page_id', 'provenance', 'score', 'to'].sort();
const REPAIR_PROVENANCE = new Set(['semantic-repair', 'semantic-repair-new']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function exactKeys(value, keys) {
  return plainObject(value) && sameArray(Object.keys(value).sort(), keys);
}

function validatePageIdArray(value, label, { sorted = true } = {}) {
  if (!Array.isArray(value)
    || value.some((pageId) => typeof pageId !== 'string' || !PAGE_ID_PATTERN.test(pageId))) {
    throw new Error(`${label} page ids are invalid`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} page ids are not unique`);
  }
  if (sorted && !sameArray(value, [...value].sort())) {
    throw new Error(`${label} page ids are not sorted`);
  }
  return value;
}

export function activeRowsFromPlan(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const checkboxLike = /^\s*(?:[-+*]|\d+[.)])\s+\[\s*\]/.test(line);
    const canonicalUnchecked = /^- \[ \] /.test(line);
    if (checkboxLike && !canonicalUnchecked) {
      throw new Error('pinned plan contains a non-canonical unchecked row');
    }
    if (!canonicalUnchecked) continue;
    const pageIdTokens = line.match(/\bPG-[A-Za-z0-9-]+/g) || [];
    if (pageIdTokens.length === 0) {
      throw new Error('cannot parse active page id from pinned plan');
    }
    if (pageIdTokens.some((pageId) => !PAGE_ID_PATTERN.test(pageId))) {
      throw new Error('pinned plan contains a malformed active page id');
    }
    if (pageIdTokens.length !== 1) {
      throw new Error('unchecked plan row must contain exactly one active page id');
    }
    const match = line.match(/^- \[ \] (`?)(PG-[A-Z0-9]+-\d+)\1(?=\s|$)(.*)$/);
    if (!match) throw new Error('cannot parse active page id from pinned plan');
    const keyword = match[3]
      .replace(/\s*->.*$/, '')
      .replace(/`/g, '')
      .replace(/\s*\(.*$/, '')
      .trim();
    rows.push({ page_id: match[2], raw_line: line, keyword });
  }
  const ids = rows.map((row) => row.page_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error('pinned plan contains duplicate active page ids');
  }
  return [...rows].sort((a, b) => a.page_id.localeCompare(b.page_id));
}

export function activePageIdsFromPlan(text) {
  return activeRowsFromPlan(text).map((row) => row.page_id);
}

export function validateSemanticRepairProof(value, expectedPageIds) {
  if (!exactKeys(value, ROOT_KEYS)) {
    throw new Error('topic-register result schema mismatch');
  }
  if (value.ok !== true) {
    throw new Error('topic-register result is not successful');
  }
  if (value.dry_run !== false || value.budget_exhausted !== false) {
    throw new Error('topic-register did not complete a bounded apply run');
  }
  if (!Array.isArray(value.summaries) || value.summaries.some((row) => !plainObject(row))) {
    throw new Error('topic-register summaries schema mismatch');
  }

  const expected = validatePageIdArray(expectedPageIds, 'expected');
  const proof = value.proof;
  if (!exactKeys(proof, PROOF_KEYS)) {
    throw new Error('semantic repair proof schema mismatch');
  }
  if (proof.mode !== 'semantic-repair-only' || proof.product !== 'astrologywiki') {
    throw new Error('semantic repair proof mode or product mismatch');
  }

  const requested = validatePageIdArray(proof.requested_page_ids, 'requested');
  const selected = validatePageIdArray(proof.selected_page_ids, 'selected');
  const changed = validatePageIdArray(proof.changed_page_ids, 'changed');
  if (!sameArray(requested, expected)) {
    throw new Error('requested page ids mismatch');
  }
  const expectedSet = new Set(expected);
  if (selected.some((pageId) => !expectedSet.has(pageId))
    || changed.some((pageId) => !expectedSet.has(pageId))) {
    throw new Error('selected or changed page ids fall outside the active set');
  }
  if (!sameArray(selected, changed)) {
    throw new Error('selected and changed page ids differ');
  }

  if (proof.created_page_id_count !== 0 || proof.cross_product_write_count !== 0) {
    throw new Error('semantic repair expanded write scope');
  }
  if (!Number.isInteger(proof.new_cluster_count) || proof.new_cluster_count < 0) {
    throw new Error('invalid new cluster count');
  }
  if (!Array.isArray(proof.cluster_repairs)) {
    throw new Error('repair provenance is not an array');
  }

  for (const row of proof.cluster_repairs) {
    if (!exactKeys(row, REPAIR_KEYS)) {
      throw new Error('semantic repair row schema mismatch');
    }
    if (typeof row.page_id !== 'string' || !PAGE_ID_PATTERN.test(row.page_id)
      || typeof row.from !== 'string' || !row.from.trim() || row.from !== row.from.trim()
      || typeof row.to !== 'string' || !row.to.trim() || row.to !== row.to.trim()
      || typeof row.score !== 'number' || !Number.isFinite(row.score)) {
      throw new Error('semantic repair row values are invalid');
    }
    if (!REPAIR_PROVENANCE.has(row.provenance)) {
      throw new Error('semantic repair provenance is invalid');
    }
  }

  const repairIds = proof.cluster_repairs.map((row) => row.page_id);
  if (new Set(repairIds).size !== repairIds.length
    || !sameArray([...repairIds].sort(), changed)) {
    throw new Error('repair provenance does not form an exact changed-page bijection');
  }
  const newClusterCount = new Set(
    proof.cluster_repairs
      .filter((row) => row.provenance === 'semantic-repair-new')
      .map((row) => row.to),
  ).size;
  if (newClusterCount !== proof.new_cluster_count) {
    throw new Error('new cluster provenance count mismatch');
  }

  const expectedStatus = changed.length ? 'applied' : 'noop';
  if (proof.status !== expectedStatus) {
    throw new Error('semantic repair status mismatch');
  }
  return proof;
}

function writeAttestedManifest(path, value) {
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o400 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function boundIdentity(path, kind) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()
    || (kind === 'directory' && !stat.isDirectory())
    || (kind === 'file' && !stat.isFile())) {
    throw new Error(`temporary ${kind} identity is invalid`);
  }
  return `${stat.dev}:${stat.ino}`;
}

function optionalBoundFileIdentity(path) {
  try {
    return boundIdentity(path, 'file');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function temporaryWorkIsCurrent(path, identity) {
  try {
    return boundIdentity(path, 'directory') === identity;
  } catch {
    return false;
  }
}

function cleanupTemporaryWork(work, workIdentity, knownFiles) {
  if (!temporaryWorkIsCurrent(work, workIdentity)) return false;
  for (const { path, identity } of knownFiles) {
    let currentIdentity;
    try {
      currentIdentity = optionalBoundFileIdentity(path);
    } catch {
      return false;
    }
    if (currentIdentity === null && identity === null) continue;
    if (currentIdentity === null || identity === null || currentIdentity !== identity) return false;
    if (!temporaryWorkIsCurrent(work, workIdentity)) return false;
    try {
      unlinkSync(path);
    } catch {
      return false;
    }
  }
  if (!temporaryWorkIsCurrent(work, workIdentity)) return false;
  try {
    rmdirSync(work);
    return true;
  } catch {
    return false;
  }
}

export function runBriefPreflight({ planPath, wrapperPath, manifestPath = null, spawn = spawnSync }) {
  const planText = readFileSync(planPath, 'utf8');
  const planDigest = createHash('sha256').update(planText).digest('hex');
  const rows = activeRowsFromPlan(planText);
  const requested = rows.map((row) => row.page_id);
  const work = mkdtempSync(join(tmpdir(), 'gg-seo-brief-preflight-'));
  const workIdentity = boundIdentity(work, 'directory');
  const resultFile = join(work, 'topic-register-result.json');
  let resultFileIdentity = null;
  try {
    const run = spawn('bash', [wrapperPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GG_TOPIC_REGISTER_PRODUCTS: 'astrologywiki',
        GG_TOPIC_REGISTER_LIMIT: String(requested.length),
        GG_TOPIC_REGISTER_INCLUDE_INCOMPLETE: '0',
        GG_TOPIC_REGISTER_LLM: 'none',
        GG_TOPIC_REGISTER_DISCOVER_EVIDENCE: '0',
        GG_TOPIC_REGISTER_APPLY: '1',
        GG_TOPIC_REGISTER_OVERWRITE: '0',
        GG_TOPIC_REGISTER_TAXONOMY_ONLY: '0',
        GG_TOPIC_REGISTER_NO_NOTIFY: '1',
        GG_TOPIC_REGISTER_REPAIR_PAGE_IDS: requested.join(','),
        GG_TOPIC_REGISTER_SEMANTIC_REPAIR_ONLY: '1',
        GG_TOPIC_REGISTER_REQUIRE_RUN: '1',
        GG_TOPIC_REGISTER_RESULT_FILE: resultFile,
        GG_TOPIC_REGISTER_REPAIR_KEYWORDS: '',
        GG_TOPIC_REGISTER_REASSIGN_EXISTING: '0',
      },
    });
    if (!temporaryWorkIsCurrent(work, workIdentity)) {
      throw new Error('temporary work directory identity changed during preflight');
    }
    resultFileIdentity = optionalBoundFileIdentity(resultFile);
    let planTextAfter;
    try {
      planTextAfter = readFileSync(planPath, 'utf8');
    } catch {
      throw new Error('pinned plan changed during preflight');
    }
    const planDigestAfter = createHash('sha256').update(planTextAfter).digest('hex');
    if (planTextAfter !== planText || planDigestAfter !== planDigest) {
      throw new Error('pinned plan changed during preflight');
    }
    if (run?.error) throw new Error('topic-register wrapper could not start');
    if (run?.status !== 0) {
      throw new Error(`topic-register wrapper failed rc=${Number.isInteger(run?.status) ? run.status : 'unknown'}`);
    }
    if (resultFileIdentity === null) throw new Error('topic-register result is unavailable');
    let value;
    try {
      value = JSON.parse(readFileSync(resultFile, 'utf8'));
    } catch (error) {
      if (error?.code && error.code !== 'ERR_INVALID_ARG_TYPE') throw error;
      throw new Error('topic-register result is malformed JSON');
    }
    if (!temporaryWorkIsCurrent(work, workIdentity)
      || optionalBoundFileIdentity(resultFile) !== resultFileIdentity) {
      throw new Error('topic-register result identity changed during preflight');
    }
    const proof = validateSemanticRepairProof(value, requested);
    if (manifestPath) {
      writeAttestedManifest(manifestPath, {
        version: 1,
        plan_sha256: planDigest,
        requested_page_ids: requested,
        rows,
      });
    }
    return proof;
  } finally {
    if (!cleanupTemporaryWork(work, workIdentity, [{ path: resultFile, identity: resultFileIdentity }])) {
      throw new Error('temporary work cleanup ownership could not be proven');
    }
  }
}

function cli(argv) {
  const args = parseArgs(argv);
  const keys = Object.keys(args).sort();
  const baseAllowed = ['json', 'plan', 'topic_register_wrapper'];
  const manifestAllowed = ['attested_manifest', ...baseAllowed].sort();
  if (!((argv.length === 5 && sameArray(keys, baseAllowed))
    || (argv.length === 7 && sameArray(keys, manifestAllowed)))) {
    throw new Error('usage: --plan <absolute.md> --topic-register-wrapper <absolute.sh> [--attested-manifest <absolute.json>] --json');
  }
  if (args.json !== true || typeof args.plan !== 'string'
    || typeof args.topic_register_wrapper !== 'string') {
    throw new Error('plan, topic-register wrapper, and --json are required');
  }
  if (!isAbsolute(args.plan) || !isAbsolute(args.topic_register_wrapper)) {
    throw new Error('plan and topic-register wrapper paths must be absolute');
  }
  if (args.attested_manifest !== undefined
    && (typeof args.attested_manifest !== 'string' || !isAbsolute(args.attested_manifest))) {
    throw new Error('attested manifest path must be absolute');
  }
  const proof = runBriefPreflight({
    planPath: args.plan,
    wrapperPath: args.topic_register_wrapper,
    manifestPath: args.attested_manifest || null,
  });
  process.stdout.write(`${JSON.stringify(proof)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    const reason = String(error?.message || error || 'unknown error').replace(/[\r\n]+/g, ' ').trim();
    process.stderr.write(`active brief preflight failed: ${reason || 'unknown error'}\n`);
    process.exit(1);
  }
}
