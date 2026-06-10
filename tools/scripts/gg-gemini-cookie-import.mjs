#!/usr/bin/env node
// Import logged-in google.com cookies from the user's daily Chrome profile
// into the baoyu gemini-web skill's cookies.json. Key material never printed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const chromeRoot = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
const outPath = path.join(home, 'Library', 'Application Support', 'baoyu-skills', 'gemini-web', 'cookies.json');

// 1. Safe Storage password from Keychain (triggers one Keychain dialog).
const password = execFileSync('security', ['find-generic-password', '-wa', 'Chrome', '-s', 'Chrome Safe Storage'], { encoding: 'utf8' }).trim();
const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');

function decrypt(encHex, hostKey) {
  const buf = Buffer.from(encHex, 'hex');
  if (buf.length === 0) return '';
  if (buf.slice(0, 3).toString() !== 'v10') return ''; // unencrypted or unknown scheme
  const dec = crypto.createDecipheriv('aes-128-cbc', key, IV);
  let plain;
  try { plain = Buffer.concat([dec.update(buf.slice(3)), dec.final()]); } catch { return ''; }
  // Chrome >= 130 prepends SHA256(host_key) to the plaintext value.
  const prefix = crypto.createHash('sha256').update(hostKey).digest();
  if (plain.length >= 32 && plain.slice(0, 32).equals(prefix)) plain = plain.slice(32);
  return plain.toString('utf8');
}

// 2. Find candidate profiles.
const profiles = fs.readdirSync(chromeRoot)
  .filter((d) => d === 'Default' || /^Profile /.test(d))
  .map((d) => path.join(chromeRoot, d, 'Cookies'))
  .filter((p) => fs.existsSync(p));

let best = null;
for (const dbPath of profiles) {
  const tmp = path.join(os.tmpdir(), 'ck-' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  fs.copyFileSync(dbPath, tmp);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + ext)) fs.copyFileSync(dbPath + ext, tmp + ext);
  }
  let rows = '';
  try {
    rows = execFileSync('sqlite3', ['-separator', '\t', tmp,
      "SELECT host_key, name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%google.com'"], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch { /* locked or unreadable */ }
  fs.rmSync(tmp, { force: true }); fs.rmSync(tmp + '-wal', { force: true }); fs.rmSync(tmp + '-shm', { force: true });
  const map = {};
  for (const line of rows.split('\n')) {
    if (!line) continue;
    const [hostKey, name, encHex] = line.split('\t');
    if (!name || !encHex) continue;
    const val = decrypt(encHex, hostKey);
    if (val) map[name] = val;
  }
  if (map['__Secure-1PSID']) { best = { profile: path.basename(path.dirname(dbPath)), map }; break; }
  if (!best && Object.keys(map).length) best = { profile: path.basename(path.dirname(dbPath)), map };
}

if (!best || !best.map['__Secure-1PSID']) {
  console.error('FAILED: no profile with a logged-in Google session (__Secure-1PSID) found. Profiles scanned: ' + profiles.length);
  process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), cookieMap: best.map, source: 'chrome-profile-import' }, null, 2));
fs.chmodSync(outPath, 0o600);
console.log('OK: imported ' + Object.keys(best.map).length + ' cookies from Chrome profile "' + best.profile + '" -> ' + outPath);
console.log('names: ' + Object.keys(best.map).sort().join(', '));
