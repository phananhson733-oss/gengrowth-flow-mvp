// Fetch the stored blog_posts content + flag any raw-markdown / placeholder leftovers.
const URL = process.env.SB_URL, KEY = process.env.SB_KEY;
const slug = process.argv[2] || 'white-label-keyword-research';
const h = { apikey: KEY, Authorization: 'Bearer ' + KEY };
const r = await fetch(`${URL}/rest/v1/blog_posts?slug=eq.${slug}&select=title,excerpt,content`, { headers: h });
const [row] = await r.json();
if (!row) { console.log('no row'); process.exit(1); }
const c = row.content;
console.log('title:', row.title);
console.log('content len:', c.length);
const flags = {
  'raw [[': (c.match(/\[\[/g) || []).length,
  'TBD': (c.match(/TBD-/g) || []).length,
  'raw ## heading': (c.match(/(^|\n)## /g) || []).length,
  'raw **bold**': (c.match(/\*\*/g) || []).length,
  'h2 tags': (c.match(/<h2>/g) || []).length,
  'p tags': (c.match(/<p>/g) || []).length,
  'table': (c.match(/<table>/g) || []).length,
  'ul/ol': (c.match(/<[uo]l>/g) || []).length,
  'strong': (c.match(/<strong>/g) || []).length,
};
console.log('flags:', JSON.stringify(flags));
console.log('--- first 300 ---\n' + c.slice(0, 300));
console.log('--- last 220 ---\n' + c.slice(-220));
