#!/usr/bin/env node
// gg-preview-verify.mjs — deterministic Playwright render-verification of a Vercel
// preview deployment. Replaces the prompt gate's MCP/Playwright checks (step 3b of
// tools/scripts/seo-autopilot-tick.prompt.md) with a single unattended, fail-closed run.
//
// Contract mirrors the prompt's chrome-preview gate:
//   - navigate <previewUrl>/en/wiki/<slug>?x-vercel-protection-bypass=<secret>&x-vercel-set-bypass-cookie=true
//   - assert: an <h1> is present, a <script type="application/ld+json"> exists, the page
//     is NOT the empty SPA soft-404 shell, NOT a vercel.com/login / auth wall.
//   - --zh: also verify <previewUrl>/zh/wiki/<slug> reusing the same browser context so the
//     bypass cookie (x-vercel-set-bypass-cookie=true) carries over.
//   - console: FAIL only on uncaught JS exceptions / failed app-bundle loads; IGNORE benign
//     favicon / font / analytics 404s.
//
// POLICY (fail-closed): if Playwright TOOLING itself fails (resolve/import/launch), exit
// nonzero with a tooling-error reason — NEVER fail-open (never report ok:true on tooling fault).
//
// CRITICAL Playwright resolution (unattended-safe): a bare import('playwright') throws
// ERR_MODULE_NOT_FOUND from this flow-mvp tree. We resolve it against the oracle dir's
// node_modules via createRequire, then import the resolved file:// URL.
//
// Run: node gg-preview-verify.mjs --preview-url <url> --slug <slug> [--zh] \
//        [--bypass-secret <s>] [--oracle-dir <dir>] [--json]

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

const EXIT = { OK: 0, CLI: 2, VERIFY_FAIL: 1, TOOLING: 3 };

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = {
    previewUrl: null,
    slug: null,
    zh: false,
    bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET || '',
    oracleDir: process.env.GG_ORACLE_DIR || join(homedir(), 'oracle'),
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--preview-url': out.previewUrl = argv[++i] ?? null; break;
      case '--slug': out.slug = argv[++i] ?? null; break;
      case '--zh': out.zh = true; break;
      case '--bypass-secret': out.bypassSecret = argv[++i] ?? ''; break;
      case '--oracle-dir': out.oracleDir = argv[++i] ?? out.oracleDir; break;
      case '--json': out.json = true; break;
      case '--help': case '-h': out.help = true; break;
      default:
        if (a.startsWith('--preview-url=')) out.previewUrl = a.slice('--preview-url='.length);
        else if (a.startsWith('--slug=')) out.slug = a.slice('--slug='.length);
        else if (a.startsWith('--bypass-secret=')) out.bypassSecret = a.slice('--bypass-secret='.length);
        else if (a.startsWith('--oracle-dir=')) out.oracleDir = a.slice('--oracle-dir='.length);
        break;
    }
  }
  return out;
}

// Validate the two REQUIRED args. Returns array of error messages (empty == ok).
// Spec: both missing -> stderr must contain BOTH messages.
export function validateArgs(opts) {
  const errors = [];
  if (!opts.previewUrl || !String(opts.previewUrl).trim()) errors.push('--preview-url is required');
  if (!opts.slug || !String(opts.slug).trim()) errors.push('--slug is required');
  return errors;
}

// ---------------------------------------------------------------------------
// URL construction — mirrors the prompt (step 3b) + gg-seo-autopilot.mjs url shape.
// ---------------------------------------------------------------------------
export function buildEnUrl(previewUrl, slug, bypassSecret) {
  const base = String(previewUrl).replace(/\/+$/, '');
  const path = `${base}/en/wiki/${encodeURIComponent(slug)}`;
  if (bypassSecret) {
    const qs = `x-vercel-protection-bypass=${encodeURIComponent(bypassSecret)}&x-vercel-set-bypass-cookie=true`;
    return `${path}?${qs}`;
  }
  return path;
}

export function buildZhUrl(previewUrl, slug) {
  // No suffix: the bypass cookie dropped by the /en navigate (set-bypass-cookie=true)
  // carries over in the same browser context.
  const base = String(previewUrl).replace(/\/+$/, '');
  return `${base}/zh/wiki/${encodeURIComponent(slug)}`;
}

