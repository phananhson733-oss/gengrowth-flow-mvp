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

function validatedRange(value, name, fallback = undefined) {
  const candidate = value === undefined ? fallback : value;
  const rule = RANGE_RULES[name];
  if (!rule || !Array.isArray(candidate) || candidate.length !== 2) {
    throw new TypeError(`${name} is invalid; expected a bounded [min, max] range`);
  }
  const lower = Number(candidate[0]);
  const nullableUpper = name === 'h3_range' || name === 'internal_link_range';
  const upper = candidate[1] === null && nullableUpper ? null : Number(candidate[1]);
  if (!finiteInteger(lower) || lower < rule.min || lower > rule.max
    || (upper !== null && (
      !finiteInteger(upper) || upper < rule.min || upper > rule.max || lower > upper
    ))) {
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

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`structural profile ${name} must be a non-empty string`);
  }
  return value;
}

function exactObject(value, expected, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`structural profile ${name} is invalid`);
  }
  const expectedEntries = Object.entries(expected);
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedEntries.length
    || expectedEntries.some(([key, expectedValue]) => value[key] !== expectedValue)) {
    throw new TypeError(`structural profile ${name} is invalid`);
  }
  return expected;
}

function rangeOverrides(base, overrides) {
  const allowedKeys = new Set([
    'h2Count',
    'wordMinimum',
    'wordMaximum',
    'keywordMinimum',
    'keywordMaximum',
  ]);
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('structural profile overrides must be an object');
  }
  for (const key of Object.keys(overrides)) {
    if (!allowedKeys.has(key)) {
      throw new TypeError(`unsupported structural profile override: ${key}`);
    }
  }
  const h2Range = overrides.h2Count === undefined
    ? base.h2Range
    : validatedRange([overrides.h2Count, overrides.h2Count], 'h2_range');
  const wordRange = overrides.wordMinimum === undefined && overrides.wordMaximum === undefined
    ? base.wordRange
    : validatedRange([
        overrides.wordMinimum ?? base.wordRange[0],
        overrides.wordMaximum ?? base.wordRange[1],
      ], 'word_range');
  const keywordRange = overrides.keywordMinimum === undefined
    && overrides.keywordMaximum === undefined
    ? base.keywordRange
    : validatedRange([
        overrides.keywordMinimum ?? base.keywordRange[0],
        overrides.keywordMaximum ?? base.keywordRange[1],
      ], 'keyword_range');
  return { h2Range, wordRange, keywordRange };
}

export function structuralWordFloor(minimum) {
  const value = Number(minimum);
  if (!finiteInteger(value) || value < RANGE_RULES.word_range.min
    || value > RANGE_RULES.word_range.max) {
    throw new TypeError('word minimum must be a bounded integer');
  }
  return Math.floor(value * 0.99);
}

export function validateStructuralProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    throw new TypeError('structural profile must be an object');
  }
  if (profile.version !== PROFILE_VERSION) {
    throw new TypeError(`unsupported structural profile version: ${String(profile.version || '(missing)')}`);
  }
  const site = requiredString(profile.site, 'site');
  const locale = requiredString(profile.locale, 'locale');
  const template = requiredString(profile.template, 'template');
  if (!Object.hasOwn(TEMPLATE_DEFAULTS, template)) {
    throw new TypeError(`structural profile template is invalid: ${template}`);
  }
  if (typeof profile.intent !== 'string') {
    throw new TypeError('structural profile intent must be a string');
  }
  const intent = profile.intent;
  const contentTier = requiredString(profile.contentTier, 'contentTier');
  const h2Range = validatedRange(profile.h2Range, 'h2_range');
  const h3Range = validatedRange(profile.h3Range, 'h3_range');
  const wordRange = validatedRange(profile.wordRange, 'word_range');
  const expectedEffectiveWordRange = effectiveWordRange(wordRange);
  if (!Array.isArray(profile.effectiveWordRange)
    || profile.effectiveWordRange.length !== 2
    || Number(profile.effectiveWordRange[0]) !== expectedEffectiveWordRange[0]
    || Number(profile.effectiveWordRange[1]) !== expectedEffectiveWordRange[1]) {
    throw new TypeError('structural profile effectiveWordRange is invalid');
  }
  const keywordRange = validatedRange(profile.keywordRange, 'keyword_range');
  const links = validatedRange(profile.internalLinkRange, 'internal_link_range');
  const allowH3 = h3Range[1] === null || h3Range[1] > 0;
  if (profile.allowH3 !== allowH3) {
    throw new TypeError('structural profile allowH3 is invalid');
  }
  if (profile.maxH4 !== 0) {
    throw new TypeError('structural profile maxH4 must remain 0');
  }
  if (profile.faqMinimum !== 3) {
    throw new TypeError('structural profile faqMinimum must remain 3');
  }
  exactObject(profile.tableMinimum, { columns: 4, rows: 3 }, 'tableMinimum');
  exactObject(profile.faqHeadingAliases, FAQ_HEADING_ALIASES, 'faqHeadingAliases');

  return Object.freeze({
    version: PROFILE_VERSION,
    site,
    locale,
    template,
    intent,
    contentTier,
    h2Range: Object.freeze(h2Range),
    h3Range: Object.freeze(h3Range),
    allowH3,
    maxH4: 0,
    wordRange: Object.freeze(wordRange),
    effectiveWordRange: Object.freeze(expectedEffectiveWordRange),
    keywordRange: Object.freeze(keywordRange),
    internalLinkRange: Object.freeze(links),
    faqMinimum: 3,
    tableMinimum: Object.freeze({ columns: 4, rows: 3 }),
    faqHeadingAliases: FAQ_HEADING_ALIASES,
  });
}

export function resolveStructuralProfile({
  site = 'astrologywiki',
  locale = 'en',
  template = 'Definition',
  intent = '',
  contentTier = 'T2',
  manifest = {},
  overrides = {},
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
  const overridden = rangeOverrides({
    h2Range,
    wordRange,
    keywordRange,
  }, overrides);

  return validateStructuralProfile({
    version: PROFILE_VERSION,
    site: String(site || 'astrologywiki'),
    locale: String(locale || 'en'),
    template: templateName,
    intent: String(intent || ''),
    contentTier: String(contentTier || 'T2'),
    h2Range: overridden.h2Range,
    h3Range,
    allowH3: h3Range[1] === null || h3Range[1] > 0,
    maxH4: 0,
    wordRange: overridden.wordRange,
    effectiveWordRange: effectiveWordRange(overridden.wordRange),
    keywordRange: overridden.keywordRange,
    internalLinkRange: links,
    faqMinimum: 3,
    tableMinimum: { columns: 4, rows: 3 },
    faqHeadingAliases: FAQ_HEADING_ALIASES,
  });
}

export { PROFILE_VERSION as STRUCTURAL_PROFILE_VERSION };
