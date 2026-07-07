import { WebSocketServer } from 'ws';
import { Game } from './game.js';

const TICK_MS = 1000 / 30;

// Attach the game websocket endpoint to an existing http server (the vite
// dev/preview server in development, or server/index.js standalone). Uses
// noServer + manual upgrade routing so it coexists with vite's HMR socket.
export function attachGameServer(httpServer, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) return; // someone else's upgrade (e.g. vite HMR)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    const game = new Game();
    let last = performance.now();

    const interval = setInterval(() => {
      const now = performance.now();
      // clamp like the old client loop so a stalled event loop can't
      // produce a huge physics step
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      game.tick(dt);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(game.snapshot()));
    }, TICK_MS);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try { game.handle(msg); } catch (err) { console.error('bad message', err); }
    });
    ws.on('close', () => clearInterval(interval));
  });

  return wss;
}