// A console / network failure is benign if it's a favicon, font, or analytics asset.
export function isBenignResourceUrl(u) {
  if (!u) return false;
  const s = String(u).toLowerCase();
  if (/favicon/.test(s)) return true;
  if (/\.(?:woff2?|ttf|otf|eot)(?:[?#].*)?$/.test(s)) return true;
  if (/\/fonts?\//.test(s)) return true;
  if (/(?:google-analytics|googletagmanager|gtag|analytics|segment|plausible|mixpanel|hotjar|sentry|datadog|posthog|clarity\.ms|doubleclick|facebook\.net|fbevents)/.test(s)) return true;
  return false;
}

// A failed request is an app-bundle load failure (a real FAIL) if it's a JS/CSS/data
// document/script that is NOT benign.
export function isAppBundleUrl(u) {
  if (!u) return false;
  if (isBenignResourceUrl(u)) return false;
  const s = String(u).toLowerCase();
  return /\.(?:m?js|cjs|css|json)(?:[?#].*)?$/.test(s) || /\/_next\//.test(s) || /\/assets?\//.test(s);
}

// isKnownBenignPageError — allowance for ONE pre-existing global error present on
// EVERY astrologywiki prerendered page (EN + ZH, prod AND preview): the <head>
// font-ready script does `document.body.classList.…` inside
// `document.fonts.ready.then()`; when fonts are cached the promise resolves before
// <body> is parsed, so `document.body` is null and it throws. It is CAUGHT, purely
// cosmetic (a font-class swap), verified on LIVE prod, and NOT a regression — so it
// must not gate every publish. Matched TIGHTLY: the null-classList message AND a
// stack frame in the inline HTML document (NOT a /_next//assets/ JS bundle), so a
// genuine future classList bug in app code still fails the gate. The oracle root-fix
// (index.html null-guard) removes the error at source on re-prerender; this stays a
// belt-and-suspenders net for the ~145 already-prerendered pages. Disable with
// GG_VERIFY_ALLOW_KNOWN_ERRORS=0.
export function isKnownBenignPageError(message, stack) {
  if (process.env.GG_VERIFY_ALLOW_KNOWN_ERRORS === '0') return false;
  const msg = String(message || '');
  const isNullClassList =
    /Cannot read properties of null \(reading 'classList'\)/.test(msg) ||
    /null is not an object \(evaluating '[^']*\.classList'\)/.test(msg); // WebKit phrasing
  if (!isNullClassList) return false;
  // REQUIRE a stack (fail-closed): a bare message with no stack is NOT trusted —
  // a real app-code classList bug that surfaces without a usable stack must still
  // fail the gate. (codex review: the no-stack allowance was a fail-open hole.)
  const s = String(stack || '');
  if (!s) return false;
  // Any frame in a JS/CSS bundle disqualifies it (that's real app code, not the
  // inline <head> font script): `…/_next/…`, `…/assets/…`, or a `….js:line:col`.
  if (/\/_next\/|\/assets?\/|\.(?:m?js|cjs|css)(?:[:?]|$)/i.test(s)) return false;
  // POSITIVELY require an inline-document frame: `at <https doc url>:line:col`
  // where the url has no script/style extension (the <head> inline font script).
  // A genuine bug lives in a bundle and won't reach here.
  return /\bat\s+https?:\/\/[^\s)]+?:\d+:\d+/i.test(s);
}

// Heuristic: is this an auth / vercel-login wall (bypass wrong/expired)?
export function looksLikeAuthWall({ url, title, bodyText }) {
  const u = String(url || '').toLowerCase();
  if (/vercel\.com\/login/.test(u) || /\/sso\//.test(u) || /vercel\.com\/sso/.test(u)) return true;
  const t = `${title || ''}\n${bodyText || ''}`.toLowerCase();
  if (/authentication required/.test(t)) return true;
  if (/log in to vercel/.test(t) || /login to vercel/.test(t)) return true;
  if (/vercel authentication/.test(t)) return true;
  if (/deployment protection/.test(t) && /log\s?in/.test(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Playwright loader — fail-closed, unattended-safe.
// ---------------------------------------------------------------------------
export async function loadPlaywright(oracleDir) {
  // createRequire anchored at the oracle dir so resolution walks oracle's node_modules,
  // NOT flow-mvp's (a bare import('playwright') throws ERR_MODULE_NOT_FOUND here).
  let resolved;
  try {
    const req = createRequire(join(oracleDir, '/'));
    resolved = req.resolve('playwright');
  } catch (e) {
    const err = new Error(`playwright resolve failed from oracle-dir ${oracleDir}: ${e.message}`);
    err.tooling = true;
    throw err;
  }
  try {
    return await import(pathToFileURL(resolved).href);
  } catch (e) {
    const err = new Error(`playwright import failed (${resolved}): ${e.message}`);
    err.tooling = true;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wire console / page-error / request-failed listeners onto a page so they push
// hard errors into the buffer for the CURRENTLY-ACTIVE nav url. The active url is
// tracked on `page.__activeUrl`; the buffer for it MUST be seeded in errorBuffers
// BEFORE navigating (see runVerification's seedActive). The verifyPage gate reads
// that SAME buffer via errorBuffers.get(navUrl) — same map, same key, same array.
//
// Exported so a unit test can drive it with a fake page/EventEmitter (no chromium).
// ---------------------------------------------------------------------------
export function wirePageListeners(page, errorBuffers, warnings = []) {
  const push = (line) => {
    const buf = errorBuffers.get(page.__activeUrl);
    // If no active buffer is seeded, fail LOUD- in-buffer is impossible; seed a
    // catch-all so a stray error is never silently dropped (fail-closed bias).
    if (buf) buf.push(line);
    else errorBuffers.set(page.__activeUrl, [line]);
  };
  // A known-benign error is NOT silently dropped — it's recorded as a visible
  // warning (surfaced in --json `warnings`) so the allowance stays auditable.
  // Redact the bypass secret AT SOURCE: page.__activeUrl (the EN nav url) carries
  // ?x-vercel-protection-bypass=<secret>, so result.warnings must never hold it raw
  // — every downstream consumer/log path is then safe, not just --json output.
  const redactSecret = (s) => String(s ?? '').replace(/(x-vercel-protection-bypass=)[^&\s"'<]+/gi, '$1<redacted>');
  const noteBenign = (message) => {
    warnings.push(redactSecret(`known-benign global error ignored on ${page.__activeUrl}: ${message}`));
  };

  page.on('pageerror', (err) => {
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? err.stack : '';
    if (isKnownBenignPageError(message, stack)) { noteBenign(message); return; }
    push(`uncaught JS exception: ${message}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text() || '';
    // Ignore benign resource 404s surfaced in console.
    if (/favicon|fonts?\/|google-analytics|gtag|analytics/i.test(text)) return;
    // Real app errors only — keep uncaught/script errors.
    if (/Failed to load resource/i.test(text) && isBenignResourceUrl(text)) return;
    // A bare "Failed to load resource" w/ a benign url already filtered; keep the rest
    // ONLY if it references the app bundle or is an explicit JS error.
    if (/Failed to load resource/i.test(text)) {
      if (isAppBundleUrl(text)) push(`failed app-bundle load (console): ${text}`);
      return;
    }
    // NOTE: the known-benign classList allowance is intentionally NOT applied to
    // console errors — they carry no usable browser stack, so they can't satisfy
    // isKnownBenignPageError's inline-document-frame requirement, and allowing them
    // on message alone would be a fail-open hole (codex review). The real error is
    // an uncaught pageerror (handled above), so nothing legitimate is lost here.
    // Uncaught/Unhandled errors in console.
    if (/uncaught|unhandled|TypeError|ReferenceError|SyntaxError/i.test(text)) {
      push(`console error: ${text}`);
    }
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (isBenignResourceUrl(url)) return;
    if (isAppBundleUrl(url)) {
      const f = req.failure();
      push(`failed app-bundle load: ${url} (${f ? f.errorText : 'unknown'})`);
    }
  });
}

// ---------------------------------------------------------------------------
// Verify a single rendered URL inside an already-open page.
// Returns { url, h1, jsonLd, ok, failReason }.
// ---------------------------------------------------------------------------
export async function verifyPage(page, navUrl, { errorBuffers }) {
  // Read the SAME buffer the page listeners push into. It was seeded BEFORE the
  // navigate (see runVerification's seedBuffer/setActive), so do NOT re-create it
  // here — re-creating it would orphan the listeners' pushes and dead-gate errors.
  const errors = errorBuffers.get(navUrl) || [];
  let resp;
  try {
    resp = await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    return { url: navUrl, h1: null, jsonLd: false, ok: false, failReason: `navigation failed: ${e.message}` };
  }

  // Give the SPA a beat to hydrate its <h1> / JSON-LD.
  try { await page.waitForSelector('h1', { timeout: 8000 }); } catch { /* asserted below */ }

  const status = resp ? resp.status() : 0;
  const finalUrl = page.url();
  const title = await page.title().catch(() => '');
  const bodyText = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');

  if (looksLikeAuthWall({ url: finalUrl, title, bodyText })) {
    return { url: navUrl, h1: null, jsonLd: false, ok: false, failReason: `vercel auth/login wall (bypass wrong or expired); landed on ${finalUrl}` };
  }
  if (status === 401 || status === 403) {
    return { url: navUrl, h1: null, jsonLd: false, ok: false, failReason: `auth wall HTTP ${status}` };
  }

  const h1 = await page.evaluate(() => {
    const el = document.querySelector('h1');
    return el ? (el.textContent || '').trim() : null;
  }).catch(() => null);

  const jsonLd = await page.evaluate(() => {
    return document.querySelectorAll('script[type="application/ld+json"]').length > 0;
  }).catch(() => false);

  // Empty SPA soft-404 shell: no h1, near-empty body.
  const bodyLen = (bodyText || '').trim().length;
  if (!h1 && bodyLen < 40) {
    return { url: navUrl, h1: null, jsonLd, ok: false, failReason: 'empty SPA soft-404 shell (no <h1>, empty body)' };
  }
  if (!h1) {
    return { url: navUrl, h1: null, jsonLd, ok: false, failReason: 'no <h1> on rendered page' };
  }
  if (!jsonLd) {
    return { url: navUrl, h1, jsonLd: false, ok: false, failReason: 'no <script type="application/ld+json"> on page' };
  }

  // Uncaught JS exceptions / failed app-bundle loads (benign 404s ignored by collector).
  if (errors.length) {
    return { url: navUrl, h1, jsonLd, ok: false, failReason: errors[0] };
  }

  return { url: navUrl, h1, jsonLd, ok: true, failReason: null };
}

// ---------------------------------------------------------------------------
// Main verification — fail-closed on tooling errors.
// Returns { ok, checked:[{url,h1,jsonLd}], warnings:[], failReason?, tooling? }.
// ---------------------------------------------------------------------------
export async function runVerification(opts) {
  // ---- PRE-FLIGHT: empty bypass secret (prompt step 3b, line 29) ----
  // If the Vercel automation bypass secret is empty, verification CANNOT run
  // (the preview sits behind Deployment Protection). STOP with a DISTINCT
  // park-needs_human reason BEFORE launching chromium — do NOT navigate bare and
  // fail generically as an "auth wall".
  if (!opts.bypassSecret || !String(opts.bypassSecret).trim()) {
    return {
      ok: false,
      checked: [],
      warnings: [],
      park: 'needs_human',
      failReason: 'no VERCEL_AUTOMATION_BYPASS_SECRET in _gg.env (verification cannot run; park needs_human)',
    };
  }

  let pw;
  try {
    pw = await loadPlaywright(opts.oracleDir);
  } catch (e) {
    return { ok: false, checked: [], warnings: [], tooling: true, failReason: `tooling-error: ${e.message}` };
  }

  const chromium = pw.chromium || (pw.default && pw.default.chromium);
  if (!chromium) {
    return { ok: false, checked: [], warnings: [], tooling: true, failReason: 'tooling-error: playwright module has no chromium export' };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    return { ok: false, checked: [], warnings: [], tooling: true, failReason: `tooling-error: chromium launch failed: ${e.message}` };
  }

  const checked = [];
  const warnings = [];
  // per-url hard-error buffers, keyed by the nav url.
  const errorBuffers = new Map();

  try {
    // ONE shared context so the Vercel bypass cookie persists across en -> zh.
    const context = await browser.newContext();
    const page = await context.newPage();
    wirePageListeners(page, errorBuffers, warnings);

    // Seed + activate a url's buffer BEFORE navigating, so the listeners and the
    // verifyPage gate read the SAME buffer (page.__activeUrl points the listeners
    // at errorBuffers.get(url)). Without this seeding the gate is dead.
    const seedActive = (url) => {
      if (!errorBuffers.has(url)) errorBuffers.set(url, []);
      page.__activeUrl = url;
    };

    // --- EN ---
    const enUrl = buildEnUrl(opts.previewUrl, opts.slug, opts.bypassSecret);
    seedActive(enUrl);
    const enResult = await verifyPage(page, enUrl, { errorBuffers });
    checked.push({ url: enResult.url, h1: enResult.h1, jsonLd: enResult.jsonLd });
    if (!enResult.ok) {
      await context.close().catch(() => {});
      return { ok: false, checked, warnings, failReason: `[en] ${enResult.failReason}` };
    }

    // --- ZH (optional, same context so bypass cookie carries over) ---
    if (opts.zh) {
      const zhUrl = buildZhUrl(opts.previewUrl, opts.slug);
      seedActive(zhUrl);
      const zhResult = await verifyPage(page, zhUrl, { errorBuffers });
      checked.push({ url: zhResult.url, h1: zhResult.h1, jsonLd: zhResult.jsonLd });
      if (!zhResult.ok) {
        await context.close().catch(() => {});
        return { ok: false, checked, warnings, failReason: `[zh] ${zhResult.failReason}` };
      }
    }

    await context.close().catch(() => {});
    return { ok: true, checked, warnings };
  } catch (e) {
    // An unexpected fault mid-run is treated as tooling (fail-closed).
    return { ok: false, checked, warnings, tooling: true, failReason: `tooling-error: unexpected ${e.message}` };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const HELP = `gg-preview-verify.mjs — deterministic Playwright render-verification of a preview.

Usage:
  node gg-preview-verify.mjs --preview-url <url> --slug <slug> [--zh] \\
       [--bypass-secret <s>] [--oracle-dir <dir>] [--json]

Required:
  --preview-url <url>   Vercel preview base URL (environment_url)
  --slug <slug>         article slug (verifies /en/wiki/<slug>)

Options:
  --zh                  also verify /zh/wiki/<slug> (reuses bypass cookie)
  --bypass-secret <s>   default: $VERCEL_AUTOMATION_BYPASS_SECRET
  --oracle-dir <dir>    default: $GG_ORACLE_DIR || ~/oracle
  --json                emit JSON evidence to stdout

Exit codes: 0 pass, 1 verification fail, 2 CLI error, 3 tooling error (fail-closed).`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    process.exit(EXIT.OK);
  }

  const errors = validateArgs(opts);
  if (errors.length) {
    for (const e of errors) process.stderr.write(e + '\n');
    process.exit(EXIT.CLI);
  }

  const result = await runVerification(opts);

  // Defense-in-depth: never let the bypass secret (carried in the EN url's
  // ?x-vercel-protection-bypass=<secret> query) reach stdout / --json / the autopilot log.
  const redactSecret = (s) => String(s ?? '').replace(/(x-vercel-protection-bypass=)[^&\s"'<]+/gi, '$1<redacted>');
  const safeChecked = (result.checked || []).map((c) => ({ ...c, url: redactSecret(c.url) }));
  const safeFailReason = result.failReason ? redactSecret(result.failReason) : null;
  // warnings may embed the EN nav url (which carries ?x-vercel-protection-bypass=<secret>)
  // — redact them too, same as checked/failReason. Never let the secret reach logs.
  const safeWarnings = (result.warnings || []).map(redactSecret);

  if (opts.json) {
    const { ok } = result;
    // Include failReason + a tooling boolean (and park, when set) so a consumer can
    // classify the failure (tooling vs verify vs park-needs_human) WITHOUT keying on
    // the process exit code.
    process.stdout.write(JSON.stringify({
      ok,
      checked: safeChecked,
      warnings: safeWarnings,
      failReason: safeFailReason,
      tooling: Boolean(result.tooling),
      ...(result.park ? { park: result.park } : {}),
    }) + '\n');
  } else {
    if (result.ok) {
      process.stdout.write(`PASS — verified ${safeChecked.length} url(s)\n`);
      for (const c of safeChecked) {
        process.stdout.write(`  ${c.url}\n    h1=${JSON.stringify(c.h1)} jsonLd=${c.jsonLd}\n`);
      }
    } else {
      process.stderr.write(`FAIL — ${safeFailReason}\n`);
    }
  }

  if (result.tooling) process.exit(EXIT.TOOLING);
  process.exit(result.ok ? EXIT.OK : EXIT.VERIFY_FAIL);
}

// Only run main when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((e) => {
    // Last-resort fail-closed: any uncaught error is a tooling fault, never fail-open.
    process.stderr.write(`tooling-error: ${e && e.message ? e.message : String(e)}\n`);
    process.exit(EXIT.TOOLING);
  });
}

export { EXIT };
