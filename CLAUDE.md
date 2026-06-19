# annas-search-download

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
public/index.html     Entire frontend (HTML + CSS + vanilla JS, no build)
dev.mjs               Express server wiring (static + api/ routes)
test/parse.test.mjs   Parser tests using saved fixture HTML
```

The handlers in `api/` must stay framework-agnostic (`req.query` in, `res.status().json()` out). All real logic belongs in `lib/annas.js`.

## Non-obvious constraints

**User-Agent is required.** Every upstream request must send a browser-like UA or DDoS-Guard returns a challenge page instead of HTML.

**Concurrency cap on inline_info.** The `DOWNLOAD_CONCURRENCY = 10` limit in `lib/annas.js` is a politeness cap — do not raise it significantly.

**Download key never touches disk.** The key is passed per-request via `Authorization: Bearer` and stored only in the browser's `localStorage`. The server must never log or persist it.

**Frontend has no build step.** `public/index.html` is a single file with inline CSS and JS. Do not introduce a bundler.

## Environment variables

| Variable             | Default                    | Purpose                                   |
| -------------------- | -------------------------- | ----------------------------------------- |
| `PORT`               | `3000`                     | Dev server port                           |
| `ANNAS_BASE_URL`     | `https://annas-archive.gd` | Upstream mirror                           |
| `ANNAS_DOWNLOAD_KEY` | —                          | Fallback key when no Authorization header |

## Tests

Tests are offline — they parse `test/fixtures/search_test-search.html`. If Anna's Archive changes their HTML structure, update the fixture and the expected values in `parse.test.mjs` together. Do not add network-dependent tests.
