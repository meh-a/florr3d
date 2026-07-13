// Cloudflare Turnstile client glue. Rendered in "interaction-only"
// appearance + "execute" mode: invisible and silent for the vast majority
// of real players (Cloudflare's risk engine clears them with no UI at
// all), and only pops a visible checkbox/challenge for traffic it isn't
// sure about. getTurnstileToken() is only ever called when the server
// says a fresh human-check is actually needed (net.js) — most reconnects
// never touch this at all because the `human` cookie already covers them.
//
// The site key is public by design but fetched at runtime rather than
// baked into the bundle, so it can be rotated without a client rebuild.
// In dev (no TURNSTILE_SITE_KEY on the server) the endpoint returns an
// empty key and this module quietly no-ops.

let siteKeyPromise = null;
function getSiteKey() {
  siteKeyPromise ??= fetch('/turnstile-sitekey')
    .then((r) => (r.ok ? r.json() : { siteKey: '' }))
    .then((d) => d.siteKey)
    .catch(() => '');
  return siteKeyPromise;
}

function waitForScript() {
  return new Promise((resolve) => {
    const check = () => (window.turnstile ? resolve() : setTimeout(check, 100));
    check();
  });
}

let widgetId = null; // null until rendered; stays null forever if unconfigured
let readyPromise = null;
const pending = []; // FIFO resolvers waiting on the widget's one shared callback

function ensureWidget() {
  readyPromise ??= (async () => {
    const siteKey = await getSiteKey();
    if (!siteKey) return; // Turnstile not configured server-side (dev)
    await waitForScript();
    widgetId = window.turnstile.render('#turnstile-container', {
      sitekey: siteKey,
      appearance: 'interaction-only',
      execution: 'execute',
      callback: (token) => pending.shift()?.(token),
      'error-callback': () => pending.shift()?.(null),
    });
  })();
  return readyPromise;
}

// resolves with a fresh response token, or '' if Turnstile isn't
// configured (server will treat a missing token as "not configured" too,
// since it only checks when TURNSTILE_SECRET_KEY is set)
export async function getTurnstileToken() {
  await ensureWidget();
  if (widgetId === null) return '';
  return new Promise((resolve) => {
    pending.push((token) => resolve(token || ''));
    window.turnstile.execute(widgetId);
  });
}
