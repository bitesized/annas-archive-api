# annas-search-download

A self-contained [Anna's Archive](https://annas-archive.org) search UI and
fast-download proxy. It scrapes the public search page into clean JSON, enriches
each result with live download counts, and proxies authenticated fast-download
requests using a key the user supplies — no secrets are ever stored on the
server.

The whole thing is two small request handlers (`api/`), a scraping core
(`lib/annas.js`), and a single static HTML page (`public/`), served locally with
Express. It's meant to be run on your own machine.

```
┌──────────────┐   /api/search    ┌─────────────┐   GET /search        ┌─────────────────┐
│  public/     │ ───────────────► │  api/       │ ───────────────────► │ Anna's Archive  │
│  index.html  │                  │  search.js  │ ◄─── HTML ─────────── │  (annas-archive)│
│  (browser)   │   /api/download  │  download.js│   GET /dyn/... json   │                 │
│              │ ───────────────► │             │ ───────────────────► │                 │
└──────────────┘                  └──────┬──────┘                      └─────────────────┘
                                         │ lib/annas.js (scrape + proxy)
```

## Quick start

Requires Node 18+ (the code relies on the global `fetch` and
`AbortSignal.timeout`).

```bash
npm install
npm run dev          # serves http://localhost:3000
```

If the port is taken:

```bash
PORT=4020 npm run dev
```

Run the offline parser tests (no network needed — they parse a saved fixture):

```bash
npm test
```

## How it works

`dev.mjs` is an Express server that serves `public/` statically and mounts the
two files in `api/` as route handlers. The handlers are framework-agnostic
(`req.query` in, `res.status().json()` out), so they stay small and easy to test.

All the real work lives in `lib/annas.js`, which the handlers are thin wrappers
around.

---

## API

Two endpoints, both `GET`, both returning JSON.

### `GET /api/search`

Search Anna's Archive and return parsed, enriched results.

**Query parameters**

| Param       | Type    | Default | Notes                                                            |
| ----------- | ------- | ------- | --------------------------------------------------------------- |
| `query`     | string  | —       | **Required.** Title, author, ISBN, DOI, or MD5. Trimmed.        |
| `limit`     | integer | `20`    | Clamped to the range `1`–`50`.                                  |
| `downloads` | string  | `true`  | Pass `downloads=false` to skip per-result download-count lookups (faster). |
| `tld`       | string  | —       | Mirror TLD to target (e.g. `gs`, `se`). Swaps the final label of `ANNAS_BASE_URL`'s host (`annas-archive.gd` → `annas-archive.gs`). A leading dot is tolerated; invalid/unknown TLDs fall back to the default mirror. |

**Response `200`**

```json
{
  "query": "clean code",
  "count": 2,
  "results": [
    {
      "title": "Clean Code: A Handbook of Agile Software Craftsmanship",
      "author": "Robert C. Martin",
      "format": "pdf",
      "downloads": 15432,
      "cover_url": "https://covers.z-lib.sk/covers400/.../cover.jpg",
      "url": "https://annas-archive.gd/md5/abc123...",
      "md5": "abc123..."
    }
  ]
}
```

Result fields:

| Field        | Type             | Notes                                                                 |
| ------------ | ---------------- | -------------------------------------------------------------------- |
| `title`      | string           | Whitespace-normalized.                                                |
| `author`     | string           | May be empty if the card has no author.                              |
| `format`     | string \| null   | Lowercased token (`pdf`, `epub`, `mobi`, `djvu`, …).                  |
| `downloads`  | number \| null   | Total download count, or `null` if not fetched or the lookup failed. |
| `cover_url`  | string \| null   | Absolute URL; `null` when the result has no cover.                   |
| `url`        | string           | Canonical Anna's Archive detail page.                               |
| `md5`        | string           | File hash — the identifier used by `/api/download`.                  |

**Errors**

| Status | Condition                                            | Body                              |
| ------ | --------------------------------------------------- | -------------------------------- |
| `400`  | `query` missing or empty                            | `{ "error": "query is required" }` |
| `502`  | Upstream unreachable or returned a non-OK status    | `{ "error": "Failed to reach Anna's Archive: …" }` |
| `500`  | Any other unexpected error                          | `{ "error": "…" }`               |

**Example**

```bash
curl 'http://localhost:3000/api/search?query=clean%20code&limit=10'
curl 'http://localhost:3000/api/search?query=clean%20code&downloads=false'
curl 'http://localhost:3000/api/search?query=clean%20code&tld=gs'
```

### `GET /api/download`

Resolve a file's MD5 into a time-limited fast-download URL by proxying Anna's
Archive's `fast_download.json` endpoint with the caller's member key.

**Authentication**

The fast-download key is supplied **per request** via an `Authorization` header
and is never persisted server-side:

```
Authorization: Bearer <your-fast-download-key>
```

For server-side or CLI use, the handler falls back to the `ANNAS_DOWNLOAD_KEY`
environment variable when no header is present.

**Query parameters**

| Param | Type   | Notes                                          |
| ----- | ------ | --------------------------------------------- |
| `md5` | string | **Required.** The file hash from a search result. |
| `tld` | string | Mirror TLD to proxy through (e.g. `gs`, `se`). Same semantics as on `/api/search`; falls back to the default mirror when invalid. |

**Response `200`**

Passes through the upstream JSON, which includes the temporary download URL:

```json
{
  "download_url": "https://...",
  "...": "additional upstream fields"
}
```

**Errors**

| Status  | Condition                                  | Body                                                       |
| ------- | ----------------------------------------- | --------------------------------------------------------- |
| `401`   | No key in header or env                     | `{ "error": "Download key not set — add it in Settings." }` |
| `400`   | `md5` missing                               | `{ "error": "md5 is required" }`                          |
| `4xx/5xx` | Upstream error (status passed through)     | `{ "error": "…" }` (defaults to `502` if no status)       |

**Example**

```bash
curl 'http://localhost:3000/api/download?md5=abc123...' \
  -H 'Authorization: Bearer YOUR_KEY'
curl 'http://localhost:3000/api/download?md5=abc123...&tld=gs' \
  -H 'Authorization: Bearer YOUR_KEY'
```

### The scraping core — `lib/annas.js`

The handlers delegate to three exported functions; you can import these directly
if you want to embed the logic elsewhere.

- **`parseSearchResults(html, baseUrl?)`** — pure function that scrapes a search
  page's HTML into result objects (with `cheerio`). It anchors on each result's
  title link (`a.js-vim-focus[href^='/md5/']`), walks up to the result card, and
  pulls out the author, cover, and the `language · FORMAT · size · year …`
  metadata line. No network access — this is what the tests exercise.

- **`search(query, { limit, includeDownloads, tld })`** — fetches the search
  page, parses it, trims to `limit`, then (unless `includeDownloads` is false)
  fans out concurrent requests to `/dyn/md5/inline_info/<md5>` to fill in download
  counts. Those counts aren't in the static HTML — the real site loads them
  client-side — so this step is what makes `downloads` non-null. Concurrency is
  capped at 10 to stay polite to the origin, and individual count failures are
  swallowed (leaving `downloads: null`) so one bad lookup never sinks the whole
  response. Pass `tld` to target a specific mirror.

- **`fastDownload(md5, key, { tld })`** — proxies a single
  `/dyn/api/fast_download.json` request with the caller's key and returns the
  upstream JSON. Pass `tld` to target a specific mirror.

- **`resolveBaseUrl(tld)`** — maps a TLD like `"gs"` onto the upstream base URL
  by swapping the final label of `ANNAS_BASE_URL`'s host (e.g.
  `https://annas-archive.gd` → `https://annas-archive.gs`). A leading dot is
  tolerated; an empty, malformed, or unknown TLD returns the default `BASE_URL`.
  This is what both `search` and `fastDownload` use to honor the `tld` option.

