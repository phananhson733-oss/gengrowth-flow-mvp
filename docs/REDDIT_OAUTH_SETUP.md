# Reddit OAuth Setup — Stage 10 (rag-friction)

This is a **one-time, ~5-minute** setup. Once configured, `gg-friction-mine.mjs`
will scrape real subreddit posts via `oauth.reddit.com` instead of falling back
to the SYNTH placeholder (`TODO: scrubbed quote`) that degrades Stage 13 quality.

> Pipeline stage reference: `docs/PIPELINE.md` §阶段 10 — rag-friction.
>
> Without OAuth: phase2 RL3 / quality drops because friction quotes are SYNTH.
> With OAuth: real user-voice friction → 4 RL passes consistently.

---

## Step 1 — Register a Reddit script app

1. Sign in to Reddit (any account is fine; a dedicated `gg-bot` account is cleanest).
2. Go to <https://www.reddit.com/prefs/apps>.
3. Click **"are you a developer? create an app..."** at the bottom.
4. Fill in:
   - **name**: `gengrowth-friction-mine`
   - **type**: select **script**
   - **description**: (optional) `Friction theme mining for gengrowth-wiki Stage 10`
   - **about url**: (blank is OK)
   - **redirect uri**: `http://localhost:8080` (required field, unused for script apps)
5. Click **create app**.

## Step 2 — Copy the credentials

After creating the app you'll see a box with two values:

- **14-character ID** — printed right under the app name (small grey text, _not_ the secret).
- **secret** — labeled `secret`, click "edit" if hidden.

Keep both visible — you'll paste them in Step 3.

## Step 3 — Add credentials to `~/.config/gg/_gg.env`

Open (or create) the env file:

```sh
mkdir -p ~/.config/gg
$EDITOR ~/.config/gg/_gg.env
```

Append these 3 lines:

```sh
GG_REDDIT_CLIENT_ID=<paste the 14-char ID>
GG_REDDIT_CLIENT_SECRET=<paste the secret>
GG_REDDIT_USER_AGENT=gengrowth-friction-mine/0.1 (by /u/<your-reddit-username>)
```

The `GG_REDDIT_USER_AGENT` value is descriptive only, but Reddit's API guidelines
require a unique, identifying UA string. Including your username is best practice.

Lock the file down (POSIX only):

```sh
chmod 600 ~/.config/gg/_gg.env
```

## Step 4 — Verify with `--check-oauth`

```sh
node tools/scripts/gg-friction-mine.mjs --check-oauth
```

Expected on success:

```
✅ Reddit OAuth working — token fetch succeeded.
   Stage 10 friction-mine will use oauth.reddit.com (no SYNTH placeholder).
```

If you see `❌ Reddit OAuth not configured` or `Reddit OAuth rejected (401)`:
- Re-read Steps 1–3 — typos in ID/secret are the #1 cause.
- Confirm the app type is **script** at <https://www.reddit.com/prefs/apps>.
- Try regenerating the secret (Reddit UI: edit app → click the small refresh icon next to `secret`).

## Step 5 — Run a real Phase 1 scrape

```sh
node tools/scripts/gg-friction-mine.mjs --entity "saturn return"
```

Look for `mode=oauth` in the success line:

```
✅ reddit pain scrape — 23 posts (pain-filtered, mode=oauth)
```

If it says `mode=anon` instead, OAuth credentials were detected but the token
fetch failed and the script fell back to the legacy anonymous scraper. The
warning line right before it will show why; re-run `--check-oauth` to debug.

---

## Notes

- **Grant type**: `client_credentials` (app-only token). This works for all
  public read endpoints we use (`/r/<sub>/search`). The library also supports
  `password` grant if you additionally set `GG_REDDIT_USERNAME` +
  `GG_REDDIT_PASSWORD`, but it's not needed for friction-mine.
- **Rate limiting**: The library throttles to 1 req/sec process-wide and does
  exponential backoff (2s → 4s → 8s) on 429. Reddit's OAuth quota is 100/min,
  so this is conservative on purpose.
- **PII scrubbing**: Reddit usernames are replaced with `[redacted]` before
  posts are persisted; `scrubPII` from `gg-shared.mjs` also strips emails,
  phones, and `@handle`s from post titles, bodies, and comments.
- **Subreddit allowlist**: Defaults to `AskAstrologers, astrology, Spiritual,
  spirituality`. Override with `--subreddits a,b,c`. Each name must match
  `^[A-Za-z0-9_]{2,21}$` (Reddit's official naming rule).
- **Secrets handling**: `_gg.env` is `chmod 600` and never committed
  (`.gitignore` covers `*_gg.env*`).
