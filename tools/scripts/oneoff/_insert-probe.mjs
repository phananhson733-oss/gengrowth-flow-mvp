// Raw-fetch INSERT probe to isolate supabase-js vs DB-level (RLS/trigger).
// Env: SB_URL, SB_KEY (service_role). POSTs a throwaway row, checks persistence, deletes it.
const URL = process.env.SB_URL;
const KEY = process.env.SB_KEY;
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
const now = new Date().toISOString();
const probe = {
  slug: '_zzz-import-probe-delete-me',
  title: 'import probe',
  content: '<p>probe</p>',
  excerpt: 'probe excerpt that is comfortably longer than forty characters for validation',
  category: 'methodology',
  locale: 'en',
  author: 'GenGrowth Team',
  published_at: now,
  status: 'draft',
};

const post = await fetch(`${URL}/rest/v1/blog_posts`, {
  method: 'POST',
  headers: { ...h, Prefer: 'return=representation' },
  body: JSON.stringify(probe),
});
console.log('POST status:', post.status, post.statusText);
const body = await post.text();
console.log('POST body:', body.slice(0, 500) || '(empty)');

const chk = await fetch(`${URL}/rest/v1/blog_posts?slug=eq._zzz-import-probe-delete-me&select=id,status`, { headers: h });
const chkBody = await chk.text();
console.log('persist check:', chk.status, chkBody.slice(0, 200));

// cleanup
const del = await fetch(`${URL}/rest/v1/blog_posts?slug=eq._zzz-import-probe-delete-me`, { method: 'DELETE', headers: h });
console.log('cleanup DELETE status:', del.status);
