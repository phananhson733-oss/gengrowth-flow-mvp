// Pure helpers for detecting whether a topic is ALREADY published in oracle, so the
// autopilot can reconcile a "no row in 选题登记表" authoring failure to `done` instead
// of parking it needs_human. Background: a plan page-id whose topic was already shipped
// under its keyword's slug (and whose registry row was therefore never added) used to
// pile up as needs_human noise (21 such parks on 2026-06-22). PURE: only fs reads.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Kebab slug matching the oracle article-slug convention (same derivation the author
// path uses for zh-backfill: lowercase, non-alnum → '-', trim leading/trailing '-').
export function kebabSlug(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// True iff `slug`.ts exists in oracle AND is re-exported from data/articles/index.ts
// (mirrors gg-seo-autopilot's articleRegisteredInOracle, but takes the oracle dir so it
// is unit-testable against a fixture). A file present but unregistered is NOT live.
export function articleRegistered(slug, oracleDir) {
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) return false;
  const dir = join(oracleDir, 'data', 'articles');
  if (!existsSync(join(dir, `${slug}.ts`))) return false;
  const index = join(dir, 'index.ts');
  if (!existsSync(index)) return false;
  const src = readFileSync(index, 'utf8');
  return src.includes(`./${slug}"`) || src.includes(`./${slug}'`);
}

// Returns the live oracle slug if `keyword`'s kebab slug is a registered article in
// `oracleDir`, else null. Conservative: matches only the exact keyword slug, so an
// ambiguous topic still parks for a human rather than being silently reconciled.
export function keywordLiveSlug(keyword, oracleDir) {
  const slug = kebabSlug(keyword);
  return articleRegistered(slug, oracleDir) ? slug : null;
}
