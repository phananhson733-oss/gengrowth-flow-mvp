// Query blog_posts for the PG-WLS-001 slug via node fetch (curl is sandbox-blocked).
// Env: SB_URL, SB_KEY (service_role). Prints rows + a diagnostic insert dry-probe.
const URL = process.env.SB_URL;
const KEY = process.env.SB_KEY;
const slug = process.argv[2] || 'white-label-keyword-research';
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

const r = await fetch(`${URL}/rest/v1/blog_posts?slug=eq.${slug}&select=id,status,locale,title,reading_time,category,pillar_slug`, { headers: h });
console.log('GET status', r.status);
const body = await r.text();
try {
  const a = JSON.parse(body);
  console.log('rows:', a.length);
  a.forEach((x) => console.log(JSON.stringify(x)));
} catch {
  console.log('raw body:', body.slice(0, 400));
}
