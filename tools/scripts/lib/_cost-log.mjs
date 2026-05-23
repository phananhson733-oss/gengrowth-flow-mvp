// _cost-log.mjs — append rows to `cost-tracking` sheet tab.
//
// Schema (matches lib/_workbook-spec.mjs cost-tracking tab):
//   timestamp | operation | tool | page_id | tokens_in | tokens_out | tokens_total | cost_usd | api_calls | notes
//
// Design:
//   - Non-blocking: any failure (no token, no workbook, network) prints a stderr
//     line and resolves null. Cost logging must never break the main pipeline.
//   - Uses OAuth (same as gg-status.mjs / gg-monitor.mjs). Reads
//     GG_SHEETS_FLOW_MVP_WORKBOOK_ID from env.
//   - Batched append: pass multiple rows in one call for one HTTP round-trip.
//
// Usage:
//   import { logCost } from './lib/_cost-log.mjs';
//   await logCost([{
//     operation: 'llm_call',  // free-form, e.g. llm_call | mine | rag-entity
//     tool: 'gg-llm-orchestrator',
//     page_id: 'page_aura_blue',
//     tokens_in: 5000,
//     tokens_out: 1500,
//     cost_usd: 0.42,
//     api_calls: 1,
//     notes: 'claude opus-4-7 xhigh, attempt 1/2',
//   }]);

import { getAccessToken } from './_oauth-token.mjs';

const COST_TAB = 'cost-tracking';

export async function logCost(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const workbookId = process.env.GG_SHEETS_FLOW_MVP_WORKBOOK_ID;
  if (!workbookId) {
    process.stderr.write('[cost-log] skip: GG_SHEETS_FLOW_MVP_WORKBOOK_ID not set\n');
    return null;
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    process.stderr.write(`[cost-log] skip: OAuth fail (${err.message.split('\n')[0]})\n`);
    return null;
  }

  const ts = new Date().toISOString();
  const values = rows.map((r) => {
    const ti = Number(r.tokens_in || 0);
    const to = Number(r.tokens_out || 0);
    return [
      r.timestamp || ts,
      String(r.operation || ''),
      String(r.tool || ''),
      String(r.page_id || ''),
      ti,
      to,
      ti + to,
      Number((r.cost_usd || 0).toFixed(6)),
      Number(r.api_calls || 1),
      String(r.notes || ''),
    ];
  });

  const url = `https://sheets.googleapis.com/v4/spreadsheets/${workbookId}/values/${encodeURIComponent(`${COST_TAB}!A:J`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      process.stderr.write(`[cost-log] skip: HTTP ${res.status} ${body.slice(0, 200)}\n`);
      return null;
    }
    return values.length;
  } catch (err) {
    process.stderr.write(`[cost-log] skip: fetch fail (${err.message})\n`);
    return null;
  }
}
