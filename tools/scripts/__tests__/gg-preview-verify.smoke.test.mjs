#!/usr/bin/env node
// Smoke tests for gg-preview-verify.mjs.
// Hermetic: NO chromium launch, NO live network. Spawn-based CLI black-box for the
// required-arg contract + direct imports for pure URL/heuristic helpers.
//
// Run: node --test /tmp/gg-landing-staging/__tests__/gg-preview-verify.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import {
  parseArgs,
  validateArgs,
  buildEnUrl,
  buildZhUrl,
  isBenignResourceUrl,
  isAppBundleUrl,
  looksLikeAuthWall,
  wirePageListeners,
  verifyPage,
  runVerification,
  EXIT,
} from '../gg-preview-verify.mjs';

const TOOL_PATH = fileURLToPath(new URL('../gg-preview-verify.mjs', import.meta.url));

function runCli(args, extraEnv = {}) {
  // Strip the default-bypass env so it cannot leak into arg defaults.
  const env = { ...process.env, ...extraEnv };
  delete env.VERCEL_AUTOMATION_BYPASS_SECRET;
  return spawnSync(process.execPath, [TOOL_PATH, ...args], { encoding: 'utf8', env, timeout: 30000 });
}

// ============================================================
// Required-arg contract (the core hermetic assertion)
// ============================================================

test('CLI: both --preview-url and --slug missing → nonzero + BOTH required-arg messages', () => {
  const r = runCli([]);
  assert.notEqual(r.status, 0, `expected nonzero, got ${r.status}`);
  assert.equal(r.status, EXIT.CLI);
  assert.match(r.stderr, /--preview-url is required/);
  assert.match(r.stderr, /--slug is required/);
});

test('CLI: only --slug given → fails with just --preview-url message', () => {
  const r = runCli(['--slug', 'chiron-in-7th-house']);
  assert.notEqual(r.status, 0);
  assert.equal(r.status, EXIT.CLI);
  assert.match(r.stderr, /--preview-url is required/);
  assert.doesNotMatch(r.stderr, /--slug is required/);
});

test('CLI: only --preview-url given → fails with just --slug message', () => {
  const r = runCli(['--preview-url', 'https://preview.example.com']);
  assert.notEqual(r.status, 0);
  assert.equal(r.status, EXIT.CLI);
  assert.match(r.stderr, /--slug is required/);
  assert.doesNotMatch(r.stderr, /--preview-url is required/);
});

test('CLI: --help → exit 0, prints usage', () => {
  const r = runCli(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--preview-url/);
});

// ============================================================
// validateArgs (pure)
// ============================================================

test('validateArgs: both present → no errors', () => {
  assert.deepEqual(validateArgs({ previewUrl: 'https://x', slug: 's' }), []);
});

test('validateArgs: both missing → both messages', () => {
  const errs = validateArgs({ previewUrl: '', slug: '' });
  assert.ok(errs.includes('--preview-url is required'));
  assert.ok(errs.includes('--slug is required'));
});

test('validateArgs: whitespace-only treated as missing', () => {
  const errs = validateArgs({ previewUrl: '   ', slug: '\t' });
  assert.equal(errs.length, 2);
});

// ============================================================
// parseArgs (pure)
// ============================================================

test('parseArgs: flags + defaults', () => {
  const o = parseArgs(['--preview-url', 'https://p', '--slug', 'foo', '--zh', '--json']);
  assert.equal(o.previewUrl, 'https://p');
  assert.equal(o.slug, 'foo');
  assert.equal(o.zh, true);
  assert.equal(o.json, true);
});

test('parseArgs: bypass-secret + oracle-dir override', () => {
  const o = parseArgs(['--preview-url', 'https://p', '--slug', 's', '--bypass-secret', 'sek', '--oracle-dir', '/tmp/oracle']);
  assert.equal(o.bypassSecret, 'sek');
  assert.equal(o.oracleDir, '/tmp/oracle');
});

test('parseArgs: --key=value form', () => {
  const o = parseArgs(['--preview-url=https://p', '--slug=s']);
  assert.equal(o.previewUrl, 'https://p');
  assert.equal(o.slug, 's');
});

test('parseArgs: oracle-dir defaults to GG_ORACLE_DIR or ~/oracle', () => {
  const o = parseArgs([]);
  assert.ok(o.oracleDir.length > 0);
});

// ============================================================
// URL construction — mirrors prompt step 3b + autopilot url shape
// ============================================================

