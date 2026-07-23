import { fastDownload } from "../lib/annas.js";

// The fast-download key is supplied per request via `Authorization: Bearer
// <key>`. No secrets are read from disk or from the environment — an env
// fallback would make this an open proxy on the operator's key when the
// server is exposed on a network without auth.
function getDownloadKey(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
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

  const tld = (req.query.tld || "").trim() || undefined;

  try {
    const data = await fastDownload(md5, key, { tld });
    res.status(200).json(data);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
}
