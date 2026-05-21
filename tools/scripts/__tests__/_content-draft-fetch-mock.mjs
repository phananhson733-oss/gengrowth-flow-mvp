// Test helper: install a global fetch mock that responds to Google Sheets URLs
// using fixture rows loaded from GG_TEST_FIXTURES (JSON path).
//
// Loaded into the spawned gg-content-draft.mjs via:
//   --import ./tools/scripts/__tests__/_content-draft-fetch-mock.mjs
//
// Fixture JSON shape:
//   {
//     "page_rows":   [[col0, col1, ...], ...],
//     "cluster_rows":[[...], ...],
//     "cta_rows":    [[...], ...],
//     "status_writes":[]   // mock collects PUTs here
//   }
//
// Fixture path comes from env GG_TEST_FIXTURES (absolute).
// Mock writes captured state back to GG_TEST_FIXTURES on every PUT/append.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const FIXTURE_PATH = process.env.GG_TEST_FIXTURES;

function loadFixtures() {
  if (!FIXTURE_PATH || !existsSync(FIXTURE_PATH)) return { page_rows: [], cluster_rows: [], cta_rows: [], status_writes: [], runs_writes: [] };
  return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
}

function saveFixtures(state) {
  if (!FIXTURE_PATH) return;
  writeFileSync(FIXTURE_PATH, JSON.stringify(state, null, 2));
}

const originalFetch = globalThis.fetch;

globalThis.fetch = async (urlObj, init = {}) => {
  const url = typeof urlObj === 'string' ? urlObj : urlObj.toString();
  const state = loadFixtures();

  // Sheet read: GET /spreadsheets/{id}/values/{range}
  const readMatch = url.match(/\/spreadsheets\/[^/]+\/values\/([^?]+)\?/);
  if (readMatch && (!init.method || init.method === 'GET')) {
    const range = decodeURIComponent(readMatch[1]);
    let values = [];
    if (range.startsWith('选题登记表')) values = state.page_rows;
    else if (range.startsWith('主题集群表')) values = state.cluster_rows;
    else if (range.startsWith('CTA Map')) values = state.cta_rows;
    return new Response(JSON.stringify({ range, majorDimension: 'ROWS', values }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // Sheet write: PUT /spreadsheets/{id}/values/{range}
  if (url.includes('/values/') && init.method === 'PUT') {
    const body = JSON.parse(init.body);
    state.status_writes = state.status_writes || [];
    state.status_writes.push({ range: body.range, values: body.values });
    saveFixtures(state);
    return new Response(JSON.stringify({ updatedCells: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // Append: POST /spreadsheets/{id}/values/runs!A:G:append?...
  if (url.includes(':append') && init.method === 'POST') {
    const body = JSON.parse(init.body);
    state.runs_writes = state.runs_writes || [];
    state.runs_writes.push({ url, values: body.values });
    saveFixtures(state);
    return new Response(JSON.stringify({ updates: { updatedRows: 1 } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // OAuth token (we should not hit this in tests because GG_SKIP_AUTH=1).
  if (url.includes('oauth2.googleapis.com')) {
    return new Response(JSON.stringify({ access_token: 'fake', token_type: 'Bearer' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }

  // Fall through to real fetch (should not happen in tests).
  if (originalFetch) return originalFetch(urlObj, init);
  throw new Error(`unmocked fetch: ${url}`);
};
