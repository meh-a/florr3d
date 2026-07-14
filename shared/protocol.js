import { PETAL_TYPES, MOB_TYPES, VIEW_RADIUS } from './config.js';

// Binary wire format for the per-tick `state` snapshot — the only message
// that matters for CPU/bandwidth (everything else stays JSON text frames;
// the client tells them apart by frame type). Snapshots are DELTAS: the
// server (DeltaEncoder) tracks per connection which byte-exact version of
// each entity that client already has and sends only changes + removals;
// the client (DeltaAssembler) folds them back into the full state-object
// shape, so neither the sim nor the render layer know the transport
// changed.
//
// Quantization: positions ride as int16 at 1/64 unit (~1.6cm over ±512),
// angles as int16 at 1/8192 rad, cooldown fractions as u8. hp is float32;
// xp values are float64 (they exceed u32 at high levels). Entity/petal
// types are enum indices into the shared config's key order — both sides
// import the same config, so the tables always agree within one build.
// PROTOCOL_VERSION guards across builds: on mismatch the decoder throws,
// and the deploy auto-reload flow gets clients onto the matching build.

export const PROTOCOL_VERSION = 4;

const PETAL_IDS = Object.keys(PETAL_TYPES);
const MOB_IDS = Object.keys(MOB_TYPES);
const PETAL_IDX = new Map(PETAL_IDS.map((k, i) => [k, i]));
const MOB_IDX = new Map(MOB_IDS.map((k, i) => [k, i]));

const POS = 64;      // world units -> int16
const ANG = 8192;    // radians -> int16
const EV = { flash: 0, dmg: 1, toast: 2, chat: 3 };
const EV_NAMES = ['flash', 'dmg', 'toast', 'chat'];

const textEnc = new TextEncoder();
const textDec = new TextDecoder();

class Writer {
  constructor() {
    this.buf = new Uint8Array(4096);
    this.view = new DataView(this.buf.buffer);
    this.at = 0;
  }
  ensure(n) {
    if (this.at + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.at + n));
    next.set(this.buf);
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v) { this.ensure(1); this.view.setUint8(this.at, v); this.at += 1; }
  u16(v) { this.ensure(2); this.view.setUint16(this.at, v); this.at += 2; }
  u32(v) { this.ensure(4); this.view.setUint32(this.at, v); this.at += 4; }
  i16(v) { this.ensure(2); this.view.setInt16(this.at, Math.max(-32768, Math.min(32767, Math.round(v)))); this.at += 2; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.at, v); this.at += 4; }
  f64(v) { this.ensure(8); this.view.setFloat64(this.at, v); this.at += 8; }
  pos(v) { this.i16(v * POS); }
  ang(v) { this.i16(v * ANG); }
  frac8(v) { this.u8(Math.max(0, Math.min(255, Math.round(v * 255)))); }
  str(s) {
    const bytes = textEnc.encode(s ?? '');
    this.u8(Math.min(bytes.length, 255));
    this.ensure(bytes.length);
    this.buf.set(bytes.subarray(0, 255), this.at);
    this.at += Math.min(bytes.length, 255);
  }
  bytes(arr) { this.ensure(arr.length); this.buf.set(arr, this.at); this.at += arr.length; }
  // reserve a u16 (e.g. a count not known until later) and patch it after
  mark16() { const at = this.at; this.u16(0); return at; }
  patch16(at, v) { this.view.setUint16(at, v); }
  done() { return this.buf.subarray(0, this.at); }
}

class Reader {
  constructor(buffer) {
    // accepts ArrayBuffer (browser) or a TypedArray/Buffer view (node)
    const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
    this.view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.u8v = u8;
    this.at = 0;
  }
  u8() { return this.view.getUint8(this.at++); }
  u16() { const v = this.view.getUint16(this.at); this.at += 2; return v; }
  u32() { const v = this.view.getUint32(this.at); this.at += 4; return v; }
  i16() { const v = this.view.getInt16(this.at); this.at += 2; return v; }
  f32() { const v = this.view.getFloat32(this.at); this.at += 4; return v; }
  f64() { const v = this.view.getFloat64(this.at); this.at += 8; return v; }
  pos() { return this.i16() / POS; }
  ang() { return this.i16() / ANG; }
  frac8() { return this.u8() / 255; }
  str() {
    const len = this.u8();
    const s = textDec.decode(this.u8v.subarray(this.at, this.at + len));
    this.at += len;
    return s;
  }
}

