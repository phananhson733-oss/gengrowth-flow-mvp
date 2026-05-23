// gg-shared.mjs — Shared helpers for tools/scripts/gg-*.mjs.
//
// SOURCE OF TRUTH — DO NOT copy-paste these helpers into individual tools.
// Import them instead:
//
//     import {
//       loadEnv, getAccessToken, gFetch, redact, errorCode, redactNote,
//       sanitize, isAllowedUrl, validateIngestPath, safeFetch,
//       parseIsoTimestamp, parseIsoDate, appendRunsRow,
//     } from './lib/gg-shared.mjs';
//
// History: extracted 2026-05-21 after codex review flagged 6-tool helper drift
// (gg-friction-mine missed NFKC, etc.). Centralised here so every tool gets the
// most-strict codex-approved version of each primitive.
//
// Pure Node built-ins — no npm dependencies.

import {
  existsSync,
  readFileSync,
  mkdirSync,
  realpathSync,
  statSync,
  lstatSync,
} from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// env loader
// ============================================================

/**
 * Walk through standard candidate locations and load the first _gg.env found.
 * Does not overwrite already-set process.env entries.
 *
 * Default search order (back-compat — used by older tools that call loadEnv()):
 *   1. process.env.GG_ENV_FILE (explicit override)
 *   2. ~/.config/gg/_gg.env
 *   3. ./_gg.env (cwd)
 *   4. <scripts-dir>/_gg.env
 *   5. <repo-root>/_gg.env
 *
 * Strict mode (opt-in via { strict: true }, gg-content-draft+):
 *   1. process.env.GG_ENV_FILE (explicit absolute-path override only)
 *   2. ~/.config/gg/_gg.env
 *   (cwd / scripts-dir / repo-root candidates dropped — git-leak risk, spec §11.4)
 *
 * Mode-600 enforcement (opt-in via { requireMode: 0o600 }):
 *   - statSync.mode & 0o077 must be 0; otherwise throw EGGSHARED_ENV_MODE.
 *   - Only enforced on POSIX (skipped on Windows).
 *
 * @param {object} [options]
 * @param {boolean} [options.strict=false]  if true, only accept GG_ENV_FILE + ~/.config/gg/_gg.env.
 * @param {number}  [options.requireMode]   if set (e.g. 0o600), throw when mode allows group/other access.
 * @returns {string|null} absolute path of the env file loaded, or null if none.
 *
 * @example
 *   // Back-compat (old tools):
 *   const envPath = loadEnv();
 *   // Strict (new tools, gg-content-draft+):
 *   const envPath = loadEnv({ strict: true, requireMode: 0o600 });
 */
export function loadEnv(options = {}) {
  const strict = options.strict === true;
  const requireMode = typeof options.requireMode === 'number' ? options.requireMode : null;

  let candidates;
  if (strict) {
    // Spec §11.4: only explicit env var + ~/.config/gg/, drop cwd / repo-root / scripts-dir.
    candidates = [
      process.env.GG_ENV_FILE,
      join(homedir(), '.config', 'gg', '_gg.env'),
    ].filter(Boolean);
  } else {
    const scriptsDir = join(__dirname, '..');
    const repoRoot = join(__dirname, '..', '..', '..');
    candidates = [
      process.env.GG_ENV_FILE,
      join(homedir(), '.config', 'gg', '_gg.env'),
      join(process.cwd(), '_gg.env'),
      join(scriptsDir, '_gg.env'),
      join(__dirname, '_gg.env'),
      join(repoRoot, '_gg.env'),
    ].filter(Boolean);
  }

  for (const p of candidates) {
    if (!existsSync(p)) continue;

    // Spec §11.3: mode-600 enforcement (opt-in).
    // Skip on Windows (process.platform === 'win32') — POSIX mode bits don't apply.
    if (requireMode !== null && process.platform !== 'win32') {
      let modeBits;
      try {
        modeBits = statSync(p).mode & 0o777;
      } catch (e) {
        const err = new Error(`EGGSHARED_ENV_MODE: cannot stat env file ${p}: ${e.message}`);
        err.code = 'EGGSHARED_ENV_MODE';
        throw err;
      }
      // requireMode is the maximum allowed mode. Reject if group/other have any
      // permission when requireMode === 0o600 (i.e. modeBits & 0o077 !== 0).
      const forbiddenBits = (~requireMode) & 0o777;
      if ((modeBits & forbiddenBits) !== 0) {
        const got = '0' + modeBits.toString(8).padStart(3, '0');
        const want = '0' + requireMode.toString(8).padStart(3, '0');
        const err = new Error(
          `EGGSHARED_ENV_MODE: ${p} has mode ${got}, expected ${want} or stricter; run: chmod ${want.slice(1)} ${p}`,
        );
        err.code = 'EGGSHARED_ENV_MODE';
        throw err;
      }
    }

    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    return p;
  }
  return null;
}

