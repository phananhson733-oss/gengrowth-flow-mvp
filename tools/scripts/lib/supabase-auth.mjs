/**
 * Build PostgREST headers for both legacy JWT keys and the newer opaque API keys.
 *
 * Opaque `sb_secret_` / `sb_publishable_` keys authenticate through `apikey`.
 * Sending them as a Bearer token makes PostgREST treat the opaque value as a user
 * JWT, which fails. Legacy anon/service_role JWTs still need both headers.
 */
export function supabaseRestHeaders(apiKey, extra = {}) {
  const key = String(apiKey || '');
  const headers = { apikey: key, ...extra };
  if (!/^sb_(?:secret|publishable)_/.test(key)) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}