// ---- entity records ----
// Server-side writers take LIVE server objects (Player/Mob instances);
// readers reconstruct the exact plain shapes the client consumers expect.
// Players are split in two: a STATIC block (identity + loadout + petal
// composition — changes rarely) and a DYNAMIC block (position, hp, petal
// motion — changes every tick). The delta layer resends each block only
// when its bytes changed.

function writeSlot(w, slot) {
  if (!slot) { w.u8(255); return; }
  w.u8(PETAL_IDX.get(slot.type));
  w.u8(slot.rarity);
}
function readSlot(r) {
  const t = r.u8();
  if (t === 255) return null;
  return { type: PETAL_IDS[t], rarity: r.u8() };
}

function writePlayerStatic(w, p) {
  w.str(p.name);
  w.u16(p.level);
  w.f32(p.maxHp);
  w.frac8((p.petals.rotFactor - 0.3) / 0.7);
  for (const slot of p.petals.primary) writeSlot(w, slot);
  for (const slot of p.petals.secondary) writeSlot(w, slot);
  w.u8(p.petals.instances.length);
  for (const inst of p.petals.instances) {
    w.u32(inst.id);
    w.u8(inst.slotIdx);
    w.u8(PETAL_IDX.get(inst.type));
    w.u8(inst.rarity);
  }
}
function readPlayerStatic(r) {
  const s = {
    name: r.str(), level: r.u16(), maxHp: r.f32(),
    rotFactor: r.frac8() * 0.7 + 0.3,
    primary: [], secondary: [], comp: [],
  };
  for (let i = 0; i < 5; i++) s.primary.push(readSlot(r));
  for (let i = 0; i < 5; i++) s.secondary.push(readSlot(r));
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    s.comp.push({ id: r.u32(), slot: r.u8(), type: PETAL_IDS[r.u8()], rarity: r.u8() });
  }
  return s;
}

function writePlayerDynamic(w, p) {
  w.u8((p.dead ? 1 : 0) | (p.immunity > 0 ? 2 : 0));
  w.pos(p.pos.x); w.pos(p.pos.z); w.ang(p.facing);
  w.f32(p.hp);
  w.u8(Math.max(0, Math.min(255, Math.round(p.deadTimer * 50))));
  w.u8(p.petals.instances.length);
  for (const inst of p.petals.instances) {
    w.u8(inst.alive ? 1 : 0);
    w.pos(inst.pos.x); w.pos(inst.pos.z);
    w.frac8(inst.alive ? 0 : Math.min(1, Math.max(0, inst.cooldown / inst.reload)));
  }
}
function readPlayerDynamic(r) {
  const flags = r.u8();
  const d = {
    dead: !!(flags & 1), imm: !!(flags & 2),
    x: r.pos(), z: r.pos(), facing: r.ang(),
    hp: r.f32(), deadTimer: r.u8() / 50,
    inst: [],
  };
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    d.inst.push({ alive: r.u8() === 1, x: r.pos(), z: r.pos(), cd: r.frac8() });
  }
  return d;
}

function writeMob(w, m) {
  w.u32(m.id);
  w.u8(MOB_IDX.get(m.type));
  w.u8(m.rarity);
  w.pos(m.pos.x); w.pos(m.pos.z); w.ang(m.facing);
  w.f32(m.hp); w.f32(m.maxHp);
  const flying = !!m.flight;
  w.u8((flying ? 1 : 0) | (m.loaded ? 2 : 0));
  if (flying) { w.pos(m.pos.y); w.ang(m.pitch); }
}
function readMob(r) {
  const m = {
    id: r.u32(), type: MOB_IDS[r.u8()], rarity: r.u8(),
    x: r.pos(), z: r.pos(), facing: r.ang(),
    hp: r.f32(), maxHp: r.f32(),
  };
  const flags = r.u8();
  if (flags & 1) {
    m.loaded = !!(flags & 2);
    m.y = r.pos();
    m.pitch = r.ang();
  }
  return m;
}

