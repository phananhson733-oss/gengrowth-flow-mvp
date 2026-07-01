#!/usr/bin/env node
// _gen-preprocessor-prompt.mjs — regenerate the manual ChatGPT-paste prompt
// (prompts/variable-preprocessor.md) from the SSOT module so it can never drift
// from the automated path (gg-brief-suggest.mjs imports the same module).
//
//   node tools/scripts/_gen-preprocessor-prompt.mjs           # write the .md
//   node tools/scripts/_gen-preprocessor-prompt.mjs --stdout  # print only
//
// After editing lib/preprocessor-prompt.mjs, re-run this and (if changed) copy the
// body into the ops mirror 变量预处理器-pre-processor-v2.0.md.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPreprocessorPrompt } from './lib/preprocessor-prompt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'prompts', 'variable-preprocessor.md');

const BANNER = [
  '<!--',
  '  CANONICAL SOURCE — do not hand-edit the prompt body below.',
  '  Generated from tools/scripts/lib/preprocessor-prompt.mjs (renderPreprocessorPrompt).',
  '  Regenerate with: node tools/scripts/_gen-preprocessor-prompt.mjs',
  '  The automated path (gg-brief-suggest.mjs) imports the SAME module, so this manual',
  '  ChatGPT-paste prompt and the script can never diverge again.',
  '  Ops mirror: gengrowth-ops/inbox/03-content-briefs/变量预处理器-pre-processor-v2.0.md',
  '-->',
  '',
].join('\n');

const body = renderPreprocessorPrompt({
  targetKeyword: '[insert keyword]',
  tier: 'T2',
  template: 'Definition',
  clusterContext: '[cluster topic / jtbd / content_angle, if known]',
});

const content = BANNER + body + '\n';

if (process.argv.includes('--stdout')) {
  process.stdout.write(content);
} else {
  writeFileSync(OUT, content);
  process.stderr.write(`written ${OUT}\n`);
}
