#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

export function activePageIdsFromPlan(text) {
  const ids = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/^\s*-\s+\[\s\]\s+/.test(line)) continue;
    const pageIdTokens = line.match(/\bPG-[A-Za-z0-9]+-\d+\b/g) || [];
    if (pageIdTokens.length === 0) {
      throw new Error('cannot parse active page id from pinned plan');
    }
    if (pageIdTokens.length !== 1) {
      throw new Error('unchecked plan row must contain exactly one active page id');
    }
    const match = line.match(/^\s*-\s+\[\s\]\s+`?(PG-[A-Z0-9]+-\d+)`?(?=\s|$)/);
    if (!match) throw new Error('cannot parse active page id from pinned plan');
    ids.push(match[1]);
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error('pinned plan contains duplicate active page ids');
  }
  return [...ids].sort();
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

export function runBriefPreflight({ planPath, wrapperPath, spawn = spawnSync }) {
  const requested = activePageIdsFromPlan(readFileSync(planPath, 'utf8'));
  const work = mkdtempSync(join(tmpdir(), 'gg-seo-brief-preflight-'));
  const resultFile = join(work, 'topic-register-result.json');
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
    if (run?.error) throw new Error('topic-register wrapper could not start');
    if (run?.status !== 0) {
      throw new Error(`topic-register wrapper failed rc=${Number.isInteger(run?.status) ? run.status : 'unknown'}`);
    }
    const value = JSON.parse(readFileSync(resultFile, 'utf8'));
    return validateSemanticRepairProof(value, requested);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function cli(argv) {
  const args = parseArgs(argv);
  const allowed = ['json', 'plan', 'topic_register_wrapper'];
  if (argv.length !== 5 || !sameArray(Object.keys(args).sort(), allowed)) {
    throw new Error('usage: --plan <absolute.md> --topic-register-wrapper <absolute.sh> --json');
  }
  if (args.json !== true || typeof args.plan !== 'string'
    || typeof args.topic_register_wrapper !== 'string') {
    throw new Error('plan, topic-register wrapper, and --json are required');
  }
  if (!isAbsolute(args.plan) || !isAbsolute(args.topic_register_wrapper)) {
    throw new Error('plan and topic-register wrapper paths must be absolute');
  }
  const proof = runBriefPreflight({
    planPath: args.plan,
    wrapperPath: args.topic_register_wrapper,
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
