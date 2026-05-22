// _call-hermes.mjs — 3rd LLM generation via OpenRouter (Nous Hermes default).
//
// Pairs with v8 paste-test workflow:
//   1. node tools/scripts/_render-<entity>-v8-test.mjs   (writes prompt + fixture)
//   2. node tools/scripts/_call-hermes.mjs \
//        --prompt .gg-cache/prompts/page_<entity>.v8-prompt.md \
//        --output _staging/page_<entity>-hermes-v8.md
//   3. node tools/scripts/_phase2-validate.mjs \
//        --source _staging/page_<entity>-hermes-v8.md \
//        --tag hermes-v8 --page-id page_<entity> \
//        --llm_source hermes-3-405b --prompt_version v8
//
// Auth: requires OPENROUTER_API_KEY in env or in ~/.config/gg/_gg.env.
//   export OPENROUTER_API_KEY=sk-or-v1-...
// or in ~/.config/gg/_gg.env:
//   OPENROUTER_API_KEY=sk-or-v1-...
//
// Default model: nousresearch/hermes-3-llama-3.1-405b — override with --model.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function loadEnvFile(path) {
  // Minimal KEY=VALUE parser. Quoted values stripped.
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (!args.prompt) {
  process.stderr.write('usage: _call-hermes.mjs --prompt <path> [--output <path>] [--model <id>] [--max-tokens 8000]\n');
  process.exit(2);
}

const promptPath = args.prompt;
const outputPath = args.output;
const model = args.model || 'nousresearch/hermes-3-llama-3.1-405b';
const maxTokens = Number.parseInt(args.max_tokens, 10) || 8000;
const temperature = Number.parseFloat(args.temperature) || 0.7;

const envFile = loadEnvFile(join(homedir(), '.config', 'gg', '_gg.env'));
const apiKey = process.env.OPENROUTER_API_KEY || envFile.OPENROUTER_API_KEY;

if (!apiKey) {
  process.stderr.write(`[hermes] OPENROUTER_API_KEY not set.

Setup:
  1. Sign up at https://openrouter.ai (free tier covers Nous Hermes)
  2. Mint a key in Account → Keys
  3. Add to env, either:
     export OPENROUTER_API_KEY=sk-or-v1-...
     # OR persist to ~/.config/gg/_gg.env:
     echo 'OPENROUTER_API_KEY=sk-or-v1-...' >> ~/.config/gg/_gg.env
     chmod 600 ~/.config/gg/_gg.env
  4. Re-run this script.

Free models to try: nousresearch/hermes-3-llama-3.1-405b (default),
nousresearch/hermes-3-llama-3.1-70b, nousresearch/hermes-3-llama-3.1-8b
`);
  process.exit(2);
}

if (!existsSync(promptPath)) {
  process.stderr.write(`[hermes] prompt file not found: ${promptPath}\n`);
  process.exit(2);
}

const prompt = readFileSync(promptPath, 'utf8');
process.stderr.write(`[hermes] model=${model} prompt=${promptPath} (${prompt.length} chars)\n`);

const body = {
  model,
  messages: [
    {
      role: 'system',
      content:
        'You are a senior English SEO content writer for astrologywiki.com. Follow the user prompt exactly. Output the full markdown article in one shot, starting at "# " and ending at the CTA URL. No preamble, no meta commentary, no follow-up offers.',
    },
    { role: 'user', content: prompt },
  ],
  max_tokens: maxTokens,
  temperature,
};

const t0 = Date.now();
let resp;
try {
  resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/gengrowth/gengrowth-flow-mvp',
      'X-Title': 'gengrowth-flow-mvp v8 paste-test',
    },
    body: JSON.stringify(body),
  });
} catch (err) {
  process.stderr.write(`[hermes] fetch failed: ${err.message}\n`);
  process.exit(1);
}

if (!resp.ok) {
  const errText = await resp.text();
  process.stderr.write(`[hermes] HTTP ${resp.status}: ${errText.slice(0, 500)}\n`);
  process.exit(1);
}

const json = await resp.json();
const content = json?.choices?.[0]?.message?.content;
if (!content) {
  process.stderr.write(`[hermes] empty content in response: ${JSON.stringify(json).slice(0, 500)}\n`);
  process.exit(1);
}

const usage = json.usage || {};
const dt = ((Date.now() - t0) / 1000).toFixed(1);
process.stderr.write(
  `[hermes] OK in ${dt}s — prompt_tokens=${usage.prompt_tokens ?? '?'} completion_tokens=${usage.completion_tokens ?? '?'} total=${usage.total_tokens ?? '?'}\n`,
);

if (outputPath) {
  writeFileSync(outputPath, content);
  process.stderr.write(`[hermes] wrote ${outputPath} (${content.length} chars)\n`);
} else {
  process.stdout.write(content);
}
