/**
 * Anna's Archive search + download core.
 *
 * Ports the original Python service (parser.py + client.py) to JavaScript:
 *  - parseSearchResults: scrape the static search HTML into result objects.
 *  - search: fetch the search page, parse it, and fan out concurrent
 *    download-count lookups (those counts are loaded client-side by the real
 *    site from /dyn/md5/inline_info/<md5>, not present in the search HTML).
 *  - fastDownload: proxy a fast-download request using the caller's key.
 */

import { createHash } from "node:crypto";

import { load } from "cheerio";

export const BASE_URL = process.env.ANNAS_BASE_URL || "https://annas-archive.gd";

/**
 * Resolve the upstream base URL for a given TLD. Anna's Archive runs the same
 * site across several mirrors that differ only in TLD (.gd, .gs, .se, …), so a
 * caller can pass `tld: "gs"` to target https://annas-archive.gs. The base
 * host (everything but the final label) is taken from BASE_URL so an overridden
 * ANNAS_BASE_URL still works. Unknown/invalid TLDs fall back to BASE_URL.
 */
export function resolveBaseUrl(tld) {
  if (!tld) return BASE_URL;
  const safe = String(tld).trim().replace(/^\.+/, "").toLowerCase();
  if (!/^[a-z]{2,}$/.test(safe)) return BASE_URL;
  const url = new URL(BASE_URL);
  url.hostname = url.hostname.replace(/\.[^.]+$/, `.${safe}`);
  return url.origin;
}

// A browser-like UA keeps DDoS-Guard from serving us a challenge page.
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

// Cap on simultaneous inline_info requests so we stay polite to the origin.
const DOWNLOAD_CONCURRENCY = 10;

const REQUEST_TIMEOUT_MS = 30_000;

// Anna's Archive pushes unauthenticated requests for /search and /md5/ through a
// DDoS-Guard JS challenge that a plain fetch cannot solve; a signed-in session
// skips it. We trade the account secret key (the same key /api/download uses)
// for a session cookie and cache only that cookie, keyed by a hash of the key —
// the key itself is never retained. The TTL is an optimisation; expiry is really
// handled by re-logging in when a challenge is detected.
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;

/** sha256(key + mirror) -> { cookie, at }. In-memory only, never persisted. */
const sessions = new Map();

/** Raised when the upstream site cannot be reached or parsed. */
export class AnnasArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "AnnasArchiveError";
  }
}

