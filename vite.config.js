import { defineConfig } from 'vite';
import { attachGameServer } from './server/ws.js';
import { handleAuth } from './server/auth.js';
import { mapPayload } from './server/map.js';
import { mintJoinToken } from './server/jointoken.js';
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
const attachJoinToken = (server) => server.middlewares.use((req, res, next) => {
  if (new URL(req.url, 'http://localhost').pathname !== '/join-token') return next();
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ token: mintJoinToken(clientIp(req)) }));
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
