import { defineConfig } from 'vite';
import { attachGameServer } from './server/ws.js';
import { handleAuth } from './server/auth.js';

// The authoritative game server piggybacks on vite's http server in dev and
// preview, so `npm run dev` is all you need. server/index.js runs it standalone.
// The /auth/* routes ride along too, so login flows are testable in dev.
const attachAuth = (server) => server.middlewares.use((req, res, next) => {
  handleAuth(req, res).then((handled) => { if (!handled) next(); }, next);
});
const gameServerPlugin = {
  name: 'florr3d-game-server',
  configureServer(server) { attachGameServer(server.httpServer); attachAuth(server); },
  configurePreviewServer(server) { attachGameServer(server.httpServer); attachAuth(server); },
};

// GitHub Pages serves project sites under /<repo-name>/, so asset URLs
// need that prefix in production builds.
export default defineConfig({
  root: 'client',
  base: process.env.GITHUB_ACTIONS ? '/florr3d/' : '/',
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [gameServerPlugin],
});
