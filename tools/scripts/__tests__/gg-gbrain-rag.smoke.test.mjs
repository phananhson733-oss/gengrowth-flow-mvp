#!/usr/bin/env node
// Smoke tests for gg-gbrain-rag.mjs fallback behavior.
//
// Run:
//   node tools/scripts/__tests__/gg-gbrain-rag.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-gbrain-rag.mjs');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  OK  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL ${name}\n     ${e.message}`);
    failed++;
  }
}

function makeExecutable(path, body) {
  writeFileSync(path, body, { mode: 0o755 });
}

console.log('gg-gbrain-rag.mjs smoke tests');
console.log('-----------------------------');

test('falls back to obsidian-rag when gbrain query is blocked by PGLite lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-gbrain-rag-'));
  try {
    const repo = join(root, 'repo');
    const cacheDir = join(repo, '.gg-cache');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const vault = join(root, 'vault');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(vault, 'books'), { recursive: true });

    makeExecutable(join(bin, 'gbrain'), `#!/bin/sh
echo "GBrain: Timed out waiting for PGLite lock." >&2
exit 1
`);

    writeFileSync(join(vault, 'books', 'world-cup-astrology.md'), `---
title: World Cup 2026 Astrology Prediction
type: note
tags:
  - astrology
---
# World Cup 2026 Astrology Prediction

## World Cup 2026 Astrology Prediction and Jupiter in Cancer

World cup 2026 astrology prediction work can describe host-country atmosphere
without naming a champion. Jupiter in Cancer emphasizes home ground, collective
belonging, crowd memory, national ritual, family symbolism, and protective
support. In this framing the host advantage is a symbolic field condition, not
a guaranteed match result.
`);

    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--page-id', 'page_test',
      '--entity', 'world cup 2026 astrology prediction',
      '--target-keyword', 'world cup 2026 astrology prediction',
      '--cache-dir', cacheDir,
      '--vault-dir', vault,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        GG_FLOW_REPO: repo,
        PATH: `${bin}:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr + result.stdout, /fallback|obsidian/i);
    const outPath = join(cacheDir, 'page_test', 'obsidian-rag.json');
    const payload = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.ok(payload.snippets.length > 0, JSON.stringify(payload));
    assert.match(payload.snippets[0].source_id, /^obsidian#/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uses fallback entity candidates when keyword-style entity has no obsidian matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'gg-gbrain-rag-'));
  try {
    const repo = join(root, 'repo');
    const cacheDir = join(repo, '.gg-cache');
    const home = join(root, 'home');
    const bin = join(home, '.local', 'bin');
    const vault = join(root, 'vault');
    mkdirSync(cacheDir, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(vault, 'notes', 'books'), { recursive: true });

    makeExecutable(join(bin, 'gbrain'), `#!/bin/sh
echo "GBrain: Timed out waiting for PGLite lock." >&2
exit 1
`);

    writeFileSync(join(vault, 'notes', 'books', 'mundane-astrology.md'), `---
title: Mundane Astrology
type: note
tags:
  - astrology
---
# Mundane Astrology

## Mundane Astrology and Collective Events

Mundane astrology studies countries, public ceremonies, crowd emotion, shared
timing, and collective symbolic weather. It is useful when an article needs to
frame a sporting event through national mood and public ritual without turning
the work into a literal match-result forecast.
`);

    const result = spawnSync(process.execPath, [
      SCRIPT,
      '--page-id', 'page_test_fallback_entity',
      '--entity', 'world cup 2026 astrology prediction',
      '--fallback-entity', 'mundane astrology · national birth chart',
      '--target-keyword', 'world cup 2026 astrology prediction',
      '--cache-dir', cacheDir,
      '--vault-dir', vault,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        GG_FLOW_REPO: repo,
        PATH: `${bin}:${process.env.PATH || ''}`,
      },
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const outPath = join(cacheDir, 'page_test_fallback_entity', 'obsidian-rag.json');
    const payload = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.ok(payload.snippets.length > 0, JSON.stringify(payload));
    assert.equal(payload.fallback_entity_used, 'mundane astrology');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}

console.log(`\n${passed} passed`);
