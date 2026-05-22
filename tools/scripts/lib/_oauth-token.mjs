// _oauth-token.mjs — 用 refresh_token 换 access_token（per-process 内存缓存）
//
// 输入 env（由 ~/.config/gg/_gg.env 加载，或调用方先 process.env 注入）：
//   GG_OAUTH_CLIENT_ID
//   GG_OAUTH_CLIENT_SECRET
//   GG_OAUTH_REFRESH_TOKEN
//
// 用法：
//   import { getAccessToken } from './lib/_oauth-token.mjs';
//   const token = await getAccessToken();
//   fetch(url, { headers: { authorization: `Bearer ${token}` } });
//
// 注意：refresh_token 不绑 scope，scope 在 consent 时已固化。
// 如要扩 scope，跑 `node tools/scripts/oauth-init.mjs` 重新 consent。

let cached = { token: null, exp: 0 };

export async function getAccessToken({ force = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (!force && cached.token && cached.exp - 60 > now) return cached.token;

  const clientId = process.env.GG_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GG_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GG_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      'OAuth env incomplete — need GG_OAUTH_CLIENT_ID / GG_OAUTH_CLIENT_SECRET / GG_OAUTH_REFRESH_TOKEN.\n' +
        'Run: node tools/scripts/oauth-init.mjs',
    );
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const desc = body.error_description || body.error || res.statusText;
    if (body.error === 'invalid_grant') {
      throw new Error(
        `refresh_token rejected (${desc}). Most common cause: 7-day Testing-mode expiry. ` +
          `Re-run: node tools/scripts/oauth-init.mjs`,
      );
    }
    throw new Error(`refresh failed (${res.status}): ${desc}`);
  }
  cached = { token: body.access_token, exp: now + (body.expires_in || 3600) };
  return cached.token;
}
