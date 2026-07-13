// Transport to the authoritative game server.
//
// If VITE_WS_URL is set at build time, this build is pinned to that dedicated
// server: it connects there, retries forever, and never falls back to the
// in-browser worker.
//
// Otherwise it prefers the websocket endpoint on the same host as the page
// (attached to the vite server in dev, server/index.js standalone), and if
// the very first connection attempt fails — e.g. a static deploy like GitHub
// Pages — it falls back to running the same server sim in a Web Worker.
import { DeltaAssembler, encodeCmd } from '../../shared/protocol.js';

const DEDICATED_URL = import.meta.env.VITE_WS_URL;

export class Net {
  constructor({ onState, onStatus }) {
    this.onState = onState;
    this.onStatus = onStatus; // ('online' | 'offline' | 'local')
    this.ws = null;
    this.worker = null;
    this.everConnected = false;
    this.updating = false; // server announced a deploy before going down
    this.connect();
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(DEDICATED_URL || `${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer'; // snapshots arrive as binary frames
    this.ws = ws;
    // snapshots are deltas against what this connection has already
    // received — a new connection means the server starts from scratch,
    // so the assembler must too
    const assembler = new DeltaAssembler();
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.everConnected = true;
      // the server we're reaching now is the freshly-deployed one, but this
      // tab still runs the old bundle — reload to pick up the new client
      // rather than risk an old-client/new-protocol mismatch
      if (this.updating) { location.reload(); return; }
      this.onStatus?.('online');
    };
    ws.onmessage = (ev) => {
      // binary frame = state snapshot; text frames = rare control messages
      if (ev.data instanceof ArrayBuffer) {
        try { this.onState(assembler.apply(ev.data)); } catch (err) { console.error('bad state frame', err); }
        return;
      }
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.t === 'state') this.onState(msg); // worker/legacy path
      else if (msg.t === 'update') {
        this.updating = true;
        this.onStatus?.('updating');
      } else if (msg.t === 'full') {
        this.onStatus?.('full'); // join refused under critical load
      }
    };
    ws.onclose = () => {
      this.ws = null;
      if (!this.everConnected && !DEDICATED_URL) {
        // no server here at all — host the sim ourselves
        this.startWorker();
        return;
      }
      if (opened) this.onStatus?.('offline');
      setTimeout(() => this.connect(), 1000);
    };
  }

  startWorker() {
    this.worker = new Worker(
      new URL('../../server/worker.js', import.meta.url),
      { type: 'module' }
    );
    this.worker.onmessage = (ev) => this.onState(ev.data);
    this.onStatus?.('local');
  }

  send(obj) {
    if (this.worker) this.worker.postMessage(obj);
    else if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeCmd(obj));
  }

  // `join` needs a fresh, short-lived proof-of-page-load token (see
  // server/jointoken.js) — fetched right before sending rather than once
  // at boot, since its ~45s TTL wouldn't survive someone idling on the
  // name gate. The worker (offline) path has no server to check it, so it
  // skips the fetch entirely.
  async sendJoin(name) {
    let token = '';
    if (!this.worker) {
      try {
        const res = await fetch('/join-token');
        if (res.ok) ({ token } = await res.json());
      } catch { /* offline/dev without the route — server will just refuse */ }
    }
    this.send({ t: 'join', name, token });
  }
}
