#!/usr/bin/env node
// gg-oracle-register-index.mjs — idempotently register a converted article in
// oracle/data/articles/index.ts.
//
// gg-md-to-oracle-ts.mjs writes <slug>.ts but deliberately does NOT touch
// index.ts (it only prints a hint). A new article is invisible to the oracle
// app until its `<camel><Lang>` export is both imported and pushed into the
// ARTICLES_<LANG> array. This script does exactly those two insertions, and is
// a no-op when the import already exists — so re-publishing an existing slug is
// safe.
//
// Usage:
//   node tools/scripts/gg-oracle-register-index.mjs \
//     --oracle-articles-dir /Users/<you>/oracle/data/articles \
//     --slug blue-aura-meaning [--lang en|zh] [--dry-run]
//
// Exit codes: 0 ok (inserted or already-present), 2 usage/structure error.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = { lang: 'en', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--oracle-articles-dir') out.articlesDir = argv[++i];
    else if (a === '--slug') out.slug = argv[++i];
    else if (a === '--lang') out.lang = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '-h' || a === '--help') out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return out;
}

// Mirror gg-md-to-oracle-ts.mjs slugToCamel so the export name matches exactly.
export function slugToCamel(slug, suffix) {
  const camel = slug
    .split('-')
    .map((w, i) => (i === 0 ? w : (w[0] || '').toUpperCase() + w.slice(1)))
    .join('');
  return camel + suffix;
}

export function registerInIndex(indexSrc, { slug, lang }) {
  const suffix = lang === 'zh' ? 'Zh' : 'En';
  const varName = slugToCamel(slug, suffix);
  const arrayName = lang === 'zh' ? 'ARTICLES_ZH' : 'ARTICLES_EN';
  const importLine = `import { ${varName} } from "./${slug}";`;

  let src = indexSrc;
  const result = { varName, arrayName, importAdded: false, arrayAdded: false };

  // 1. Import line — insert before the "// All articles organized by language"
  // marker if not already present anywhere.
  if (!new RegExp(`\\b${varName}\\b\\s*}\\s*from\\s*"\\./${slug}"`).test(src)
      && !src.includes(importLine)) {
    const marker = '\n// All articles organized by language';
    const idx = src.indexOf(marker);
    if (idx === -1) throw new Error('index.ts: cannot find "// All articles organized by language" anchor');
    src = src.slice(0, idx) + `\nimport { ${varName} } from "./${slug}";` + src.slice(idx);
    result.importAdded = true;
  }

  // 2. Array entry — insert before the closing `];` of the target array.
  const arrayOpen = new RegExp(`const ${arrayName}: WikiArticle\\[\\] = \\[`);
  const openMatch = arrayOpen.exec(src);
  if (!openMatch) throw new Error(`index.ts: cannot find "const ${arrayName}" array`);
  const close = src.indexOf('];', openMatch.index);
  if (close === -1) throw new Error(`index.ts: cannot find closing "];" for ${arrayName}`);
  const arrayBody = src.slice(openMatch.index, close);
  if (!new RegExp(`\\b${varName}\\b`).test(arrayBody)) {
    // Preserve indentation of existing entries (2 spaces).
    src = src.slice(0, close) + `  ${varName},\n` + src.slice(close);
    result.arrayAdded = true;
  }

  result.src = src;
  return result;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.articlesDir || !args.slug) {
    console.error('usage: --oracle-articles-dir <dir> --slug <slug> [--lang en|zh] [--dry-run]');
    process.exit(args.help ? 0 : 2);
  }
  const indexPath = join(args.articlesDir, 'index.ts');
  if (!existsSync(indexPath)) {
    console.error(`index.ts not found: ${indexPath}`);
    process.exit(2);
  }
  const before = readFileSync(indexPath, 'utf8');
  const { varName, arrayName, importAdded, arrayAdded, src } =
    registerInIndex(before, { slug: args.slug, lang: args.lang });

  if (!importAdded && !arrayAdded) {
    console.log(`✓ ${varName} already registered in ${arrayName} — no change`);
    return;
  }
  if (args.dryRun) {
    console.log(`[dry-run] would register ${varName}: import=${importAdded} array=${arrayAdded}`);
    return;
  }
  writeFileSync(indexPath, src);
  console.log(`✓ registered ${varName} (import=${importAdded} array=${arrayAdded}) in ${indexPath}`);
}

// Only run when invoked directly (allows importing registerInIndex in tests).
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) main();
