// author-personas/loader.mjs — persona card loader for the SEO content pipeline.
//
// Parses a persona markdown card (YAML frontmatter + prose body) into a structured,
// prompt-safe capsule. Fail-loud: any missing required field, malformed frontmatter,
// or unsafe body content throws — the loader never returns a half-built or undefined
// persona, because a silently wrong byline is worse than a crash.
//
// Exposed contract (Lane A shared ctx):
//   loadPersona(authorId)  -> frozen { id, displayName, primaryFocus, bannedTokens[],
//                                      capsule:{voiceRule, allowedMoves, forbiddenMoves,
//                                      credential}, version, sourceRef }
//   loadAllPersonas()      -> frozen array of every valid card (any bad card throws)
//   listAuthorIds()        -> string[] of available <id> (from <id>.md filenames)
//
// No external deps (matches the rest of tools/scripts/lib). Frontmatter parser is a
// minimal subset: top-level `key: value` scalars + `key:` followed by `- item` lists.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONA_DIR = __dirname;

// kebab-case id whitelist: lowercase alnum + single hyphens, length 1..64.
// Mirrors the page_id discipline in gg-content-draft so an id can never escape
// the persona directory via path tricks.
const AUTHOR_ID_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const REQUIRED_SCALARS = Object.freeze([
  'id',
  'display_name',
  'primary_focus',
  'version',
  'source_ref',
  'voice_rule',
  'allowed_moves',
  'forbidden_moves',
  'credential',
]);

// Body safety caps + forbidden patterns. The body is NEVER injected into the
// binary-check-protected prompt; these checks exist so the source card itself
// cannot smuggle prompt-control instructions, structure-breaking headings, or
// the author's own banned tokens (which would teach the model the forbidden words).
const MAX_BODY_LEN = 4000;

const FORBIDDEN_BODY_PATTERNS = Object.freeze([
  { re: /^#{1,6}\s+/m, label: 'markdown heading' },
  { re: /\{\{[^}]*\}\}/, label: 'template placeholder {{...}}' },
  { re: /```/, label: 'fenced code block' },
  { re: /\b(always|never|must|do not|don't)\s+(write|include|output|use|ignore|forget)\b/i, label: 'imperative prompt-control phrase' },
  { re: /\bignore\s+(the\s+)?(previous|above|outline|instructions)\b/i, label: 'prompt-injection phrase' },
  { re: /\bsystem\s*:/i, label: 'system: directive' },
]);

class PersonaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersonaError';
    this.code = 'EPERSONA';
  }
}

// ---- frontmatter parsing -------------------------------------------------

// Split a raw card into { frontmatterText, body }. Requires a leading `---`
// fence and a closing `---`. Anything else is malformed → throw.
function splitFrontmatter(raw, idForMsg) {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) {
    throw new PersonaError(`persona "${idForMsg}": missing leading --- frontmatter fence`);
  }
  const rest = text.slice(text.indexOf('\n') + 1);
  const closeIdx = rest.search(/^---\s*$/m);
  if (closeIdx === -1) {
    throw new PersonaError(`persona "${idForMsg}": unterminated frontmatter (no closing ---)`);
  }
  const frontmatterText = rest.slice(0, closeIdx);
  const body = rest.slice(closeIdx).replace(/^---\s*\r?\n?/, '');
  return { frontmatterText, body: body.trim() };
}

function stripQuotes(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

// Minimal YAML subset parser: top-level scalars and `- ` lists. Returns a plain
// object where list keys map to string[] and scalar keys map to string.
function parseFrontmatter(frontmatterText, idForMsg) {
  const out = {};
  let currentList = null;
  const lines = frontmatterText.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem) {
      if (!currentList) {
        throw new PersonaError(`persona "${idForMsg}": list item with no parent key: "${line.trim()}"`);
      }
      out[currentList].push(stripQuotes(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) {
      throw new PersonaError(`persona "${idForMsg}": malformed frontmatter line: "${line}"`);
    }
    const [, key, rawVal] = kv;
    if (rawVal.trim() === '') {
      currentList = key;
      out[key] = [];
    } else {
      currentList = null;
      out[key] = stripQuotes(rawVal);
    }
  }
  return out;
}

// ---- validation ----------------------------------------------------------

function validateBannedTokens(fm, idForMsg) {
  const raw = fm.banned_tokens;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new PersonaError(`persona "${idForMsg}": banned_tokens must be a list`);
  }
  const tokens = [];
  for (const t of raw) {
    const trimmed = String(t).trim();
    if (!trimmed) continue;
    // Fail loud on uppercase: RL7 matches case-insensitively, but a stray
    // uppercase token in a card signals a hand-edit mistake worth catching.
    if (trimmed !== trimmed.toLowerCase()) {
      throw new PersonaError(`persona "${idForMsg}": banned_token "${trimmed}" must be lowercase`);
    }
    tokens.push(trimmed);
  }
  return tokens;
}

function validateBody(body, bannedTokens, idForMsg) {
  if (body.length === 0) {
    throw new PersonaError(`persona "${idForMsg}": prose body is empty`);
  }
  if (body.length > MAX_BODY_LEN) {
    throw new PersonaError(`persona "${idForMsg}": body length ${body.length} exceeds ${MAX_BODY_LEN}`);
  }
  for (const { re, label } of FORBIDDEN_BODY_PATTERNS) {
    if (re.test(body)) {
      throw new PersonaError(`persona "${idForMsg}": body contains forbidden ${label}`);
    }
  }
  const lowerBody = body.toLowerCase();
  for (const token of bannedTokens) {
    if (lowerBody.includes(token)) {
      throw new PersonaError(
        `persona "${idForMsg}": body contains its own banned_token "${token}" (would teach the model the forbidden word)`
      );
    }
  }
}

// The four capsule scalars are injected verbatim into the LLM prompt, so they
// need an injection-phrase filter — a "system:" or "ignore the previous
// instructions" smuggled into voice_rule would otherwise reach the model. This
// is a SUBSET of FORBIDDEN_BODY_PATTERNS: forbidden_moves legitimately uses
// imperative voice ("Do not use academic framing"), so the body-only heading and
// imperative-prompt-control patterns are excluded — only true injection vectors
// remain. A length cap bounds the surface (personas use 1-3 sentences per field).
const INJECTED_CAPSULE_FIELDS = Object.freeze(['voice_rule', 'allowed_moves', 'forbidden_moves', 'credential']);
const MAX_CAPSULE_FIELD_LEN = 400;
const FORBIDDEN_CAPSULE_PATTERNS = Object.freeze([
  { re: /\{\{[^}]*\}\}/, label: 'template placeholder {{...}}' },
  { re: /```/, label: 'fenced code block' },
  { re: /\bignore\s+(the\s+)?(previous|above|outline|instructions)\b/i, label: 'prompt-injection phrase' },
  { re: /\bsystem\s*:/i, label: 'system: directive' },
]);