// ============================================================
// Google SA JWT → access token
// ============================================================

/**
 * Exchange a Google service-account JSON file for a short-lived access token.
 *
 * @param {string} saPath  absolute path to the SA JSON key file.
 * @param {string[]} scopes  e.g. ['https://www.googleapis.com/auth/spreadsheets'].
 * @returns {Promise<{token: string, sa: object}>} access token + parsed SA object.
 * @throws {Error} if the file is missing or the token exchange fails.
 *
 * @example
 *   const { token } = await getAccessToken(
 *     '/Users/me/.config/gg/gg-writer-sa.json',
 *     ['https://www.googleapis.com/auth/spreadsheets'],
 *   );
 */
export async function getAccessToken(saPath, scopes) {
  if (!existsSync(saPath)) {
    throw new Error(`SA JSON not found: ${saPath}`);
  }
  const sa = JSON.parse(readFileSync(saPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: sa.private_key_id };
  const claim = {
    iss: sa.client_email,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const signingInput = `${b64url(header)}.${b64url(claim)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(sa.private_key)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  const assertion = `${signingInput}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return { token: json.access_token, sa };
}

// ============================================================
// generic authed fetch for Google APIs
// ============================================================

/**
 * Authenticated fetch for Google API endpoints.
 * Returns parsed JSON when possible, otherwise raw text. Throws on non-2xx.
 *
 * @param {string} url
 * @param {string} token  Bearer token from getAccessToken().
 * @param {object} [init]  fetch init (method, body, etc.).
 * @returns {Promise<any>} response body (JSON-parsed where applicable).
 *
 * @example
 *   const meta = await gFetch(
 *     `https://sheets.googleapis.com/v4/spreadsheets/${id}?includeGridData=false`,
 *     token,
 *   );
 */
export async function gFetch(url, token, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    const e = new Error(
      `${res.status} ${res.statusText}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`,
    );
    e.status = res.status;
    e.body = body;
    throw e;
  }
  return body;
}

// ============================================================
// secret / token redaction
// ============================================================

// Codex round 2 C4: PEM blocks + JWT must be redacted *before* the generic
// long-blob pattern so they get the explicit label, not '<redacted>'.
const REDACT_PATTERNS = [
  // Full PEM block (BEGIN PRIVATE KEY / RSA PRIVATE KEY / CERTIFICATE / etc.).
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g,
  // JSON Web Token: header.payload.signature, header and payload start with `eyJ`.
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g,
  /private_key[^,}]*/gi,
  /client_email[^,}]*/gi,
  /Bearer\s+[A-Za-z0-9_\-.]+/g,
  /Basic\s+[A-Za-z0-9+/=]+/g,
  /[A-Za-z0-9_-]{32,}/g, // long token-like blob (last-resort)
];

const REDACT_LABELS = ['[REDACTED_PEM]', '[REDACTED_JWT]'];

