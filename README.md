# annas-archive-api

A self-contained [Anna's Archive](https://annas-archive.org) search API and
fast-download proxy, with a small built-in web UI. It scrapes the public search
page into clean JSON, enriches each result with live download counts, and
proxies authenticated fast-download requests using a key the user supplies — no
secrets are ever stored on the server.

The whole thing is two small request handlers (`api/`), a scraping core
(`lib/annas.js`), and a single static HTML page (`public/`), served with
Express. Run it on your own machine with Node, or ship it as a container.

```
┌──────────────────────────────────────────────────────────┐
│              Browser  —  public/index.html               │
│    search UI + settings panel  (vanilla JS, no build)    │
└──────────────────────────────────────────────────────────┘
                              │
                                 HTTP  ·  JSON
                              ▼
┌──────────────────────────────────────────────────────────┐
│                Express server  —  dev.mjs                │
│                                                          │
│         api/search.js            api/download.js         │
│          validate + shape          key + proxy           │
│                                                          │
│      lib/annas.js  —  scrape core + download proxy       │
│        search · parseSearchResults · fastDownload        │
└──────────────────────────────────────────────────────────┘
                              │
                                 HTTPS  ·  browser-like User-Agent
                              ▼
┌──────────────────────────────────────────────────────────┐
│        Anna's Archive mirror   (annas-archive.gd)        │
│            /search   ·   /dyn/md5/inline_info            │
│               /dyn/api/fast_download.json                │
└──────────────────────────────────────────────────────────┘
```

## Why I built this

I do all of my reading on a Kobo running [KOReader](https://github.com/koreader/koreader), and getting books onto the device was always a hassle. Either I would go through the process of downloading a book, uploading to dropbox, and then moving the file to my KOReader library, or doing the same with a manual wired file transfer. Either way, I would always need a second device just to get a new book on my Kobo.

Anna's Archive exposes a download API, however this API only accepts an MD5 hash, and there is no public search api provided to easily access this hash. This project aims to bridge this gap. By scraping search page results into JSON and passing the MD5 hash to the existing download API, this project provides an all-in-one solution to searching and downloading books from Anna's Archive. A companion [KOReader plugin](https://github.com/bitesized/annasarchive.koplugin/) can be installed to allow for both searching and downloading directly from the reading device itself, removing the need for manual file transfers.

This project served as a very useful exercise in both development and learning about important security considerations:

* **Handling secrets** - A key requirement of the project is the passing of a secret download key to the download API. This key also serves as the login to the Anna's Archive website, and as such needs to be handled with care. An important part of this project was ensuring that the key doesn't persist anywhere server-side.
* **Browser-like UA** - In order to avoid bot detection/captcha that Anna's Archive employs, the scraper uses a realistic user agent header.
* **Reverse-engineering search results** - Anna's Archive doesn't expose a search API, so the search results need to be scraped from the rendered HTML from the search results page. The core of the JSONified search results is the MD5 hash that's taken from the URL of the linked books from the search page, as I determined it was the least likely to change. Once this is located the parser walks up levels to find the rest of the required information within the search result card. This per-card method prevents one malformed result from poisoning others.
* **Isolation of live download counts** - The live download counts for each search result do not appear in the raw HTML, instead they are fetched per result on the client side. As such they had to be isolated via the developer tools' network tab to identify the endpoint being hit.
* **Untrusted third-party content** - the search results are built from user-submitted data outside of my control. This means that a lot of the scraped data should be treated as untrusted. As such, all the scraped data is passed through an escaping function first, treating it as a potential XSS vector rather than assuming safe text.
* **Containerised deployment** - I explored and learned about both Docker and LXC deployment for this project, as my personal instance is hosted on a Proxmox server

### Legal and ethical considerations

Anna's Archive is a shadow library that indexes copyrighted materials. This tool automates requests against a public mirror that is specified by the user, and downloading any copyrighted materials requires a download key that is required to be provided by the user. I don't endorse or promote the use of this tool to access any material you don't have the legal right to access - it was built purely to overcome a personal issue in my reading setup.

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

## Run with Docker

The image builds on `node:24-alpine` (the current Node LTS), installs only
production dependencies, and runs as the non-root `node` user.

```bash
docker build -t annas-archive-api .
docker run --rm -p 3000:3000 annas-archive-api
```

Then open http://localhost:3000.

Pass configuration through with `-e`. To target a different mirror:

```bash
docker run --rm -p 3000:3000 \
  -e ANNAS_BASE_URL=https://annas-archive.gd \
  annas-archive-api
```

Notes:

- `PORT` defaults to `3000` inside the container; the `EXPOSE`d port is `3000`.
  To publish it elsewhere on the host, change the left side of the mapping, e.g.
  `-p 8080:3000`.
- `.dockerignore` keeps the build context lean (no `node_modules`, `.git`,
  tests, or docs), so builds are fast and reproducible from `package-lock.json`.

## Deploy to Proxmox (LXC)

Two scripts in `deploy/` create and tear down an unprivileged LXC on a Proxmox
host and run the app inside it as a systemd service. They hold **no secrets and
no hard-coded addresses** — authentication is via your SSH agent, and every
setting is a `--flag` with a sensible default.

**Prerequisites**

- SSH access to the Proxmox node with your key loaded (`ssh-add -l`), reachable
  through a host alias in `~/.ssh/config` (default alias: `proxmox`).
- A container template already present on the node (e.g. `debian-13-standard`).

**Deploy** — run from the repo root:

```bash
./deploy/deploy-lxc.sh
```

This picks a free VMID, creates a Debian 13 container (DHCP, unprivileged),
installs Node and the app's production dependencies, registers and starts a
systemd service, then prints the container's IP and URL. Override any default
with a flag:

```bash
./deploy/deploy-lxc.sh --port 9000 --memory 1024 --storage sata-storage
./deploy/deploy-lxc.sh --help      # full list of flags
```

Available flags: `--host`, `--vmid`, `--hostname`, `--template`, `--storage`,
`--disk`, `--cores`, `--memory`, `--swap`, `--bridge`, `--mac`, `--port`,
`--base-url`, `--timezone`, `--tags`.

The container uses DHCP. To pin it to a fixed address, add a DHCP reservation on
your router for the container's MAC (found in `/etc/pve/lxc/<vmid>.conf`). By
default Proxmox generates a fresh MAC each time you create a container, so a
teardown-and-redeploy would break that reservation. To keep the same address
across redeploys, pass the container's MAC back in with `--mac`:

```bash
./deploy/deploy-lxc.sh --mac <container-mac>
```

**Undeploy**

```bash
./deploy/undeploy-lxc.sh
```

Finds the container by hostname (default `annas-archive-api`), shows what it will
remove, and asks for confirmation before stopping and destroying it (rootfs
included). Use `--vmid <id>` to target a specific container, or `--yes` to skip
the prompt.

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

The header is required — there is no environment-variable fallback, so an
unauthenticated request cannot spend a key the operator configured.

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

The handlers delegate to a handful of exported functions; you can import these
directly if you want to embed the logic elsewhere.

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
| `PORT`               | `3000`                        | Server port (`dev.mjs`).                                    |
| `ANNAS_BASE_URL`     | `https://annas-archive.gd`    | Upstream mirror to scrape/proxy.                            |

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
deploy/
  deploy-lxc.sh    Create a Proxmox LXC and run the app as a systemd service
  undeploy-lxc.sh  Stop and destroy that LXC
dev.mjs            Express server (serves public/ + mounts the api/ handlers)
Dockerfile         Container build (node:24-alpine, non-root, prod deps only)
.dockerignore      Keeps the Docker build context lean
```
