import { fastDownload } from "../lib/annas.js";

// The fast-download key is supplied per request via `Authorization: Bearer
// <key>`, with an optional env-var fallback for server-side/CLI use. No
// secrets are read from disk.
const ENV_DOWNLOAD_KEY = process.env.ANNAS_DOWNLOAD_KEY || null;

function getDownloadKey(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : ENV_DOWNLOAD_KEY;
}

export default async function handler(req, res) {
  const key = getDownloadKey(req);
  if (!key) {
    res.status(401).json({ error: "Download key not set — add it in Settings." });
    return;
  }

  const md5 = req.query.md5;
  if (!md5) {
    res.status(400).json({ error: "md5 is required" });
    return;
  }

  try {
    const data = await fastDownload(md5, key);
    res.status(200).json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}
