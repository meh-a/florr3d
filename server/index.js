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
import { mapPayload } from './map.js';
import { mintJoinToken } from './jointoken.js';
import { clientIp } from './utils.js';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.glb': 'model/gltf-binary', '.jpg': 'image/jpeg',
};

const port = Number(process.env.PORT) || 8081;
const server = http.createServer(async (req, res) => {
  if (await handleAuth(req, res)) return;
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // the loaded map, already normalized; 404 tells the client to use the
  // built-in defaults (must revalidate so a redeployed map propagates)
  if (pathname === '/map.json') {
    if (!mapPayload) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    res.end(JSON.stringify(mapPayload));
    return;
  }
  // minted fresh per request — never cache
  if (pathname === '/join-token') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ token: mintJoinToken(clientIp(req)) }));
    return;
  }
  // resolve inside dist/ only; normalize() defuses ../ traversal
  const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel === '/' || rel === '\\' ? 'index.html' : rel);
  // vite emits content-hashed filenames under /assets/, so those can be
  // cached forever — a returning player re-downloads a model or bundle only
  // when its content actually changed. Everything else (index.html, icons)
  // must revalidate so deploys propagate.
  const cache = rel.startsWith('/assets/') || rel.startsWith('\\assets\\')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': cache,
    });
    res.end(body);
  } catch {
    // SPA-ish fallback: unknown paths get the game page
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' });
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
