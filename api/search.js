import { search, AnnasArchiveError } from "../lib/annas.js";

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

  try {
    const results = await search(query, { limit, includeDownloads, tld });
    res.status(200).json({ query, count: results.length, results });
  } catch (err) {
    const status = err instanceof AnnasArchiveError ? 502 : 500;
    res.status(status).json({ error: err.message });
  }
}
