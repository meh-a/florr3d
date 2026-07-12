import { PETAL_TYPES, MOB_TYPES } from './config.js';

// Binary wire format for the per-tick `state` snapshot — the only message
// that matters for CPU/bandwidth (everything else stays JSON text frames;
// the client tells them apart by frame type). encodeState produces a
// Uint8Array; decodeState reconstructs the exact object shape the JSON
// snapshot had, so the client's consumers don't know the transport changed.
//
// Quantization: positions ride as int16 at 1/64 unit (~1.6cm over ±512),
// angles as int16 at 1/8192 rad, cooldown fractions as u8. hp is float32;
// xp values are float64 (they exceed u32 at high levels). Entity/petal
// types are enum indices into the shared config's key order — both sides
// import the same config, so the tables always agree within one build.
// PROTOCOL_VERSION guards across builds: on mismatch the decoder throws,
// and the deploy auto-reload flow gets clients onto the matching build.

export const PROTOCOL_VERSION = 1;

const PETAL_IDS = Object.keys(PETAL_TYPES);
const MOB_IDS = Object.keys(MOB_TYPES);
const PETAL_IDX = new Map(PETAL_IDS.map((k, i) => [k, i]));
const MOB_IDX = new Map(MOB_IDS.map((k, i) => [k, i]));

const POS = 64;      // world units -> int16
const ANG = 8192;    // radians -> int16
const EV = { flash: 0, dmg: 1, toast: 2 };
const EV_NAMES = ['flash', 'dmg', 'toast'];

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

// ---- players ----

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

function writePlayer(w, p) {
  w.u32(p.id);
  w.str(p.name);
  w.pos(p.x); w.pos(p.z); w.ang(p.facing);
  w.f32(p.hp); w.f32(p.maxHp);
  w.u16(p.level);
  w.u8((p.dead ? 1 : 0) | (p.imm ? 2 : 0));
  w.u8(Math.max(0, Math.min(255, Math.round(p.deadTimer * 50))));
  w.frac8((p.petals.rotFactor - 0.3) / 0.7);
  for (const slot of p.petals.primary) writeSlot(w, slot);
  for (const slot of p.petals.secondary) writeSlot(w, slot);
  w.u8(p.petals.instances.length);
  for (const inst of p.petals.instances) {
    w.u32(inst.id);
    w.u8(inst.slot);
    w.u8(PETAL_IDX.get(inst.type));
    w.u8(inst.rarity);
    w.u8(inst.alive ? 1 : 0);
    w.pos(inst.x); w.pos(inst.z);
    w.frac8(inst.cd);
  }
}

function readPlayer(r) {
  const p = {
    id: r.u32(), name: r.str(),
    x: r.pos(), z: r.pos(), facing: r.ang(),
    hp: r.f32(), maxHp: r.f32(), level: r.u16(),
  };
  const flags = r.u8();
  p.dead = !!(flags & 1);
  if (flags & 2) p.imm = true;
  p.deadTimer = r.u8() / 50;
  const petals = { rotFactor: r.frac8() * 0.7 + 0.3, primary: [], secondary: [], instances: [] };
  for (let i = 0; i < 5; i++) petals.primary.push(readSlot(r));
  for (let i = 0; i < 5; i++) petals.secondary.push(readSlot(r));
  const n = r.u8();
  for (let i = 0; i < n; i++) {
    petals.instances.push({
      id: r.u32(), slot: r.u8(), type: PETAL_IDS[r.u8()], rarity: r.u8(),
      alive: r.u8() === 1, x: r.pos(), z: r.pos(), cd: r.frac8(),
    });
  }
  p.petals = petals;
  return p;
}

// ---- mobs / projectiles / drops ----

