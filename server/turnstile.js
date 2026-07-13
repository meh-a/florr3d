// Cloudflare Turnstile: the second layer of join defense, for traffic that
// clears the join-token check (jointoken.js) by actually running a browser
// (headless or otherwise). Verified server-side via Cloudflare's siteverify
// API — the client only ever holds the ephemeral, single-use response
// token, never the secret.
//
// Env: TURNSTILE_SITE_KEY (public, served to the client), TURNSTILE_SECRET_KEY
// (private). Unset in dev: verifyTurnstile always passes and the client
// widget never renders (see /turnstile-sitekey serving an empty key), so
// `npm run dev` needs no Cloudflare account.
const SECRET = process.env.TURNSTILE_SECRET_KEY;
export const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

if (!SECRET) {
  console.warn('turnstile: TURNSTILE_SECRET_KEY not set — human check disabled (fine for dev, not for prod)');
}

export const turnstileConfigured = () => !!SECRET;

export async function verifyTurnstile(token, ip) {
  if (!SECRET) return true; // not configured — dev fallback
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: SECRET, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return data.success === true;
  } catch (err) {
    console.error('turnstile: siteverify request failed —', err.message);
    return false;
  }
}
