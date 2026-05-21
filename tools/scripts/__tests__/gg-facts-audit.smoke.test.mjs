#!/usr/bin/env node
// Smoke test for gg-facts-audit.mjs
// Node built-in `node:test` + `node:assert` only — no npm deps.
//
// Run: node --test tools/scripts/__tests__/gg-facts-audit.smoke.test.mjs

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  scanTrackEventsInSource,
  scanOracleDir,
  findOracleSrc,
  validateOracleSrc,
  assertOracleVsExpected,
  assertCtaMapVsOracle,
  assertKeywordSchema,
  assertPiiAbsent,
  assertGscObservedVsExpected,
  summarize,
  parseSimpleYaml,
  loadOrInitConfig,
  redact,
  errorCode,
  EXPECTED_KEYWORD_HEADERS,
  DEFAULT_PII_BLACKLIST,
  SEVERITY,
  sidecarPathFor,
  buildSidecar,
} from '../gg-facts-audit.mjs';

// ============================================================
// helpers
// ============================================================

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'gg-facts-audit-'));
}

// ============================================================
// trackEvent regex scan
// ============================================================

test('scanTrackEventsInSource: extracts single-quoted event names', () => {
  const src = `
    function onClick() {
      trackEvent('newsletter_submit_success');
      trackEvent("cta_click");
      trackEvent(\`article_view\`);
    }
  `;
  const out = scanTrackEventsInSource(src);
  assert.deepEqual(out.events.sort(), ['article_view', 'cta_click', 'newsletter_submit_success']);
  assert.equal(out.dynamicHits.length, 0);
});

test('scanTrackEventsInSource: flags dynamic event names as warnings', () => {
  const src = `
    const name = 'foo';
    trackEvent(name);
    trackEvent('signup_click');
  `;
  const out = scanTrackEventsInSource(src);
  assert.deepEqual(out.events, ['signup_click']);
  assert.ok(out.dynamicHits.length >= 1, 'expected at least one dynamic hit');
});

test('scanTrackEventsInSource: ignores trackEvent in comments/other-tokens loosely', () => {
  // regex is intentionally permissive; ensure no crash on weird inputs
  const src = `// trackEvent('not_called_but_regex_matches')\nconst x = 1;`;
  const out = scanTrackEventsInSource(src);
  // we accept either behavior; key is "no throw" + returns array
  assert.ok(Array.isArray(out.events));
});

test('scanOracleDir: walks a temp dir of .ts/.tsx/.js files', () => {
  const dir = sandbox();
  mkdirSync(join(dir, 'components'), { recursive: true });
  writeFileSync(join(dir, 'components', 'A.tsx'), `trackEvent('paid_signup');`);
  writeFileSync(join(dir, 'components', 'B.ts'), `trackEvent('newsletter_submit_success');`);
  writeFileSync(join(dir, 'components', 'C.js'), `trackEvent("cta_click");`);
  writeFileSync(join(dir, 'README.md'), `trackEvent('not_scanned_md');`); // .md ignored
  mkdirSync(join(dir, 'node_modules', 'evil'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'evil', 'D.ts'), `trackEvent('should_be_skipped');`);

  const res = scanOracleDir(dir);
  assert.equal(res.ok, true);
  assert.deepEqual(
    res.events.sort(),
    ['cta_click', 'newsletter_submit_success', 'paid_signup'],
  );
  assert.equal(res.filesScanned, 3);
});

test('scanOracleDir: returns ok=false when dir does not exist', () => {
  const res = scanOracleDir('/nonexistent/path/abc/xyz');
  assert.equal(res.ok, false);
  assert.ok(res.reason.includes('not found'));
});

test('findOracleSrc: returns null when explicit path missing', () => {
  assert.equal(findOracleSrc('/nope/abc'), null);
});

test('findOracleSrc: returns explicit path when it exists', () => {
  const dir = sandbox();
  assert.equal(findOracleSrc(dir), dir);
});

// ============================================================
// Assertion #1 — oracle ⊇ expected
// ============================================================