/**
 * Scrub secret patterns from a string before logging or writing to disk.
 * Patterns covered: private_key, client_email, Bearer/Basic auth headers, and
 * any contiguous 32+ char base64-ish blob.
 *
 * @param {string|object|null|undefined} input
 * @returns {string|null|undefined} redacted string (or pass-through null/undefined).
 *
 * @example
 *   console.error(redact(err.message));
 */
export function redact(input) {
  if (input == null) return input;
  let s = typeof input === 'string' ? input : safeStringify(input);
  for (let i = 0; i < REDACT_PATTERNS.length; i++) {
    // First two patterns get explicit labels (PEM / JWT); the rest collapse to '<redacted>'.
    const label = REDACT_LABELS[i] || '<redacted>';
    s = s.replace(REDACT_PATTERNS[i], label);
  }
  return s;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ============================================================
// error → short code mapping
// ============================================================

/**
 * Map a thrown error (or string) to a short error_code label. Used in runs-log
 * Notes column so wzb can sort/filter by failure mode without raw error text.
 *
 * Codes: ERR_NETWORK, ERR_AUTH, ERR_PARSE, ERR_VALIDATION, ERR_OTHER.
 *
 * @param {Error|string} err
 * @returns {string} one of the 5 codes above.
 *
 * @example
 *   try { ... } catch (e) { console.log(errorCode(e)); }
 */
export function errorCode(err) {
  const msg = (err && err.message ? err.message : String(err || '')).toLowerCase();
  if (/network|fetch|timeout|abort|enotfound|econnrefused/.test(msg)) return 'ERR_NETWORK';
  if (/401|403|auth|unauthorized|forbidden|token|credential|invalid_grant/.test(msg)) return 'ERR_AUTH';
  if (/parse|json|unexpected token|syntax/.test(msg)) return 'ERR_PARSE';
  if (/validation|schema|must (be|end|have|match)|missing|required|≤|>|allowlist|allowed|enum|not a known/.test(msg)) return 'ERR_VALIDATION';
  return 'ERR_OTHER';
}

/**
 * Build a runs-log Notes value: errorCode + redacted + truncated to 80 chars.
 *
 * @param {Error|string|null|undefined} input
 * @returns {string} '' for null/empty, otherwise 'ERR_XYZ: redacted-text...'.
 *
 * @example
 *   await appendRunsRow(workbookId, token, { ..., notes: redactNote(err) });
 */
export function redactNote(input) {
  if (input == null) return '';
  const code = input instanceof Error ? errorCode(input) : null;
  const base = redact(typeof input === 'string' ? input : (input.message || safeStringify(input)));
  const truncated = base.length > 80 ? base.slice(0, 77) + '...' : base;
  return code ? `${code}: ${truncated}` : truncated;
}

// ============================================================
// PII scrub (for RAG cache artifacts written to disk)
// ============================================================
// Strip high-confidence PII from Reddit user-voice quotes before persisting
// them into `.rag.json` files that downstream prompt builders read.
// Patterns: email, phone (intl + US), @handle (>=4 chars), non-allowlist URLs,
// US street address, US ZIP. Conservative over false-positive — over-redacting
// a cache file is cheaper than leaking PII into a prompt.
// URL allowlist preserves citation links (wikipedia/astro.com/*.reddit.com).

const PII_URL_ALLOWLIST = Object.freeze(new Set([
  'wikipedia.org', 'en.wikipedia.org', 'astro.com', 'www.astro.com',
  'old.reddit.com', 'np.reddit.com',
]));

// Order matters: URL before email (URLs may contain @). URL also runs before
// REDDIT_USER so that a full https://old.reddit.com/u/foo URL is preserved
// (allowlisted) instead of being doubly redacted.
const PII_PATTERNS = Object.freeze([
  { type: 'REDACTED_URL', re: /https?:\/\/[^\s)>\]]+/gi, mode: 'url' },
  { type: 'REDACTED_EMAIL', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gi, mode: 'plain' },
  { type: 'REDACTED_PHONE', re: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3,4}[-.\s]?\d{4}\b/g, mode: 'plain' },
  { type: 'REDACTED_HANDLE', re: /(^|\s)@\w{4,}\b/g, mode: 'keepG1' },
  // Reddit-style user mentions in body text: `u/foo`, `/u/foo`, `/user/foo`.
  // Reddit usernames map 1:1 to a person — same privacy posture as @handle.
  // Length 3-20 per Reddit naming rules. Capture group 1 is the leading
  // delimiter (start-of-string or whitespace) so we don't inadvertently
  // match inside an already-preserved URL like `https://old.reddit.com/u/foo`
  // (the slash inside the URL is not preceded by whitespace).
  { type: 'REDACTED_REDDIT_USER', re: /(^|\s)\/?u(?:ser)?\/[A-Za-z0-9_-]{3,20}\b/gi, mode: 'keepG1' },
  { type: 'REDACTED_ADDRESS', re: /\b\d{1,5}\s+\w+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Ln|Lane|Dr|Drive)\b/gi, mode: 'plain' },
  { type: 'REDACTED_ZIP', re: /\b[A-Z]{2}\s\d{5}(-\d{4})?\b/g, mode: 'plain' },
]);