function clean(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Pull the file format out of the metadata line, e.g.
 *   "English [en] · EPUB · 0.4MB · 2014 · 📕 Book (fiction) · 🚀/lgli/..."
 * Format is the short alphabetic token (epub/pdf/mobi/…). We scan segments
 * rather than hard-coding an index so an extra leading field doesn't break it.
 */
function extractFormat(metaText) {
  for (const seg of metaText.split("·").map((s) => s.trim())) {
    const token = seg.toLowerCase();
    const stripped = token.replace(/-/g, "");
    // Short, all-letter tokens only; skip language-ish "[xx]" segments.
    if (stripped && /^\p{L}+$/u.test(stripped) && token.length <= 6) {
      if (seg.includes("[")) continue;
      return token;
    }
  }
  return null;
}

/** Fallback: locate the metadata line by its emoji/middot signature. */
function findMetaDiv($, card) {
  let found = null;
  card.find("div").each((_, el) => {
    if (found) return;
    const div = $(el);
    const text = div.text();
    const hasSignature =
      text.includes("📕") ||
      text.includes("📘") ||
      text.includes("📗") ||
      text.includes("MB") ||
      text.includes("KB");
    if (text.includes("·") && hasSignature && div.find("div").length === 0) {
      // Prefer the most specific (deepest) matching div.
      found = div;
    }
  });
  return found;
}

/** Extract all search results from a search page's HTML. */
export function parseSearchResults(html, baseUrl = BASE_URL) {
  const $ = load(html);
  const base = baseUrl.replace(/\/$/, "");
  const results = [];

  // Each result's title is an anchor carrying the `js-vim-focus` class and
  // pointing at /md5/<hash> — the most stable anchor on the card.
  $("a.js-vim-focus[href^='/md5/']").each((_, el) => {
    const titleLink = $(el);
    const href = titleLink.attr("href") || "";
    const md5 = href.split("/").pop();
    // Drop anything that isn't a real 32-hex md5 — the value is mirror-controlled
    // and flows into a JS-string sink in the frontend download button.
    if (!/^[a-f0-9]{32}$/.test(md5)) return;
    const title = clean(titleLink.text());

    // Walk up to the result card so author/meta lookups stay scoped to it.
    let card = titleLink;
    for (let i = 0; i < 6; i++) {
      const parent = card.parent();
      if (parent.length === 0) break;
      card = parent;
      if (card.hasClass("flex") && card.hasClass("pt-3")) break;
    }

    // Author: the anchor whose icon is `mdi--user-edit`.
    let author = "";
    const authorIcon = card.find("span[class*='icon-[mdi--user-edit]']").first();
    if (authorIcon.length) {
      const authorLink = authorIcon.closest("a");
      if (authorLink.length) author = clean(authorLink.text());
    }

    // Cover image inside the cover thumbnail div (some results have none).
    let coverUrl = null;
    const coverImg = card
      .find("div[id^='list_cover_aarecord_id__'] img")
      .first();
    if (coverImg.length) {
      const src = coverImg.attr("src");
      if (src) {
        coverUrl = src.startsWith("http")
          ? src
          : `${base}/${src.replace(/^\//, "")}`;
      }
    }

    // Metadata line (language · FORMAT · size · year · type · sources).
    let metaDiv = card
      .find("div.font-semibold.text-sm")
      .filter((__, d) => ($(d).attr("class") || "").includes("leading-[1.2]"))
      .first();
    if (!metaDiv.length) metaDiv = findMetaDiv($, card);
    const format = metaDiv && metaDiv.length ? extractFormat(metaDiv.text()) : null;

    results.push({
      title,
      author,
      format,
      downloads: null,
      cover_url: coverUrl,
      url: `${base}/md5/${md5}`,
      md5,
    });
  });

  return results;
}

async function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function sessionId(key, baseUrl) {
  return createHash("sha256").update(`${key}\n${baseUrl}`).digest("hex");
}

/**
 * Read Set-Cookie as a list. `getSetCookie()` needs a newer undici than our
 * Node 18 floor guarantees, so fall back to splitting the joined header — only
 * before a `name=` so a comma inside an Expires date doesn't split a cookie.
 */
function readSetCookies(resp) {
  if (typeof resp.headers.getSetCookie === "function") {
    return resp.headers.getSetCookie();
  }
  const raw = resp.headers.get("set-cookie");
  return raw ? raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : [];
}

/**
 * Exchange the account secret key for a session cookie. Anna's Archive
 * authenticates with a single form field (`key`) on POST /account/ and replies
 * with an `aa_account_id2` cookie; anything starting `aa_` is session state.
 */
async function login(baseUrl, key) {
  let resp;
  try {
    resp = await fetchWithTimeout(`${baseUrl}/account/`, {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key }).toString(),
      redirect: "manual",
    });
  } catch (err) {
    throw new AnnasArchiveError(`Failed to reach Anna's Archive: ${err.message}`);
  }

  const cookie = readSetCookies(resp)
    .map((c) => c.split(";")[0].trim())
    .filter((c) => c.startsWith("aa_") && c.includes("="))
    .join("; ");

  if (!cookie) {
    // A bad key still returns 200 with the login form, just no session cookie.
    const err = new AnnasArchiveError(
      "Anna's Archive rejected the download key — check it in Settings."
    );
    err.status = 401;
    throw err;
  }
  return cookie;
}

/** Cached login. `force` discards a stale entry after a challenge. */
async function ensureSession(baseUrl, key, force = false) {
  const id = sessionId(key, baseUrl);
  const hit = sessions.get(id);
  if (!force && hit && Date.now() - hit.at < SESSION_TTL_MS) return hit.cookie;
  const cookie = await login(baseUrl, key);
  sessions.set(id, { cookie, at: Date.now() });
  return cookie;
}

/**
 * A challenge shows up two ways: a 403 straight from DDoS-Guard, or a redirect
 * to the same path with `check=1`. The latter is what an expired session gets,
 * and following it loops until fetch dies with "redirect count exceeded" — so
 * we drive redirects manually and name the condition instead.
 */