function assertRequiredScalars(fm, idForMsg) {
  for (const key of REQUIRED_SCALARS) {
    const v = fm[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new PersonaError(`persona "${idForMsg}": missing or empty required field "${key}"`);
    }
  }
  for (const key of INJECTED_CAPSULE_FIELDS) {
    const v = fm[key];
    if (v.length > MAX_CAPSULE_FIELD_LEN) {
      throw new PersonaError(`persona "${idForMsg}": capsule field "${key}" length ${v.length} exceeds ${MAX_CAPSULE_FIELD_LEN}`);
    }
    for (const { re, label } of FORBIDDEN_CAPSULE_PATTERNS) {
      if (re.test(v)) {
        throw new PersonaError(`persona "${idForMsg}": capsule field "${key}" contains forbidden ${label}`);
      }
    }
  }
}

// ---- build ---------------------------------------------------------------

function buildPersona(fm, body, expectedId) {
  assertRequiredScalars(fm, expectedId);
  if (fm.id !== expectedId) {
    throw new PersonaError(`persona "${expectedId}": frontmatter id "${fm.id}" does not match filename`);
  }
  const bannedTokens = validateBannedTokens(fm, expectedId);
  validateBody(body, bannedTokens, expectedId);
  return Object.freeze({
    id: fm.id,
    displayName: fm.display_name,
    primaryFocus: fm.primary_focus,
    bannedTokens: Object.freeze([...bannedTokens]),
    capsule: Object.freeze({
      voiceRule: fm.voice_rule,
      allowedMoves: fm.allowed_moves,
      forbiddenMoves: fm.forbidden_moves,
      credential: fm.credential,
    }),
    version: fm.version,
    sourceRef: fm.source_ref,
  });
}

// ---- public API ----------------------------------------------------------

function cardPath(authorId) {
  if (typeof authorId !== 'string' || !AUTHOR_ID_REGEX.test(authorId)) {
    throw new PersonaError(`invalid author id "${authorId}": must be kebab-case (${AUTHOR_ID_REGEX})`);
  }
  return join(PERSONA_DIR, `${authorId}.md`);
}

export function loadPersona(authorId) {
  const path = cardPath(authorId);
  if (!existsSync(path)) {
    throw new PersonaError(`unknown author id "${authorId}": no card at ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  const { frontmatterText, body } = splitFrontmatter(raw, authorId);
  const fm = parseFrontmatter(frontmatterText, authorId);
  return buildPersona(fm, body, authorId);
}

export function listAuthorIds() {
  return readdirSync(PERSONA_DIR)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((id) => AUTHOR_ID_REGEX.test(id))
    .sort();
}

export function loadAllPersonas() {
  return Object.freeze(listAuthorIds().map((id) => loadPersona(id)));
}

export { PersonaError, AUTHOR_ID_REGEX };
