// Join tokens: proof that a `join` command came from a browser that just
// loaded the real page over HTTP, not a script speaking the websocket
// protocol directly. GET /join-token (server/index.js, vite.config.js)
// mints one bound to the requester's IP with a short TTL; ws.js requires a
// valid, unused token on every `join`. This is what actually stops naive
// flood scripts — they never fetch the page, so they never have a token —
// where matching on the display NAME (trivially changed) did not.
//
// Not proof against a real (even headless) browser automating the fetch +
// connect dance; that tier is what Turnstile is for.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 45_000;
// per-process secret: a restart invalidates every outstanding token, which
// is fine — the graceful-shutdown {t:'update'} flow makes every client
// reload and refetch a fresh one anyway
const secret = randomBytes(32).toString('hex');
const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

// single-use: a token is consumed the moment it's accepted, so a leaked or
// intercepted token can't be replayed into a second connection
const used = new Map(); // token -> expiry, pruned periodically
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of used) if (now > exp) used.delete(t);
}, 60_000).unref();

export function mintJoinToken(ip) {
  const payload = `${ip}.${Date.now() + TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyJoinToken(token, ip) {
  if (typeof token !== 'string' || used.has(token)) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  const macBuf = Buffer.from(token.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (macBuf.length !== expected.length || !timingSafeEqual(macBuf, expected)) return false;
  // ip may itself contain dots (IPv4) — split on the LAST dot in the
  // payload, since expiry (numeric) never does
  const j = payload.lastIndexOf('.');
  const tokenIp = payload.slice(0, j);
  const expiry = Number(payload.slice(j + 1));
  if (tokenIp !== ip || Date.now() > expiry) return false;
  used.set(token, expiry);
  return true;
}
