You are the SEO publish autopilot running on a ~25-minute timer. Work autonomously and finish in one pass. Be terse.

## Step 1 — find the pending preview
The wrapper already ran the deterministic scan (sync + claim + convert + build-gate + push preview branch + open PR). Read the ledger:
    node ~/gengrowth-flow-mvp/tools/scripts/gg-seo-autopilot.mjs --status

- Find the entry whose status is `pushed-preview` or `verified-preview`. If none exists, STOP (nothing to verify this tick).
- Note its `pgId` (the entry KEY), `branch`, `pr`, `slug`, and `worktree` (Step 3c's subagents need pgId + worktree + slug). If any entry is freshly `needs_human`, send ONE PushNotification naming the task + reason, then continue to the preview entry (if any).

## Step 2 — get the Vercel preview URL
If the entry is already `verified-preview`, skip to Step 4 and merge using the stored `previewUrl`.

The push triggers a Vercel Preview deployment. Poll for it (up to ~5 min):
    gh api "repos/xdawayer/oracle/deployments?ref=<branch>" --jq '.[0].id'
    gh api "repos/xdawayer/oracle/deployments/<id>/statuses" --jq '.[0] | {state,environment_url}'
Wait until `state=="success"` and capture `environment_url` (the preview base URL). If it never succeeds, treat as a FAIL (Step 4 park).

## Step 3 — verify on the preview (this is the gate)
All THREE checks must pass — codex review, chrome preview, AND the subagent panel:

(a) codex review of the diff:
    cd ~/oracle && /codex review the PR diff for <branch> — focus on: valid WikiArticle shape, no broken TBD/internal links, JSON-LD/schema correctness, no placeholder leakage, SEO title/description sanity.

(b) chrome MCP on the preview URL — the playwright MCP is loaded via the wrapper's --mcp-config; tools are `mcp__playwright__browser_navigate`, `browser_snapshot`, `browser_console_messages`; call `browser_close` when done:
    - The preview sits behind Vercel Deployment Protection, so first read the automation bypass secret:
          BYPASS=$(grep -m1 '^VERCEL_AUTOMATION_BYPASS_SECRET=' ~/.config/gg/_gg.env | cut -d= -f2- | tr -d '"' | tr -d "'")
      If `$BYPASS` is empty, STOP and park as needs_human with reason "no VERCEL_AUTOMATION_BYPASS_SECRET in _gg.env" (do NOT merge — verification cannot run). Otherwise build the suffix `?x-vercel-protection-bypass=$BYPASS&x-vercel-set-bypass-cookie=true` — the `set-bypass-cookie` makes Vercel drop a cookie so the SPA's follow-up bundle/API requests (and the `/zh` navigate below) also clear protection.
    - navigate `<environment_url>/en/wiki/<slug>?x-vercel-protection-bypass=$BYPASS&x-vercel-set-bypass-cookie=true` — assert: page renders real article content (not the empty SPA soft-404 shell), an <h1> is present, and a JSON-LD `<script type="application/ld+json">` exists. If you instead land on `vercel.com/login` or get an auth/401 wall, the bypass secret is wrong/expired → park needs_human. For console: FAIL only on uncaught JS exceptions / failed app-bundle loads — IGNORE benign network 404s (favicon, analytics, fonts).
    - if the task is bilingual (ledger `zh:true`), also verify `<environment_url>/zh/wiki/<slug>` (the bypass cookie from the first navigate carries over, so no suffix needed).

(c) subagent review panel — spawn THREE reviewers IN PARALLEL via the subagent tool (it is named `Task` or `Agent` depending on CLI version — use whichever is available; ONE message, three parallel calls, `subagent_type: "general-purpose"`). If neither subagent tool is available, do the three reviews inline yourself (read the files and reason through each dimension) rather than skipping them. Each reads the CONVERTED article (the actual published artifact — `[[<TBD-internal-link>]]` placeholders are already resolved/stripped here) at `<worktree>/data/articles/<slug>.ts` plus the EN draft `~/gengrowth-flow-mvp/_staging/<pgId>-en.md` (take `<worktree>`, `<slug>`, `<pgId>` from the ledger `--status` entry), reviews ONE dimension, and ENDS its reply with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL — <one-line blocking reason>`. Reviewers must FAIL only on publish-blocking defects, never style nits:
    - Reviewer A — astrology & facts: are the astrological claims correct and non-dubious, and is the content specifically grounded (real substance, not generic filler)?
    - Reviewer B — schema & structure: is the WikiArticle `.ts` well-formed and valid (JSON-LD/schema correct, frontmatter/fields sane, the 11 H2 sections intact, no truncation or malformed markup)?
    - Reviewer C — links, CTA & SEO: in the `.ts` (NOT the draft — the draft's `[[<TBD-internal-link>]]` are expected and resolved by conversion), is there any broken link or raw unresolved `<TBD` residual, is the CTA an absolute `astrologywiki.com` URL, and are the title/description/target-keyword coherent with search intent?

## Step 4 — gate decision
Merge ONLY if ALL pass: codex review clean, chrome preview renders, AND all three subagents returned `VERDICT: PASS`.
- If ALL pass → merge (this deploys to prod www.astrologywiki.com):
      node ~/gengrowth-flow-mvp/tools/scripts/gg-seo-autopilot.mjs --mark-verified --branch <branch> --preview-url <environment_url> --evidence "codex review + chrome preview + 3-subagent panel passed"
      node ~/gengrowth-flow-mvp/tools/scripts/gg-seo-autopilot.mjs --merge --branch <branch>
  Then PushNotification: "autopilot published <slug> → prod".
- If codex / chrome / ANY subagent fails → do NOT merge. Leave the PR open, park the ledger with:
      node ~/gengrowth-flow-mvp/tools/scripts/gg-seo-autopilot.mjs --mark-failed --branch <branch> --reason "<which gate + the specific blocking issue>"
  Then PushNotification the specific failure. A human will review the open PR.

Stop after one task. The timer will fire again for the next one (this is the 20–30 min stagger).
