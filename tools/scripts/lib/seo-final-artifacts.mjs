import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

const IMAGE_EXT_RE = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)));
}

function parseAttributes(source) {
  const attributes = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of String(source || '').matchAll(pattern)) {
    const name = String(match[1] || '').toLowerCase();
    if (!name) continue;
    attributes[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function htmlTags(html) {
  const tags = [];
  const pattern = /<([A-Za-z][\w:-]*)(\s[^<>]*?)?\/?>/g;
  for (const match of String(html || '').matchAll(pattern)) {
    tags.push({
      name: match[1].toLowerCase(),
      attributes: parseAttributes(match[2] || ''),
      raw: match[0],
    });
  }
  return tags;
}

function canonicalHref(html) {
  for (const tag of htmlTags(html)) {
    if (tag.name !== 'link') continue;
    const rel = String(tag.attributes.rel || '').toLowerCase().split(/\s+/);
    if (rel.includes('canonical')) return tag.attributes.href || '';
  }
  return '';
}

function normalizedHostname(hostname) {
  return String(hostname || '').toLowerCase().replace(/^www\./, '');
}

function normalizedUrl(value, base) {
  try {
    const url = new URL(decodeEntities(value), base);
    url.hash = '';
    url.hostname = String(url.hostname || '').toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443')
      || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return '';
  }
}

function routePath(value, base) {
  try {
    const url = new URL(String(value || ''), base);
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    const path = String(value || '').split(/[?#]/)[0].replace(/\/+$/, '');
    return path || '/';
  }
}

function normalizedSet(values, mapper) {
  return new Set([...values || []].map(mapper).filter(Boolean));
}

function headerValue(response, name) {
  if (response?.headers?.get) return response.headers.get(name) || '';
  const headers = response?.headers || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

async function responseText(response) {
  if (typeof response?.text === 'function') return response.text();
  if (typeof response?.text === 'string') return response.text;
  if (Buffer.isBuffer(response?.body)) return response.body.toString('utf8');
  if (typeof response?.body === 'string') return response.body;
  return '';
}

async function responseBytes(response) {
  if (typeof response?.arrayBuffer === 'function') {
    return Buffer.from(await response.arrayBuffer());
  }
  if (Buffer.isBuffer(response?.bytes)) return response.bytes;
  if (response?.bytes instanceof Uint8Array) return Buffer.from(response.bytes);
  if (Buffer.isBuffer(response?.body)) return response.body;
  if (response?.body instanceof Uint8Array) return Buffer.from(response.body);
  if (typeof response?.body === 'string') return Buffer.from(response.body);
  if (typeof response?.text === 'function') return Buffer.from(await response.text());
  if (typeof response?.text === 'string') return Buffer.from(response.text);
  return Buffer.alloc(0);
}

function fetchFunction(fetchImpl) {
  if (typeof fetchImpl === 'function') return fetchImpl;
  if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
  throw new Error('fetch implementation is required');
}

export function sitemapUrlsFromXml(xml) {
  const urls = new Set();
  for (const match of String(xml || '').matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    const value = decodeEntities(match[1]).trim();
    if (value) urls.add(value);
  }
  return urls;
}

export async function verifyFinalLinks({
  html,
  pageUrl,
  allowedRoutes = new Set(),
  sitemapUrls = new Set(),
  fetch: fetchImpl,
}) {
  const checked = [];
  const failed = [];
  const ignored = [];
  const page = new URL(pageUrl);
  const pageHost = normalizedHostname(page.hostname);
  const routes = normalizedSet(allowedRoutes, (value) => routePath(value, pageUrl));
  const sitemap = normalizedSet(sitemapUrls, (value) => normalizedUrl(value, pageUrl));
  const fetchTarget = fetchFunction(fetchImpl);

  for (const tag of htmlTags(html)) {
    if (tag.name !== 'a' || !Object.hasOwn(tag.attributes, 'href')) continue;
    const href = String(tag.attributes.href || '').trim();
    const lower = href.toLowerCase();
    if (href.startsWith('#')) {
      ignored.push({ href, reason: 'hash' });
      continue;
    }
    if (lower.startsWith('mailto:')) {
      ignored.push({ href, reason: 'mailto' });
      continue;
    }
    if (lower.startsWith('tel:')) {
      ignored.push({ href, reason: 'tel' });
      continue;
    }
    let parsed;
    try {
      parsed = new URL(href, pageUrl);
    } catch {
      failed.push({ href, url: '', path: '', reason: 'invalid URL' });
      continue;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      ignored.push({ href, reason: 'external' });
      continue;
    }
    if (normalizedHostname(parsed.hostname) !== pageHost) {
      ignored.push({ href, reason: 'external' });
      continue;
    }
    parsed.hash = '';
    const url = normalizedUrl(parsed.toString(), pageUrl);
    const path = routePath(url, pageUrl);
    const allowedBy = routes.has(path)
      ? 'route'
      : (sitemap.has(url) ? 'sitemap' : null);
    if (!allowedBy) {
      failed.push({ href, url, path, reason: 'internal target is not route-or-sitemap allowed' });
      continue;
    }
    try {
      const response = await fetchTarget(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'gg-seo-final-links/1' },
      });
      const status = Number(response?.status || 0);
      const finalUrl = normalizedUrl(response?.url || url, pageUrl);
      const body = await responseText(response);
      const canonical = normalizedUrl(canonicalHref(body), url);
      const reasons = [];
      if (status !== 200) reasons.push(`HTTP ${status || 0}`);
      if (response?.redirected === true || finalUrl !== url) {
        reasons.push(`redirect target drift ${finalUrl || '<missing>'} != ${url}`);
      }
      if (!canonical) reasons.push('canonical missing');
      else if (canonical !== url) reasons.push(`canonical mismatch ${canonical} != ${url}`);
      const entry = {
        href,
        url,
        path,
        allowedBy,
        status,
        finalUrl,
        redirected: response?.redirected === true || finalUrl !== url,
        canonical,
      };
      if (reasons.length) failed.push({ ...entry, reason: reasons.join('; ') });
      else checked.push(entry);
    } catch (error) {
      failed.push({
        href,
        url,
        path,
        allowedBy,
        status: 0,
        canonical: '',
        reason: `fetch failed: ${error?.message || String(error)}`,
      });
    }
  }

  return {
    ok: failed.length === 0,
    checked,
    failed,
    ignored,
  };
}

function srcsetCandidates(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function renderedAssetReferences(html) {
  const references = [];
  for (const tag of htmlTags(html)) {
    if (tag.name === 'img') {
      if (tag.attributes.src) references.push({ tag: 'img', attribute: 'src', value: tag.attributes.src });
      for (const value of srcsetCandidates(tag.attributes.srcset)) {
        references.push({ tag: 'img', attribute: 'srcset', value });
      }
    } else if (tag.name === 'source') {
      if (tag.attributes.src) references.push({ tag: 'source', attribute: 'src', value: tag.attributes.src });
      for (const value of srcsetCandidates(tag.attributes.srcset)) {
        references.push({ tag: 'source', attribute: 'srcset', value });
      }
    } else if (tag.name === 'use' || tag.name === 'image') {
      const value = tag.attributes.href || tag.attributes['xlink:href'];
      if (value) references.push({ tag: tag.name, attribute: 'href', value, svgReference: true });
    }
  }
  return references;
}

function expectedMimeFor(url, reference) {
  let pathname = '';
  try { pathname = new URL(url).pathname.toLowerCase(); } catch {}
  if (reference.svgReference || pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.avif')) return 'image/avif';
  return 'image/*';
}

function mimeMatches(actual, expected) {
  const mime = String(actual || '').split(';')[0].trim().toLowerCase();
  if (expected === 'image/*') return mime.startsWith('image/');
  return mime === expected;
}

function parseRaster(bytes, mime) {
  const type = String(mime || '').toLowerCase();
  if (type === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
      return { ok: false, reason: 'PNG signature/header is invalid' };
    }
    let offset = 8;
    let first = true;
    let ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const typeName = bytes.subarray(offset + 4, offset + 8).toString('ascii');
      const next = offset + 12 + length;
      if (next > bytes.length) return { ok: false, reason: `PNG ${typeName} chunk is truncated` };
      if (first) {
        if (typeName !== 'IHDR' || length !== 13) return { ok: false, reason: 'PNG must start with IHDR' };
        if (bytes.readUInt32BE(offset + 8) === 0 || bytes.readUInt32BE(offset + 12) === 0) {
          return { ok: false, reason: 'PNG dimensions are invalid' };
        }
        first = false;
      }
      offset = next;
      if (typeName === 'IEND') {
        ended = length === 0 && offset === bytes.length;
        break;
      }
    }
    return ended ? { ok: true } : { ok: false, reason: 'PNG parser did not reach a valid IEND' };
  }
  if (type === 'image/jpeg') {
    if (bytes.length < 8 || bytes[0] !== 0xff || bytes[1] !== 0xd8
      || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
      return { ok: false, reason: 'JPEG SOI/EOI markers are invalid' };
    }
    let offset = 2;
    let dimensions = false;
    while (offset + 4 <= bytes.length - 2) {
      while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
      while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return { ok: false, reason: 'JPEG segment is truncated' };
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 7 || bytes.readUInt16BE(offset + 3) === 0 || bytes.readUInt16BE(offset + 5) === 0) {
          return { ok: false, reason: 'JPEG dimensions are invalid' };
        }
        dimensions = true;
      }
      offset += length;
    }
    return dimensions ? { ok: true } : { ok: false, reason: 'JPEG parser found no frame dimensions' };
  }
  if (type === 'image/gif') {
    const valid = bytes.length >= 14
      && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
      && bytes.readUInt16LE(6) > 0
      && bytes.readUInt16LE(8) > 0
      && bytes.at(-1) === 0x3b;
    return valid ? { ok: true } : { ok: false, reason: 'GIF parser rejected header, dimensions, or trailer' };
  }
  if (type === 'image/webp') {
    const valid = bytes.length >= 20
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
      && bytes.readUInt32LE(4) + 8 <= bytes.length
      && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.subarray(12, 16).toString('ascii'));
    return valid ? { ok: true } : { ok: false, reason: 'WebP RIFF/chunk parser failed' };
  }
  if (type === 'image/avif') {
    const valid = bytes.length >= 16
      && bytes.subarray(4, 8).toString('ascii') === 'ftyp'
      && /avif|avis/.test(bytes.subarray(8, Math.min(bytes.length, 40)).toString('ascii'));
    return valid ? { ok: true } : { ok: false, reason: 'AVIF box parser failed' };
  }
  return { ok: false, reason: `unsupported image parser for ${type || '<missing MIME>'}` };
}

