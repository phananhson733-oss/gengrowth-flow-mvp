#!/usr/bin/env node
// Resolve exactly one pending-writeback record. Repair agents use this scoped
// entrypoint instead of the all-ledger reconcile job.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillOnLive, readWriteback } from './lib/backfill-tx.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function runBackfillOne(pageId, deps = {}) {
  if (!PAGE_ID_RE.test(String(pageId || ''))) {
    return { ok: false, pageId: String(pageId || ''), terminal: 'human_only', reason: 'invalid page_id' };
  }
  const read = deps.readWriteback || readWriteback;
  const run = deps.backfillOnLive || backfillOnLive;
  const entry = read(pageId);
  if (!entry) {
    return { ok: true, pageId, terminal: 'clean', reason: 'no pending writeback' };
  }
  const result = await run(entry);
  return {
    ...result,
    pageId,
    terminal: result?.ok ? 'resolved' : 'pending',
  };
}

function parsePageId(argv) {
  const index = argv.indexOf('--page-id');
  return index >= 0 ? argv[index + 1] || '' : '';
}

async function main() {
  const pageId = parsePageId(process.argv.slice(2));
  const result = await runBackfillOne(pageId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  await main();
}