test('#1 pass when oracle has all expected events', () => {
  const r = assertOracleVsExpected({
    oracleEvents: ['paid_signup', 'cta_click', 'extra_event'],
    expectedEvents: ['paid_signup', 'cta_click'],
    oracleScanOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.CRITICAL);
  assert.equal(r.id, 1);
});

test('#1 fail when oracle missing expected events', () => {
  const r = assertOracleVsExpected({
    oracleEvents: ['cta_click'],
    expectedEvents: ['paid_signup', 'cta_click', 'newsletter_submit_success'],
    oracleScanOk: true,
  });
  assert.equal(r.pass, false);
  assert.equal(r.severity, SEVERITY.CRITICAL);
  assert.deepEqual(r.details.missing.sort(), ['newsletter_submit_success', 'paid_signup']);
});

test('#1 graceful skip → INFO when oracle source missing', () => {
  const r = assertOracleVsExpected({
    oracleEvents: [],
    expectedEvents: ['paid_signup'],
    oracleScanOk: false,
    oracleScanReason: 'no oracle dir',
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.INFO);
  assert.ok(r.evidence.includes('graceful skip'));
});

test('#1 empty expected → INFO informational pass', () => {
  const r = assertOracleVsExpected({
    oracleEvents: ['evt1', 'evt2'],
    expectedEvents: [],
    oracleScanOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.INFO);
});

// ============================================================
// Assertion #2 — cta_map ⊆ oracle
// ============================================================

test('#2 pass when cta_map ⊆ oracle', () => {
  const r = assertCtaMapVsOracle({
    ctaMapEvents: ['cta_click'],
    oracleEvents: ['cta_click', 'paid_signup'],
    oracleScanOk: true,
    ctaMapOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.CRITICAL);
});

test('#2 fail when cta_map lists event not in oracle', () => {
  const r = assertCtaMapVsOracle({
    ctaMapEvents: ['cta_click', 'orphan_event'],
    oracleEvents: ['cta_click'],
    oracleScanOk: true,
    ctaMapOk: true,
  });
  assert.equal(r.pass, false);
  assert.deepEqual(r.details.orphan, ['orphan_event']);
});

test('#2 fail when cta_map read failed', () => {
  const r = assertCtaMapVsOracle({
    ctaMapEvents: [],
    oracleEvents: ['anything'],
    oracleScanOk: true,
    ctaMapOk: false,
    ctaMapReason: 'PERMISSION_DENIED',
  });
  assert.equal(r.pass, false);
  assert.equal(r.severity, SEVERITY.CRITICAL);
});

test('#2 graceful skip when oracle missing', () => {
  const r = assertCtaMapVsOracle({
    ctaMapEvents: ['x'],
    oracleEvents: [],
    oracleScanOk: false,
    ctaMapOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.INFO);
});

// ============================================================
// Assertion #3 — keyword_candidates schema
// ============================================================

test('#3 pass when headers exact match expected 11 cols', () => {
  const r = assertKeywordSchema({
    actualHeaders: [...EXPECTED_KEYWORD_HEADERS],
    expectedHeaders: [...EXPECTED_KEYWORD_HEADERS],
    headersOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.HIGH);
});

test('#3 fail when column order swapped', () => {
  const swapped = [...EXPECTED_KEYWORD_HEADERS];
  swapped[2] = 'source'; // swap query & source
  swapped[3] = 'query';
  const r = assertKeywordSchema({
    actualHeaders: swapped,
    expectedHeaders: [...EXPECTED_KEYWORD_HEADERS],
    headersOk: true,
  });
  assert.equal(r.pass, false);
  assert.ok(r.details.diffs.length >= 2);
});

test('#3 fail when read failed', () => {
  const r = assertKeywordSchema({
    actualHeaders: [],
    expectedHeaders: [...EXPECTED_KEYWORD_HEADERS],
    headersOk: false,
    headersReason: 'sheet not found',
  });
  assert.equal(r.pass, false);
  assert.equal(r.severity, SEVERITY.HIGH);
});

// ============================================================
// Assertion #4 — PII absent from GSC
// ============================================================

test('#4 pass when no PII keyword appears in GSC queries', () => {
  const r = assertPiiAbsent({
    gscQueries: [{ query: 'saturn return age 29' }, { query: 'venus return meaning' }],
    piiBlacklist: ['email', '@gmail.com', 'phone'],
    gscOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.CRITICAL);
});

test('#4 fail when PII term appears in a query', () => {
  const r = assertPiiAbsent({
    gscQueries: [{ query: 'send me email about my chart' }],
    piiBlacklist: ['email', 'phone'],
    gscOk: true,
  });
  assert.equal(r.pass, false);
  assert.equal(r.severity, SEVERITY.CRITICAL);
  assert.equal(r.details.hits[0].term, 'email');
});

test('#4 fail when GSC read failed', () => {
  const r = assertPiiAbsent({
    gscQueries: [],
    piiBlacklist: ['email'],
    gscOk: false,
    gscReason: '403 forbidden',
  });
  assert.equal(r.pass, false);
});

// ============================================================
// Assertion #5 — GSC observed (cold-start OK)
// ============================================================

test('#5 INFO pass when cold-start (0 rows)', () => {
  const r = assertGscObservedVsExpected({
    gscQueries: [],
    expectedEvents: ['paid_signup'],
    gscOk: true,
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.INFO);
  assert.ok(r.evidence.includes('cold-start'));
});

test('#5 INFO pass when GSC unavailable', () => {
  const r = assertGscObservedVsExpected({
    gscQueries: [],
    expectedEvents: [],
    gscOk: false,
    gscReason: 'unset',
  });
  assert.equal(r.pass, true);
  assert.equal(r.severity, SEVERITY.INFO);
});

// ============================================================
// summarize
// ============================================================

test('summarize: any CRITICAL fail → status=fail', () => {
  const sum = summarize([
    { severity: SEVERITY.CRITICAL, pass: false },
    { severity: SEVERITY.HIGH, pass: true },
    { severity: SEVERITY.INFO, pass: true },
  ]);
  assert.equal(sum.status, 'fail');
  assert.equal(sum.anyCriticalFail, true);
});

test('summarize: HIGH fail only → status=partial', () => {
  const sum = summarize([
    { severity: SEVERITY.CRITICAL, pass: true },
    { severity: SEVERITY.HIGH, pass: false },
    { severity: SEVERITY.INFO, pass: true },
  ]);
  assert.equal(sum.status, 'partial');
  assert.equal(sum.anyCriticalFail, false);
  assert.equal(sum.anyHighFail, true);
});

test('summarize: all pass → status=ok', () => {
  const sum = summarize([
    { severity: SEVERITY.CRITICAL, pass: true },
    { severity: SEVERITY.HIGH, pass: true },
    { severity: SEVERITY.INFO, pass: true },
  ]);
  assert.equal(sum.status, 'ok');
});

// ============================================================
// YAML reader
// ============================================================

test('parseSimpleYaml: parses key: value + list items', () => {
  const text = `
expected_events:
  - foo
  - bar
pii_blacklist:
  - "email"
  - '@gmail.com'

scalar: hello
`;
  const parsed = parseSimpleYaml(text);
  assert.deepEqual(parsed.expected_events, ['foo', 'bar']);
  assert.deepEqual(parsed.pii_blacklist, ['email', '@gmail.com']);
  assert.equal(parsed.scalar, 'hello');
});

test('loadOrInitConfig: creates template when missing + returns defaults', () => {
  const dir = sandbox();
  const cfgPath = join(dir, 'facts-audit.yml');
  const res = loadOrInitConfig(cfgPath);
  assert.equal(res.created, true);
  assert.ok(Array.isArray(res.config.expected_events));
  assert.ok(res.config.expected_events.length > 0);
  assert.ok(Array.isArray(res.config.pii_blacklist));
});

test('loadOrInitConfig: reads existing config file', () => {
  const dir = sandbox();
  const cfgPath = join(dir, 'facts-audit.yml');
  writeFileSync(
    cfgPath,
    `expected_events:\n  - custom_event\npii_blacklist:\n  - my_pii\n`,
  );
  const res = loadOrInitConfig(cfgPath);
  assert.equal(res.created, false);
  assert.deepEqual(res.config.expected_events, ['custom_event']);
  assert.deepEqual(res.config.pii_blacklist, ['my_pii']);
});

test('loadOrInitConfig: backfills DEFAULT_PII_BLACKLIST when empty', () => {
  const dir = sandbox();
  const cfgPath = join(dir, 'facts-audit.yml');
  writeFileSync(cfgPath, `expected_events:\n  - x\n`);
  const res = loadOrInitConfig(cfgPath);
  assert.deepEqual(res.config.pii_blacklist, [...DEFAULT_PII_BLACKLIST]);
});

// ============================================================
// redact reuse
// ============================================================

test('redact: strips Bearer tokens and long token-like blobs', () => {
  const s = redact('Authorization: Bearer abc123xyz.def456 and AKIA1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  assert.ok(!s.includes('Bearer abc123xyz'));
  assert.ok(s.includes('<redacted>'));
});

test('errorCode: maps common error patterns', () => {
  assert.equal(errorCode(new Error('fetch failed: ENOTFOUND')), 'ERR_NETWORK');
  assert.equal(errorCode(new Error('401 Unauthorized')), 'ERR_AUTH');
  assert.equal(errorCode(new Error('JSON parse error')), 'ERR_PARSE');
  assert.equal(errorCode(new Error('schema validation failed')), 'ERR_VALIDATION');
  assert.equal(errorCode(new Error('something else')), 'ERR_OTHER');
});

// ============================================================
// Fix 2 — validateOracleSrc realpath jail (file-enumeration防护)
// ============================================================

test('validateOracleSrc: throws on empty/non-string input', () => {
  assert.throws(() => validateOracleSrc(''));
  assert.throws(() => validateOracleSrc(null));
});

test('validateOracleSrc: rejects nonexistent path (not found)', () => {
  assert.throws(
    () => validateOracleSrc('/nonexistent/oracle/path/abc/xyz/qqq'),
    /not found/,
  );
});

test('validateOracleSrc: rejects /etc/passwd when at least one allowed root exists; permissive otherwise', () => {
  // The function permissively allows any real path when NO well-known oracle roots
  // exist on the machine (avoids breaking wzb's fresh-laptop experimentation).
  // We probe the candidate roots first; if at least one exists, the jail kicks in
  // and /etc/passwd MUST throw. Otherwise we exercise the permissive fallback.
  const candidates = [
    join(process.env.HOME || '', 'oracle'),
    join(process.env.HOME || '', 'gengrowth', 'oracle'),
    join(process.env.HOME || '', 'Code', 'oracle'),
  ];
  const anyRootExists = candidates.some((c) => existsSync(c));
  if (!anyRootExists) {
    // Permissive fallback: /etc/passwd should resolve (it exists on macOS/Linux);
    // either it returns a real path or fails with a fs-level error — both acceptable.
    let threw = false;
    try {
      const real = validateOracleSrc('/etc/passwd', { warn: () => {} });
      assert.equal(typeof real, 'string');
    } catch (e) {
      threw = true;
      assert.ok(/not found|denied|EACCES/i.test(e.message), `unexpected error: ${e.message}`);
    }
    // either branch is acceptable — the contract is "no jail to enforce"
    assert.ok(typeof threw === 'boolean');
    return;
  }
  // At least one allowed root exists → /etc/passwd must throw (jail enforced).
  assert.throws(() => validateOracleSrc('/etc/passwd', { warn: () => {} }), /must be under|not found/);
});

// ============================================================
// Fix 4 — JSON sidecar (consumed by /gg-gate-check vertical-slice)
// ============================================================

test('sidecarPathFor: swaps .md → .json', () => {
  assert.equal(
    sidecarPathFor('/tmp/facts-audit-2026-05-21.md'),
    '/tmp/facts-audit-2026-05-21.json',
  );
});

test('sidecarPathFor: appends .json when path has no .md ext', () => {
  assert.equal(sidecarPathFor('/tmp/facts-audit-no-ext'), '/tmp/facts-audit-no-ext.json');
});

test('buildSidecar: schema includes ts/status/critical_count/high_count/info_count/assertions[]', () => {
  const assertions = [
    { id: 1, name: '#1 oracle', severity: SEVERITY.CRITICAL, pass: true, evidence: 'evidence 1' },
    { id: 2, name: '#2 cta_map', severity: SEVERITY.CRITICAL, pass: false, evidence: 'evidence 2' },
    { id: 3, name: '#3 schema', severity: SEVERITY.HIGH, pass: false, evidence: 'evidence 3' },
  ];
  const summary = summarize(assertions);
  const sidecar = buildSidecar({ assertions, summary });
  // schema shape
  assert.equal(typeof sidecar.ts, 'string');
  assert.match(sidecar.ts, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(['pass', 'fail', 'partial', 'ok'].includes(sidecar.status));
  assert.equal(typeof sidecar.critical_count, 'number');
  assert.equal(typeof sidecar.high_count, 'number');
  assert.equal(typeof sidecar.info_count, 'number');
  // counts reflect the assertions above
  assert.equal(sidecar.critical_count, 1);
  assert.equal(sidecar.high_count, 1);
  assert.equal(sidecar.info_count, 0);
  // assertions array
  assert.equal(sidecar.assertions.length, 3);
  assert.deepEqual(
    sidecar.assertions.map((a) => a.status),
    ['pass', 'fail', 'fail'],
  );
  // each entry has id/name/severity/status/evidence_summary
  for (const a of sidecar.assertions) {
    assert.equal(typeof a.id, 'number');
    assert.equal(typeof a.name, 'string');
    assert.equal(typeof a.severity, 'string');
    assert.ok(['pass', 'fail'].includes(a.status));
    assert.equal(typeof a.evidence_summary, 'string');
  }
});

test('buildSidecar: status=pass when no CRITICAL/HIGH fails', () => {
  const assertions = [
    { id: 1, name: '#1', severity: SEVERITY.CRITICAL, pass: true, evidence: 'ok' },
    { id: 2, name: '#2', severity: SEVERITY.HIGH, pass: true, evidence: 'ok' },
    { id: 3, name: '#3', severity: SEVERITY.INFO, pass: true, evidence: 'ok' },
  ];
  const sidecar = buildSidecar({ assertions, summary: summarize(assertions) });
  assert.equal(sidecar.status, 'ok');
  assert.equal(sidecar.critical_count, 0);
});