/**
 * Scrub PII from text before persisting to disk (RAG cache files).
 * Returns scrubbed text + list of redaction types that fired (for pii_audit).
 *
 * @param {string|null|undefined} text
 * @returns {{text: string, matches: string[]}}
 *
 * @example
 *   const { text, matches } = scrubPII('email jane@x.com or @realname123');
 *   // text:    'email [REDACTED_EMAIL] or [REDACTED_HANDLE]'
 *   // matches: ['REDACTED_EMAIL', 'REDACTED_HANDLE']
 */
export function scrubPII(text) {
  if (text == null) return { text: '', matches: [] };
  let s = String(text);
  const matches = [];
  for (const { type, re, mode } of PII_PATTERNS) {
    s = s.replace(re, (m, g1) => {
      if (mode === 'url') {
        let host = null;
        try { host = new URL(m).hostname; } catch { /* malformed → redact */ }
        if (host && PII_URL_ALLOWLIST.has(host)) return m;
        matches.push(type);
        return `[${type}]`;
      }
      matches.push(type);
      return mode === 'keepG1' ? `${g1}[${type}]` : `[${type}]`;
    });
  }
  return { text: s, matches };
}

// ============================================================
// sanitizer (NFKC + zero-width + base64 + prompt-injection)
// ============================================================

// Phrases normalized at module load so they match post-NFKC input
// (e.g. fullwidth "ｉｇｎｏｒｅ" collapses to ASCII "ignore" before matching).
// 15-item set: superset of every per-tool variant (covers EN/CN/KR/AR).
const INJECTION_PHRASES = Object.freeze([
  'ignore previous instructions',
  'ignore all previous instructions',
  'disregard previous instructions',
  'system:',
  '用户：',
  '系统：',
  '<|im_start|>',
  '<|im_end|>',
  '[INST]',
  '[/INST]',
  '忽略以上指示',
  '忽略以上提示',
  '从现在开始你是',
  '이전 지시를 무시하세요',
  'تجاهل التعليمات السابقة',
].map((p) => {
  try { return p.normalize('NFKC'); } catch { return p; }
}));

// zero-width + bidi controls:
// U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM,
// U+202A..U+202E bidi overrides, U+2066..U+2069 bidi isolates.
const ZERO_WIDTH_REGEX = /[​-‍﻿‪-‮⁦-⁩]/g;

