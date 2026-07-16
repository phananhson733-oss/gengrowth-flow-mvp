# Recap Performance Full Service Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove personal Google OAuth from the unattended recap-performance production path by using the existing reader SA for GSC/GA4 and the existing writer SA for Sheets.

**Architecture:** Extend the SA helpers already owned by `gg-index-monitor.mjs` with a combined read-only reporting token. `gg-recap-performance.mjs` consumes that helper and fails closed when the reader SA is missing or lacks GSC/GA4 access. The wrapper remains the only production entrypoint and its failure copy names the exact SA permission boundary.

**Tech Stack:** Node.js ESM, built-in `node:test`, Google OAuth 2.0 service-account JWT flow, Google Search Console API, Google Analytics Data API, Bash wrapper.

## Global Constraints

- GSC/GA4 reporting uses `GG_READER_SA_JSON` or `~/.config/gg/gg-reader-sa.json`; no personal OAuth fallback.
- Sheets continues to use `GG_WRITER_SA_JSON` or `~/.config/gg/gg-writer-sa.json`.
- Reporting scopes are exactly `webmasters.readonly` and `analytics.readonly`.
- Add no new environment variables, credentials, schedulers, core tools, or dependencies.
- Preserve D14/D30/D60 selection, Sheet writes, report generation, and success notification behavior.
- Do not publish, deploy, request indexing, or call the Google Indexing API.
- Live production reruns use only `bash tools/scripts/gg-recap-performance-tick.sh`.

---

## File Map

- Modify `tools/scripts/gg-index-monitor.mjs`: own the combined reader-SA reporting token helper beside the existing GSC and Sheets SA helpers.
- Modify `tools/scripts/gg-recap-performance.mjs`: replace explicit personal OAuth with the reporting SA helper.
- Modify `tools/scripts/gg-recap-performance-tick.sh`: make failure guidance describe reader/writer SA permissions.
- Modify `tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs`: prove reader SA path and exact reporting scopes.
- Modify `tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs`: prove recap requests a reporting token with no personal OAuth options and preserves the wrapper contract.

### Task 1: Lock the reader-SA reporting token contract

**Files:**
- Modify: `tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs`
- Modify: `tools/scripts/gg-index-monitor.mjs:170-230`

**Interfaces:**
- Consumes: `getSaAccessToken(saPath: string, scopes: string[])` from `tools/scripts/lib/gg-shared.mjs`.
- Produces: `getReportingAccessToken(options?) -> Promise<string>` using the reader SA and both GSC/GA4 read-only scopes.

- [ ] **Step 1: Write the failing token-helper test**

Add a namespace import so the test can fail on an assertion instead of failing module loading when the export does not yet exist:

```js
import * as indexMonitorModule from '../gg-index-monitor.mjs';
```

Add this test next to `preflightGscAccess` tests:

```js
test('getReportingAccessToken uses reader SA with GSC and GA4 readonly scopes', async () => {
  assert.equal(typeof indexMonitorModule.getReportingAccessToken, 'function');
  let seen = null;
  const token = await indexMonitorModule.getReportingAccessToken({
    env: { GG_READER_SA_JSON: '/tmp/reader-sa.json' },
    home: '/tmp/home',
    tokenProvider: async (saPath, scopes) => {
      seen = { saPath, scopes };
      return { token: 'reporting-sa-token' };
    },
  });

  assert.equal(token, 'reporting-sa-token');
  assert.deepEqual(seen, {
    saPath: '/tmp/reader-sa.json',
    scopes: [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test --test-name-pattern='getReportingAccessToken uses reader SA' tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs
```

Expected: FAIL because `getReportingAccessToken` is `undefined`.

- [ ] **Step 3: Implement the minimal reporting token helper**

In `gg-index-monitor.mjs`, add the GA4 scope beside the GSC scopes:

```js
const GA4_READONLY_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
```

Make the existing reader path resolver accept explicit inputs without changing its default behavior:

```js
function readerSaPath(env = process.env, home = homedir()) {
  return env.GG_READER_SA_JSON || join(home, '.config', 'gg', 'gg-reader-sa.json');
}
```

Add the helper beside `getGscAccessToken()`:

```js
export async function getReportingAccessToken({
  env = process.env,
  home = homedir(),
  tokenProvider = getSaAccessToken,
} = {}) {
  const { token } = await tokenProvider(
    readerSaPath(env, home),
    [GSC_READONLY_SCOPE, GA4_READONLY_SCOPE],
  );
  return token;
}
```

- [ ] **Step 4: Run focused and file-level tests and verify GREEN**

Run:

```bash
node --test --test-name-pattern='getReportingAccessToken uses reader SA' tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs
node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs
```

Expected: focused test PASS; full file exits `0` with zero failures.

### Task 2: Move recap production auth from personal OAuth to reader SA

**Files:**
- Modify: `tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs`
- Modify: `tools/scripts/gg-recap-performance.mjs:9-21,789-806`

