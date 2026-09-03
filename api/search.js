import { search, AnnasArchiveError } from "../lib/annas.js";
import { getBearerKey } from "./bearer.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export default async function handler(req, res) {
  const query = (req.query.query || "").trim();
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, parseInt(req.query.limit, 10) || DEFAULT_LIMIT)
  );
  const includeDownloads = req.query.downloads !== "false";
  const tld = (req.query.tld || "").trim() || undefined;
  // Required in practice: the upstream challenges anonymous searches, so a
  // request without this fails with a 401. Kept optional here so an
  // unauthenticated search starts working again if that ever changes.
  const key = getBearerKey(req) || undefined;

  try {
    const results = await search(query, { limit, includeDownloads, tld, key });
    res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    // A challenge or a rejected key is a 401 the UI can act on, not a 502.
    const status =
      err.status || (err instanceof AnnasArchiveError ? 502 : 500);
    res.status(status).json({ error: err.message, code: err.code });
  }
}
