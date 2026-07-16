import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function normalizedFailureLines(value) {
  if (Array.isArray(value)) return value.flatMap((item) => normalizedFailureLines(item));
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s+/, ''))
    .filter(Boolean)
    .filter((line) => !/^phase2 failed$/i.test(line));
}

export function mergeAuthorFailures(existing = [], incoming = '', { limit = 24 } = {}) {
  const merged = [];
  const seen = new Set();
  for (const line of [...existing, ...normalizedFailureLines(incoming)]) {
    const normalized = String(line || '').trim();
    const key = normalized.toLowerCase().replace(/\s+/g, ' ');
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
    if (merged.length >= limit) break;
  }
  return merged;
}

export function authorFailureText(failures = []) {
  return failures.map((line) => `- ${String(line).replace(/^[-*]\s+/, '')}`).join('\n');
}

export function readAuthorFailureMemory(path, { pageId = '' } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed?.status !== 'failed' || !Array.isArray(parsed.failures)) return [];
    if (pageId && parsed.pageId && parsed.pageId !== pageId) return [];
    return mergeAuthorFailures([], parsed.failures);
  } catch {
    return [];
  }
}

export function writeAuthorFailureMemory(path, {
  pageId,
  status,
  failures = [],
  updatedAt = new Date().toISOString(),
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 1,
    pageId,
    status,
    failures: status === 'failed' ? mergeAuthorFailures([], failures) : [],
    updatedAt,
  }, null, 2)}\n`);
}
