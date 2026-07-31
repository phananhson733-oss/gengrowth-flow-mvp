// gengrowth.ai 的 canonical 内容源是仓库里的 Markdown（apps/marketing/content/blog/<locale>/<slug>.md），
// 不再是 Supabase blog_posts。这组用例锁住 --emit md 的产出必须能被站点自己的 frontmatter
// 读取器 + zod schema 吃下去。
//
// 站点侧契约（nevermore: apps/marketing/src/lib/blog-content.ts）：
//   - 逐行解析 `^([A-Za-z][A-Za-z0-9]*):\s*(.*)$`，只切第一个冒号 → 值里可以有冒号
//   - unquoteFrontmatterValue 只剥一对首尾引号，**不认任何转义序列**
//   - zod .strict()：多一个未知键就整篇 build 失败
//   - localeExclusive 是字符串 "true"/"false"；publishedAt/updatedAt 是 YYYY-MM-DD
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteFrontmatterScalar, buildSiteMarkdown } from '../gg-md-to-gengrowth-blog.mjs';

// 站点解析器的等价实现 —— 用来断言"我们生成的东西它读得回来"，而不是断言字面量。
function parseLikeSite(doc) {
  assert.ok(doc.startsWith('---\n'), '必须以 frontmatter 开头');
  const end = doc.indexOf('\n---\n', 4);
  assert.ok(end !== -1, '缺少 frontmatter 结束分隔符');
  const out = {};
  for (const line of doc.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    assert.ok(m, `无法解析的 frontmatter 行: ${line}`);
    assert.ok(!Object.hasOwn(out, m[1]), `重复字段 ${m[1]}`);
    const v = m[2].trim();
    const q = v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")));
    out[m[1]] = q ? v.slice(1, -1) : v;
  }
  return { frontmatter: out, body: doc.slice(end + 5).trim() };
}

const ALLOWED = new Set(['title', 'excerpt', 'author', 'category', 'pillar', 'status',
  'publishedAt', 'updatedAt', 'heroImage', 'heroImageAlt', 'localeExclusive']);

const baseRow = {
  slug: 'demo-post', title: 'A Title', excerpt: 'An excerpt.', author: 'GenGrowth Team',
  category: 'methodology', pillar_slug: 'seo_content', status: 'published',
  published_at: '2026-06-16T08:00:00Z', updated_at: '2026-06-16T08:00:00Z',
  locale: 'en', locale_exclusive: true,
};
const baseMeta = { markdown: '## Section\n\nBody text.' };

test('emitted frontmatter round-trips through the site parser', () => {
  const doc = buildSiteMarkdown(baseRow, baseMeta);
  const { frontmatter: fm, body } = parseLikeSite(doc);
  assert.equal(fm.title, 'A Title');
  assert.equal(fm.category, 'methodology');
  assert.equal(fm.pillar, 'seo_content');          // pillar_slug -> pillar
  assert.equal(fm.publishedAt, '2026-06-16');      // ISO datetime -> 日期
  assert.equal(fm.localeExclusive, 'true');        // 字符串，不是布尔
  assert.ok(body.startsWith('## Section'));
});

test('no key outside the strict schema is ever emitted', () => {
  const { frontmatter } = parseLikeSite(buildSiteMarkdown(baseRow, baseMeta));
  for (const k of Object.keys(frontmatter)) {
    assert.ok(ALLOWED.has(k), `未知字段会让站点 build 失败: ${k}`);
  }
});

// 站点读取器不认转义。带引号/冒号的标题是编辑内容里的常态，必须原样读回来。
test('values with quotes and colons survive without escaping', () => {
  const tricky = 'SEO: the "cheap" tactics that don\'t compound';
  const doc = buildSiteMarkdown({ ...baseRow, title: tricky }, baseMeta);
  assert.equal(parseLikeSite(doc).frontmatter.title, tricky);
});

test('a value that is itself fully quoted is not silently unwrapped', () => {
  const quoted = '"Growth Automation" Explained';
  assert.equal(parseLikeSite(buildSiteMarkdown({ ...baseRow, title: quoted }, baseMeta)).frontmatter.title, quoted);
});

// 解析器是逐行的：值里混进换行会把后面的正文吞成 frontmatter 行。
test('embedded newlines are flattened, never emitted raw', () => {
  const out = siteFrontmatterScalar('line one\nline two');
  assert.ok(!out.includes('\n'));
  assert.equal(out, 'line one line two');
});

test('hero fields fall back to the asset the legacy migration used', () => {
  const { frontmatter } = parseLikeSite(buildSiteMarkdown(baseRow, baseMeta));
  assert.equal(frontmatter.heroImage, '/images/og-default.svg');
  assert.match(frontmatter.heroImageAlt, /^Cover illustration for /);
});

test('hero overrides win when real art exists', () => {
  const doc = buildSiteMarkdown(baseRow, baseMeta,
    { heroImage: '/images/blog/demo-post/hero.webp', heroImageAlt: 'A specific description.' });
  const { frontmatter } = parseLikeSite(doc);
  assert.equal(frontmatter.heroImage, '/images/blog/demo-post/hero.webp');
  assert.equal(frontmatter.heroImageAlt, 'A specific description.');
});

// 正文必须是 Markdown。站点把 legacy HTML 明确称为一次性迁移边界，新文章要 GFM。
test('body is the markdown source, not rendered HTML', () => {
  const { body } = parseLikeSite(buildSiteMarkdown(baseRow, { markdown: '## Heading\n\nA [link](/en/blog/other).' }));
  assert.match(body, /^## Heading/);
  assert.doesNotMatch(body, /<h2|<p>/);
});
