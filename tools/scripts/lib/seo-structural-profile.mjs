const PROFILE_VERSION = 'seo-structure-v1';

const TEMPLATE_DEFAULTS = Object.freeze({
  Definition: Object.freeze({
    h2Range: Object.freeze([11, 11]),
    wordRange: Object.freeze([1500, 1800]),
    keywordRange: Object.freeze([5, 8]),
  }),
  Pillar: Object.freeze({
    h2Range: Object.freeze([11, 11]),
    wordRange: Object.freeze([2500, 3500]),
    keywordRange: Object.freeze([8, 12]),
  }),
});

const RANGE_RULES = Object.freeze({
  h2_range: Object.freeze({ min: 1, max: 30 }),
  h3_range: Object.freeze({ min: 0, max: 60 }),
  word_range: Object.freeze({ min: 100, max: 10_000 }),
  keyword_range: Object.freeze({ min: 0, max: 100 }),
  kw_count_range: Object.freeze({ min: 0, max: 100 }),
  internal_link_range: Object.freeze({ min: 0, max: 100 }),
});

const FAQ_HEADING_ALIASES = Object.freeze({
  '## FAQ': '## Frequently Asked Questions',
  '## FAQs': '## Frequently Asked Questions',
  '## Q&A': '## Frequently Asked Questions',
});

function normalizedTemplate(value) {
  return /^pillar$/i.test(String(value || '')) ? 'Pillar' : 'Definition';
}

function finiteInteger(value) {
  return Number.isInteger(value) && Number.isFinite(value);
}

function validatedRange(value, name, fallback) {
  if (value === undefined) return [...fallback];
  const rule = RANGE_RULES[name];
  if (!rule || !Array.isArray(value) || value.length !== 2) {
    throw new TypeError(`${name} is invalid; expected a bounded [min, max] range`);
  }
  const [lower, upper] = value.map(Number);
  if (!finiteInteger(lower) || !finiteInteger(upper)
    || lower < rule.min || upper > rule.max || lower > upper) {
    throw new TypeError(
      `${name} is invalid; expected non-inverted integers bounded by ${rule.min}-${rule.max}`,
    );
  }
  return [lower, upper];
}

function legacyRange(value, fallback, name) {
  if (value === undefined) return [...fallback];
  return validatedRange(value, name, fallback);
}

function internalLinkRange(contentTier) {
  switch (String(contentTier || '').trim().toUpperCase()) {
    case 'T1': return [5, null];
    case 'T2': return [3, null];
    case 'T3': return [1, 2];
    default: return [2, null];
  }
}

function explicitProfile(manifest) {
  const value = manifest?.structural_profile;
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('structural_profile must be an object');
  }
  if (value.version !== PROFILE_VERSION) {
    throw new TypeError(`unsupported structural profile version: ${String(value.version || '(missing)')}`);
  }
  return value;
}

function effectiveWordRange(wordRange) {
  return [structuralWordFloor(wordRange[0]), wordRange[1]];
}

export function structuralWordFloor(minimum) {
  const value = Number(minimum);
  if (!finiteInteger(value) || value < RANGE_RULES.word_range.min
    || value > RANGE_RULES.word_range.max) {
    throw new TypeError('word minimum must be a bounded integer');
  }
  return Math.floor(value * 0.99);
}

export function resolveStructuralProfile({
  site = 'astrologywiki',
  locale = 'en',
  template = 'Definition',
  intent = '',
  contentTier = 'T2',
  manifest = {},
} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('manifest must be an object');
  }
  const templateName = normalizedTemplate(template);
  const defaults = TEMPLATE_DEFAULTS[templateName];
  const declared = explicitProfile(manifest);
  const legacyH2 = manifest.h2_count === undefined
    ? defaults.h2Range
    : [
        Number(manifest.h2_count),
        Number(manifest.h2_count),
      ];
  const h2Range = declared
    ? validatedRange(declared.h2_range, 'h2_range', legacyH2)
    : validatedRange(legacyH2, 'h2_range', defaults.h2Range);
  const h3Range = declared
    ? validatedRange(declared.h3_range, 'h3_range', [0, null])
    : [0, null];
  const wordRange = declared
    ? validatedRange(
        declared.word_range,
        'word_range',
        legacyRange(manifest.word_range, defaults.wordRange, 'word_range'),
      )
    : legacyRange(manifest.word_range, defaults.wordRange, 'word_range');
  const keywordRange = declared
    ? validatedRange(
        declared.keyword_range ?? declared.kw_count_range,
        declared.keyword_range !== undefined ? 'keyword_range' : 'kw_count_range',
        legacyRange(manifest.kw_count_range, defaults.keywordRange, 'kw_count_range'),
      )
    : legacyRange(manifest.kw_count_range, defaults.keywordRange, 'kw_count_range');
  const legacyLinks = internalLinkRange(contentTier);
  const declaredLinks = declared?.internal_link_range;
  const links = declaredLinks === undefined
    ? legacyLinks
    : validatedRange(declaredLinks, 'internal_link_range', legacyLinks);

  return Object.freeze({
    version: PROFILE_VERSION,
    site: String(site || 'astrologywiki'),
    locale: String(locale || 'en'),
    template: templateName,
    intent: String(intent || ''),
    contentTier: String(contentTier || 'T2'),
    h2Range: Object.freeze(h2Range),
    h3Range: Object.freeze(h3Range),
    allowH3: h3Range[1] === null || h3Range[1] > 0,
    maxH4: 0,
    wordRange: Object.freeze(wordRange),
    effectiveWordRange: Object.freeze(effectiveWordRange(wordRange)),
    keywordRange: Object.freeze(keywordRange),
    internalLinkRange: Object.freeze(links),
    faqMinimum: 3,
    tableMinimum: Object.freeze({ columns: 4, rows: 3 }),
    faqHeadingAliases: FAQ_HEADING_ALIASES,
  });
}

export { PROFILE_VERSION as STRUCTURAL_PROFILE_VERSION };
