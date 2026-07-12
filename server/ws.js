import { WebSocketServer } from 'ws';
import { encodeState } from '../shared/protocol.js';
import { World } from './world.js';
import { sessionFromCookie } from './auth.js';
import { loadSave, writeSave } from './db.js';

// 20Hz: at 40+ players the per-tick serialize+deflate work saturated the
// VM's single core at 30Hz (late ticks -> ping spikes -> the dead-peer
// reaper cutting live players). The client interpolates between snapshots,
// so the lower rate costs little visually and buys ~35% CPU headroom.
const TICK_MS = 1000 / 20;
const AUTOSAVE_MS = 60_000;
const HEARTBEAT_MS = 30_000;
// A connection that stops reading keeps readyState OPEN while every send
// piles up in ws's in-memory buffer (~300KB/s at our snapshot rate) — left
// alone, one stalled client OOMs the process in a couple of hours. Past
// this ceiling we cut the connection instead of buffering; the player
// couldn't play at that latency anyway, and close() cleanup saves them.
const MAX_BUFFERED = 1_000_000;

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
  // permessage-deflate: snapshots are repetitive JSON and compress ~5-10x.
  // No context takeover on either side — a shared zlib context per
  // connection is the classic ws memory-bloat footgun, and per-message
  // compression at level 1 keeps CPU negligible at 30Hz while giving up
  // little ratio on JSON. Browsers negotiate this transparently.
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: {
      serverNoContextTakeover: true,
      clientNoContextTakeover: true,
      zlibDeflateOptions: { level: 1 },
      // binary snapshots are already compact (quantized ints compress
      // poorly anyway) — only frames well past typical snapshot size are
      // worth zlib CPU
      threshold: 8192,
    },
  });
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

  // once-a-minute tick cost breakdown in the journal — sim vs snapshot
  // build vs serialize+send — so optimization targets are measured, not
  // guessed. A tick budget is TICK_MS; sustained avg near it means the
  // core is saturating.
  const perf = { n: 0, sim: 0, build: 0, send: 0, max: 0 };
  setInterval(() => {
    if (perf.n === 0) return;
    const ms = (v) => (v / perf.n).toFixed(1);
    console.log(`[tick] players=${world.players.size} spectators=${spectators.size} ` +
      `avg=${ms(perf.sim + perf.build + perf.send)}ms ` +
      `(sim=${ms(perf.sim)} build=${ms(perf.build)} send=${ms(perf.send)}) ` +
      `max=${perf.max.toFixed(1)}ms of ${TICK_MS.toFixed(1)}ms budget`);
    perf.n = perf.sim = perf.build = perf.send = perf.max = 0;
  }, 60_000);

  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    // clamp like the old client loop so a stalled event loop can't
    // produce a huge physics step (2 ticks of headroom at 20Hz — a hard
    // clamp at the nominal interval would run the world in slow motion)
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    if (world.players.size === 0 && spectators.size === 0) return; // empty world idles
    const t0 = performance.now();
    world.tick(dt);
    const t1 = performance.now();
    const specViews = [];
    for (const spec of spectators.values()) {
      spec.target = world.spectateTarget(spec.target);
      specViews.push({ key: spec.key, ...spec.target });
    }
    const snapshots = world.buildSnapshots(specViews);
    const t2 = performance.now();
    const deliver = (ws, snapshot) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; }
      ws.send(encodeState(snapshot)); // binary frame; control messages stay JSON text
    };
    for (const [playerId, ws] of sockets) deliver(ws, snapshots.get(playerId));
    for (const [ws, spec] of spectators) deliver(ws, snapshots.get(spec.key));
    const t3 = performance.now();
    perf.n++;
    perf.sim += t1 - t0;
    perf.build += t2 - t1;
    perf.send += t3 - t2;
    perf.max = Math.max(perf.max, t3 - t0);
  }, TICK_MS);

  // Dead-peer reaper: a connection that vanished without a FIN never fires
  // 'close' on its own; ping it and cut it if the previous ping went
  // unanswered. terminate() fires 'close', which runs the normal cleanup
  // (save, remove player) — so ghosts can't linger as immortal flowers.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);

  // Graceful shutdown (deploys, restarts): save every logged-in player —
  // the close-handler saves never run when the process is killed, which
  // used to cost up to AUTOSAVE_MS of progress — and tell every client
  // this is an update, so they can show "updating…" and reload into the
  // new bundle instead of silently reconnecting with a stale one.
  const shutdown = () => {
    for (const [playerId, accountId] of accounts) {
      const player = world.players.get(playerId);
      if (player) writeSave(accountId, player.serializeSave());
    }
    const bye = JSON.stringify({ t: 'update' });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(bye);
    }
    setTimeout(() => process.exit(0), 300).unref(); // let the sends flush
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  wss.on('connection', (ws, req) => {
    let player = null; // spawned lazily by `join`, not on connect
    const accountId = sessionFromCookie(req?.headers?.cookie);
    spectators.set(ws, { key: `spec${nextSpecKey++}`, target: null });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