// base64-like contiguous block (>100 chars), tolerant of = padding and url-safe variants.
const BASE64_BLOCK_REGEX = /[A-Za-z0-9+/_=-]{101,}/g;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sanitize text before feeding it to an LLM prompt or storing it as a snippet.
 *
 * Steps:
 *   1. NFKC normalize (collapses fullwidth/compatibility forms, e.g. ｉｇｎｏｒｅ → ignore).
 *      Without this, attackers bypass the ASCII phrase blacklist with fullwidth chars.
 *   2. Strip zero-width / bidi control characters.
 *   3. Replace any 100+ char base64-ish block with [BASE64_BLOCK_REMOVED].
 *   4. Replace any prompt-injection phrase (case-insensitive) with [BLOCKED_PHRASE].
 *      Covers EN/CN/KR/AR variants seen in real prompt-injection attempts.
 *
 * @param {string|null|undefined} input
 * @returns {string} sanitised text, or '' for null/undefined.
 *
 * @example
 *   const safe = sanitize(redditPost.body);
 */
export function sanitize(input) {
  if (input == null) return '';
  let s = String(input);

  // 1. NFKC normalize first
  try {
    s = s.normalize('NFKC');
  } catch {
    // older engines might not support NFKC; ignore
  }

  // 2. strip zero-width / bidi control
  s = s.replace(ZERO_WIDTH_REGEX, '');

  // 3. strip long base64-like blocks
  s = s.replace(BASE64_BLOCK_REGEX, '[BASE64_BLOCK_REMOVED]');

  // 4. neutralize injection phrases
  for (const phrase of INJECTION_PHRASES) {
    const re = new RegExp(escapeRegex(phrase), 'gi');
    s = s.replace(re, '[BLOCKED_PHRASE]');
  }

  return s;
}

// ============================================================
// strict URL allowlist (SSRF protection)
// ============================================================

/**
 * Check if a URL is safe to fetch given a caller-provided allowlist.
 *
 * Rejects: non-https, explicit non-443 port, userinfo, hostnames not in the Set,
 * IPv4 literals, localhost. The hostname check is exact-match — substring tricks
 * like 'old.reddit.com.evil.com' are rejected because they don't equal a Set entry.
 * @-tricks like 'old.reddit.com@evil.com' are also rejected because the URL parser
 * treats the prefix as userinfo (caught by the username/password guard).
 *
 * @param {string} urlString  the URL to validate.
 * @param {Set<string>} allowedHosts  exact hostnames the caller allows.
 * @returns {boolean} true iff every check passes.
 *
 * @example
 *   const ALLOWED = new Set(['old.reddit.com', 'np.reddit.com']);
 *   if (!isAllowedUrl(url, ALLOWED)) throw new Error('SSRF blocked');
 */
export function isAllowedUrl(urlString, allowedHosts) {
  if (!(allowedHosts instanceof Set)) {
    // defensive: a fail-closed default if a caller mis-uses the API.
    return false;
  }
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== '443') return false;
  if (!allowedHosts.has(u.hostname)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return false;
  if (u.hostname === 'localhost') return false;
  return true;
}

// ============================================================
// ingest-path validator (path-traversal + size protection)
// ============================================================