test('buildEnUrl: appends /en/wiki/<slug> + bypass params', () => {
  const u = buildEnUrl('https://preview.example.com', 'chiron-in-7th-house', 'SEKRET');
  assert.match(u, /^https:\/\/preview\.example\.com\/en\/wiki\/chiron-in-7th-house\?/);
  assert.match(u, /x-vercel-protection-bypass=SEKRET/);
  assert.match(u, /x-vercel-set-bypass-cookie=true/);
});

test('buildEnUrl: trims trailing slash on base', () => {
  const u = buildEnUrl('https://preview.example.com/', 'slug', 's');
  assert.match(u, /example\.com\/en\/wiki\/slug\?/);
  assert.doesNotMatch(u, /com\/\/en/);
});

test('buildEnUrl: no bypass secret → no query string', () => {
  const u = buildEnUrl('https://preview.example.com', 'slug', '');
  assert.equal(u, 'https://preview.example.com/en/wiki/slug');
});

test('buildZhUrl: /zh/wiki/<slug>, no suffix (cookie carries over)', () => {
  const u = buildZhUrl('https://preview.example.com/', 'slug');
  assert.equal(u, 'https://preview.example.com/zh/wiki/slug');
});

// ============================================================
// console/network filtering heuristics
// ============================================================

test('isBenignResourceUrl: favicon, fonts, analytics → true', () => {
  assert.equal(isBenignResourceUrl('https://x/favicon.ico'), true);
  assert.equal(isBenignResourceUrl('https://x/fonts/inter.woff2'), true);
  assert.equal(isBenignResourceUrl('https://x/static/Inter.ttf'), true);
  assert.equal(isBenignResourceUrl('https://www.googletagmanager.com/gtag/js'), true);
  assert.equal(isBenignResourceUrl('https://cdn.segment.com/analytics.js'), true);
});

test('isBenignResourceUrl: app bundle → false', () => {
  assert.equal(isBenignResourceUrl('https://x/_next/static/chunks/main.js'), false);
});

test('isAppBundleUrl: next chunk / css / json → true', () => {
  assert.equal(isAppBundleUrl('https://x/_next/static/chunks/main-abc.js'), true);
  assert.equal(isAppBundleUrl('https://x/assets/app.css'), true);
  assert.equal(isAppBundleUrl('https://x/data/page.json'), true);
});

test('isAppBundleUrl: benign asset → false (not an app-bundle failure)', () => {
  assert.equal(isAppBundleUrl('https://x/favicon.ico'), false);
  assert.equal(isAppBundleUrl('https://x/fonts/inter.woff2'), false);
});

test('looksLikeAuthWall: vercel.com/login url → true', () => {
  assert.equal(looksLikeAuthWall({ url: 'https://vercel.com/login?next=x' }), true);
});

test('looksLikeAuthWall: "Authentication Required" body → true', () => {
  assert.equal(looksLikeAuthWall({ url: 'https://preview/en/wiki/s', title: 'Vercel', bodyText: 'Authentication Required' }), true);
});

test('looksLikeAuthWall: normal article → false', () => {
  assert.equal(looksLikeAuthWall({ url: 'https://preview/en/wiki/s', title: 'Chiron in 7th House', bodyText: 'A reflective lens on relationships.' }), false);
});

// ============================================================
// HIGH bug regression: the console/network error GATE must be live.
// Drive wirePageListeners + verifyPage with a fake page/EventEmitter (NO chromium):
// inject a pageerror and a failed app-bundle requestfailed during goto, and assert
// verifyPage returns ok:false with the error captured. If the dead-gate bug returned
// (listeners + gate read different buffers), verifyPage would wrongly return ok:true
// and these tests FAIL LOUDLY (assert, never hang).
// ============================================================

// A fake Playwright Page backed by EventEmitter. `goto` emits any queued events
// BEFORE resolving (mirrors real load-time errors firing during navigation), so the
// listeners have populated the active buffer by the time verifyPage reads it.
function makeFakePage({ html = 'good', queuedEvents = [] } = {}) {
  const ee = new EventEmitter();
  let currentUrl = 'about:blank';
  const page = {
    __activeUrl: undefined,
    on: (...a) => ee.on(...a),
    async goto(navUrl) {
      currentUrl = navUrl;
      // Fire load-time events into whatever buffer is currently active.
      for (const ev of queuedEvents) ee.emit(ev.type, ev.payload);
      return { status: () => 200 };
    },
    async waitForSelector() { return {}; },
    url: () => currentUrl,
    async title() { return 'Chiron in 7th House'; },
    async evaluate(fn) {
      const src = String(fn);
      if (html === 'good') {
        if (/body\.innerText/.test(src)) return 'A long real article body about Chiron in the 7th house and relationships, well past forty characters.';
        if (/querySelector\('h1'\)/.test(src) || /querySelector\("h1"\)/.test(src)) return 'Chiron in the 7th House';
        if (/ld\+json/.test(src)) return true;
      }
      return '';
    },
  };
  return page;
}

