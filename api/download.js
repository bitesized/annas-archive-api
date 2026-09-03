import { fastDownload } from "../lib/annas.js";
import { getBearerKey } from "./bearer.js";

export default async function handler(req, res) {
  const key = getBearerKey(req);
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
