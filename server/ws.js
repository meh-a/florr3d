import { WebSocketServer } from 'ws';
import { World } from './world.js';

const TICK_MS = 1000 / 30;

// Attach the game websocket endpoint to an existing http server (the vite
// dev/preview server in development, or server/index.js standalone). Uses
// noServer + manual upgrade routing so it coexists with vite's HMR socket.
//
// One shared World per process: every connection becomes a Player in it.
// A single tick loop advances the world and sends each connection its own
// per-recipient snapshot (own inventory/toasts stay private).
export function attachGameServer(httpServer, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });
  const world = new World();
  const sockets = new Map(); // playerId -> ws

  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) return; // someone else's upgrade (e.g. vite HMR)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    // clamp like the old client loop so a stalled event loop can't
    // produce a huge physics step
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (world.players.size === 0) return; // empty world idles
    world.tick(dt);
    const snapshots = world.buildSnapshots();
    for (const [playerId, ws] of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshots.get(playerId)));
    }
  }, TICK_MS);

  wss.on('connection', (ws) => {
    const player = world.addPlayer();
    sockets.set(player.id, ws);

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      try { world.handle(player.id, msg); } catch (err) { console.error('bad message', err); }
    });
    ws.on('close', () => {
      sockets.delete(player.id);
      world.removePlayer(player.id);
    });
  });

  return wss;
}
