// Test bot: joins the local dev server and walks to the lake nearest spawn
// so a spectator (the name-gate camera follows a random player) can be
// screenshotted looking at water. Usage: node tools/waterbot.mjs [tx tz]
import WebSocket from 'ws';
import { encodeCmd } from '../shared/protocol.js';

const [tx, tz] = process.argv.length > 3
  ? [Number(process.argv[2]), Number(process.argv[3])]
  : [-200, -60]; // center of the lake nearest spawn on Zeemap

const ws = new WebSocket('ws://localhost:5173/ws');
ws.on('open', () => {
  ws.send(encodeCmd({ t: 'join', name: 'waterbot' }));
  setInterval(() => {
    ws.send(encodeCmd({
      t: 'input', tx, tz, ax: 0, az: 0, fps: false, yaw: 0, atk: false, def: false,
    }));
  }, 100);
  console.log(`waterbot: joined, walking to (${tx}, ${tz})`);
});
ws.on('error', (e) => { console.error('waterbot:', e.message); process.exit(1); });
