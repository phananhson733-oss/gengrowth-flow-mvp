// One-off: targeted body fixes so PG-WLS-004 (RL5) and PG-ART-001 (SC2) pass _phase2-validate.
import { readFileSync, writeFileSync } from 'node:fs';

function rep(path, pairs) {
  let s = readFileSync(path, 'utf8');
  const log = [];
  for (const [a, b] of pairs) {
    const n = s.split(a).length - 1;
    s = s.split(a).join(b);
    log.push(`  x${n}  "${a.slice(0, 48)}..."`);
  }
  writeFileSync(path, s);
  return log;
}

const APO = String.fromCharCode(39); // '

console.log('WLS-004:');
console.log(
  rep('_staging/PG-WLS-004-claude-v8.md', [
    [
      'Free white label seo differs from in-house reporting because',
      'Free white-label reporting differs from in-house reporting because',
    ],
    [
      `The free tier you choose for free white label seo should survive a client${APO}s close read`,
      `The free tier you choose here should survive a client${APO}s close read`,
    ],
  ]).join('\n')
);

console.log('ART-001:');
const artOld =
  '- [[<TBD-internal-link: guide to white-label SEO pricing>]] — for setting retainer prices that protect margin once reporting is automated';
const artNew =
  artOld +
  '\n- [[<TBD-internal-link: local SEO audit workflow for multi-client agencies>]] — for teams layering local audits onto their tracking and reporting stack';
console.log(rep('_staging/PG-ART-001-claude-v8.md', [[artOld, artNew]]).join('\n'));

const w = readFileSync('_staging/PG-WLS-004-claude-v8.md', 'utf8');
console.log('WLS-004 exact-phrase count now:', (w.toLowerCase().match(/free white label seo/g) || []).length);
const a = readFileSync('_staging/PG-ART-001-claude-v8.md', 'utf8');
console.log('ART-001 internal-link count now:', (a.match(/TBD-internal-link/g) || []).length);
