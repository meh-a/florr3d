// Web Worker entry: the same authoritative Game the websocket server runs,
// hosted in-browser for static deploys (GitHub Pages) where there is no
// server to connect to. The sim code is identical — only the transport
// differs (postMessage instead of a websocket).
import { Game } from './game.js';

const TICK_MS = 1000 / 30;
const game = new Game();
let last = performance.now();

setInterval(() => {
  const now = performance.now();
  // clamp like the websocket server so a stalled worker can't produce a
  // huge physics step
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  game.tick(dt);
  postMessage(game.snapshot());
}, TICK_MS);

onmessage = (ev) => {
  try { game.handle(ev.data); } catch (err) { console.error('bad message', err); }
};
