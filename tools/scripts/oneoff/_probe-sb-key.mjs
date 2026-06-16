// Read `supabase projects api-keys -o json` from stdin, find service_role key,
// probe it against the REST endpoint. Prints only status + redacted prefix.
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', async () => {
  let arr;
  try { arr = JSON.parse(s); } catch { console.log('NON-JSON / empty; len', s.length); return; }
  console.log('entries:', arr.length, '| names:', [...new Set(arr.map((k) => k.name))].join(','));
  const sr = arr.find((k) => (k.name || '') === 'service_role') || arr.find((k) => /service/i.test(k.name || ''));
  if (!sr) { console.log('no service_role entry'); return; }
  const key = sr.api_key || sr.apiKey || sr.value || sr.secret;
  if (!key) { console.log('entry fields:', Object.keys(sr).join(',')); return; }
  console.log('service_role: len', key.length, 'prefix', key.slice(0, 8));
  try {
    const r = await fetch('https://qeeocwurjslqppjxlsbk.supabase.co/rest/v1/blog_posts?select=id&limit=1', {
      headers: { apikey: key, Authorization: 'Bearer ' + key },
    });
    console.log('PROBE status:', r.status, r.status === 200 ? '(VALID - can write)' : '(still rejected)');
  } catch (e) { console.log('probe err', e.message); }
});
