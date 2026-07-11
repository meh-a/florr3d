// Standalone production server: serves the built client from dist/ and the
// authoritative game endpoint on /ws. Deploy this anywhere Node runs
// (Fly.io, Railway, Render, a VPS): `npm run build && npm run server`.
//
// In development you don't need this — the vite plugin in vite.config.js
// attaches the same endpoint to the dev server.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachGameServer } from './ws.js';
import { handleAuth } from './auth.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

const port = Number(process.env.PORT) || 8081;
const server = http.createServer(async (req, res) => {
  if (await handleAuth(req, res)) return;
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // resolve inside dist/ only; normalize() defuses ../ traversal
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel === '/' || rel === '\\' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    // SPA-ish fallback: unknown paths get the game page
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('client not built — run `npm run build` first\n');
    }
  }
});

attachGameServer(server);
server.listen(port, () => {
  console.log(`florr3d listening on http://localhost:${port} (game endpoint /ws)`);
});