const DEFAULT_CACHE_DIR = (() => {
  const dir = join(homedir(), '.gg-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
})();

const DEFAULT_MAX_INGEST_BYTES = 1024 * 1024; // 1 MB

/**
 * Verify a caller-supplied ingest file path is safe to read.
 *
 * Checks (in order):
 *   - non-empty string
 *   - extension is in allowedExtensions (default ['.json'])
 *   - lstat rejects symlinks (path itself must be a regular file, not a symlink)
 *   - realpath resolves successfully (file exists)
 *   - real path lives under one of the allowed root directories (default: ~/.gg-cache)
 *   - is a regular file
 *   - size ≤ maxBytes (default 1 MB)
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.maxBytes=1048576]
 * @param {string[]} [options.allowedDirs]  defaults to [~/.gg-cache]; each will be realpath-resolved.
 * @param {string[]} [options.allowedExtensions=['.json']]  spec §11.1 — caller may pass ['.md', '.txt'].
 * @returns {string} the realpath-resolved absolute path.
 * @throws {Error} on any failure.
 *
 * @example
 *   // Back-compat: .json only
 *   const real = validateIngestPath(args.ingest);
 *   // gg-content-draft: .md / .txt ingest from Desktop / Downloads / .gg-cache
 *   const real = validateIngestPath(args.ingestFile, {
 *     allowedExtensions: ['.md', '.txt'],
 *     allowedDirs: [join(homedir(), 'Desktop'), join(homedir(), 'Downloads')],
 *   });
 */
export function validateIngestPath(filePath, options = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('ingest path must be a non-empty string');
  }
  const allowedExtensions = options.allowedExtensions || ['.json'];
  if (!Array.isArray(allowedExtensions) || allowedExtensions.length === 0) {
    throw new Error('allowedExtensions must be a non-empty array');
  }
  const lowered = filePath.toLowerCase();
  const extOk = allowedExtensions.some((e) => lowered.endsWith(e.toLowerCase()));
  if (!extOk) {
    throw new Error(`ingest file must end in one of: ${allowedExtensions.join(', ')}`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_INGEST_BYTES;
  const allowedDirsRaw = options.allowedDirs || [DEFAULT_CACHE_DIR];
  const allowedDirs = allowedDirsRaw
    .map((d) => {
      try {
        return realpathSync(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (allowedDirs.length === 0) {
    throw new Error('no allowed ingest dirs resolved (caller bug?)');
  }
  const abs = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);

  // Spec §11 / M1: lstat rejects symlinks BEFORE realpath would silently follow them.
  // realpath collapses symlinks → without lstat first, a symlink in /tmp/evil → /Users/secrets
  // could escape the jail check below.
  let lst;
  try {
    lst = lstatSync(abs);
  } catch {
    throw new Error(`ingest file not found: ${filePath}`);
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`ingest path is a symlink (refused): ${filePath}`);
  }

  let real;
  try {
    real = realpathSync(abs);
  } catch {
    throw new Error(`ingest file not found: ${filePath}`);
  }
  const inJail = allowedDirs.some((d) => real === d || real.startsWith(d + sep));
  if (!inJail) {
    throw new Error(`ingest file must be in ${allowedDirs.join(' or ')}/`);
  }
  const stat = statSync(real);
  if (!stat.isFile()) {
    throw new Error('ingest path is not a regular file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`ingest file >${maxBytes} bytes`);
  }
  return real;
}

/**
 * Verify a caller-supplied write target path is safe (spec §11.2).
 *
 * Used by tools that need to write under a constrained directory tree (e.g.
 * `_staging/{page_id}/draft.md`). Ensures the *parent* directory realpath lies
 * inside one of allowedDirs, the parent is not a symlink, and (if the target
 * file already exists) the existing target is not a symlink either.
 *
 * Does NOT create directories — caller mkdirs after validation passes.
 *
 * @param {string} targetPath  absolute or relative path to the file to be written.
 * @param {object} options
 * @param {string[]} options.allowedDirs  realpath jail roots for the parent dir.
 * @param {string[]} [options.allowedExtensions]  optional extension whitelist.
 * @param {boolean} [options.mustCreateParent=true]  if true, mkdirSync(parent) recursively before checking.
 * @returns {{realParent: string, abs: string}}  realpath of validated parent + absolute target.
 * @throws {Error} on any failure.
 *
 * @example
 *   const { realParent, abs } = validateWritePath(
 *     join(stagingRoot, pageId, 'draft.md'),
 *     { allowedDirs: [stagingRoot], allowedExtensions: ['.md', '.json'] },
 *   );
 *   writeFileSync(abs, content);
 */
export function validateWritePath(targetPath, options = {}) {
  if (typeof targetPath !== 'string' || !targetPath) {
    throw new Error('write target must be a non-empty string');
  }
  const allowedDirsRaw = options.allowedDirs;
  if (!Array.isArray(allowedDirsRaw) || allowedDirsRaw.length === 0) {
    throw new Error('validateWritePath: options.allowedDirs required (non-empty array)');
  }
  const allowedExtensions = options.allowedExtensions || null;
  const mustCreateParent = options.mustCreateParent !== false;

  if (allowedExtensions) {
    const lowered = targetPath.toLowerCase();
    const extOk = allowedExtensions.some((e) => lowered.endsWith(e.toLowerCase()));
    if (!extOk) {
      throw new Error(`write target must end in one of: ${allowedExtensions.join(', ')}`);
    }
  }

  // Resolve allowedDirs to realpaths (jail roots).
  const allowedDirs = allowedDirsRaw
    .map((d) => {
      try {
        return realpathSync(d);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (allowedDirs.length === 0) {
    throw new Error('validateWritePath: no allowedDirs resolved (caller bug?)');
  }

  const abs = isAbsolute(targetPath) ? targetPath : join(process.cwd(), targetPath);
  const parent = dirname(abs);

  if (mustCreateParent) {
    // Create the parent dir tree if missing. Then validate.
    try {
      mkdirSync(parent, { recursive: true });
    } catch (e) {
      throw new Error(`validateWritePath: cannot create parent ${parent}: ${e.message}`);
    }
  }

  // Reject if parent itself is a symlink.
  let parentLst;
  try {
    parentLst = lstatSync(parent);
  } catch {
    throw new Error(`validateWritePath: parent dir missing: ${parent}`);
  }
  if (parentLst.isSymbolicLink()) {
    throw new Error(`validateWritePath: parent dir is a symlink (refused): ${parent}`);
  }

  let realParent;
  try {
    realParent = realpathSync(parent);
  } catch {
    throw new Error(`validateWritePath: cannot realpath parent ${parent}`);
  }

  const inJail = allowedDirs.some((d) => realParent === d || realParent.startsWith(d + sep));
  if (!inJail) {
    throw new Error(`validateWritePath: parent ${realParent} escapes jail ${allowedDirs.join(' or ')}`);
  }

  // If target already exists, reject symlink at the leaf.
  if (existsSync(abs)) {
    const targetLst = lstatSync(abs);
    if (targetLst.isSymbolicLink()) {
      throw new Error(`validateWritePath: target file is a symlink (refused): ${abs}`);
    }
  }

  return { realParent, abs };
}

// ============================================================
// safe HTTP fetch with allowlist + manual redirect re-validation
// ============================================================

/**
 * Fetch a URL while enforcing an allowlist on every hop (including redirects).
 *
 * Implements `redirect: 'manual'` so each Location header is re-validated against
 * the allowlist before following. Throws on disallowed targets, ≥maxRedirects hops,
 * malformed Location values, or non-2xx final status.
 *
 * @param {string} url
 * @param {Set<string>} allowedHosts  passed to isAllowedUrl on every hop.
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000]
 * @param {number} [options.maxRedirects=2]
 * @param {string} [options.userAgent]  default 'gg-shared/1.0'.
 * @param {string} [options.accept]     default 'application/json, text/html;q=0.9'.
 * @returns {Promise<string>} response body as text.
 *
 * @example
 *   const ALLOWED = new Set(['old.reddit.com']);
 *   const body = await safeFetch(url, ALLOWED);
 */
export async function safeFetch(url, allowedHosts, options = {}) {
  const timeoutMs = options.timeoutMs ?? 10000;
  const maxRedirects = options.maxRedirects ?? 2;
  const userAgent = options.userAgent || 'gg-shared/1.0 (+https://astrologywiki.com)';
  const accept = options.accept || 'application/json, text/html;q=0.9';

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isAllowedUrl(current, allowedHosts)) {
      throw new Error(`URL not in allowlist: ${current}`);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current, {
        signal: ctl.signal,
        headers: { 'user-agent': userAgent, accept },
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`redirect (${res.status}) with no Location header`);
      let next;
      try {
        next = new URL(loc, current).toString();
      } catch {
        throw new Error(`redirect (${res.status}) with malformed Location`);
      }
      if (!isAllowedUrl(next, allowedHosts)) {
        throw new Error(`redirect target not in allowlist: ${next}`);
      }
      current = next;
      continue;
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  }
  throw new Error(`too many redirects (>${maxRedirects})`);
}

// ============================================================
// ISO timestamp / date parsing
// ============================================================

const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+\-]\d{2}:?\d{2})$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a strict ISO-8601 timestamp like '2026-05-21T18:00:00Z'.
 *
 * @param {string} value
 * @returns {Date|null} Date instance, or null if invalid / not a string.
 *
 * @example
 *   const d = parseIsoTimestamp(manifest.signed_at);
 *   if (!d) recordFail('signed_at invalid');
 */
export function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!ISO_TIMESTAMP_REGEX.test(value.trim())) return null;
  const d = new Date(value.trim());
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/**
 * Parse a strict YYYY-MM-DD date (treated as UTC midnight).
 *
 * @param {string} value
 * @returns {Date|null} Date instance at 00:00 UTC, or null if invalid.
 *
 * @example
 *   const d = parseIsoDate('2026-06-09');
 */
export function parseIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!ISO_DATE_REGEX.test(value.trim())) return null;
  const d = new Date(value.trim() + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

// ============================================================
// unified runs-log row writer
// ============================================================

/**
 * Append a row to the `runs` sheet in the GenGrowth workbook using the unified
 * 7-column schema. Tools should use this instead of writing per-tool columns
 * so cross-tool queries work without surprises.
 *
 * Schema:
 *   ts            ISO timestamp (string)
 *   tool          tool name, e.g. 'keyword-fallback'
 *   entity        entity string (or '' if not entity-scoped)
 *   count         numeric (each tool defines what it counts)
 *   payload_json  JSON.stringify(...) of tool-specific extras
 *   status        'ok' | 'partial' | 'fail' | 'skip'
 *   notes         redactNote()-ed, <=80 chars
 *
 * If the sheet does not exist, the caller's existing ensureSheet helper should
 * create it with the matching HEADERS array (exported below).
 *
 * @param {string} workbookId  Google Sheets workbook ID.
 * @param {string} token       Bearer token (writer-scope).
 * @param {object} row
 * @param {string} row.tool
 * @param {string} [row.entity='']
 * @param {number} [row.count=0]
 * @param {object} [row.payload={}]
 * @param {'ok'|'partial'|'fail'|'skip'} [row.status='ok']
 * @param {string} [row.notes='']
 * @returns {Promise<object>} Sheets API response.
 *
 * @example
 *   await appendRunsRow(workbookId, token, {
 *     tool: 'keyword-fallback',
 *     entity: 'saturn return',
 *     count: 20,
 *     payload: { top5: [...] },
 *     status: 'ok',
 *   });
 */
export async function appendRunsRow(workbookId, token, row) {
  if (!workbookId) throw new Error('appendRunsRow: workbookId required');
  if (!token) throw new Error('appendRunsRow: token required');
  if (!row || typeof row !== 'object') throw new Error('appendRunsRow: row required');
  if (typeof row.tool !== 'string' || !row.tool) {
    throw new Error('appendRunsRow: row.tool required');
  }
  const status = row.status || 'ok';
  if (!['ok', 'partial', 'fail', 'skip'].includes(status)) {
    throw new Error(`appendRunsRow: invalid status: ${status}`);
  }
  const values = [
    new Date().toISOString(),
    row.tool,
    row.entity || '',
    typeof row.count === 'number' ? row.count : 0,
    JSON.stringify(row.payload || {}),
    status,
    row.notes ? redactNote(row.notes) : '',
  ];
  return gFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent('runs!A:G')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: [values] }),
    },
  );
}

/**
 * Header row for the unified `runs` sheet. Pass to ensureSheet().
 * Frozen so callers can't accidentally mutate the shared schema.
 */
export const RUNS_SHEET_HEADERS = Object.freeze([
  'ts',
  'tool',
  'entity',
  'count',
  'payload_json',
  'status',
  'notes',
]);