const writeMissile = (w, mi) => {
  w.u32(mi.id); w.u8(mi.rarity);
  w.pos(mi.pos.x); w.pos(mi.pos.y); w.pos(mi.pos.z);
  w.ang(mi.yaw); w.ang(mi.pitch);
};
const readMissile = (r) => ({
  id: r.u32(), rarity: r.u8(),
  x: r.pos(), y: r.pos(), z: r.pos(), yaw: r.ang(), pitch: r.ang(),
});

const writePMissile = (w, pm) => {
  w.u32(pm.id); w.u8(PETAL_IDX.get(pm.type)); w.u8(pm.rarity);
  w.pos(pm.pos.x); w.pos(pm.pos.y); w.pos(pm.pos.z); w.ang(pm.yaw); w.ang(pm.pitch);
};
const readPMissile = (r) => ({
  id: r.u32(), type: PETAL_IDS[r.u8()], rarity: r.u8(),
  x: r.pos(), y: r.pos(), z: r.pos(), yaw: r.ang(), pitch: r.ang(),
});

const writeDrop = (w, d) => {
  w.u32(d.id); w.u8(PETAL_IDX.get(d.type)); w.u8(d.rarity);
  w.pos(d.pos.x); w.pos(d.pos.z);
};
const readDrop = (r) => ({
  id: r.u32(), type: PETAL_IDS[r.u8()], rarity: r.u8(), x: r.pos(), z: r.pos(),
});

// ---- events ----

function writeEvent(w, ev) {
  w.u8(EV[ev.e]);
  if (ev.e === 'flash') { w.u8(ev.k === 'player' ? 0 : 1); w.u32(ev.id); }
  else if (ev.e === 'dmg') { w.u32(ev.a); w.pos(ev.x); w.pos(ev.z); }
  else if (ev.e === 'chat') { w.u32(ev.id); w.pos(ev.x); w.pos(ev.z); w.str(ev.text); }
  else w.str(ev.text); // toast
}
function readEvent(r) {
  const e = EV_NAMES[r.u8()];
  if (e === 'flash') return { e, k: r.u8() === 0 ? 'player' : 'mob', id: r.u32() };
  if (e === 'dmg') return { e, a: r.u32(), x: r.pos(), z: r.pos() };
  if (e === 'chat') return { e, id: r.u32(), x: r.pos(), z: r.pos(), text: r.str() };
  return { e, text: r.str() };
}

// ---- client -> server commands ----
// Same version-byte guard as snapshots. decodeCmd returns the exact object
// shapes world.handle() always took, so the server's message handling
// doesn't know the transport changed. Buffers come from the network, so
// decodeCmd must be wrapped in try/catch — truncated frames throw.

const CMD_NAMES = ['join', 'input', 'swapSlot', 'swapRows', 'rotSpeed', 'equip', 'chat'];
const CMD = new Map(CMD_NAMES.map((k, i) => [k, i]));

export function encodeCmd(msg) {
  const w = new Writer();
  w.u8(PROTOCOL_VERSION);
  w.u8(CMD.get(msg.t));
  switch (msg.t) {
    case 'join':
      w.str(msg.name);
      w.str(msg.token || '');
      break;
    case 'input':
      w.f32(msg.tx); w.f32(msg.tz);
      w.f32(msg.ax); w.f32(msg.az);
      w.f32(msg.yaw); w.f32(msg.pitch);
      w.u8((msg.fps ? 1 : 0) | (msg.atk ? 2 : 0) | (msg.def ? 4 : 0));
      break;
    case 'swapSlot':
      w.u8(msg.i);
      break;
    case 'swapRows':
      break;
    case 'rotSpeed':
      w.f32(msg.delta);
      break;
    case 'equip': {
      const [type, rarity] = String(msg.key).split(':');
      w.u8(msg.row === 'secondary' ? 1 : 0);
      w.u8(msg.i);
      w.u8(PETAL_IDX.get(type) ?? 255);
      w.u8(Number(rarity) & 255);
      break;
    }
    case 'chat':
      w.str(msg.text);
      break;
    default:
      throw new Error(`unknown command: ${msg.t}`);
  }
  return w.done();
}

