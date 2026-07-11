// Web Worker entry: the same authoritative World the websocket server runs,
// hosted in-browser for static deploys (GitHub Pages) where there is no
// server to connect to. The sim code is identical — only the transport
// differs (postMessage instead of a websocket). Fundamentally solo: the
// world has exactly one player, this tab's.
import { World } from './world.js';

const TICK_MS = 1000 / 30;
const world = new World();
let player = null;    // spawned by `join` from the name gate, like ws.js
let specTarget = null; // pre-join spectate: solo world, so always a mob
let last = performance.now();

setInterval(() => {
  const now = performance.now();
  // clamp like the websocket server so a stalled worker can't produce a
  // huge physics step
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  world.tick(dt);
  if (player) {
    postMessage(world.buildSnapshots().get(player.id));
  } else {
    specTarget = world.spectateTarget(specTarget);
    postMessage(world.buildSnapshots([{ key: 'spec', ...specTarget }]).get('spec'));
  }
}, TICK_MS);

onmessage = (ev) => {
  const msg = ev.data;
  if (!player) {
    if (msg?.t === 'join') {
      player = world.addPlayer();
      try { world.handle(player.id, msg); } catch (err) { console.error('bad message', err); }
    }
    return;
  }
  try { world.handle(player.id, msg); } catch (err) { console.error('bad message', err); }
};
