import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
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
import { isIP } from 'node:net';

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
      failed.push({
        href,
        url: '',
        path: '',
        reason: `unsafe link protocol ${parsed.protocol || '<missing>'}`,
      });
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
    .map((part) => part.trim().split(/\s+/)[0]);
}

function parseInlineSvgReferences(html) {
  const references = [];
  let context = null;
  const tokens = String(html || '').match(
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z][^>]*>/g,
  ) || [];
  const finalize = () => {
    if (!context) return;
    const structurallyValid = context.malformed !== true && context.stack.length === 0;
    for (const reference of context.references) {
      const fragment = String(reference.value || '').slice(1);
      const fragmentPresent = context.ids.has(fragment);
      references.push({
        ...reference,
        inlineValidation: {
          ok: structurallyValid && fragmentPresent,
          reason: !structurallyValid
            ? 'inline SVG parser rejected malformed or unclosed structure'
            : `inline SVG fragment #${fragment} is missing from the same SVG`,
        },
      });
    }
    context = null;
  };

  for (const raw of tokens) {
    if (/^<!--|^<\?|^<!/.test(raw)) continue;
    const close = raw.match(/^<\/\s*([A-Za-z][\w:.-]*)\s*>$/);
    if (close) {
      const name = close[1].toLowerCase();
      if (!context) continue;
      if (name === 'svg') {
        if (context.stack.length !== 1 || context.stack[0] !== 'svg') context.malformed = true;
        context.stack = [];
        finalize();
        continue;
      }
      const expected = context.stack.pop();
      if (!expected || expected !== name) context.malformed = true;
      continue;
    }

    const open = raw.match(/^<\s*([A-Za-z][\w:.-]*)\b([\s\S]*?)\/?\s*>$/);
    if (!open) continue;
    const name = open[1].toLowerCase();
    const attributes = parseAttributes(open[2] || '');
    const selfClosing = /\/\s*>$/.test(raw);
    if (!context) {
      if (name === 'svg') {
        context = {
          ids: new Set(),
          references: [],
          stack: selfClosing ? [] : ['svg'],
          malformed: false,
        };
        if (attributes.id) context.ids.add(attributes.id);
        if (selfClosing) finalize();
      } else if ((name === 'use' || name === 'image')) {
        const hasHref = Object.hasOwn(attributes, 'href')
          || Object.hasOwn(attributes, 'xlink:href');
        const value = attributes.href ?? attributes['xlink:href'] ?? '';
        if (hasHref && String(value).startsWith('#')) {
          references.push({
            tag: name,
            attribute: 'href',
            value,
            svgReference: true,
            inlineValidation: {
              ok: false,
              reason: 'inline SVG reference is outside an inline SVG root',
            },
          });
        }
      }
      continue;
    }

    if (attributes.id) context.ids.add(attributes.id);
    if (name === 'use' || name === 'image') {
      const hasHref = Object.hasOwn(attributes, 'href')
        || Object.hasOwn(attributes, 'xlink:href');
      const value = attributes.href ?? attributes['xlink:href'] ?? '';
      if (hasHref && String(value).startsWith('#')) {
        context.references.push({
          tag: name,
          attribute: 'href',
          value,
          svgReference: true,
        });
      }
    }
    if (!selfClosing) context.stack.push(name);
  }
  if (context) {
    context.malformed = true;
    context.stack = [];
    finalize();
  }
  return references;
}

