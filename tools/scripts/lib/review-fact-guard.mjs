#!/usr/bin/env node
// review-fact-guard.mjs — conservative post-review guard for autopilot.
//
// The author-review step is best-effort polish on a draft that already passed
// phase2. It must never silently rewrite core coordinates (calendar dates,
// exact times, sign/degree markers, URLs). If a reviewer/reviser wants to fix
// those, it should happen upstream in the brief/override/prompt source of truth
// or via an explicit human edit — not as an unverified review mutation.

const MONTHS = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const SIGNS = '(?:Aries|Taurus|Gemini|Cancer|Leo|Virgo|Libra|Scorpio|Sagittarius|Capricorn|Aquarius|Pisces)';
const TIMEZONES = '(?:UTC|GMT|EDT|EST|CDT|CST|MDT|MST|PDT|PST|BST|CET|CEST|EET|EEST|IST|AEST|AEDT|JST|KST)';

const PROTECTED_PATTERNS = {
  calendar_dates: new RegExp(`\\b${MONTHS}\\s+\\d{1,2}(?:\\/\\d{1,2})?(?:,\\s+\\d{4})?\\b`, 'gi'),
  exact_times: new RegExp(`\\b\\d{1,2}:\\d{2}(?:\\s*[ap]\\.?m\\.?)?\\s*${TIMEZONES}\\b`, 'gi'),
  sign_degrees: new RegExp(`\\b\\d{1,2}(?:°|º)(?:\\d{1,2})?\\s*${SIGNS}\\b`, 'gi'),
  urls: /https?:\/\/[^\s)>'"`]+/gi,
};

function normalizeToken(token) {
  return String(token || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeToken).filter(Boolean))].sort();
}

function collect(text, re) {
  return uniqueSorted(String(text || '').match(re) || []);
}

export function extractProtectedReviewFacts(text) {
  return Object.fromEntries(
    Object.entries(PROTECTED_PATTERNS).map(([key, re]) => [key, collect(text, re)]),
  );
}

function diff(before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    removed: before.filter((v) => !afterSet.has(v)),
    added: after.filter((v) => !beforeSet.has(v)),
  };
}

export function detectProtectedFactDrift(beforeText, afterText) {
  const before = extractProtectedReviewFacts(beforeText);
  const after = extractProtectedReviewFacts(afterText);
  const categories = {};
  let hasDrift = false;

  for (const key of Object.keys(PROTECTED_PATTERNS)) {
    const delta = diff(before[key], after[key]);
    categories[key] = delta;
    if (delta.added.length || delta.removed.length) hasDrift = true;
  }

  return { hasDrift, before, after, categories };
}

export function summarizeProtectedFactDrift(report) {
  if (!report?.hasDrift) return 'no protected-fact drift';
  return Object.entries(report.categories)
    .filter(([, delta]) => delta.added.length || delta.removed.length)
    .map(([key, delta]) => {
      const parts = [];
      if (delta.removed.length) parts.push(`removed=[${delta.removed.join('; ')}]`);
      if (delta.added.length) parts.push(`added=[${delta.added.join('; ')}]`);
      return `${key} ${parts.join(' ')}`;
    })
    .join(' | ');
}