function writeMob(w, m) {
  w.u32(m.id);
  w.u8(MOB_IDX.get(m.type));
  w.u8(m.rarity);
  w.pos(m.x); w.pos(m.z); w.ang(m.facing);
  w.f32(m.hp); w.f32(m.maxHp);
  const flying = m.y !== undefined;
  w.u8((flying ? 1 : 0) | (m.loaded ? 2 : 0));
  if (flying) { w.pos(m.y); w.ang(m.pitch); }
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
  w.pos(mi.x); w.pos(mi.y); w.pos(mi.z);
  w.ang(mi.yaw); w.ang(mi.pitch);
};
const readMissile = (r) => ({
  id: r.u32(), rarity: r.u8(),
  x: r.pos(), y: r.pos(), z: r.pos(), yaw: r.ang(), pitch: r.ang(),
});

const writePMissile = (w, pm) => {
  w.u32(pm.id); w.u8(PETAL_IDX.get(pm.type)); w.u8(pm.rarity);
  w.pos(pm.x); w.pos(pm.z); w.ang(pm.yaw);
};
const readPMissile = (r) => ({
  id: r.u32(), type: PETAL_IDS[r.u8()], rarity: r.u8(),
  x: r.pos(), z: r.pos(), yaw: r.ang(),
});

const writeDrop = (w, d) => {
  w.u32(d.id); w.u8(PETAL_IDX.get(d.type)); w.u8(d.rarity);
  w.pos(d.x); w.pos(d.z);
};
const readDrop = (r) => ({
  id: r.u32(), type: PETAL_IDS[r.u8()], rarity: r.u8(), x: r.pos(), z: r.pos(),
});

// ---- events ----

function writeEvent(w, ev) {
  w.u8(EV[ev.e]);
  if (ev.e === 'flash') { w.u8(ev.k === 'player' ? 0 : 1); w.u32(ev.id); }
  else if (ev.e === 'dmg') { w.u32(ev.a); w.pos(ev.x); w.pos(ev.z); }
  else w.str(ev.text); // toast
}
function readEvent(r) {
  const e = EV_NAMES[r.u8()];
  if (e === 'flash') return { e, k: r.u8() === 0 ? 'player' : 'mob', id: r.u32() };
  if (e === 'dmg') return { e, a: r.u32(), x: r.pos(), z: r.pos() };
  return { e, text: r.str() };
}

// ---- snapshot ----

const list = (w, arr, fn) => { w.u16(arr.length); for (const item of arr) fn(w, item); };
const readList = (r, fn) => {
  const n = r.u16();
  const out = [];
  for (let i = 0; i < n; i++) out.push(fn(r));
  return out;
};

export function encodeState(s) {
  const w = new Writer();
  w.u8(PROTOCOL_VERSION);
  const spec = s.you == null;
  let flags = spec ? 1 : 0;
  if (s.xp !== undefined) flags |= 2;
  if (s.inventory) flags |= 4;
  w.u8(flags);
  w.f64(s.time);
  if (spec) {
    w.u8(s.spec.k === 'player' ? 0 : s.spec.k === 'mob' ? 1 : 2);
    w.u32(s.spec.id ?? 0);
  } else {
    w.u32(s.you);
  }
  list(w, s.players, writePlayer);
  list(w, s.mobs, writeMob);
  list(w, s.missiles, writeMissile);
  list(w, s.pmissiles, writePMissile);
  list(w, s.drops, writeDrop);
  if (s.xp !== undefined) { w.f64(s.xp); w.f64(s.xpNext); }
  if (s.inventory) {
    w.u16(s.inventory.length);
    for (const [key, count] of s.inventory) {
      const [type, rarity] = key.split(':');
      w.u8(PETAL_IDX.get(type)); w.u8(Number(rarity)); w.u16(count);
    }
  }
  if (!spec) {
    w.u8(s.others.length);
    for (const o of s.others) { w.str(o.name); w.pos(o.x); w.pos(o.z); }
  }
  list(w, s.events, writeEvent);
  return w.done();
}

export function decodeState(buffer) {
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
  s.players = readList(r, readPlayer);
  s.mobs = readList(r, readMob);
  s.missiles = readList(r, readMissile);
  s.pmissiles = readList(r, readPMissile);
  s.drops = readList(r, readDrop);
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
  s.events = readList(r, readEvent);
  return s;
}
