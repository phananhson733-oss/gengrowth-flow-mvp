// site-profile.mjs — GG_SITE multi-site resolver. Sync, no deps, never throws.
//
// flow-mvp was single-site (astrology "oracle"/astrologywiki). Adding a second
// target site (the B2B-SaaS blog "gengrowth.ai") is done by config isolation,
// NOT by cloning the repo: GG_SITE selects per-site knobs while the DEFAULT
// path (GG_SITE unset / 'oracle' / unknown) reproduces the original behavior
// byte-for-byte. This keeps the live oracle pipeline (1000+ tests) untouched.
//
// This module is deliberately thin: it only resolves the site id and the
// per-site paths/flags the core scripts branch on. It does NOT import any
// site-specific modules (red-lines, personas, templates) — consumers do that
// lazily so the default path never loads gengrowth code. Keep it sync and
// throw-free: lib/_config.mjs imports it at module-load from non-async
// validators.

import { join } from 'node:path';

export const DEFAULT_SITE = 'oracle';

// Non-default sites we recognize. Anything else (unset/empty/'oracle'/typo)
// resolves to DEFAULT_SITE so a stray env value can never silently divert the
// oracle line onto a half-built profile.
export const KNOWN_SITES = new Set(['gengrowth']);

/**
 * Resolve the active site id from the environment.
 * Unset / empty / 'oracle' / unrecognized → DEFAULT_SITE ('oracle').
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function activeSite(env = process.env) {
  const raw = String(env.GG_SITE || '').trim().toLowerCase();
  return KNOWN_SITES.has(raw) ? raw : DEFAULT_SITE;
}

/** True when running the default (oracle) profile — i.e. original behavior. */
export function isDefaultSite(env = process.env) {
  return activeSite(env) === DEFAULT_SITE;
}

/**
 * Per-site config-snapshot path. The default site returns the ORIGINAL global
 * path (.gg-cache/config-snapshot.json) verbatim; non-default sites get an
 * isolated path (.gg-cache/sites/<site>/config-snapshot.json) so running
 * gg-config-sync for a second workbook can never overwrite oracle's author.map
 * and red-line thresholds. Both the reader (lib/_config.mjs) and the writer
 * (gg-config-sync.mjs) derive the path from here, so this single function keeps
 * read and write in lockstep.
 * @param {string} repoRoot  absolute repo root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function configSnapshotPath(repoRoot, env = process.env) {
  const site = activeSite(env);
  if (site === DEFAULT_SITE) {
    return join(repoRoot, '.gg-cache', 'config-snapshot.json');
  }
  return join(repoRoot, '.gg-cache', 'sites', site, 'config-snapshot.json');
}

// A CTA must always belong to the active product. The selector receives this
// host and rejects cross-product, blog, external and placeholder rows before
// ranking semantic candidates. There is intentionally no code-level default CTA:
// each workbook owns its single wildcard fallback in CTA Map.
const SITE_CTA_HOST = { oracle: 'astrologywiki.com', gengrowth: 'gengrowth.ai' };

/**
 * Returns the required CTA host for the active product.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
export function siteCtaHost(env = process.env) {
  return SITE_CTA_HOST[activeSite(env)] || null;
}

// GitHub `owner/name` of the site's publish repo — the slug every `gh` call in the
// publish path (PR create/view/merge, deployment + commit-status polling, the codex
// fact-check gate's compare-diff fetch) passes as --repo.
//
// WHY THIS LIVES HERE: it was copy-pasted as a literal into 4 scripts / 8 call sites.
// When the oracle repo moved GitHub accounts on 2026-07-27 the old slug started
// resolving to a 404, so every one of those `gh` calls was primed to fail the moment
// autopilot restarted — silently, because the gate reads a failed review as SKIPPED.
// One constant, one place to change on the next migration.
//
// Override with GG_PUBLISH_REPO. Empty/whitespace falls back to the default rather
// than passing an empty --repo, which gh would interpret against the cwd remote.
//
// Only the oracle line has a GitHub publish repo: the gengrowth lane writes its
// posts directly and makes no `gh` calls at all, so there is deliberately no slug
// mapped for it. If that ever changes, add the map here rather than a second literal.
export const DEFAULT_PUBLISH_REPO = 'phananhson733-oss/oracle'; // migrated 2026-07-27 from xdawayer/oracle (now 404)

/**
 * GitHub owner/name of the publish repo for `gh --repo`.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function publishRepo(env = process.env) {
  return String(env.GG_PUBLISH_REPO || '').trim() || DEFAULT_PUBLISH_REPO;
}