function isChallenge(resp) {
  if (resp.status === 403 && /ddos-guard/i.test(resp.headers.get("server") || "")) {
    return true;
  }
  const loc = resp.headers.get("location") || "";
  return resp.status >= 300 && resp.status < 400 && /[?&]check=1/.test(loc);
}

function challengeError() {
  const err = new AnnasArchiveError(
    "Anna's Archive served a bot check instead of results. Add your download " +
      "key in Settings — signed-in searches skip the check."
  );
  err.code = "CHALLENGE";
  err.status = 401;
  return err;
}

/** Follow redirects by hand so a `check=1` hop is reported, not followed. */
async function fetchFollowing(url, options) {
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const resp = await fetchWithTimeout(current, { ...options, redirect: "manual" });
    if (isChallenge(resp)) throw challengeError();
    if (resp.status < 300 || resp.status >= 400) return resp;
    const loc = resp.headers.get("location");
    if (!loc) return resp;
    current = new URL(loc, current);
  }
  throw new AnnasArchiveError("Too many redirects from Anna's Archive.");
}

/**
 * Populate result.downloads from the inline_info endpoint. Failures are
 * swallowed and leave downloads as null so one bad lookup never sinks the
 * whole response.
 */
async function fetchDownloads(result, baseUrl = BASE_URL) {
  try {
    const resp = await fetchWithTimeout(
      `${baseUrl}/dyn/md5/inline_info/${result.md5}`,
      { headers: { ...HEADERS, Accept: "text/css" } }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const n = parseInt(data.downloads_total, 10);
    result.downloads = Number.isNaN(n) ? null : n;
  } catch {
    result.downloads = null;
  }
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function withConcurrency(items, limit, worker) {
  const queue = items.slice();
  const runners = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length) await worker(queue.shift());
    }
  );
  await Promise.all(runners);
}

/**
 * Fetch one search page's HTML, signed in when a key is given. `force` skips
 * the session cache so a stale cookie can be replaced.
 */
async function fetchSearchPage(url, baseUrl, key, force = false) {
  const headers = { ...HEADERS };
  if (key) headers.Cookie = await ensureSession(baseUrl, key, force);

  let resp;
  try {
    resp = await fetchFollowing(url, { headers });
  } catch (err) {
    if (err instanceof AnnasArchiveError) throw err;
    throw new AnnasArchiveError(`Failed to reach Anna's Archive: ${err.message}`);
  }
  if (!resp.ok) {
    throw new AnnasArchiveError(`Failed to reach Anna's Archive: HTTP ${resp.status}`);
  }
  return resp.text();
}

/**
 * Search Anna's Archive and return up to `limit` enriched results. Fetches the
 * search page, parses it, trims to `limit`, and (optionally) fans out
 * concurrent requests to fill in download counts.
 *
 * Pass `key` (the account secret key) to search as a signed-in member, which
 * is what keeps the upstream from answering with a DDoS-Guard challenge.
 */
export async function search(
  query,
  { limit = 20, includeDownloads = true, tld, key } = {}
) {
  const baseUrl = resolveBaseUrl(tld);
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", query);

  let html;
  try {
    html = await fetchSearchPage(url, baseUrl, key);
  } catch (err) {
    // A cached session that has expired looks exactly like being logged out.
    // Log in again once before giving up.
    if (err.code === "CHALLENGE" && key) {
      html = await fetchSearchPage(url, baseUrl, key, true);
    } else {
      throw err;
    }
  }

  const results = parseSearchResults(html, baseUrl).slice(0, limit);

  if (includeDownloads && results.length) {
    await withConcurrency(results, DOWNLOAD_CONCURRENCY, (r) =>
      fetchDownloads(r, baseUrl)
    );
  }

  return results;
}

/**
 * Proxy an Anna's Archive fast-download request. The key belongs to the
 * caller (member account) and is never persisted server-side.
 */
export async function fastDownload(md5, key, { tld } = {}) {
  const baseUrl = resolveBaseUrl(tld);
  const url = new URL(`${baseUrl}/dyn/api/fast_download.json`);
  url.searchParams.set("md5", md5);
  url.searchParams.set("key", key);

  let resp;
  try {
    resp = await fetchWithTimeout(url, { headers: HEADERS });
  } catch (err) {
    throw new AnnasArchiveError(`Failed to reach Anna's Archive: ${err.message}`);
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new AnnasArchiveError(data.error || `HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  return data;
}
