// authority-allowlist.mjs — single source of truth accessor for the
// human-curated authority allowlist (authority-allowlist.json).
//
// The JSON lists, per author_id, the REAL foundational authors the SEO content
// pipeline is permitted to NAME for authority anchoring. This module is the only
// reader: both the prompt renderer (_render-aura-shared.authorityAllowlist) and
// the RL12 red line (red-lines.mjs) call authorityNamesFor(authorId) so they
// never drift from the same list.
//
// Pure Node, no deps. The JSON is read once at import (frozen snapshot) — the
// allowlist is a static human-curated file, not hot-reloaded at runtime.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAuthorId } from './author-routing.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = join(__dirname, 'content-draft-templates', 'authority-allowlist.json');

// Read + freeze once. Underscore-prefixed keys are documentation, not author_ids.
const RAW = (() => {
  try {
    const parsed = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('_')) continue;
      if (Array.isArray(v)) out[k] = Object.freeze(v.map((s) => String(s).trim()).filter(Boolean));
    }
    return Object.freeze(out);
  } catch {
    // A missing/corrupt file must not break rendering or validation — degrade to
    // the anonymous-attribution fallback everywhere (empty lists for all ids).
    return Object.freeze({});
  }
})();

export const AUTHORITY_ALLOWLIST = RAW;

// Names allowed for an author_id. Unknown / empty / absent author_id → [].
// Normalizes the id the same way the persona routing does (trim + lowercase),
// so "Marcus-Orion" / " marcus-orion " resolve identically.
export function authorityNamesFor(authorId) {
  const raw = String(authorId == null ? '' : authorId).replace(/^["']|["']$/g, '').trim();
  if (!raw) return [];
  const id = normalizeAuthorId(raw);
  return RAW[id] || [];
}