function renderedAssetReferences(html) {
  const references = [];
  for (const tag of htmlTags(html)) {
    if (tag.name === 'img') {
      if (Object.hasOwn(tag.attributes, 'src')) {
        references.push({ tag: 'img', attribute: 'src', value: tag.attributes.src });
      }
      if (Object.hasOwn(tag.attributes, 'srcset')) {
        for (const value of srcsetCandidates(tag.attributes.srcset)) {
          references.push({ tag: 'img', attribute: 'srcset', value });
        }
      }
    } else if (tag.name === 'source') {
      if (Object.hasOwn(tag.attributes, 'src')) {
        references.push({ tag: 'source', attribute: 'src', value: tag.attributes.src });
      }
      if (Object.hasOwn(tag.attributes, 'srcset')) {
        for (const value of srcsetCandidates(tag.attributes.srcset)) {
          references.push({ tag: 'source', attribute: 'srcset', value });
        }
      }
    } else if (tag.name === 'use' || tag.name === 'image') {
      const hasHref = Object.hasOwn(tag.attributes, 'href')
        || Object.hasOwn(tag.attributes, 'xlink:href');
      const value = tag.attributes.href ?? tag.attributes['xlink:href'] ?? '';
      if (hasHref && !String(value).startsWith('#')) {
        references.push({ tag: tag.name, attribute: 'href', value, svgReference: true });
      }
    }
  }
  return [...references, ...parseInlineSvgReferences(html)];
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

function stripIpBrackets(hostname) {
  return String(hostname || '').replace(/^\[|\]$/g, '');
}

function unsafeIpv4(address) {
  const parts = String(address || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function unsafeIp(address) {
  let value = stripIpBrackets(address).toLowerCase();
  const family = isIP(value);
  if (family === 4) return unsafeIpv4(value);
  if (family !== 6) return true;
  try {
    value = stripIpBrackets(new URL(`http://[${value}]/`).hostname).toLowerCase();
  } catch {
    return true;
  }
  const mappedDecimal = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDecimal) return unsafeIpv4(mappedDecimal[1]);
  const mappedHex = value.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return unsafeIpv4([
      high >> 8,
      high & 0xff,
      low >> 8,
      low & 0xff,
    ].join('.'));
  }
  return value === '::'
    || value === '::1'
    || /^f[cd]/.test(value)
    || /^fe[89a-f]/.test(value)
    || /^ff/.test(value);
}

function configuredAssetHosts(values) {
  const configured = [
    ...values || [],
    ...String(process.env.GG_SEO_ASSET_CDN_ALLOWLIST || '').split(','),
  ];
  const hosts = new Set();
  for (const value of configured) {
    const raw = String(value || '').trim();
    if (!raw) continue;
    try {
      hosts.add(normalizedHostname(new URL(raw.includes('://') ? raw : `https://${raw}`).hostname));
    } catch {}
  }
  return hosts;
}

async function validateAssetUrl(url, {
  trustedHosts,
  configuredHosts,
  resolveHost,
}) {
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, reason: 'invalid asset URL' }; }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: `unsafe asset protocol ${parsed.protocol || '<missing>'}` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'unsafe asset URL credentials are forbidden' };
  }
  const host = normalizedHostname(parsed.hostname);
  if (!trustedHosts.has(host)) {
    return { ok: false, reason: `asset host is not trusted: ${parsed.hostname}` };
  }
  const literal = stripIpBrackets(parsed.hostname);
  if (isIP(literal) && unsafeIp(literal)) {
    return { ok: false, reason: `unsafe private/loopback asset IP: ${literal}` };
  }
  if (configuredHosts.has(host) && !isIP(literal)) {
    const resolver = resolveHost || (async (hostname) => dnsLookup(hostname, {
      all: true,
      verbatim: true,
    }));
    let addresses;
    try { addresses = await resolver(literal); } catch (error) {
      return { ok: false, reason: `asset DNS resolution failed: ${error?.message || String(error)}` };
    }
    if (!Array.isArray(addresses) || addresses.length === 0) {
      return { ok: false, reason: 'asset DNS resolution returned no addresses' };
    }
    const unsafe = addresses.find((entry) => unsafeIp(entry?.address || entry));
    if (unsafe) {
      return {
        ok: false,
        reason: `asset DNS resolved private/loopback address: ${unsafe.address || unsafe}`,
      };
    }
  }
  parsed.hash = '';
  return { ok: true, url: parsed.toString(), host };
}

