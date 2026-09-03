/**
 * Shared `Authorization: Bearer <key>` extraction.
 *
 * The Anna's Archive account secret key doubles as the fast-download key, so
 * both handlers take it the same way: per request, from the header, never from
 * disk or the environment. An env fallback would make this an open proxy on the
 * operator's key when the server is exposed on a network without auth.
 */
export function getBearerKey(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}