export function decodeCmd(buffer) {
  const r = new Reader(buffer);
  const version = r.u8();
  if (version !== PROTOCOL_VERSION) throw new Error(`protocol mismatch: ${version} != ${PROTOCOL_VERSION}`);
  const t = CMD_NAMES[r.u8()];
  switch (t) {
    case 'join':
      return { t, name: r.str(), token: r.str() };
    case 'input': {
      const msg = { t, tx: r.f32(), tz: r.f32(), ax: r.f32(), az: r.f32(), yaw: r.f32(), pitch: r.f32() };
      const flags = r.u8();
      msg.fps = !!(flags & 1);
      msg.atk = !!(flags & 2);
      msg.def = !!(flags & 4);
      return msg;
    }
    case 'swapSlot':
      return { t, i: r.u8() };
    case 'swapRows':
      return { t };
    case 'rotSpeed':
      return { t, delta: r.f32() };
    case 'equip': {
      const row = r.u8() === 1 ? 'secondary' : 'primary';
      const i = r.u8();
      const type = PETAL_IDS[r.u8()];
      const rarity = r.u8();
      return { t, row, i, key: `${type}:${rarity}` };
    }
    case 'chat':
      return { t, text: r.str() };
    default:
      throw new Error('unknown command frame');
  }
}

// ---- delta snapshots ----
//
// Frame layout (v2): header (version, flags, time, you|spec), then one
// section per entity kind — players, mobs, missiles, pmissiles, drops —
// each `u16 removedN, u32 ids..., u16 upsertN, records...`, then the
// private slice (xp/inventory when dirty), others, events.
//
// The server keeps, per connection, which byte-exact version of every
// entity that client has (DeltaEncoder); the client folds the deltas back
// into full per-tick state objects (DeltaAssembler), so the render layer
// never knows the transport changed. TCP ordering makes this safe without
// acks; a reconnect gets fresh caches on both ends, which is a full
// snapshot by construction.

const bytesEq = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const VIEW_R2 = VIEW_RADIUS * VIEW_RADIUS;

export class DeltaEncoder {
  constructor() {
    this.scratch = new Writer();
    // id -> last serialized bytes, refreshed each tick; when an entity's
    // bytes are unchanged the PREVIOUS array object is kept, so "did this
    // connection already send exactly this" is a reference compare
    this.prev = { stat: new Map(), dyn: new Map(), mobs: new Map(), missiles: new Map(), pmissiles: new Map(), drops: new Map() };
    this.tick = null;
  }

  _serialize(prevMap, nextMap, id, writeFn, obj) {
    this.scratch.at = 0;
    writeFn(this.scratch, obj);
    const view = this.scratch.buf.subarray(0, this.scratch.at);
    const prev = prevMap.get(id);
    const bytes = prev && bytesEq(prev, view) ? prev : view.slice();
    nextMap.set(id, bytes);
    return bytes;
  }

  // serialize every entity once, shared by all connections this tick.
  // `players`/`mobs`/... are live server objects; drops carry an owner.
  beginTick({ players, mobs, missiles, pmissiles, drops }) {
    const next = { stat: new Map(), dyn: new Map(), mobs: new Map(), missiles: new Map(), pmissiles: new Map(), drops: new Map() };
    const t = { players: [], mobs: [], missiles: [], pmissiles: [], drops: [] };
    for (const p of players) {
      t.players.push({
        id: p.id, x: p.pos.x, z: p.pos.z,
        stat: this._serialize(this.prev.stat, next.stat, p.id, writePlayerStatic, p),
        dyn: this._serialize(this.prev.dyn, next.dyn, p.id, writePlayerDynamic, p),
      });
    }
    for (const m of mobs) {
      t.mobs.push({ id: m.id, x: m.pos.x, z: m.pos.z, bytes: this._serialize(this.prev.mobs, next.mobs, m.id, writeMob, m) });
    }
    for (const mi of missiles) {
      t.missiles.push({ id: mi.id, x: mi.pos.x, z: mi.pos.z, bytes: this._serialize(this.prev.missiles, next.missiles, mi.id, writeMissile, mi) });
    }
    for (const pm of pmissiles) {
      t.pmissiles.push({ id: pm.id, x: pm.pos.x, z: pm.pos.z, bytes: this._serialize(this.prev.pmissiles, next.pmissiles, pm.id, writePMissile, pm) });
    }
    for (const d of drops) {
      t.drops.push({ id: d.id, x: d.pos.x, z: d.pos.z, owner: d.owner, bytes: this._serialize(this.prev.drops, next.drops, d.id, writeDrop, d) });
    }
    this.prev = next; // dead ids fall out here
    this.tick = t;
  }