async function fetchSafeAsset(initialUrl, {
  fetchTarget,
  trustedHosts,
  configuredHosts,
  resolveHost,
  headers,
  maxRedirects = 5,
}) {
  let current = initialUrl;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const safe = await validateAssetUrl(current, {
      trustedHosts,
      configuredHosts,
      resolveHost,
    });
    if (!safe.ok) throw new Error(safe.reason);
    const response = await fetchTarget(safe.url, {
      redirect: 'manual',
      headers,
    });
    const status = Number(response?.status || 0);
    if (status >= 300 && status < 400) {
      if (redirectCount === maxRedirects) throw new Error('asset redirect limit exceeded');
      const location = headerValue(response, 'location');
      if (!location) throw new Error(`asset redirect HTTP ${status} is missing Location`);
      current = new URL(location, safe.url).toString();
      continue;
    }
    const finalUrl = response?.url || safe.url;
    const finalSafe = await validateAssetUrl(finalUrl, {
      trustedHosts,
      configuredHosts,
      resolveHost,
    });
    if (!finalSafe.ok) throw new Error(`unsafe asset final URL: ${finalSafe.reason}`);
    if (response?.redirected === true || finalSafe.url !== safe.url) {
      throw new Error(`asset final URL drift ${finalSafe.url} != ${safe.url}`);
    }
    return { response, url: safe.url };
  }
  throw new Error('asset redirect limit exceeded');
}

export async function verifyFinalAssets({
  html,
  pageUrl,
  assetBaseUrl = pageUrl,
  fetch: fetchImpl,
  decodeImage = defaultDecodeImage,
  allowedAssetHosts = new Set(),
  resolveHost,
}) {
  const checked = [];
  const failed = [];
  const ignored = [];
  const fetchTarget = fetchFunction(fetchImpl);
  const configuredHosts = configuredAssetHosts(allowedAssetHosts);
  const trustedHosts = new Set([
    normalizedHostname(new URL(pageUrl).hostname),
    normalizedHostname(new URL(assetBaseUrl).hostname),
    ...configuredHosts,
  ]);
  const references = renderedAssetReferences(html);
  for (const reference of references) {
    if (String(reference.value || '').trim()) continue;
    failed.push({
      ...reference,
      url: '',
      reason: `rendered ${reference.tag}/${reference.attribute} asset reference is empty or missing`,
    });
  }
  if (failed.length > 0) return { ok: false, checked, failed, ignored };

  for (const reference of references) {
    const raw = String(reference.value || '').trim();
    if (raw.startsWith('#')) {
      const fragment = raw.slice(1);
      if (reference.inlineValidation?.ok === true) {
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
          reason: reference.inlineValidation?.reason
            || `inline SVG fragment #${fragment} is missing`,
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
      const fetched = await fetchSafeAsset(url, {
        fetchTarget,
        trustedHosts,
        configuredHosts,
        resolveHost,
        headers: { 'user-agent': 'gg-seo-final-assets/1' },
      });
      const { response } = fetched;
      const status = Number(response?.status || 0);
      const mime = String(headerValue(response, 'content-type') || '').split(';')[0].trim().toLowerCase();
      const bytes = await responseBytes(response);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const base = {
        ...reference,
        url: fetched.url,
        fragment,
        status,
        mime,
        expectedMime,
        bytes: bytes.length,
        sha256,
      };
      if (status !== 200) {
        failed.push({ ...base, reason: `HTTP ${status || 0}` });
        continue;
      }
      if (!mimeMatches(mime, expectedMime)) {
        failed.push({
          ...base,
          reason: `MIME mismatch ${mime || '<missing>'} != ${expectedMime}`,
        });
        continue;
      }
      if (bytes.length === 0) {
        failed.push({ ...base, reason: 'asset body is empty' });
        continue;
      }
      if (mime === 'image/svg+xml') {
        const parsedSvg = parseSvg(bytes, fragment);
        if (!parsedSvg.ok) {
          failed.push({
            ...base,
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
          reason: decoded?.reason || 'image decode/parser failed',
        });
        continue;
      }
      checked.push({
        ...base,
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
  allowedAssetHosts,
  resolveAssetHost,
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
    allowedAssetHosts,
    resolveHost: resolveAssetHost,
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