function parseSvg(bytes, fragment = '') {
  const source = Buffer.from(bytes).toString('utf8').trim();
  if (!source || !/<svg\b/i.test(source)
    || (!/<\/svg\s*>/i.test(source) && !/<svg\b[^>]*\/\s*>/i.test(source))) {
    return { ok: false, reason: 'SVG parser rejected empty or missing svg root' };
  }
  const stack = [];
  const tags = source.match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z][^>]*>/g) || [];
  for (const raw of tags) {
    if (/^<!--|^<\?|^<!/.test(raw)) continue;
    const close = raw.match(/^<\/\s*([A-Za-z][\w:.-]*)\s*>$/);
    if (close) {
      const expected = stack.pop();
      if (!expected || expected !== close[1].toLowerCase()) {
        return { ok: false, reason: `SVG parser tag mismatch at ${close[1]}` };
      }
      continue;
    }
    const open = raw.match(/^<\s*([A-Za-z][\w:.-]*)\b/);
    if (open && !/\/\s*>$/.test(raw)) stack.push(open[1].toLowerCase());
  }
  if (stack.length) return { ok: false, reason: `SVG parser found unclosed ${stack.at(-1)}` };
  if (fragment) {
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\bid\\s*=\\s*["']${escaped}["']`, 'i').test(source)) {
      return { ok: false, reason: `SVG fragment #${fragment} is missing` };
    }
  }
  return { ok: true };
}