  static newCache() {
    return { players: new Map(), mobs: new Map(), missiles: new Map(), pmissiles: new Map(), drops: new Map() };
  }

  // one section: removals (cached ids no longer visible) + upserts
  // (visible entities whose bytes this connection hasn't sent yet).
  // `limit` keeps only the nearest N when a crowd packs the view radius —
  // without it a spawn cluster of P players costs every client P records,
  // i.e. P^2 total (this melted the server at 145 concurrent players)
  _section(w, entities, cache, px, pz, writeUpsert, changed, limit = 0) {
    let inView = [];
    for (const e of entities) {
      const dx = e.x - px, dz = e.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 <= VIEW_R2) inView.push({ e, d2 });
    }
    if (limit && inView.length > limit) {
      inView.sort((a, b) => a.d2 - b.d2);
      inView.length = limit;
    }
    const visible = new Map();
    for (const { e } of inView) visible.set(e.id, e);
    const removeAt = w.mark16();
    let removed = 0;
    for (const id of cache.keys()) {
      if (!visible.has(id)) { w.u32(id); cache.delete(id); removed++; }
    }
    w.patch16(removeAt, removed);
    const upsertAt = w.mark16();
    let upserts = 0;
    for (const e of visible.values()) {
      if (!changed(cache.get(e.id), e)) continue;
      writeUpsert(w, e, cache.get(e.id));
      upserts++;
    }
    w.patch16(upsertAt, upserts);
  }

  encodeFor(cache, view, playerCap = 30) {
    // view: { px, pz, you | spec, time, xp?, xpNext?, inventory?, others?, events }
    const w = new Writer();
    w.u8(PROTOCOL_VERSION);
    const spec = view.you == null;
    let flags = spec ? 1 : 0;
    if (view.xp !== undefined) flags |= 2;
    if (view.inventory) flags |= 4;
    w.u8(flags);
    w.f64(view.time);
    if (spec) {
      w.u8(view.spec.k === 'player' ? 0 : view.spec.k === 'mob' ? 1 : 2);
      w.u32(view.spec.id ?? 0);
    } else {
      w.u32(view.you);
    }

    const { px, pz } = view;
    // nearest-30 player cap; your own flower is at distance 0, so it can
    // never be culled by the cap
    this._section(w, this.tick.players, cache.players, px, pz,
      (wr, e, sent) => {
        const needStat = !sent || sent.stat !== e.stat;
        wr.u32(e.id);
        wr.u8(needStat ? 1 : 0);
        if (needStat) wr.bytes(e.stat);
        wr.bytes(e.dyn);
        cache.players.set(e.id, { stat: e.stat, dyn: e.dyn });
      },
      (sent, e) => !sent || sent.stat !== e.stat || sent.dyn !== e.dyn,
      playerCap);
    const whole = (kindCache) => [
      (wr, e) => { wr.bytes(e.bytes); kindCache.set(e.id, e.bytes); },
      (sent, e) => sent !== e.bytes,
    ];
    let [up, ch] = whole(cache.mobs);
    this._section(w, this.tick.mobs, cache.mobs, px, pz, up, ch);
    [up, ch] = whole(cache.missiles);
    this._section(w, this.tick.missiles, cache.missiles, px, pz, up, ch);
    [up, ch] = whole(cache.pmissiles);
    this._section(w, this.tick.pmissiles, cache.pmissiles, px, pz, up, ch);
    [up, ch] = whole(cache.drops);
    const ownDrops = spec ? [] : this.tick.drops.filter((d) => d.owner === view.you);
    this._section(w, ownDrops, cache.drops, px, pz, up, ch);

    if (view.xp !== undefined) { w.f64(view.xp); w.f64(view.xpNext); }
    if (view.inventory) {
      w.u16(view.inventory.length);
      for (const [key, count] of view.inventory) {
        const [type, rarity] = key.split(':');
        w.u8(PETAL_IDX.get(type)); w.u8(Number(rarity)); w.u16(count);
      }
    }
    if (!spec) {
      w.u8(view.others.length);
      for (const o of view.others) { w.str(o.name); w.pos(o.x); w.pos(o.z); }
    }
    w.u16(view.events.length);
    for (const ev of view.events) writeEvent(w, ev);
    return w.done();
  }
}

