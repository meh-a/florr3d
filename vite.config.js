import { defineConfig } from 'vite';
import { attachGameServer } from './server/ws.js';
import { handleAuth, parseCookies, sessionFromCookie } from './server/auth.js';
import { mapPayload } from './server/map.js';
import { mintJoinToken } from './server/jointoken.js';
import { verifyTurnstile, turnstileConfigured, TURNSTILE_SITE_KEY } from './server/turnstile.js';
import { makeHumanCookie, verifyHumanCookie, HUMAN_TTL_MS } from './server/human.js';
import { clientIp } from './server/utils.js';

// The authoritative game server piggybacks on vite's http server in dev and
// preview, so `npm run dev` is all you need. server/index.js runs it standalone.
// The /auth/* routes ride along too, so login flows are testable in dev.
// Importing server/map.js also loads map.json into this process's sim; the
// middleware serves the same payload to the dev client.
const attachAuth = (server) => server.middlewares.use((req, res, next) => {
  handleAuth(req, res).then((handled) => { if (!handled) next(); }, next);
});
const attachMap = (server) => server.middlewares.use((req, res, next) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/map.json') return next();
  if (!mapPayload) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(mapPayload));
});
const attachJoinToken = (server) => server.middlewares.use(async (req, res, next) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/turnstile-sitekey') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ siteKey: TURNSTILE_SITE_KEY }));
    return;
  }
  if (pathname !== '/join-token') return next();
  const ip = clientIp(req);
  const loggedIn = sessionFromCookie(req.headers.cookie) != null;
  if (!loggedIn && turnstileConfigured() && !verifyHumanCookie(parseCookies(req.headers.cookie).human, ip)) {
    const url = new URL(req.url, 'http://localhost');
    const ok = await verifyTurnstile(url.searchParams.get('turnstile'), ip);
    if (!ok) { res.writeHead(403, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'human-check-required' })); return; }
    res.setHeader('Set-Cookie',
      `human=${makeHumanCookie(ip)}; Path=/; Max-Age=${HUMAN_TTL_MS / 1000}; HttpOnly; Secure; SameSite=Lax`);
  }
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ token: mintJoinToken(ip) }));
});
const attach = (server) => {
  attachGameServer(server.httpServer); attachAuth(server); attachMap(server); attachJoinToken(server);
};
const gameServerPlugin = {
  name: 'florr3d-game-server',
  configureServer: attach,
  configurePreviewServer: attach,
};

// GitHub Pages serves project sites under /<repo-name>/, so asset URLs
// need that prefix in production builds.
export default defineConfig({
  root: 'client',
  base: process.env.GITHUB_ACTIONS ? '/florr3d/' : '/',
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [gameServerPlugin],
});