**Interfaces:**
- Consumes: `getReportingAccessToken() -> Promise<string>` from Task 1.
- Produces: `runRecapPerformance()` defaults to reader SA for GSC/GA4 while preserving `deps.getAnalyticsToken` injection.

- [ ] **Step 1: Write failing recap auth tests**

Add this behavioral test before the existing end-to-end recap test:

```js
test('runRecapPerformance requests a reporting token without personal OAuth options', async () => {
  let tokenArgs = null;
  const code = await runRecapPerformance(['--workbook', 'wb-test'], {
    sheetToken: 'sheet-token',
    getAnalyticsToken: async (...args) => {
      tokenArgs = args;
      return 'reporting-sa-token';
    },
    readTrackingRows: async () => [],
    readRecapRows: async () => [],
  });

  assert.equal(code, 0);
  assert.deepEqual(tokenArgs, []);
});
```

Add this architectural invariant:

```js
test('recap production source has no personal OAuth dependency', () => {
  const source = readFileSync(join(SCRIPTS, 'gg-recap-performance.mjs'), 'utf8');
  assert.doesNotMatch(source, /_oauth-token\.mjs|getUserAccessToken|\{\s*user:\s*true\s*\}/);
  assert.match(source, /getReportingAccessToken/);
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
node --test --test-name-pattern='reporting token without personal OAuth|no personal OAuth dependency' tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
```

Expected: both tests FAIL because the current source imports `_oauth-token.mjs` and passes `{ user: true }`.

- [ ] **Step 3: Implement the minimal recap auth change**

Remove:

```js
import { getAccessToken as getUserAccessToken } from './lib/_oauth-token.mjs';
```

Add `getReportingAccessToken` to the existing `gg-index-monitor.mjs` import list:

```js
  getReportingAccessToken,
  getSheetAccessToken,
```

Replace the token block with:

```js
  let analyticsToken = deps.analyticsToken;
  if (!analyticsToken) {
    try {
      analyticsToken = await (deps.getAnalyticsToken || getReportingAccessToken)();
    } catch (e) {
      process.stderr.write(`error: cannot mint GSC/GA4 reader SA token — ${e.message}\n`);
      return 1;
    }
  }
```

- [ ] **Step 4: Run recap and index-monitor tests and verify GREEN**

Run:

```bash
node --test tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs
```

Expected: both files exit `0` with zero failures.

### Task 3: Correct recap failure guidance

**Files:**
- Modify: `tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs`
- Modify: `tools/scripts/gg-recap-performance-tick.sh:128-139`

**Interfaces:**
- Consumes: existing `index_tick_fail` notification event.
- Produces: accurate one-line remediation text for reader/writer SA permissions.

- [ ] **Step 1: Write the failing wrapper-contract assertions**

In the existing `daily wrapper loops products` test, add:

```js
  assert.match(wrapper, /GSC reader SA Full user、GA4 reader SA Viewer、Sheets writer SA 与 workbook/);
  assert.doesNotMatch(wrapper, /GSC\/GA4 OAuth/);
```

- [ ] **Step 2: Run the wrapper test and verify RED**

Run:

```bash
node --test --test-name-pattern='daily wrapper loops products' tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
```

Expected: FAIL because the wrapper still says `GSC/GA4 OAuth`.

- [ ] **Step 3: Update the failure hint**

Replace the generic hint in `gg-recap-performance-tick.sh` with:

```bash
--hint "请检查 GSC reader SA Full user、GA4 reader SA Viewer、Sheets writer SA 与 workbook 配置。"
```

- [ ] **Step 4: Run tests and shell syntax verification**

Run:

```bash
node --test tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
bash -n tools/scripts/gg-recap-performance-tick.sh
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 5: Commit the code and regression tests**

```bash
git add tools/scripts/gg-index-monitor.mjs \
  tools/scripts/gg-recap-performance.mjs \
  tools/scripts/gg-recap-performance-tick.sh \
  tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs \
  tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
git commit -m "fix: use reader SA for recap reporting"
```

### Task 4: Grant the reader SA GA4 Viewer and prove live API access

**Files:**
- External state only: GA4 `properties/524765570` Property Access Management.
- Read: `~/.config/gg/gg-reader-sa.json`
- Read: `~/.config/gg/gg-writer-sa.json`

**Interfaces:**
- Consumes: `gg-reader-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com`.
- Produces: GSC and GA4 read access for the combined reporting token; no repository change.

- [ ] **Step 1: Add the least-privilege GA4 role**

In Google Analytics, open Admin -> Property Access Management for property `524765570`. Add:

```text
gg-reader-sa@aqueous-sandbox-496915-i1.iam.gserviceaccount.com
Role: Viewer
```

Do not grant Editor, Administrator, or user-management permission.

- [ ] **Step 2: Run the live combined-token probe**

Run this read-only probe; it loads the local environment without printing credentials and prints only pass markers:

```bash
set -a
. "$HOME/.config/gg/_gg.env"
set +a
node --input-type=module <<'NODE'
import { getReportingAccessToken } from './tools/scripts/gg-index-monitor.mjs';
import { gFetch } from './tools/scripts/lib/gg-shared.mjs';