Failures to reach or parse the upstream throw `AnnasArchiveError`, which the
search handler maps to a `502`.

### Configuration

All optional, read from the environment:

| Variable             | Default                       | Purpose                                                       |
| -------------------- | ----------------------------- | ----------------------------------------------------------- |
| `PORT`               | `3000`                        | Local dev server port (`dev.mjs` only).                     |
| `ANNAS_BASE_URL`     | `https://annas-archive.gd`    | Upstream mirror to scrape/proxy.                            |
| `ANNAS_DOWNLOAD_KEY` | —                             | Fallback fast-download key when no `Authorization` header.   |

A browser-like `User-Agent` is sent on every upstream request to avoid being
served a DDoS-Guard challenge page, and every request has a 30s timeout.

---

## Front end

A single static page, `public/index.html` — no build step, no framework, just
inline CSS and vanilla JS talking to the two API endpoints.

**What it does**

- A search bar (Enter or the button triggers a search) with a results-count
  selector (10/20/30/50) wired to the `limit` param.
- Results render as a responsive grid of book cards showing the cover (with a 📖
  placeholder on missing/broken images), title, author, a color-coded format
  badge (`pdf`/`epub`/`djvu`/`mobi`), and the formatted download count
  (e.g. `15.4k`). The whole card links to the Anna's Archive detail page.
- A **Download** button on each card calls `/api/download` with the saved key and
  opens the resolved URL in a new tab. Inline error states surface problems
  (e.g. prompting to set a key).
- A **⚙ Settings** panel where the user pastes their fast-download key. The key
  is stored in `localStorage` (`annasDownloadKey`) and sent only on download
  requests as a `Bearer` token — it never touches the server's disk.

All user-supplied strings are HTML-escaped before injection into the DOM.

---

## Project layout

```
api/
  search.js        Request handler for /api/search (validation + JSON shaping)
  download.js      Request handler for /api/download (key extraction + proxy)
lib/
  annas.js         Scraping + download core: parseSearchResults, search, fastDownload
public/
  index.html       The entire front end (HTML + CSS + JS)
test/
  parse.test.mjs   Offline parser tests
  fixtures/        Saved search-page HTML used by the tests
dev.mjs            Express server (serves public/ + mounts the api/ handlers)
```

## Notes

This tool only automates requests against a public mirror; respect Anna's
Archive's terms and your local laws. Fast downloads require a valid member key,
which is yours to supply.
