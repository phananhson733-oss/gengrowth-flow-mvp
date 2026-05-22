#!/usr/bin/env node
// oauth-init.mjs — wzb 个人 Gmail OAuth (Desktop app + loopback + PKCE) 一键 consent
//
// 前置（你在 GCP Console 已经做完）：
//   1) 启用 4 个 API: Sheets / Drive / Search Console / Analytics Data
//   2) OAuth consent screen: External / Testing / scopes = spreadsheets + webmasters.readonly + analytics.readonly
//   3) Test users 含 xdawayer@gmail.com
//   4) Desktop OAuth Client → 下载 JSON 到 ~/.config/gg/gg-oauth-client.json (mode 600)
//
// 用法：
//   node tools/scripts/oauth-init.mjs
//
// 行为：
//   - 起 localhost loopback HTTP server (随机端口)
//   - 打开浏览器到 Google consent → 用户授权
//   - 捕获 auth code → exchange refresh_token (access_type=offline, prompt=consent)
//   - 把 3 个 secret 写回 ~/.config/gg/_gg.env (mode 600, idempotent 替换)
//   - 不打印 token 本身（只打印长度 + 末 4 位指纹）

import { readFileSync, writeFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const CLIENT_JSON = process.env.GG_OAUTH_CLIENT_JSON || join(homedir(), '.config', 'gg', 'gg-oauth-client.json');
const ENV_FILE = process.env.GG_ENV_FILE || join(homedir(), '.config', 'gg', '_gg.env');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
];

// ---------- helpers ----------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function fingerprint(secret) {
  if (!secret) return '(empty)';
  const tail = secret.slice(-4);
  return `len=${secret.length} tail=…${tail}`;
}

function loadClient() {
  if (!existsSync(CLIENT_JSON)) {
    console.error(`❌ OAuth client JSON not found: ${CLIENT_JSON}`);
    console.error('   Download from GCP Console → Credentials → your Desktop OAuth client → Download JSON');
    console.error(`   mv ~/Downloads/client_secret_*.json ${CLIENT_JSON} && chmod 600 ${CLIENT_JSON}`);
    process.exit(1);
  }
  const mode = statSync(CLIENT_JSON).mode & 0o777;
  if (mode !== 0o600) {
    console.warn(`⚠️  ${CLIENT_JSON} mode is ${mode.toString(8)}, fixing → 600`);
    chmodSync(CLIENT_JSON, 0o600);
  }
  const raw = JSON.parse(readFileSync(CLIENT_JSON, 'utf8'));
  const cfg = raw.installed || raw.web;
  if (!cfg?.client_id || !cfg?.client_secret) {
    console.error('❌ client JSON missing installed.client_id / client_secret — is this a "Desktop app" OAuth client?');
    process.exit(1);
  }
  return { clientId: cfg.client_id, clientSecret: cfg.client_secret };
}

function upsertEnv(updates) {
  let text = '';
  if (existsSync(ENV_FILE)) text = readFileSync(ENV_FILE, 'utf8');
  const lines = text.split('\n');
  for (const [key, val] of Object.entries(updates)) {
    const escaped = String(val).replace(/\n/g, '\\n');
    const re = new RegExp(`^\\s*${key}\\s*=.*$`);
    const idx = lines.findIndex((l) => re.test(l));
    const line = `${key}=${escaped}`;
    if (idx >= 0) lines[idx] = line;
    else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(line);
    }
  }
  writeFileSync(ENV_FILE, lines.join('\n'));
  chmodSync(ENV_FILE, 0o600);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  const args = process.platform === 'win32' ? ['', url] : [url];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
}

async function exchangeCode({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${body.error_description || body.error || res.statusText}`);
  if (!body.refresh_token) {
    throw new Error(
      'No refresh_token returned. Google only returns refresh_token on FIRST consent. ' +
        'Revoke at https://myaccount.google.com/permissions and re-run.',
    );
  }
  return body;
}

// ---------- main ----------
(async () => {
  console.log('GenGrowth MVP — wzb personal Gmail OAuth init');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const { clientId, clientSecret } = loadClient();
  console.log(`client_id: ${fingerprint(clientId)}`);
  console.log(`scopes:    ${SCOPES.join(' ')}`);
  console.log('');

  const state = b64url(randomBytes(24));
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      include_granted_scopes: 'true',
    }).toString();

  console.log(`📡 loopback listening on ${redirectUri}`);
  console.log('🌐 opening browser… (if it does not open, paste this URL:)');
  console.log(`   ${authUrl}`);
  console.log('');
  console.log('⏳ waiting for consent (Ctrl+C to abort)…');
  openBrowser(authUrl);

  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout after 5 min')), 5 * 60 * 1000);
    server.on('request', (req, res) => {
      const u = new URL(req.url, redirectUri);
      const code = u.searchParams.get('code');
      const got = u.searchParams.get('state');
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`OAuth error: ${err}. You can close this tab.`);
        clearTimeout(timer);
        reject(new Error(`consent denied: ${err}`));
        return;
      }
      if (got !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('state mismatch (CSRF?). You can close this tab.');
        clearTimeout(timer);
        reject(new Error('state mismatch'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset=utf-8><title>OAuth done</title>' +
          '<body style="font-family:system-ui;padding:40px;text-align:center">' +
          '<h2>✅ Consent captured</h2>' +
          '<p>You can close this tab and return to the terminal.</p>' +
          '</body>',
      );
      clearTimeout(timer);
      resolve(code);
    });
  }).finally(() => server.close());

  const tokens = await exchangeCode({
    clientId,
    clientSecret,
    code: result,
    codeVerifier,
    redirectUri,
  });

  upsertEnv({
    GG_OAUTH_CLIENT_ID: clientId,
    GG_OAUTH_CLIENT_SECRET: clientSecret,
    GG_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
  });

  console.log('');
  console.log('✅ refresh_token saved');
  console.log(`   file:          ${ENV_FILE} (mode 600)`);
  console.log(`   refresh_token: ${fingerprint(tokens.refresh_token)}`);
  console.log(`   access_token:  ${fingerprint(tokens.access_token)} (expires in ${tokens.expires_in}s, not saved)`);
  console.log(`   scope granted: ${tokens.scope || '(see consent screen)'}`);
  console.log('');
  console.log('Next: node tools/scripts/verify-gcp-oauth.mjs');
  console.log('');
  console.log('⏰ Testing-mode refresh_token expires every 7 days. Re-run this script when verify fails with invalid_grant.');
})().catch((e) => {
  console.error('');
  console.error('❌ fatal:', e.message);
  process.exit(1);
});
