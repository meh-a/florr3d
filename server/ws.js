import { WebSocketServer } from 'ws';
import { World } from './world.js';
import { sessionFromCookie } from './auth.js';
import { loadSave, writeSave } from './db.js';

const TICK_MS = 1000 / 30;
const AUTOSAVE_MS = 60_000;

// Attach the game websocket endpoint to an existing http server (the vite
// dev/preview server in development, or server/index.js standalone). Uses
// noServer + manual upgrade routing so it coexists with vite's HMR socket.
//
// One shared World per process: every connection becomes a Player in it —
// but only once it sends `join` from the name gate. Until then it's a
// spectator: it receives world snapshots centered on a random living player
// (or a mob when nobody's online) so the start screen shows the live world,
// without a controllable flower existing for it.
// A single tick loop advances the world and sends each connection its own
// per-recipient snapshot (own inventory/toasts stay private).
export function attachGameServer(httpServer, path = '/ws') {
  const wss = new WebSocketServer({ noServer: true });
  const world = new World();
  const sockets = new Map();    // playerId -> ws
  const spectators = new Map(); // ws -> { key, target } for pre-join connections
  const accounts = new Map();   // playerId -> accountId, for logged-in players
  let nextSpecKey = 1;

  // periodic safety net; the authoritative save happens on disconnect
  setInterval(() => {
    for (const [playerId, accountId] of accounts) {
      const player = world.players.get(playerId);
      if (player) writeSave(accountId, player.serializeSave());
    }
  }, AUTOSAVE_MS);

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
    if (world.players.size === 0 && spectators.size === 0) return; // empty world idles
    world.tick(dt);
    const specViews = [];
    for (const spec of spectators.values()) {
      spec.target = world.spectateTarget(spec.target);
      specViews.push({ key: spec.key, ...spec.target });
    }
    const snapshots = world.buildSnapshots(specViews);
    for (const [playerId, ws] of sockets) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshots.get(playerId)));
    }
    for (const [ws, spec] of spectators) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(snapshots.get(spec.key)));
    }
  }, TICK_MS);

  wss.on('connection', (ws, req) => {
    let player = null; // spawned lazily by `join`, not on connect
    const accountId = sessionFromCookie(req?.headers?.cookie);
    spectators.set(ws, { key: `spec${nextSpecKey++}`, target: null });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!player) {
        // spectators have exactly one valid intent: joining the world
        if (msg?.t === 'join') {
          spectators.delete(ws);
          player = world.addPlayer();
          sockets.set(player.id, ws);
          // logged in: restore saved progress — unless this account is
          // already playing on another connection (would duplicate the
          // save on the two disconnects); the extra tab plays as a guest
          if (accountId != null && ![...accounts.values()].includes(accountId)) {
            player.applySave(loadSave(accountId));
            accounts.set(player.id, accountId);
          }
          try { world.handle(player.id, msg); } catch (err) { console.error('bad message', err); }
        }
        return;
      }
      try { world.handle(player.id, msg); } catch (err) { console.error('bad message', err); }
    });
    ws.on('close', () => {
      spectators.delete(ws);
      if (player) {
        const acct = accounts.get(player.id);
        if (acct != null) {
          writeSave(acct, player.serializeSave());
          accounts.delete(player.id);
        }
        sockets.delete(player.id);
        world.removePlayer(player.id);
      }
    });
  });

  return wss;
}
