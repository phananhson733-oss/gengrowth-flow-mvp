#!/usr/bin/env node
// EN-only regression guard (2026-07-03 zh removal, Phase 2 of the flow
// remediation): every pipeline entry point that used to accept a zh language
// flag must now REJECT it loudly (clear error + nonzero exit) — never silently
// coerce to EN and ship wrong content, and never silently produce zh.
//
// gg-md-to-oracle-ts's rejections are covered in its own smoke test; the
// autopilot's zh lanes are covered in gg-seo-autopilot.smoke.test.mjs.
//
// Run: node --test tools/scripts/__tests__/en-only-rejection.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(__dirname, '..');

const run = (script, args, opts = {}) =>
  spawnSync('node', [join(SCRIPTS, script), ...args], { encoding: 'utf8', ...opts });

test('_phase2-validate: --language zh → exit 2 with EN-only error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-enonly-'));
  const src = join(dir, 'draft.md');
  writeFileSync(src, '# 标题\n\n正文。\n');
  const r = run('_phase2-validate.mjs', [
    '--source', src, '--tag', 'zh', '--language', 'zh',
    '--page-id', 'PG-TEST-001', '--entity', 'x', '--target-keyword', 'x', '--author', 'a',
  ]);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('_phase2-validate: fixture language zh (no CLI flag) → exit 2 with EN-only error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-enonly-'));
  const src = join(dir, 'draft.md');
  const fixture = join(dir, 'fixture.json');
  writeFileSync(src, '# 标题\n\n正文。\n');
  writeFileSync(fixture, JSON.stringify({ language: 'zh', page_id: 'PG-TEST-001', entity: 'x', target_keyword: 'x' }));
  const r = run('_phase2-validate.mjs', [
    '--source', src, '--tag', 'zh', '--fixture', fixture, '--author', 'a',
  ]);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('gg-render-batch: --language zh → exit 2 with EN-only error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-enonly-'));
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify({ batch_id: 'b', rows: [] }));
  const r = run('gg-render-batch.mjs', ['--batch', batch, '--language', 'zh']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('gg-render-batch: --language both → exit 2 with EN-only error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-enonly-'));
  const batch = join(dir, 'batch.json');
  writeFileSync(batch, JSON.stringify({ batch_id: 'b', rows: [] }));
  const r = run('gg-render-batch.mjs', ['--batch', batch, '--language', 'both']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('gg-oracle-register-index: --lang zh → exit 2 with EN-only error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-enonly-'));
  writeFileSync(join(dir, 'index.ts'), '// All articles organized by language\nconst ARTICLES_EN: WikiArticle[] = [\n];\n');
  const r = run('gg-oracle-register-index.mjs', ['--oracle-articles-dir', dir, '--slug', 'x', '--lang', 'zh']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('gg-publish-to-wiki.sh: --language zh → exit 2 with EN-only error', () => {
  const r = spawnSync('bash', [join(SCRIPTS, 'gg-publish-to-wiki.sh'), '--language', 'zh', '--dry-run'], { encoding: 'utf8' });
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
});

test('gg-preview-verify: --zh → exit 2 with EN-only error (not silently ignored)', () => {
  const r = run('gg-preview-verify.mjs', ['--preview-url', 'https://p', '--slug', 's', '--zh']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
});

test('gg-author-repair: --language zh → exit 2 with EN-only error', () => {
  const r = run('gg-author-repair.mjs', ['--language', 'zh']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
});

test('gg-obsidian-rag: --language zh → nonzero exit with EN-only error', () => {
  const r = run('gg-obsidian-rag.mjs', ['--page-id', 'PG-X', '--entity', 'x', '--language', 'zh']);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}${r.stdout}`, /EN-only/);
});

test('gg-gengrowth-publish: --locale zh → exit 2 with EN-only error (before any gate/IO)', () => {
  const r = run('gg-gengrowth-publish.mjs', ['--locale', 'zh']);
  assert.equal(r.status, 2, `stderr: ${r.stderr}`);
  assert.match(r.stderr, /EN-only/);
});

test('gg-md-to-gengrowth-blog: --locale zh rejected BEFORE source-not-found', () => {
  const r = run('gg-md-to-gengrowth-blog.mjs', ['--source', '/nonexistent-draft.md', '--locale', 'zh', '--emit', 'rest']);
  assert.notEqual(r.status, 0);
  assert.match(`${r.stderr}${r.stdout}`, /EN-only/);
  assert.doesNotMatch(`${r.stderr}${r.stdout}`, /source not found/);
});

test('renderAuraPrompt: legacy language:"zh" in an override is passed through and throws (no silent EN render)', async () => {
  const { composeCfg } = await import('../gg-render-batch.mjs');
  const { cfg } = composeCfg(
    { page_id: 'PG-X', brief: { target_keyword: 'x', entity: 'x' } },
    { language: 'zh' },
  );
  assert.equal(cfg.language, 'zh', 'composeCfg must NOT swallow the legacy language field');
  const { renderAuraPrompt } = await import('../lib/_render-aura-shared.mjs');
  assert.throws(() => renderAuraPrompt(cfg), /EN-only/);
});
