#!/usr/bin/env node
/** 只读:线上复核 row59/85 的 EMPATH 两 slug 重定向状态(验证 codex 的 308 判断) */
const urls = [
  'https://www.astrologywiki.com/en/wiki/signs-of-a-highly-sensitive-person',
  'https://www.astrologywiki.com/en/wiki/signs-you-re-a-highly-sensitive-person',
];
for (const u of urls) {
  try {
    const r = await fetch(u, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    console.log(`${r.status} ${u.replace('https://www.astrologywiki.com', '')}${loc ? ' → ' + loc : ''}`);
  } catch (e) {
    console.log(`ERR ${u}: ${e.message}`);
  }
}
// sitemap 复核哪个 slug 在收录
try {
  const sm = await (await fetch('https://www.astrologywiki.com/sitemap.xml')).text();
  console.log('\nsitemap 含 signs-of- :', sm.includes('signs-of-a-highly-sensitive-person'));
  console.log('sitemap 含 signs-you-re- :', sm.includes('signs-you-re-a-highly-sensitive-person'));
} catch (e) { console.log('sitemap ERR', e.message); }