// Client side: folds delta frames back into the full state-object shape
// the pre-delta protocol delivered, so EntitySync/UI code is unchanged.
// Create a fresh assembler per websocket connection — the server's caches
// for a new connection are empty, so the first frame is a full snapshot.
export class DeltaAssembler {
  constructor() {
    this.players = new Map(); // id -> merged player object (+ petal comp)
    this.mobs = new Map();
    this.missiles = new Map();
    this.pmissiles = new Map();
    this.drops = new Map();
  }

  _applySection(r, map, readRecord) {
    const removedN = r.u16();
    for (let i = 0; i < removedN; i++) map.delete(r.u32());
    const upsertN = r.u16();
    for (let i = 0; i < upsertN; i++) readRecord();
  }

  apply(buffer) {
    const r = new Reader(buffer);
    const version = r.u8();
    if (version !== PROTOCOL_VERSION) throw new Error(`protocol mismatch: ${version} != ${PROTOCOL_VERSION}`);
    const flags = r.u8();
    const s = { t: 'state', time: r.f64() };
    if (flags & 1) {
      const k = r.u8();
      s.you = null;
      s.spec = { k: k === 0 ? 'player' : k === 1 ? 'mob' : null, id: r.u32() || null };
    } else {
      s.you = r.u32();
    }

    this._applySection(r, this.players, () => {
      const id = r.u32();
      const hasStatic = r.u8() === 1;
      let p = this.players.get(id);
      if (!p) { p = { id, petals: {} }; this.players.set(id, p); }
      if (hasStatic) {
        const st = readPlayerStatic(r);
        p.name = st.name; p.level = st.level; p.maxHp = st.maxHp;
        p.petals.rotFactor = st.rotFactor;
        p.petals.primary = st.primary;
        p.petals.secondary = st.secondary;
        p.comp = st.comp;
      }
      const d = readPlayerDynamic(r);
      p.x = d.x; p.z = d.z; p.facing = d.facing; p.hp = d.hp;
      p.dead = d.dead; p.deadTimer = d.deadTimer; p.imm = d.imm;
      // dynamic petal state rides positionally over the static composition
      p.petals.instances = d.inst.map((di, i) => {
        const def = p.comp?.[i] ?? {};
        return { id: def.id, slot: def.slot, type: def.type, rarity: def.rarity, ...di };
      });
    });
    this._applySection(r, this.mobs, () => { const m = readMob(r); this.mobs.set(m.id, m); });
    this._applySection(r, this.missiles, () => { const m = readMissile(r); this.missiles.set(m.id, m); });
    this._applySection(r, this.pmissiles, () => { const m = readPMissile(r); this.pmissiles.set(m.id, m); });
    this._applySection(r, this.drops, () => { const d = readDrop(r); this.drops.set(d.id, d); });

    s.players = [...this.players.values()];
    s.mobs = [...this.mobs.values()];
    s.missiles = [...this.missiles.values()];
    s.pmissiles = [...this.pmissiles.values()];
    s.drops = [...this.drops.values()];

    if (flags & 2) { s.xp = r.f64(); s.xpNext = r.f64(); }
    if (flags & 4) {
      const n = r.u16();
      s.inventory = [];
      for (let i = 0; i < n; i++) {
        const type = PETAL_IDS[r.u8()], rarity = r.u8(), count = r.u16();
        s.inventory.push([`${type}:${rarity}`, count]);
      }
    }
    if (!(flags & 1)) {
      const n = r.u8();
      s.others = [];
      for (let i = 0; i < n; i++) s.others.push({ name: r.str(), x: r.pos(), z: r.pos() });
    }
    const evN = r.u16();
    s.events = [];
    for (let i = 0; i < evN; i++) s.events.push(readEvent(r));
    return s;
  }
}
