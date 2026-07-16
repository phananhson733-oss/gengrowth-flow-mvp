import { createHash } from 'node:crypto';

const SUPPORTED_PROFILE_VERSION = 'seo-structure-v1';
const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
const NUMBER_RE = /(?<![A-Za-z])\d[\d,]*(?:\.\d+)?%?(?![A-Za-z])/g;
const MARKDOWN_ASSET_RE = /!\[[^\]]*\]\([^)]+\)/g;
const HTML_ASSET_RE = /<(?:img|source)\b[^>]*(?:src|srcset)=["'][^"']+["'][^>]*>/gi;
const ASSET_PATH_RE = /(?:^|[\s("'`])(?:\/|\.\/|\.\.\/)?[^\s)"'`]+\.(?:svg|png|jpe?g|gif|webp|avif)(?:\?[^\s)"'`]*)?(?:#[^\s)"'`]*)?/gi;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedProtectedLine(line) {
  return String(line || '')
    .replace(/[ \t]+$/g, '')
    .replace(/^(\s*)[*+]\s+/, '$1- ')
    .trim();
}

function frontmatterLines(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return [];
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return [];
  return normalized
    .slice(4, end)
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(normalizedProtectedLine);
}

function sectionLines(markdown, matcher) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const protectedLines = [];
  let active = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^##\s+/.test(line)) {
      active = matcher.test(line);
      continue;
    }
    if (active && line.trim() !== '') protectedLines.push(normalizedProtectedLine(line));
  }
  return protectedLines;
}

function matches(markdown, regex) {
  return [...String(markdown || '').matchAll(regex)].map((match) => normalizedProtectedLine(match[0]));
}

function protectedPayload(markdown) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const slugLines = lines
    .filter((line) => /^\s*slug\s*:/i.test(line))
    .map(normalizedProtectedLine);
  return {
    frontmatter: frontmatterLines(normalized),
    slugLines,
    numbersAndDates: matches(normalized, NUMBER_RE),
    urls: matches(normalized, URL_RE),
    ctaLines: sectionLines(normalized, /^##\s+(?:Take Action|Call to Action)\b/i),
    sourceLines: sectionLines(normalized, /^##\s+Sources?\b/i),
    markdownAssets: matches(normalized, MARKDOWN_ASSET_RE),
    htmlAssets: matches(normalized, HTML_ASSET_RE),
    assetPaths: matches(normalized, ASSET_PATH_RE),
  };
}

function protectedDigest(markdown) {
  return sha256(JSON.stringify(protectedPayload(markdown)));
}

function profileAliases(profile) {
  if (!profile || profile.version !== SUPPORTED_PROFILE_VERSION) {
    throw new TypeError(`unsupported structural profile version: ${String(profile?.version || '(missing)')}`);
  }
  const aliases = profile.faqHeadingAliases || {};
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new TypeError('faqHeadingAliases must be an object');
  }
  return aliases;
}

function bump(counts, type, amount = 1) {
  counts.set(type, Number(counts.get(type) || 0) + amount);
}

export function normalizeStructuralMarkdown(markdown, profile) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const aliases = profileAliases(profile);
  const protectedDigestBefore = protectedDigest(markdown);
  const counts = new Map();
  let normalized = markdown.replace(/\r\n?/g, (match) => {
    bump(counts, 'line_endings');
    return '\n';
  });
  const lines = normalized.split('\n');
  const output = [];
  let inFence = false;
  let inFrontmatter = lines[0] === '---';
  let blankRun = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const originalLine = lines[index];
    const fence = /^\s*(```|~~~)/.test(originalLine);
    if (inFence) {
      output.push(originalLine);
      if (fence) inFence = false;
      continue;
    }
    if (fence && !inFrontmatter) {
      output.push(originalLine);
      inFence = true;
      blankRun = 0;
      continue;
    }

    let line = originalLine.replace(/[ \t]+$/g, '');
    if (line !== originalLine) bump(counts, 'trailing_space');

    if (inFrontmatter) {
      output.push(line);
      if (index > 0 && line === '---') inFrontmatter = false;
      continue;
    }

    if (/^\s*$/.test(line)) {
      blankRun += 1;
      if (blankRun > 1) {
        bump(counts, 'blank_lines');
        continue;
      }
      output.push('');
      continue;
    }
    blankRun = 0;

    const listNormalized = line.replace(/^(\s*)[*+]\s+/, '$1- ');
    if (listNormalized !== line) {
      line = listNormalized;
      bump(counts, 'unordered_list_marker');
    }
    const faqAlias = aliases[line];
    if (faqAlias && faqAlias !== line) {
      line = faqAlias;
      bump(counts, 'faq_heading_alias');
    }
    output.push(line);
  }

  normalized = output.join('\n');
  const protectedDigestAfter = protectedDigest(normalized);
  if (protectedDigestAfter !== protectedDigestBefore) {
    throw new Error('protected structural digest changed; refusing normalized output');
  }
  const changes = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => ({ type, count }));
  return {
    markdown: normalized,
    changes,
    protectedDigestBefore,
    protectedDigestAfter,
  };
}