const token = await getReportingAccessToken();
const endDate = new Date().toISOString().slice(0, 10);
const startDate = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
for (const [label, site] of [
  ['GSC_ASTROLOGY', 'sc-domain:astrologywiki.com'],
  ['GSC_GENGROWTH', 'sc-domain:gengrowth.ai'],
]) {
  await gFetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    token,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['date'], rowLimit: 1 }),
    },
  );
  console.log(`${label}=PASS`);
}

const property = process.env.GG_GA4_PROPERTY_ID || '524765570';
await gFetch(
  `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`,
  token,
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      limit: 1,
    }),
  },
);
console.log('GA4=PASS');
NODE
```

Expected: all three PASS and exit `0`.

- [ ] **Step 3: Recheck writer SA against both workbooks**

Run `verify-gcp.mjs` twice and require the writer-pass line from each selected workbook:

```bash
set -a
. "$HOME/.config/gg/_gg.env"
set +a

astro_out=$(
  GG_SHEETS_FLOW_MVP_WORKBOOK_ID="${GG_SHEETS_ASTROLOGY_WORKBOOK_ID:-$GG_SHEETS_FLOW_MVP_WORKBOOK_ID}" \
  GG_GSC_SITE="${GG_GSC_ASTROLOGY_SITE:-sc-domain:astrologywiki.com}" \
  GG_GA4_PROPERTY_ID="${GG_GA4_ASTROLOGY_PROPERTY#properties/}" \
  node tools/scripts/verify-gcp.mjs 2>&1 || true
)
printf '%s\n' "$astro_out" | rg '^✅ 2/4 Sheets writer SA can write workbook'

gengrowth_out=$(
  GG_SHEETS_FLOW_MVP_WORKBOOK_ID="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}" \
  GG_SHEETS_WORKBOOK_ID="${GG_SHEETS_GENGROWTH_WORKBOOK_ID:-$GG_SHEETS_WORKBOOK_ID}" \
  GG_GSC_SITE="${GG_GSC_GENGROWTH_SITE:-sc-domain:gengrowth.ai}" \
  GG_GA4_PROPERTY_ID="${GG_GA4_GENGROWTH_PROPERTY#properties/}" \
  node tools/scripts/verify-gcp.mjs 2>&1 || true
)
printf '%s\n' "$gengrowth_out" | rg '^✅ 2/4 Sheets writer SA can write workbook'
```

Expected: both writer probes PASS. The probe writes the original `README!A1` value back unchanged.

### Task 5: Full verification and production wrapper rerun

**Files:**
- Read: `docs/superpowers/specs/2026-07-16-recap-performance-service-account-design.md`
- Read: `/Users/awayer_mini/gengrowth-agents/cron-sync/recap_performance/2026-07-16.log`

**Interfaces:**
- Consumes: code from Tasks 1-3 and external permission from Task 4.
- Produces: fresh automated and live evidence for every acceptance criterion.

- [ ] **Step 1: Run focused and complete automated verification**

```bash
node --test tools/scripts/__tests__/gg-recap-performance.smoke.test.mjs
node --test tools/scripts/__tests__/gg-index-monitor.smoke.test.mjs
node --test tools/scripts/__tests__/*.test.mjs
bash -n tools/scripts/gg-recap-performance-tick.sh
git diff --check
```

Expected: every command exits `0`, with zero test failures.

- [ ] **Step 2: Prove the production path no longer references personal OAuth**

```bash
rg -n "_oauth-token|GG_OAUTH_|getUserAccessToken|user:\s*true" \
  tools/scripts/gg-recap-performance.mjs \
  tools/scripts/gg-recap-performance-tick.sh
```

Expected: no matches and `rg` exit `1`.

- [ ] **Step 3: Run the deterministic production wrapper once**

Record the current byte count of the dated log, then run:

```bash
bash tools/scripts/gg-recap-performance-tick.sh
```

Expected: exit `0`. Do not invoke the underlying Node script manually as a substitute.

- [ ] **Step 4: Isolate and inspect the exact new log window**

Read only bytes appended after the saved offset. Confirm:

- both `product=astrologywiki` and `product=gengrowth` appear;
- neither personal OAuth nor `PERMISSION_DENIED` appears;
- the segment ends with `recap performance ok`;
- the notification result is reported only as visible in the log.

- [ ] **Step 5: Audit every specification requirement**

Re-read the design spec and map each numbered acceptance criterion to current evidence: source grep, targeted tests, full suite, live GSC/GA4 probe, writer workbook probes, and exact wrapper log window. Any missing or indirect evidence remains incomplete.

- [ ] **Step 6: Record final repository state**

```bash
git status --short --branch
git log -3 --oneline
```

Expected: only known unrelated user/concurrent files remain; implementation files are committed and no unmerged paths exist.