test('GATE LIVE: injected pageerror during goto → verifyPage ok:false, error captured', async () => {
  const errorBuffers = new Map();
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const page = makeFakePage({
    queuedEvents: [{ type: 'pageerror', payload: new Error('boom undefined is not a function') }],
  });
  wirePageListeners(page, errorBuffers);
  // Seed + activate BEFORE navigating (this is the wiring runVerification does).
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, false, 'a page that threw an uncaught JS exception MUST NOT pass');
  assert.match(res.failReason, /uncaught JS exception/);
  assert.match(res.failReason, /boom undefined is not a function/);
});

test('GATE LIVE: failed app-bundle requestfailed during goto → verifyPage ok:false', async () => {
  const errorBuffers = new Map();
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const req = {
    url: () => 'https://preview.example.com/_next/static/chunks/main-abc.js',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  };
  const page = makeFakePage({ queuedEvents: [{ type: 'requestfailed', payload: req }] });
  wirePageListeners(page, errorBuffers);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, false, 'a failed app-bundle load MUST fail verification');
  assert.match(res.failReason, /failed app-bundle load/);
  assert.match(res.failReason, /main-abc\.js/);
});

test('GATE LIVE: benign favicon requestfailed → does NOT fail (still ok:true)', async () => {
  const errorBuffers = new Map();
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const req = {
    url: () => 'https://preview.example.com/favicon.ico',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  };
  const page = makeFakePage({ queuedEvents: [{ type: 'requestfailed', payload: req }] });
  wirePageListeners(page, errorBuffers);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, true, 'a benign favicon 404 must be ignored, page still passes');
  assert.equal(res.failReason, null);
});

test('GATE LIVE: clean page with no errors → ok:true (control)', async () => {
  const errorBuffers = new Map();
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const page = makeFakePage({ queuedEvents: [] });
  wirePageListeners(page, errorBuffers);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, true);
  assert.equal(res.failReason, null);
  assert.ok(res.h1);
  assert.equal(res.jsonLd, true);
});

// ============================================================
// MEDIUM bug regression: empty bypass secret → park-needs_human, distinct reason,
// NO chromium launch. runVerification short-circuits BEFORE loadPlaywright, so this
// needs no chromium and cannot hang.
// ============================================================

test('empty bypass secret → runVerification parks needs_human, distinct reason, no chromium', async () => {
  const res = await runVerification({
    previewUrl: 'https://preview.example.com',
    slug: 'slug',
    zh: false,
    bypassSecret: '',
    oracleDir: '/nonexistent-oracle-should-never-be-touched',
    json: false,
  });
  assert.equal(res.ok, false);
  assert.equal(res.park, 'needs_human');
  assert.match(res.failReason, /no VERCEL_AUTOMATION_BYPASS_SECRET/);
  // Distinct from the generic auth-wall reason.
  assert.doesNotMatch(res.failReason, /auth\/login wall|auth wall HTTP/);
  // Did NOT enter the tooling/chromium path (oracleDir is bogus; if it had tried to
  // load playwright it would be a tooling error instead).
  assert.notEqual(res.tooling, true);
});

test('whitespace-only bypass secret → also parks needs_human', async () => {
  const res = await runVerification({
    previewUrl: 'https://preview.example.com',
    slug: 'slug',
    bypassSecret: '   ',
    oracleDir: '/nonexistent-oracle',
  });
  assert.equal(res.park, 'needs_human');
  assert.match(res.failReason, /no VERCEL_AUTOMATION_BYPASS_SECRET/);
});

// ============================================================
// LOW: --json mode includes failReason + tooling flag (empty-secret path is
// hermetic: no chromium). A consumer can classify without the exit code.
// ============================================================

test('--json: empty-secret park emits failReason + tooling=false + park in JSON', () => {
  const r = runCli(['--preview-url', 'https://preview.example.com', '--slug', 'slug', '--json']);
  // No chromium launched on this path, so stdout JSON is deterministic.
  const line = r.stdout.trim().split('\n').filter(Boolean).pop();
  const obj = JSON.parse(line);
  assert.equal(obj.ok, false);
  assert.equal(obj.tooling, false);
  assert.equal(obj.park, 'needs_human');
  assert.match(obj.failReason, /no VERCEL_AUTOMATION_BYPASS_SECRET/);
  assert.ok(Array.isArray(obj.checked));
  assert.ok(Array.isArray(obj.warnings));
});

// ============================================================
// Known-benign global classList error allowance (oracle font-ready bug)
// ============================================================
import { isKnownBenignPageError } from '../gg-preview-verify.mjs';

