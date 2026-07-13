// "Already passed Turnstile" cookie: same signed-payload shape as
// jointoken.js, but long-lived and reusable — Turnstile only needs to run
// once per browser per few hours, not on every reconnect (a real player's
// tab reconnecting after a network blip or a server restart shouldn't have
// to re-solve a challenge). /join-token (index.js, vite.config.js) issues
// this the first time a connection clears Turnstile, then accepts the
// cookie in place of a fresh Turnstile token on subsequent calls.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const HUMAN_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// per-process secret: a restart just means everyone re-verifies with
// Turnstile once more, same tradeoff as jointoken.js
const secret = randomBytes(32).toString('hex');
const sign = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');

export function makeHumanCookie(ip) {
  const payload = `${ip}.${Date.now() + HUMAN_TTL_MS}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyHumanCookie(cookie, ip) {
  if (typeof cookie !== 'string') return false;
  const i = cookie.lastIndexOf('.');
  if (i < 0) return false;
  const payload = cookie.slice(0, i);
  const macBuf = Buffer.from(cookie.slice(i + 1));
  const expected = Buffer.from(sign(payload));
  if (macBuf.length !== expected.length || !timingSafeEqual(macBuf, expected)) return false;
  // ip may itself contain dots (IPv4) — split on the LAST dot, since expiry
  // (numeric) never does
  const j = payload.lastIndexOf('.');
  const tokenIp = payload.slice(0, j);
  const expiry = Number(payload.slice(j + 1));
  return tokenIp === ip && Date.now() <= expiry;
}
