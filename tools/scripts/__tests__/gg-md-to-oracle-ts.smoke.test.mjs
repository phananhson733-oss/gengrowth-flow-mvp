#!/usr/bin/env node
// Smoke test for gg-md-to-oracle-ts.mjs — EN-only converter (zh removed
// 2026-07-03; the bilingual mergeIntoSibling path was deleted with it).
// Covers: emitExportBlock/emitTs shape, atomicWrite, slugToCamel identifier
// safety, deriveDescription, and the hard rejection of --language zh.
// Run: node --test tools/scripts/__tests__/gg-md-to-oracle-ts.smoke.test.mjs

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  deriveDescription,
  emitExportBlock,
  emitTs,
  atomicWrite,
  slugToCamel,
} from '../gg-md-to-oracle-ts.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'gg-md-to-oracle-ts.mjs');

test('emitExportBlock: no authorMeta → authorId "" + lang en', () => {
  const out = emitExportBlock({
    slug: 'x', title: 't', date: '2026-05-25', description: 'd',
    keywords: ['k'], body: 'b', varName: 'xEn',
  });
  assert.match(out, /authorId: ""/);
  assert.match(out, /lang: "en"/);
});

test('emitTs: includes WikiArticle import + export shape', () => {
  const ts = emitTs({
    slug: 'x', title: 't', date: '2026-05-25', description: 'd',
    keywords: [], body: 'b', varName: 'xEn',
  });
  assert.match(ts, /import type \{ WikiArticle \} from "\.\.\/\.\.\/types";/);
  assert.match(ts, /export const xEn: WikiArticle = \{/);
  assert.match(ts, /^\};\n*$/m);
});

// EN-only regression: --language zh must be REJECTED with a clear error (exit 2),
// never silently converted as English (both the --batch and --source CLI paths).
test('CLI: --language zh → exit 2 with EN-only error (single-file path)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-conv-'));
  const src = join(dir, 'draft.md');
  writeFileSync(src, '---\nslug: x\n---\n# T\n\nBody.\n');
  const r = spawnSync('node', [SCRIPT, '--source', src, '--out', join(dir, 'x.ts'), '--language', 'zh'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /EN-only/);
  rmSync(dir, { recursive: true });
});

test('CLI: --batch --language zh → exit 2 with EN-only error', () => {
  const r = spawnSync('node', [SCRIPT, '--batch', '--language', 'zh'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /EN-only/);
});

test('atomicWrite: tmp file does not leak after successful write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-atomic-'));
  const p = join(dir, 'target.txt');
  atomicWrite(p, 'hello');
  assert.equal(readFileSync(p, 'utf8'), 'hello');
  // Verify no .tmp.<pid> file leaked
  const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp.'));
  assert.equal(leftovers.length, 0);
  rmSync(dir, { recursive: true });
});

// ---------- slugToCamel: leading-ordinal slugs must yield VALID JS identifiers ----------
// (2026-05-26) "8th-house-meaning" → "8thHouseMeaningEn" is a syntax error that
// broke the oracle build. Leading ordinals spell out; identifiers stay valid.
test('slugToCamel: leading ordinal slugs → valid identifiers', () => {
  const valid = (s) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
  assert.equal(slugToCamel('8th-house-meaning', 'En'), 'eighthHouseMeaningEn');
  assert.equal(slugToCamel('11th-house', 'En'), 'eleventhHouseEn');
  assert.equal(slugToCamel('12th-house-astrology', 'En'), 'twelfthHouseAstrologyEn');
  for (const s of ['8th-house-meaning', '9th-house-astrology', '11th-house', '12th-house-astrology']) {
    assert.ok(valid(slugToCamel(s, 'En')), `invalid id from ${s}`);
  }
  // non-ordinal slugs unchanged
  assert.equal(slugToCamel('green-aura-meaning', 'En'), 'greenAuraMeaningEn');
});

test('deriveDescription: keeps a complete long sentence instead of truncating a date at comma', () => {
  const body = [
    '# Why the NiKo Birth Chart Made the Cologne Major Inevitable',
    '',
    '## What Is the NiKo Birth Chart?',
    '',
    'The NiKo birth chart is **an Aquarius-dominant natal map for CS2 player Nikola Kovač**, born February 16, 1997 — a horoscope that traditional astrologers associate with exceptional individual output followed by delayed collective breakthrough.',
    '',
    'More prose.',
  ].join('\n');
  const desc = deriveDescription(body);
  assert.match(desc, /February 16, 1997/);
  assert.match(desc, /breakthrough\.$/);
  assert.doesNotMatch(desc, /February 16$/);
});

// deriveDescription's CJK sentence-boundary handling is language-agnostic string
// processing — kept as coverage for the legacy bilingual back catalog.
test('deriveDescription: short complete CJK sentence beats partial second sentence', () => {
  const firstSentence = '西班牙2026世界杯占星，是一套以西班牙足协奠基日期为结构锚点、结合木星约27度巨蟹座对相位本届赛事窗口进行象征性解读的参考框架。';
  const secondSentence = '西班牙于6月15日在 H 组首战以0比0战平佛得角，第二场对阵沙特阿拉伯落在6月21日，正值木星行经晚段巨蟹座（约27度）——象征上与西班牙被关联的摩羯座价值相对立，而非对某个已验证本命点的精确相位。';
  const body = [
    '# 西班牙2026世界杯占星',
    '',
    '## 斗牛士军团的星盘是什么？',
    '',
    `${firstSentence} ${secondSentence}`,
  ].join('\n');
  assert.equal(deriveDescription(body), firstSentence);
});
