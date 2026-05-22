#!/usr/bin/env node
// Smoke test for gg-friction-mine.mjs resolveRagRoot() — verifies the
// v0.18 fix that moved the default RAG cache root from ~/.gg-cache/ to
// <repo>/.gg-cache/, so gg-render-batch can actually read real friction
// data instead of always synth-overwriting it.
//
// Run: node --test tools/scripts/__tests__/gg-friction-mine-rag-root.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRagRoot } from '../gg-friction-mine.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REPO_RAG = join(REPO, '.gg-cache');

test('resolveRagRoot defaults to repo .gg-cache/', () => {
  // Wipe env to test pure default.
  const prev = process.env.GG_FRICTION_RAG_DIR;
  delete process.env.GG_FRICTION_RAG_DIR;
  try {
    assert.equal(resolveRagRoot({}), REPO_RAG);
    assert.equal(resolveRagRoot(undefined), REPO_RAG);
    assert.equal(resolveRagRoot({ ragDir: null }), REPO_RAG);
  } finally {
    if (prev !== undefined) process.env.GG_FRICTION_RAG_DIR = prev;
  }
});

test('resolveRagRoot honors --rag-dir CLI flag (camelCase ragDir)', () => {
  assert.equal(resolveRagRoot({ ragDir: '/tmp/custom-rag' }), '/tmp/custom-rag');
});

test('resolveRagRoot honors --rag-dir CLI flag (snake_case rag_dir)', () => {
  // Some parseArgs implementations use snake_case after normalizing flags.
  assert.equal(resolveRagRoot({ rag_dir: '/tmp/custom-snake' }), '/tmp/custom-snake');
});

test('resolveRagRoot honors GG_FRICTION_RAG_DIR env when no CLI flag', () => {
  const prev = process.env.GG_FRICTION_RAG_DIR;
  process.env.GG_FRICTION_RAG_DIR = '/tmp/from-env';
  try {
    assert.equal(resolveRagRoot({}), '/tmp/from-env');
  } finally {
    if (prev === undefined) delete process.env.GG_FRICTION_RAG_DIR;
    else process.env.GG_FRICTION_RAG_DIR = prev;
  }
});

test('resolveRagRoot: CLI flag beats env', () => {
  const prev = process.env.GG_FRICTION_RAG_DIR;
  process.env.GG_FRICTION_RAG_DIR = '/tmp/from-env';
  try {
    assert.equal(resolveRagRoot({ ragDir: '/tmp/from-cli' }), '/tmp/from-cli');
  } finally {
    if (prev === undefined) delete process.env.GG_FRICTION_RAG_DIR;
    else process.env.GG_FRICTION_RAG_DIR = prev;
  }
});