async function defaultDecodeImage({ bytes, mime, fragment }) {
  if (mime === 'image/svg+xml') return parseSvg(bytes, fragment);
  return parseRaster(bytes, mime);
}

function inlineIdExists(html, fragment) {
  const escaped = String(fragment || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Boolean(fragment) && new RegExp(`\\bid\\s*=\\s*["']${escaped}["']`, 'i').test(String(html || ''));
}

export async function verifyFinalAssets({
  html,
  pageUrl,
  assetBaseUrl = pageUrl,
  fetch: fetchImpl,
  decodeImage = defaultDecodeImage,
}) {
  const checked = [];
  const failed = [];
  const ignored = [];
  const fetchTarget = fetchFunction(fetchImpl);

  for (const reference of renderedAssetReferences(html)) {
    const raw = String(reference.value || '').trim();
    if (!raw) continue;
    if (raw.startsWith('#')) {
      const fragment = raw.slice(1);
      if (inlineIdExists(html, fragment)) {
        checked.push({
          ...reference,
          url: pageUrl,
          fragment,
          inline: true,
          status: 200,
          mime: 'image/svg+xml',
          bytes: 0,
          sha256: null,
        });
      } else {
        failed.push({
          ...reference,
          url: pageUrl,
          fragment,
          inline: true,
          reason: `inline SVG fragment #${fragment} is missing`,
        });
      }
      continue;
    }
    if (/^data:/i.test(raw)) {
      failed.push({ ...reference, url: raw.slice(0, 64), reason: 'embedded data asset has no HTTP 200 evidence' });
      continue;
    }
    let parsed;
    try {
      parsed = new URL(raw, assetBaseUrl);
    } catch {
      failed.push({ ...reference, url: '', reason: 'invalid asset URL' });
      continue;
    }
    const fragment = parsed.hash ? parsed.hash.slice(1) : '';
    parsed.hash = '';
    const url = parsed.toString();
    const expectedMime = expectedMimeFor(url, reference);
    try {
      const response = await fetchTarget(url, {
        redirect: 'follow',
        headers: { 'user-agent': 'gg-seo-final-assets/1' },
      });
      const status = Number(response?.status || 0);
      const mime = String(headerValue(response, 'content-type') || '').split(';')[0].trim().toLowerCase();
      const base = {
        ...reference,
        url,
        fragment,
        status,
        mime,
        expectedMime,
      };
      if (status !== 200) {
        failed.push({ ...base, reason: `HTTP ${status || 0}` });
        continue;
      }
      const bytes = await responseBytes(response);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (!mimeMatches(mime, expectedMime)) {
        failed.push({
          ...base,
          bytes: bytes.length,
          sha256,
          reason: `MIME mismatch ${mime || '<missing>'} != ${expectedMime}`,
        });
        continue;
      }
      if (bytes.length === 0) {
        failed.push({ ...base, bytes: 0, sha256, reason: 'asset body is empty' });
        continue;
      }
      if (mime === 'image/svg+xml') {
        const parsedSvg = parseSvg(bytes, fragment);
        if (!parsedSvg.ok) {
          failed.push({
            ...base,
            bytes: bytes.length,
            sha256,
            reason: parsedSvg.reason,
          });
          continue;
        }
      }
      const decoded = await decodeImage({ bytes, mime, url, fragment, reference });
      const decodeOk = decoded === true || decoded?.ok === true;
      if (!decodeOk) {
        failed.push({
          ...base,
          bytes: bytes.length,
          sha256,
          reason: decoded?.reason || 'image decode/parser failed',
        });
        continue;
      }
      checked.push({
        ...base,
        bytes: bytes.length,
        sha256,
      });
    } catch (error) {
      failed.push({
        ...reference,
        url,
        fragment,
        status: 0,
        reason: `fetch/decode failed: ${error?.message || String(error)}`,
      });
    }
  }

  return {
    ok: failed.length === 0,
    checked,
    failed,
    ignored,
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

export function failureFingerprintFor(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

export function artifactShaForEvidence({
  articleSha,
  finalAssets,
}) {
  const hash = createHash('sha256');
  hash.update('article\0');
  hash.update(String(articleSha || ''));
  const assets = [
    ...(finalAssets?.checked || []),
    ...(finalAssets?.failed || []),
  ]
    .filter((entry) => entry?.sha256)
    .map((entry) => ({ url: entry.url, sha256: entry.sha256 }))
    .sort((left, right) => `${left.url}\0${left.sha256}`.localeCompare(`${right.url}\0${right.sha256}`));
  for (const asset of assets) {
    hash.update('\0asset\0');
    hash.update(String(asset.url || ''));
    hash.update('\0');
    hash.update(asset.sha256);
  }
  return hash.digest('hex');
}

function safeRelative(worktree, file) {
  const path = relative(worktree, resolve(file)).replaceAll('\\', '/');
  if (!path || path === '.' || path.startsWith('../') || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return null;
  }
  return path;
}

function slugAsset(path, slug) {
  const normalized = String(path || '').replaceAll('\\', '/');
  return normalized.startsWith(`public/images/blog/${slug}`)
    && IMAGE_EXT_RE.test(normalized)
    && ['.', '-'].includes(normalized[`public/images/blog/${slug}`.length] || '');
}

function discoveredSlugAssets(worktree, slug) {
  const directory = join(worktree, 'public/images/blog');
  try {
    return readdirSync(directory)
      .filter((name) => (name.startsWith(`${slug}.`) || name.startsWith(`${slug}-`)) && IMAGE_EXT_RE.test(name))
      .map((name) => `public/images/blog/${name}`);
  } catch {
    return [];
  }
}

export function artifactShaFromFiles({
  worktree,
  articlePath,
  slug,
  changedPaths,
}) {
  const root = resolve(worktree);
  const article = resolve(articlePath);
  const candidates = new Map();
  const articleRelative = safeRelative(root, article);
  if (articleRelative && existsSync(article)) candidates.set(articleRelative, article);
  const assets = changedPaths == null ? discoveredSlugAssets(root, slug) : changedPaths;
  for (const path of assets || []) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const relativePath = safeRelative(root, absolute);
    if (!relativePath || !slugAsset(relativePath, slug) || !existsSync(absolute)) continue;
    candidates.set(relativePath, absolute);
  }
  const hash = createHash('sha256');
  for (const [path, absolute] of [...candidates.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const bytes = readFileSync(absolute);
    hash.update(path);
    hash.update('\0');
    hash.update(String(bytes.length));
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function verifyRenderedArtifacts({
  html,
  pageUrl,
  assetBaseUrl = pageUrl,
  allowedRoutes,
  sitemapUrls,
  fetch: fetchImpl,
  decodeImage,
  articleSha,
  reviewedHeadRefOid,
}) {
  const final_links = await verifyFinalLinks({
    html,
    pageUrl,
    allowedRoutes,
    sitemapUrls,
    fetch: fetchImpl,
  });
  const final_assets = await verifyFinalAssets({
    html,
    pageUrl,
    assetBaseUrl,
    fetch: fetchImpl,
    decodeImage,
  });
  const artifactSha = artifactShaForEvidence({ articleSha, finalAssets: final_assets });
  const failureFingerprint = (final_links.ok && final_assets.ok)
    ? null
    : failureFingerprintFor({
        final_links: final_links.failed,
        final_assets: final_assets.failed,
      });
  return {
    ok: final_links.ok && final_assets.ok,
    reviewedHeadRefOid,
    artifactSha,
    failureFingerprint,
    final_links,
    final_assets,
  };
}
