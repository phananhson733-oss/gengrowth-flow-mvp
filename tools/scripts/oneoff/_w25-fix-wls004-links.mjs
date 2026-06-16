// One-off: WLS-004 is a T3 page (SC2 internal-link ceiling = 2). It has 4 TBD
// internal-links; drop 2 (keep the pillar link L11 + the cross-cluster link L97).
import { readFileSync, writeFileSync } from 'node:fs';

const path = '_staging/PG-WLS-004-claude-v8.md';
let s = readFileSync(path, 'utf8');

const pairs = [
  // L23: unwrap the inline wikilink to plain prose
  [
    'This is the friction [[<TBD-internal-link: comparison with managed SEO services>]] tends to surface too, just at a higher price point.',
    'This is the friction managed SEO services tend to surface too, just at a higher price point.',
  ],
  // L96: remove the SEO-reseller-pricing related-reading bullet entirely
  [
    '- [[<TBD-internal-link: guide to SEO reseller pricing>]] — how markup ceilings on resold work shape what you can charge for branded reports.\n',
    '',
  ],
];

for (const [a, b] of pairs) {
  const n = s.split(a).length - 1;
  s = s.split(a).join(b);
  console.log(`x${n}  "${a.slice(0, 50)}..."`);
}
writeFileSync(path, s);
console.log('WLS-004 internal-link count now:', (s.match(/TBD-internal-link/g) || []).length);
