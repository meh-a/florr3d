import { defineConfig } from 'vite';
import { attachGameServer } from './server/ws.js';

// The authoritative game server piggybacks on vite's http server in dev and
// preview, so `npm run dev` is all you need. server/index.js runs it standalone.
const gameServerPlugin = {
  name: 'florr3d-game-server',
  configureServer(server) { attachGameServer(server.httpServer); },
  configurePreviewServer(server) { attachGameServer(server.httpServer); },
};

// GitHub Pages serves project sites under /<repo-name>/, so asset URLs
// need that prefix in production builds.
export default defineConfig({
  root: 'client',
  base: process.env.GITHUB_ACTIONS ? '/florr3d/' : '/',
  build: { outDir: '../dist', emptyOutDir: true },
  plugins: [gameServerPlugin],
});
