# Anna's Archive API

A self-contained [Anna's Archive](https://annas-archive.org) search API and
fast-download proxy with a built-in web UI. It scrapes the search page into
JSON, fills in live download counts, and proxies fast-download requests.

Both endpoints need your Anna's Archive account secret key, which you supply per
request — searching requires it because Anna's Archive challenges anonymous
requests. Nothing is stored server-side.

Node 18+, no build step, no database.

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
                                 HTTPS  ·  signed-in session
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

```bash
npm install
npm run dev            # http://localhost:3000
PORT=4020 npm run dev  # if 3000 is taken
npm test               # offline parser tests, no network
```

Open the app, then **paste your Anna's Archive account secret key into ⚙ Settings
before searching** — it's the key from your account page, the same one that
authorises fast downloads. Searches without it fail (see
[Authentication](#get-apisearch)).

## Run with Docker

Builds on `node:24-alpine`, production dependencies only, runs as the non-root
`node` user.

```bash
docker build -t annas-archive-api .
docker run --rm -p 3000:3000 annas-archive-api
```

`PORT` is `3000` inside the container — remap the host side to move it
(`-p 8080:3000`). Pass config with `-e`:

```bash
docker run --rm -p 3000:3000 \
  -e ANNAS_BASE_URL=https://annas-archive.gd \
  annas-archive-api
```

## Deploy to Proxmox (LXC)

`deploy/` holds two scripts that create and destroy an unprivileged LXC running
the app as a systemd service. No secrets, no hard-coded addresses — auth is via
your SSH agent and every setting has a flag.

You need SSH access to the Proxmox node with your key loaded (`ssh-add -l`) and
a host alias in `~/.ssh/config` (default: `proxmox`), plus a container template
on the node (e.g. `debian-13-standard`).

```bash
./deploy/deploy-lxc.sh                                    # create and start
./deploy/deploy-lxc.sh --port 9000 --memory 1024          # override defaults
./deploy/deploy-lxc.sh --help                             # all flags
./deploy/undeploy-lxc.sh                                  # stop and destroy
```

Deploy picks a free VMID, creates a Debian 13 container on DHCP, installs Node
and the app, registers the service, and prints the container's IP. Flags:
`--host`, `--vmid`, `--hostname`, `--template`, `--storage`, `--disk`,
`--cores`, `--memory`, `--swap`, `--bridge`, `--mac`, `--port`, `--base-url`,
`--timezone`, `--tags`.

Undeploy finds the container by hostname, shows what it will remove, and asks
before destroying it. `--vmid` targets a specific one, `--yes` skips the prompt.

**Keeping a fixed IP.** Proxmox generates a new MAC per container, so a
redeploy breaks any DHCP reservation. Pass the old MAC back in:

```bash
./deploy/deploy-lxc.sh --mac <container-mac>   # from /etc/pve/lxc/<vmid>.conf
```

---

## API

Two `GET` endpoints, both returning JSON. `dev.mjs` serves `public/` and mounts
each file in `api/` as a handler; the handlers are framework-agnostic
(`req.query` in, `res.status().json()` out) and all real logic lives in
`lib/annas.js`.

### `GET /api/search`

**Authentication** — required in practice. Anna's Archive puts unauthenticated
`/search` requests behind a DDoS-Guard JavaScript challenge that an HTTP client
can't solve. The server will still attempt an anonymous search, so this header is
technically optional and would start working again if the upstream stopped
challenging — but today a call without it returns `401`. A signed-in session
skips the check, and the key is the same one `/api/download` uses:

```
Authorization: Bearer <your-account-secret-key>
```

The server trades it for a session cookie via `POST /account/` and caches only
that cookie in memory, keyed by a hash of the key. The key itself is never
stored, and an expired session triggers one silent re-login.

**Query parameters**

| Param       | Type    | Default | Notes |
| ----------- | ------- | ------- | ----- |
| `query`     | string  | —       | **Required.** Title, author, ISBN, DOI, or MD5. |
| `limit`     | integer | `20`    | Clamped to `1`–`50`. |
| `downloads` | string  | `true`  | `false` skips download-count lookups (faster). |
| `tld`       | string  | —       | Mirror TLD, e.g. `gd`, `pk`, `gl`. See [Mirrors](#mirrors). |

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

| Field       | Type           | Notes |
| ----------- | -------------- | ----- |
| `title`     | string         | Whitespace-normalised. |
| `author`    | string         | Empty if the card has no author. |
| `format`    | string \| null | Lowercased: `pdf`, `epub`, `mobi`, `djvu`, … |
| `downloads` | number \| null | `null` if not fetched or the lookup failed. |
| `cover_url` | string \| null | Absolute URL, `null` when there's no cover. |
| `url`       | string         | Anna's Archive detail page. |
| `md5`       | string         | File hash — the identifier `/api/download` takes. |

**Errors**

| Status | Condition |
| ------ | --------- |
| `400`  | `query` missing or empty. |
| `401`  | Upstream served a bot check (`code: "CHALLENGE"`), or the key was rejected. |
| `502`  | Upstream unreachable or returned a non-OK status. |
| `500`  | Anything else. |

```bash
curl 'http://localhost:3000/api/search?query=clean%20code&limit=10' \
  -H 'Authorization: Bearer YOUR_KEY'
```

### `GET /api/download`

Resolves an MD5 into a time-limited download URL by proxying Anna's Archive's
`fast_download.json` with your member key.

**Authentication** — required, per request, never persisted server-side:

```
Authorization: Bearer <your-fast-download-key>
```

There's no environment-variable fallback, so an unauthenticated request can't
spend the operator's key.

**Query parameters**

| Param | Type   | Notes |
| ----- | ------ | ----- |
| `md5` | string | **Required.** The hash from a search result. |
| `tld` | string | Mirror TLD. See [Mirrors](#mirrors) — your key is sent to this host. |

**Response `200`** passes the upstream JSON straight through, including
`download_url`.

**Errors**

| Status    | Condition |
| --------- | --------- |
| `400`     | `md5` missing. |
| `401`     | No key in the header. |
| `4xx/5xx` | Upstream error, status passed through (`502` if none). |

```bash
curl 'http://localhost:3000/api/download?md5=abc123...' \
  -H 'Authorization: Bearer YOUR_KEY'
```

---

## Mirrors

Anna's Archive runs the same site across several TLDs. Set one globally with
`ANNAS_BASE_URL`, per request with `tld`, or in the UI's Settings panel. `tld`
swaps the final label of `ANNAS_BASE_URL`'s host, so `gd` → `annas-archive.gd`.
A leading dot is fine; anything malformed or unknown falls back to the default.

> [!WARNING]
> **Your download key is sent to whichever mirror you select**, as a `key=`
> query parameter on the upstream URL. A mistyped, outdated, or squatted domain
> receives it in full and logs it.
>
> Anna's Archive rotates its domains, and retired ones get re-registered by
> third parties — `annas-archive.li`, a former mirror, now resolves to a
> domain-parking page. Check the current list on the
> [Anna's Archive Wikipedia page](https://en.wikipedia.org/wiki/Anna%27s_Archive)
> before changing mirrors, and rotate your key if you've sent it somewhere
> unintended.

## Configuration

| Variable         | Default                    | Purpose |
| ---------------- | -------------------------- | ------- |
| `PORT`           | `3000`                     | Server port. |
| `ANNAS_BASE_URL` | `https://annas-archive.gd` | Default mirror — see the warning above. |

Every upstream request sends a browser-like `User-Agent` and times out after
30s.

---

## The scraping core — `lib/annas.js`

Importable directly if you want the logic without the server.

- **`parseSearchResults(html, baseUrl?)`** — pure function, no network. Anchors
  on each title link (`a.js-vim-focus[href^='/md5/']`), walks up to the result
  card, and pulls the author, cover, and `language · FORMAT · size · year` line.
  This is what the tests exercise.

- **`search(query, { limit, includeDownloads, tld, key })`** — fetches, parses,
  trims to `limit`, then fans out to `/dyn/md5/inline_info/<md5>` for download
  counts, which aren't in the static HTML. Concurrency is capped at 10 out of
  politeness, and a failed count leaves `downloads: null` rather than sinking
  the response. Without `key` the upstream answers with a challenge and an
  `AnnasArchiveError` carrying `code: "CHALLENGE"`.

- **`fastDownload(md5, key, { tld })`** — proxies one
  `/dyn/api/fast_download.json` request and returns the upstream JSON.

- **`resolveBaseUrl(tld)`** — maps a TLD onto the base URL by swapping the
  host's final label. Both `search` and `fastDownload` use it.

Unreachable or unparseable upstreams throw `AnnasArchiveError`.

## Front end

One static page, `public/index.html` — inline CSS and vanilla JS, no build step.

- Search bar with a results-count selector (10/20/30/50) wired to `limit`.
- File-type filter and sort controls (relevance, most downloaded, title,
  author, file type). Both work on the results already fetched — Anna's Archive
  only offers its own ordering upstream, and download counts aren't in the
  search HTML at all. The filter is rebuilt from each search's results, so it
  only lists types that would actually match.
- Results as a grid of cards: cover (📖 placeholder when missing), title,
  author, colour-coded format badge, and download count (`15.4k`). PDF, EPUB,
  DJVU and MOBI each have their own badge colour; every other type shares one.
  The card links to the detail page.
- A **Download** button per card calls `/api/download` and opens the resolved
  URL in a new tab, with inline error states.
- A **⚙ Settings** panel holding the secret key and the mirror. The key lives in
  `localStorage` (`annasDownloadKey`) and is sent as a `Bearer` token on both
  search and download requests.

Every scraped string is HTML-escaped before it reaches the DOM — search results
are user-submitted data and treated as an XSS vector.

## Project layout

```
api/
  search.js        /api/search — validation + JSON shaping
  download.js      /api/download — key extraction + proxy
  bearer.js        Shared Authorization: Bearer parsing
lib/
  annas.js         Scrape + download core, session handling
public/
  index.html       The entire front end
test/
  parse.test.mjs   Offline parser tests
  fixtures/        Saved search-page HTML
deploy/
  deploy-lxc.sh    Create a Proxmox LXC, run the app as a systemd service
  undeploy-lxc.sh  Stop and destroy it
dev.mjs            Express server
Dockerfile         node:24-alpine, non-root, prod deps
.dockerignore      Keeps the build context lean
```
