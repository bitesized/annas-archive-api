# annas-archive-api

Self-contained Anna's Archive search UI + fast-download proxy. Node 18+, no build step.

## Commands

```bash
npm run dev          # Express server at http://localhost:3000
npm test             # Offline parser tests (no network needed)
PORT=4020 npm run dev  # Use a different port
```

## Architecture

```
lib/annas.js          Core: parseSearchResults, search, fastDownload
api/search.js         Thin handler — validation + JSON shaping only
api/download.js       Thin handler — key extraction + proxy only
api/bearer.js         Shared `Authorization: Bearer` parsing for both handlers
public/index.html     Entire frontend (HTML + CSS + vanilla JS, no build)
dev.mjs               Express server wiring (static + api/ routes)
test/parse.test.mjs   Parser tests using saved fixture HTML
```

The handlers in `api/` must stay framework-agnostic (`req.query` in, `res.status().json()` out). All real logic belongs in `lib/annas.js`.

## Non-obvious constraints

**User-Agent is required.** Every upstream request must send a browser-like UA or DDoS-Guard returns a challenge page instead of HTML.

**Searches must be signed in.** Anna's Archive pushes *unauthenticated* requests for
`/search` and `/md5/` through a DDoS-Guard JS challenge that `fetch` cannot solve —
a headless browser can't either (only headful passes). A signed-in session skips the
check entirely, so `search()` takes a `key` and trades it for a session cookie via
`POST /account/`. The `/dyn/*` JSON endpoints (`inline_info`, `fast_download.json`)
are **not** gated, so downloads work without any of this.

**A challenge is not always a 403.** An expired session gets a 302 to the same path
with `check=1`, which loops until `fetch` throws "redirect count exceeded". That is
why `search()` drives redirects manually (`redirect: "manual"`) instead of following
them — see `isChallenge()`.

**Concurrency cap on inline_info.** The `DOWNLOAD_CONCURRENCY = 10` limit in `lib/annas.js` is a politeness cap — do not raise it significantly.

**Download key never touches disk.** The key is passed per-request via `Authorization: Bearer` and stored only in the browser's `localStorage`. The server must never log or persist it. The same key is the account secret key used to log in; the in-memory `sessions` cache in `lib/annas.js` stores only the *derived* session cookie, under a sha256 of the key — never the key itself.

**Frontend has no build step.** `public/index.html` is a single file with inline CSS and JS. Do not introduce a bundler.

## Environment variables

| Variable             | Default                    | Purpose                                   |
| -------------------- | -------------------------- | ----------------------------------------- |
| `PORT`               | `3000`                     | Dev server port                           |
| `ANNAS_BASE_URL`     | `https://annas-archive.gd` | Upstream mirror                           |

## Tests

Tests are offline — they parse `test/fixtures/search_test-search.html`. If Anna's Archive changes their HTML structure, update the fixture and the expected values in `parse.test.mjs` together. Do not add network-dependent tests.
