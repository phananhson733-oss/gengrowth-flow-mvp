#!/usr/bin/env node
// Smoke test for the gengrowth author lane's PUBLISH HANDOFF invariant (阶段 3 · 杀"漏写").
// gg-gengrowth-author-tick.sh authors `_staging/<PID>-en.md` (+ passing manifest) then COPIES that
// pair to the `<PID>-<llm>-v8` names the gengrowth publisher consumes. This locks in that contract:
// a copied `-en` pair MUST be reported READY by the real gg-gengrowth-publish scanReady — so a future
// change to DRAFT_RE / the manifest field / frontmatter parsing can't silently strand authored drafts.
// Run: node --test tools/scripts/__tests__/gg-gengrowth-author-handoff.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLISH = join(__dirname, '..', 'gg-gengrowth-publish.mjs');

// A minimal but realistic passing gengrowth `-en` draft pair, as the author engine leaves it.
function writeEnPair(dir, pid, slug) {
  const md = [
    '---',
    `page_id: ${pid}`,
    `slug: ${slug}`,
    'title: Example B2B SEO Guide',
    'locale: en',
    'author_id: gg-editorial',
    '---',
    '',
    '# Example B2B SEO Guide',
    '',
    'Body content for the publisher to upsert.',
    '',
  ].join('\n');
  const manifest = JSON.stringify({ page_id: pid, slug, phase2_checks: { overall: 'pass' } }, null, 2);
  writeFileSync(join(dir, `${pid}-en.md`), md);
  writeFileSync(join(dir, `${pid}-en.manifest.json`), manifest);
}
// The tick's copy-handoff: `-en` pair → `-<llm>-v8` names the publisher scans for.
function copyHandoff(dir, pid, tag) {
  copyFileSync(join(dir, `${pid}-en.md`), join(dir, `${pid}-${tag}.md`));
  copyFileSync(join(dir, `${pid}-en.manifest.json`), join(dir, `${pid}-${tag}.manifest.json`));
}
function publisherDryRun(stagingDir, pid) {
  // no --apply → dry-run scanReady listing; no SB_KEY / network needed.
  return execFileSync('node', [PUBLISH, '--staging-dir', stagingDir, '--pages', pid], { encoding: 'utf8' });
}

test('copy-handoff of a passing -en pair → publisher reports it READY', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-handoff-'));
  try {
    const pid = 'PG-ART-004';
    const slug = 'manual-seo-service';
    writeEnPair(dir, pid, slug);
    copyHandoff(dir, pid, 'claude-v8');
    const out = publisherDryRun(dir, pid);
    assert.match(out, /1 ready draft/, 'publisher counts the copied draft as ready');
    assert.match(out, new RegExp(pid), 'lists the page id');
    assert.match(out, new RegExp(slug), 'reads the slug from frontmatter');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('non-default winner tag (opus-v8) is also publisher-consumable (DRAFT_RE = -<llm>-v8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-handoff-'));
  try {
    const pid = 'PG-EOS-008';
    const slug = 'ethical-seo-services';
    writeEnPair(dir, pid, slug);
    copyHandoff(dir, pid, 'opus-v8');
    const out = publisherDryRun(dir, pid);
    assert.match(out, /1 ready draft/);
    assert.match(out, new RegExp(slug));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a raw draft WITHOUT a passing manifest is NOT ready (idempotency guard is real)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-handoff-'));
  try {
    const pid = 'PG-SFS-005';
    // raw orchestrator-style draft: right filename, but manifest missing → must not publish
    writeFileSync(join(dir, `${pid}-claude-v8.md`), '# no frontmatter, raw\n');
    const out = publisherDryRun(dir, pid);
    assert.doesNotMatch(out, /1 ready draft/, 'a manifest-less raw draft is never ready');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
