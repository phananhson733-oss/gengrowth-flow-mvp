# macOS Scheduler Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the wiki Notes schedule to a GUI LaunchAgent and create a single macOS launchd executor for the complete SEO Blog workflow.

**Architecture:** Notes retains its existing shell script and gains a version-controlled LaunchAgent template. SEO gains a thin LaunchAgent runner that enforces time-window and single-executor guards, then passes the existing persisted Codex Automation prompt to `codex exec`; the prompt continues to invoke the deterministic `gg-nightly-seo.sh` workflow.

**Tech Stack:** macOS launchd, Bash, plist XML, Node.js built-in test runner, Python 3 `tomllib`, Codex CLI, Codex Automation API.

## Global Constraints

- Run in `gui/501`, with `TZ=Asia/Shanghai`; do not use Unix crontab for either target workflow.
- Keep `gg-nightly-seo.sh` as the SEO business entrypoint and preserve the Automation prompt verbatim as the source of orchestration rules.
- A legacy SEO label or process is a fail-closed conflict; do not launch a second executor.
- Do not create new publish runs after 22:00 Asia/Shanghai.
- Do not store or print secrets.

---

### Task 1: Add testable source templates

**Files:**
- Create: `tools/launchd/com.gengrowth.seo-blog.plist`
- Create: `tools/scripts/gg-seo-blog-launchd-tick.sh`
- Create: `tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`
- Create: `/Users/awayer_mini/gengrowth-wiki/tools/launchd/com.gengrowth.wiki-notes-digest.plist`

**Interfaces:**
- SEO plist invokes `gg-seo-blog-launchd-tick.sh` at 18:30, 19:00, 19:30, 20:00, 20:30, 21:00, and 21:30.
- SEO runner reads `~/.codex/automations/gengrowth-seo-blog/automation.toml` using `python3` and passes the extracted `prompt` through stdin to `codex exec`.
- Notes plist invokes `weekly-notes-digest.sh` at Monday 09:07.

- [ ] **Step 1: Write failing static smoke tests**

Run: `node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: FAIL because the runner and plist template do not exist.

- [ ] **Step 2: Implement minimal templates and runner**

The runner must use a `/tmp/gg-seo-blog-launchd.lock` directory, reject out-of-window starts unless `GG_SEO_LAUNCHD_ALLOW_OUTSIDE_WINDOW=1`, reject loaded legacy labels/processes, and execute:

```bash
python3 - "$AUTOMATION" <<'PY' | "$CODEX_BIN" exec \
  --sandbox danger-full-access \
  --ask-for-approval never \
  -C "$FLOW" \
  --add-dir "$HOME/gengrowth-ops" \
  --add-dir "$HOME/oracle-autopilot" \
  -
import sys, tomllib
with open(sys.argv[1], 'rb') as f:
    print(tomllib.load(f)['prompt'])
PY
```

- [ ] **Step 3: Verify static contracts**

Run: `bash -n tools/scripts/gg-seo-blog-launchd-tick.sh && plutil -lint tools/launchd/com.gengrowth.seo-blog.plist && node --test tools/scripts/__tests__/gg-seo-blog-launchd-tick.smoke.test.mjs`

Expected: all commands exit `0`.

### Task 2: Deploy and migrate the Notes schedule

**Files:**
- Deploy: `/Users/awayer_mini/Library/LaunchAgents/com.gengrowth.wiki-notes-digest.plist`
- Modify: current user crontab via `crontab -`

**Interfaces:**
- The deployed plist is a byte-for-byte copy of the wiki source template.
- The crontab filter removes only the `weekly-notes-digest.sh` invocation and its explanatory comment.

- [ ] **Step 1: Validate Notes plist before deployment**

Run: `plutil -lint /Users/awayer_mini/gengrowth-wiki/tools/launchd/com.gengrowth.wiki-notes-digest.plist`

Expected: `OK`.

- [ ] **Step 2: Deploy, bootstrap, and remove the old crontab entry**

Run: copy the validated plist into `~/Library/LaunchAgents/`, bootstrap it in `gui/501`, then replace the crontab with the filtered result after verifying the exact before/after diff.

- [ ] **Step 3: Trigger and verify one Notes run**

Run: `launchctl kickstart -k gui/501/com.gengrowth.wiki-notes-digest`, then inspect `launchctl print`, the latest `~/Library/Logs/wiki-notes-digest/*.log`, and `crontab -l`.

Expected: service is loaded; crontab has no Notes entry; a fresh run log is created and remains observable until completion.

### Task 3: Activate the single SEO executor and disable duplicates

**Files:**
- Deploy: `/Users/awayer_mini/Library/LaunchAgents/com.gengrowth.seo-blog.plist`
- Update via API: Codex Automation `gengrowth-seo-blog`

**Interfaces:**
- The Codex Automation remains stored with the same prompt, model, project, and environment, but becomes inactive so its scheduler cannot overlap launchd.
- The new label is the only loaded SEO scheduler label.

- [ ] **Step 1: Confirm credentials and preflight**

Run: `codex login status`, `claude auth status --json`, and the runner with an intentionally out-of-window invocation.

Expected: both CLIs report authenticated; runner exits `0` with an explicit out-of-window skip and does not invoke Codex.

- [ ] **Step 2: Disable legacy execution paths**

Run: `launchctl disable gui/501/<label>` and `launchctl bootout gui/501/<label>` for each legacy label, treating “no such service” as the expected unloaded state.

- [ ] **Step 3: Pause the Codex scheduler using the official Automation API**

Expected: the persisted automation retains its prompt and reports a non-active status on readback.

- [ ] **Step 4: Deploy and bootstrap the new SEO LaunchAgent**

Run: copy the validated template to `~/Library/LaunchAgents/`, bootstrap `gui/501/com.gengrowth.seo-blog`, and inspect `launchctl print`.

Expected: loaded service, no `RunAtLoad`, and no legacy label loaded.

### Task 4: Final operational verification

**Files:**
- Verify: `~/Library/Logs/gg-seo-blog-launchd.out.log`
- Verify: `~/Library/Logs/gg-nightly-seo.log`
- Verify: `~/Library/Logs/wiki-notes-digest/`

- [ ] **Step 1: Run syntax, plist, and smoke tests again**

Run: the Task 1 verification command plus `plutil -lint` on both deployed plists.

Expected: all checks pass.

- [ ] **Step 2: Verify scheduler ownership**

Run: inspect `crontab -l`, `launchctl print-disabled gui/501`, and `launchctl print gui/501/<label>` for the Notes, SEO, and legacy labels.

Expected: Notes has no crontab entry; Notes and new SEO labels are loaded; all legacy SEO labels are disabled and unloaded; Codex SEO automation is inactive.

- [ ] **Step 3: Record terminal state**

Append only the final deployment state, real run status, and any remaining authentication or workflow blocker to the daily record; verify the new block is at true EOF.