const CLASSLIST_MSG = "Cannot read properties of null (reading 'classList')";
const INLINE_STACK = `TypeError: ${CLASSLIST_MSG}\n    at https://preview.example.com/en/wiki/slug:135:23`;
const BUNDLE_STACK = `TypeError: ${CLASSLIST_MSG}\n    at https://preview.example.com/_next/static/chunks/main-abc.js:5:10`;

test('isKnownBenignPageError: classList-null + inline-document stack → benign', () => {
  assert.equal(isKnownBenignPageError(CLASSLIST_MSG, INLINE_STACK), true);
});

test('isKnownBenignPageError: classList-null with NO stack → NOT benign (fail-closed)', () => {
  // A bare message with no usable stack must still fail the gate — a real app-code
  // classList bug without a stack must not be silently allowed (codex review).
  assert.equal(isKnownBenignPageError(CLASSLIST_MSG, ''), false);
});

test('isKnownBenignPageError: classList-null with a non-document stack → NOT benign', () => {
  // Non-empty stack but no `at <https doc url>:line:col` frame → not trusted.
  assert.equal(isKnownBenignPageError(CLASSLIST_MSG, 'TypeError: boom\n    at <anonymous>'), false);
});

test('isKnownBenignPageError: classList-null from a JS BUNDLE → NOT benign (still fails gate)', () => {
  assert.equal(isKnownBenignPageError(CLASSLIST_MSG, BUNDLE_STACK), false);
});

test('isKnownBenignPageError: a different error is never benign', () => {
  assert.equal(isKnownBenignPageError('foo is not a function', INLINE_STACK), false);
  assert.equal(isKnownBenignPageError('Cannot read properties of null (reading \'foo\')', INLINE_STACK), false);
});

test('isKnownBenignPageError: GG_VERIFY_ALLOW_KNOWN_ERRORS=0 disables the allowance', () => {
  const prev = process.env.GG_VERIFY_ALLOW_KNOWN_ERRORS;
  process.env.GG_VERIFY_ALLOW_KNOWN_ERRORS = '0';
  try {
    assert.equal(isKnownBenignPageError(CLASSLIST_MSG, INLINE_STACK), false);
  } finally {
    if (prev === undefined) delete process.env.GG_VERIFY_ALLOW_KNOWN_ERRORS;
    else process.env.GG_VERIFY_ALLOW_KNOWN_ERRORS = prev;
  }
});

test('GATE LIVE: benign classList pageerror (inline stack) → verifyPage ok:TRUE + recorded warning', async () => {
  const errorBuffers = new Map();
  const warnings = [];
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const page = makeFakePage({
    queuedEvents: [{ type: 'pageerror', payload: { message: CLASSLIST_MSG, stack: INLINE_STACK } }],
  });
  wirePageListeners(page, errorBuffers, warnings);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, true, 'the known-benign global classList error must NOT fail the gate');
  assert.equal(warnings.length, 1, 'it must be recorded as a visible warning, not silently dropped');
  assert.match(warnings[0], /known-benign global error ignored/);
});

test('GATE LIVE: classList pageerror from a JS BUNDLE → verifyPage STILL ok:false', async () => {
  const errorBuffers = new Map();
  const warnings = [];
  const navUrl = 'https://preview.example.com/en/wiki/slug';
  const page = makeFakePage({
    queuedEvents: [{ type: 'pageerror', payload: { message: CLASSLIST_MSG, stack: BUNDLE_STACK } }],
  });
  wirePageListeners(page, errorBuffers, warnings);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  const res = await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(res.ok, false, 'a classList error originating in app code MUST still fail the gate');
  assert.match(res.failReason, /uncaught JS exception/);
});

test('GATE LIVE: benign-warning redacts the bypass secret AT SOURCE (not just JSON output)', async () => {
  const errorBuffers = new Map();
  const warnings = [];
  const secret = 'SUPER-SECRET-BYPASS';
  const navUrl = `https://preview.example.com/en/wiki/slug?x-vercel-protection-bypass=${secret}&x-vercel-set-bypass-cookie=true`;
  const page = makeFakePage({
    queuedEvents: [{ type: 'pageerror', payload: { message: CLASSLIST_MSG, stack: INLINE_STACK } }],
  });
  wirePageListeners(page, errorBuffers, warnings);
  errorBuffers.set(navUrl, []);
  page.__activeUrl = navUrl;

  await verifyPage(page, navUrl, { errorBuffers });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes(secret), 'result.warnings must NOT contain the raw bypass secret');
  assert.match(warnings[0], /x-vercel-protection-bypass=<redacted>/);
});
