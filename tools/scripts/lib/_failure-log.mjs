// _failure-log.mjs — append a row to `failure-log` sheet tab when a pipeline
// stage fails. Designed for retro聚类: "80% phase2 fail = RL4 → fix prompt template".
//
// Schema (matches lib/_workbook-spec.mjs failure-log tab):
//   timestamp | stage | tool | page_id | llm | tag | failed_checks | fail_reason | notes
//
// Failure-fault tolerant: any error (auth/network) prints stderr line, returns null.
// NEVER throws — the caller is already on the error path.
//
// Usage:
//   import { logFailure } from './lib/_failure-log.mjs';
//   await logFailure({
//     stage: 'phase2',         // free-form: phase2 | render | bridge | llm_call
//     tool: '_phase2-validate',
//     page_id: 'page_aura_blue',
//     llm: 'claude',
//     tag: 'claude-v8',
//     failed_checks: ['RL4', 'RL5'],
//     fail_reason: 'RL4: drifted 3 H2 sections (threshold 2)',
//     notes: 'structure pass; rl1-3 pass',
//   });

import { getAccessToken } from './_oauth-token.mjs';

const FAILURE_TAB = 'failure-log';

export async function logFailure(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const workbookId = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!workbookId) {
    process.stderr.write('[failure-log] skip: GG_SHEETS_FLOW_MVP_WORKBOOK_ID not set\n');
    return null;
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    process.stderr.write(`[failure-log] skip: OAuth fail (${err.message.split('\n')[0]})\n`);
    return null;
  }

  const ts = entry.timestamp || new Date().toISOString();
  const failedChecks = Array.isArray(entry.failed_checks)
    ? entry.failed_checks.join(',')
    : String(entry.failed_checks || '');
  const row = [
    ts,
    String(entry.stage || ''),
    String(entry.tool || ''),
    String(entry.page_id || ''),
    String(entry.llm || ''),
    String(entry.tag || ''),
    failedChecks,
    String(entry.fail_reason || ''),
    String(entry.notes || ''),
  ];

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${FAILURE_TAB}!A:I`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values: [row] }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`[failure-log] skip: HTTP ${res.status} ${body.slice(0, 200)}\n`);
      return null;
    }
    return 1;
  } catch (err) {
    process.stderr.write(`[failure-log] skip: fetch fail (${err.message})\n`);
    return null;
  }
}
