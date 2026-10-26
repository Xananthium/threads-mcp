# threads-mcp

[![npm](https://img.shields.io/npm/v/@bintangtimurlangit/threads-mcp?style=flat-square)](https://www.npmjs.com/package/@bintangtimurlangit/threads-mcp)
[![license](https://img.shields.io/github/license/bintangtimurlangit/threads-mcp?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/bintangtimurlangit/threads-mcp/ci.yml?branch=main&style=flat-square)](https://github.com/bintangtimurlangit/threads-mcp/actions)
[![GitHub Repo](https://img.shields.io/badge/GitHub-threads--mcp-24292f?style=flat-square&logo=github)](https://github.com/bintangtimurlangit/threads-mcp)

An MCP server for **Meta's Threads** that acts as _your own account_ — read profiles, posts, replies, your timeline & search, and post / reply / quote / like / repost / follow / schedule — from any MCP client (Claude Desktop, Claude Code, etc.).

> **No developer account.** Unlike the official [Threads Graph API](https://developers.facebook.com/docs/threads) approach (which needs an app, OAuth, and an Instagram Business account), this server drives a **real logged-in browser session** using your own cookies.

**Contents:** [Rate limits](#️-behave-for-rate-limits) · [Tools](#tools) · [Structured output](#structured-output) · [Media](#media) · [Scheduling](#scheduling) · [Setup](#setup) · [Run as a daemon](#running-as-a-persistent-daemon) · [Config](#configuration) · [How it works](#how-it-works) · [When things break](#when-things-break) · [Troubleshooting](#troubleshooting)

**Full reference:** [Documentation](./docs/README.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Versioning & releases:** [docs/RELEASES.md](./docs/RELEASES.md)

---

## ⚠️ Behave for rate limits

You are automating a **real Threads account**. Meta rate-limits aggressively and can **restrict or ban** accounts that behave like bots — bursty posting, rapid follow/unfollow, like loops. This server helps, but the discipline is on you:

- Writes are **spaced ≥ `THREADS_MIN_ACTION_INTERVAL_MS` (default 8s) apart**, enforced server-side.
- Treat `create_thread`, `follow_user`, `like_thread` as **scarce actions**, not loops.
- If you hit a `🐢 rate-limited` message, **stop for several minutes** — don't retry immediately.
- Reads are cheaper but still hit a real session; results are cached briefly.

---

## Tools

**24 tools.** Posts are identified by a full `url` **or** `handle` + `code` (the shortcode in `.../@user/post/CODE`).

### Read

| Tool                 | What it returns                                                                           |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `whoami`             | Which account you're signed in as (handle, user id, name, follower/following).            |
| `get_profile`        | A user's bio, follower count, verified status + recent posts. Omit `handle` for your own. |
| `get_user_threads`   | A user's recent posts (their profile feed).                                               |
| `get_thread`         | A single post with its like/reply/repost counts.                                          |
| `get_thread_replies` | Replies under a post.                                                                     |
| `get_timeline`       | Your "For you" home feed.                                                                 |
| `search`             | Search Threads for `posts` or `users`.                                                    |
| `get_followers`      | A partial sample of a user's followers.                                                   |
| `get_following`      | A partial sample of who a user follows.                                                   |
| `get_notifications`  | Your Activity feed — follows, replies, mentions, suggestions. Filterable by `kind`.       |

### Write &nbsp;(rate-limited — real account)

| Tool                                          | Action                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `create_thread`                               | Post a new thread — text and/or media, optionally a multi-post `chain`. |
| `reply_to_thread`                             | Reply to a post — text and/or media.                                    |
| `durable_create_thread`                       | Send one text post with an idempotency key and saved receipt.           |
| `durable_reply_to_thread`                     | Reply once to an exact post URL with a saved receipt.                   |
| `get_durable_send` / `reconcile_durable_send` | Inspect or confirm a prior durable send.                                |
| `quote_thread`                                | Quote-post (repost with your own comment + optional media).             |
| `delete_thread`                               | Delete one of your own posts (permanent).                               |
| `like_thread` / `unlike_thread`               | Like / remove a like.                                                   |
| `repost_thread` / `unrepost_thread`           | Repost / remove a repost.                                               |
| `follow_user` / `unfollow_user`               | Follow / unfollow a user.                                               |

### Schedule

| Tool               | Action                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `schedule_thread`  | Queue a text/media post to publish later (`at` ISO time or `in` duration). |
| `list_scheduled`   | List scheduled posts and their status.                                     |
| `cancel_scheduled` | Cancel a pending scheduled post by id.                                     |

> **Note:** reposting your _own_ post is a no-op on Threads (it silently does nothing) — that's Threads' behavior, not a bug.

### Durable text sends

The `durable_*` tools accept a stable `idempotencyKey` chosen for one intended
message. The server saves the account, target, and exact text before opening the
composer, then records an attempted send on disk immediately before the submit
gesture. Repeating the same key returns its saved receipt or checks the existing
attempt. It never makes a second submit after an attempt with an unknown outcome.

```json
{ "text": "One complete thought.", "idempotencyKey": "launch-2026-10-26-01" }
```

`durable_reply_to_thread` also needs `targetUrl`, for example
`https://www.threads.com/@someone/post/ABC123`. Results report `published`
with a provider ID and permalink, `uncertain` when the receipt is still missing,
or `failed_before_send` when the browser stopped before the submit gesture.
`reconcile_durable_send` takes the same key and only reads provider evidence.
The record remains available through `get_durable_send` after a restart. A key
with different account, text, or target returns `key_conflict`.

Text-only posts and replies use this path; existing media, chains, and other
write tools retain their current behavior. Set `THREADS_SEND_DIR` to relocate
the private record directory (default `~/.threads-mcp/sends`). On a server,
set `THREADS_ACCOUNT_HANDLE` to the signed-in account's handle. This binds
durable sends to an explicit account when Threads' navigation has no labelled
profile link; the server no longer guesses from links in the home feed.

### Tool annotations

Per the [MCP annotations spec](https://modelcontextprotocol.io/) — side effects at a glance. Write tools act on your **real** account.

| Tool                                                                                                                                                                       | Read-only | Idempotent | Destructive |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------: | :--------: | :---------: |
| `whoami`, `get_profile`, `get_user_threads`, `get_thread`, `get_thread_replies`, `get_timeline`, `search`, `get_followers`, `get_following`, `get_notifications`, `doctor` |     ✓     |     ✓      |      –      |
| `create_thread`, `reply_to_thread`, `quote_thread`                                                                                                                         |     –     |     –      |      –      |
| `like_thread` / `unlike_thread`, `repost_thread` / `unrepost_thread`, `follow_user` / `unfollow_user`                                                                      |     –     |     ✓      |      –      |
| `delete_thread`                                                                                                                                                            |     –     |     ✓      |      ✓      |
| `schedule_thread`                                                                                                                                                          |     –     |     –      |      –      |
| `list_scheduled`                                                                                                                                                           |     ✓     |     ✓      |      –      |
| `cancel_scheduled`                                                                                                                                                         |     –     |     ✓      |      –      |

### Structured output

Every read tool returns **both** a rendered text block and machine-readable
`structuredContent`, described by an `outputSchema` the client can inspect. Text
clients are unaffected; anything that understands structured output gets typed
fields instead of parsing prose.

This matters for chaining. Recovering a shortcode from rendered markdown works
right up until a post's own text contains something shortcode-shaped:

```jsonc
// search → structuredContent
{
  "posts": [
    {
      "code": "DbUd7C8iR7A", // pass straight to like_thread / get_thread
      "url": "https://www.threads.com/@someone/post/DbUd7C8iR7A",
      "author": "someone",
      "text": "…",
      "created_at": "2026-07-28T05:12:44.000Z", // ISO, not a relative "3h"
      "likes": 15,
      "replies": 2,
      "reposts": 0,
      "quotes": 0,
      "media": "image", // none | image | video
      "is_reply": false,
      "quoted": { "author": "other", "text": "…" }, // when it quotes a post
    },
  ],
}
```

`get_profile` and `get_followers` / `get_following` return `profile` / `users`
in the same spirit; `get_notifications` returns `notifications` with a
normalised `kind` plus Threads' own `label`.

The shapes are a small surface this project owns — deliberately **not** Meta's
raw payloads, which reshuffle between app builds. Failures set `isError` and
carry no structured content, so a failed call is never mistaken for an empty
result.

---

## Media

`create_thread`, `reply_to_thread`, `quote_thread`, and `schedule_thread` take an optional `media` array — **local file paths and/or `http(s)` URLs** (URLs are downloaded to a temp file first, then cleaned up). Supported: images (`jpg/png/webp/avif`) and video (`mp4/mov/webm`). **Multiple images post as a carousel.** Either `text` or `media` is required.

```jsonc
// text + single image
create_thread { "text": "hello", "media": ["/path/to/pic.jpg"] }

// carousel (multiple images, mix local + URL)
create_thread { "text": "trip 🧵", "media": ["a.jpg", "b.jpg", "https://…/c.jpg"] }

// image-only reply
reply_to_thread { "handle": "someone", "code": "ABC123", "media": ["reaction.png"] }

// quote with a comment + image
quote_thread { "url": "https://www.threads.com/@x/post/ABC", "text": "this 👇", "media": ["chart.png"] }
```

### Multi-post threads

`create_thread` takes an optional `chain` — extra posts published as one
connected thread, the format Threads calls "Add to thread". Posting them
separately instead produces unlinked standalone threads.

```jsonc
create_thread {
  "text": "Three things I learned shipping this 🧵",
  "chain": ["1. Meta detects headless.", "2. Cache invalidation is still hard.", "3. Ship it."]
}
```

On your profile a chain appears as a **single** entry; the later parts are
reachable via `get_thread_replies` on the first post.

---

## Scheduling

Threads' **web UI has no native scheduling** (it's a mobile / Meta Business Suite feature), so this server runs its own scheduler: jobs are **persisted** to `~/.threads-mcp/scheduled.json` and a poll loop publishes them when due, through the same code path as `create_thread`.

```jsonc
// absolute time (local timezone unless you add an offset like +07:00 or Z)
schedule_thread { "text": "launch 🚀", "at": "2026-07-20T09:00" }

// relative delay
schedule_thread { "text": "in a bit", "in": "2h", "media": ["teaser.jpg"] }

list_scheduled {}                 // → ids + status (pending / done / failed / canceled)
cancel_scheduled { "id": "b9ec…" }
```

### The one hard limit

A cookie/browser approach can only post **while this server process is running** — there's no Threads-side scheduler to hand the job to. So:

- **Short horizons / same session** — works while your MCP client keeps the server alive.
- **Past-due jobs** — fire on the **next startup** (better late than never).
- **Long horizons (days out)** — run the server as an **[always-on daemon](#running-as-a-persistent-daemon)** so it's alive when the job is due.

Local media paths must **still exist** when the job fires (URLs are re-downloaded at fire time).

---

## Setup

### From npm (recommended)

```bash
npm install -g @bintangtimurlangit/threads-mcp   # downloads the CloakBrowser binary (~200 MB, cached)
```

This puts two commands on your PATH: **`threads-mcp`** (the server) and **`threads-mcp-login`** (one-time login). Or run without installing: `npx -y @bintangtimurlangit/threads-mcp`.

### From source

```bash
git clone https://github.com/bintangtimurlangit/threads-mcp.git
cd threads-mcp
npm install          # also downloads the CloakBrowser binary (~200 MB, cached)
npm run build
```

### 1. Log in once

```bash
threads-mcp-login    # global install — or, from a source checkout:  npm run login
```

Opens a CloakBrowser window — log into Threads, then press Enter. Saves your session to `~/.threads-mcp/chrome-profile`. Re-run only when it expires.

### 2. Register with your MCP client

The server launches a **headed** browser, so it needs a display. On a headless machine wrap it with `xvfb-run`:

```json
{
  "mcpServers": {
    "threads": {
      "command": "xvfb-run",
      "args": ["-a", "threads-mcp"]
    }
  }
}
```

On a machine with a real display, drop `xvfb-run`: `"command": "threads-mcp"`, `"args": []`. From a source checkout, use `"command": "node"`, `"args": ["/absolute/path/to/threads-mcp/build/index.js"]` (wrapped in `xvfb-run` on a headless box).

---

## Running as a persistent daemon

For **reliable scheduling** (and to avoid re-launching the browser each session), run the server always-on under a virtual display. Example with **systemd** on Linux:

```ini
# ~/.config/systemd/user/threads-mcp.service
[Unit]
Description=threads-mcp (Threads MCP server)
After=network-online.target

[Service]
ExecStart=/usr/bin/xvfb-run -a /usr/bin/node /absolute/path/to/threads-mcp/build/index.js
Restart=on-failure
Environment=DEBUG=false

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now threads-mcp
loginctl enable-linger "$USER"     # keep it running after logout
```

Or with **pm2**: `pm2 start "xvfb-run -a node build/index.js" --name threads-mcp`.

### Signing in without a display

`npm run login` needs a visible browser, which is the main obstacle to running
this anywhere without a desktop — a VPS, a container, CI. The session is only
cookies, so move it instead of trying to log in headlessly:

1. On a machine with a display, sign in to Threads normally.
2. Open devtools → Application → Cookies → `threads.com` and copy `sessionid`
   and `ds_user_id`.
3. On the server:

```bash
THREADS_SESSIONID=… THREADS_DS_USER_ID=… npx threads-mcp-import-session
npm run test:live      # confirm it worked
```

> ⚠️ A `sessionid` is a bearer credential for your **entire account** — whoever
> holds it is you. Prefer the environment-variable form so it stays out of shell
> history, never commit it, and revoke it by logging out of Threads if it leaks.

### Chromium system libraries

On a fresh server Chromium needs system libraries that are not installed by
default. If the browser fails to launch with a missing `.so`:

```bash
npx playwright install-deps chromium
# or, Debian/Ubuntu, without Playwright's helper:
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libasound2 libpango-1.0-0 libcairo2
```

> **Why not a Docker image?** It would mainly pin those libraries — the one line
> above. Against that, MCP over stdio means the client owns the process, so a
> container turns `npx threads-mcp` into `docker run -i` with a volume for the
> profile; and a containerised Chromium on a virtual display has no GPU and
> reports renderer strings that match no real desktop, which cuts directly
> against the fingerprint work this server depends on. Running it natively under
> `xvfb` is both simpler and less detectable.

> Note: MCP over stdio expects the client to own the process. Running a standalone daemon is specifically for the **scheduler** to survive between client sessions — the scheduled-post queue is shared via `~/.threads-mcp/scheduled.json`.

---

## Configuration

All optional — see `.env.example`, copy to `.env` to override.

| Variable                         | Default                         | Purpose                                                                   |
| -------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `THREADS_DOMAIN`                 | `threads.com`                   | Threads domain (`threads.net` redirects here).                            |
| `THREADS_PROFILE_DIR`            | `~/.threads-mcp/chrome-profile` | Where the saved login lives.                                              |
| `THREADS_HEADLESS`               | `false`                         | Keep `false` — headless is detected.                                      |
| `THREADS_MIN_ACTION_INTERVAL_MS` | `8000`                          | Minimum gap between write actions. Raise to be safer.                     |
| `CACHE_TTL_MS`                   | `30000`                         | In-memory read-cache lifetime.                                            |
| `THREADS_LOCK_TIMEOUT_MS`        | `120000`                        | Ceiling on one browser operation; on timeout the page resets.             |
| `THREADS_MAX_MEDIA_BYTES`        | `67108864`                      | Largest accepted media file (64 MB).                                      |
| `THREADS_MEDIA_TIMEOUT_MS`       | `60000`                         | Per-download timeout for `http(s)` media.                                 |
| `DEBUG`                          | `false`                         | Log startup, captured GraphQL op names, and scheduler activity to stderr. |

State lives under `~/.threads-mcp/`: `chrome-profile/` (your login) and `scheduled.json` (the post queue).

---

## How it works

Threads' web app talks to Meta's **Relay GraphQL gateway** with per-session tokens (`fb_dtsg`, `lsd`) and anti-automation fingerprinting. A hand-rolled `fetch` gets rejected, and operation IDs churn. So this server drives **[CloakBrowser](https://github.com/CloakHQ/cloakbrowser)** — a fingerprint-patched Chromium — against a persistent profile you log into once, and:

- **Reads** — collects the data the app renders: the server-side JSON embedded in each page's `<script>` tags, plus every `/api/graphql` **and** `/graphql/query` response (the home feed uses the latter). A defensive walker pulls posts/users out of _whatever_ comes back, so it survives Meta renaming operations.
- **Writes** — drive the real composer and action buttons so Meta's own client mints the tokens. Icon buttons are clicked at the DOM level (a humanized pointer click misses them). Replies use the inline composer's Ctrl+Enter; reply-with-media promotes it to the full dialog via "Expand composer".
- **Scheduling** — a persisted queue + poll loop, delegating to the same publish path as `create_thread`.

The browser runs **headed** (Meta detects headless); on a server use a virtual display (`xvfb`).

---

## Development

```bash
npm run typecheck
npm test             # unit tests (no browser, no login — runs in CI)
npm run test:live    # live READ-only smoke test (needs login + a display)
npm run dev          # tsx watch
```

`DEBUG=true` logs every GraphQL operation name the app fires and each scheduler tick — useful if Meta reshuffles a surface and a reader comes back empty.

---

## When things break

Meta ships UI changes without notice. Because writes drive the real interface,
a moved button shows up as a vague "couldn't confirm" from whichever tool
happened to use it — not as an obvious failure.

Run `doctor` first. It checks the session and every DOM anchor the write tools
depend on, and tells you what each failure breaks:

```
✅ session — session cookie present
✅ composer-add-to-thread — present
❌ post-repost — NOT FOUND

**Impact:**
- `post-repost` → repost_thread / quote_thread / unrepost_thread
```

Anchors are declared in [`src/browser/selectors.ts`](./src/browser/selectors.ts);
update the ones that moved. `doctor { "deep": true }` also checks a real post
page and the activity feed.

---

## Troubleshooting

| Symptom                                   | Likely cause / fix                                                                                                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `🔒 Not signed in` on every tool          | No/expired session → run `npm run login`.                                                                                                           |
| A read returns empty for a public account | Try again (feed/timeline is lazy-loaded); run with `DEBUG=true` to see the GraphQL ops. Private/blocked accounts yield nothing.                     |
| A write says it couldn't find its button  | Meta changed the UI, or a promo interstitial got in the way (the server tries to dismiss those). Retry; if persistent, the selector needs updating. |
| `🐢 rate-limited`                         | Stop for several minutes, then slow down.                                                                                                           |
| Scheduled post never fired                | The server wasn't running when it was due — see [Run as a daemon](#running-as-a-persistent-daemon). It'll fire on next startup.                     |
| Headless / server has no display          | Wrap the command in `xvfb-run -a …`.                                                                                                                |

---

## Caveats

- **Login required.** No session → tools return a friendly "run `npm run login`" prompt.
- **Anti-bot is a moving target.** The free CloakBrowser binary can go stale as Meta updates detection; CloakBrowser Pro ships newer patches. Writes rely on UI selectors Meta can change.
- **Reads are resilient** to GraphQL renames (they parse whatever the app fetches), but a private/blocked account yields nothing, and just-posted content can be briefly stale on read-back.
- **Scheduling only fires while the server runs** (see above).
- Respect Threads' Terms of Service and the rate-limit guidance above. This is for personal use of your own account, not scraping or automation at scale.

## Contributing & security

[CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE)

---

## Disclaimer

This is an **unofficial** project. It is **not affiliated with, authorized, maintained, sponsored, or endorsed by Meta, Threads, or Instagram**.

It works by driving a real logged-in browser session against Threads' web app, which can change without notice — a tool may break when Meta updates its site or anti-bot behavior. It automates **your own** account and performs only the actions you invoke.

You are responsible for using this software in compliance with [Threads' / Meta's Terms of Service](https://help.instagram.com/769983657850450) and applicable law. Keep request and write volumes reasonable. All product names, logos, and brands are property of their respective owners.
