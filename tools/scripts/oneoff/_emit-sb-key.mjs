// Read `supabase projects api-keys -o json` from stdin, print ONLY the
// service_role key to stdout (captured into an env var; never echoed to chat).
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  let arr;
  try { arr = JSON.parse(s); } catch { process.exit(1); }
  const sr = arr.find((k) => (k.name || '') === 'service_role');
  const key = sr && (sr.api_key || sr.apiKey || sr.value || sr.secret);
  if (!key) process.exit(1);
  process.stdout.write(key);
});
