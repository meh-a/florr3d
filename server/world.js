import { PETAL_TYPES, RARITIES, VIEW_RADIUS, PITCH_LIMIT } from '../shared/config.js';
import { censorName } from './censor.js';
import { Player } from './player.js';
import { MobManager } from './mobs.js';
import { DropManager } from './drops.js';
import { updateCombat } from './combat.js';

const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const SLOTS = 5;

// One authoritative shared world per server process. Every websocket
// connection is a Player inside this world — they all see the same mobs,
// drops, and each other. The client only ever sends intents — movement
// input and loadout requests — and everything with gameplay consequences
// (damage, xp, drops, inventory) is decided here.
export class World {
  constructor() {
    this.time = 0;
    // world-visible one-shot events (flash, dmg) sent to every recipient;
    // per-player toasts live on each Player instead. Flushed once per tick
    // after snapshots are built, not per recipient.
    this.events = [];
    this.players = new Map(); // id -> Player
    this.mobs = new MobManager(this);
    this.drops = new DropManager(this);
  }

  addPlayer() {
    const player = new Player(this);
    this.players.set(player.id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
  }

  // Resolve what a not-yet-joined connection watches from the name gate:
  // keep the current target while it's still valid, otherwise pick a random
  // living player, falling back to a random mob when no flowers are online.
  // Returns { k, id, x, z } (k/id null when the world is completely empty).
  spectateTarget(current) {
    if (current?.k === 'player') {
      const p = this.players.get(current.id);
      if (p && !p.dead) return { k: 'player', id: p.id, x: p.pos.x, z: p.pos.z };
    } else if (current?.k === 'mob') {
      const m = this.mobs.mobs.find((m) => m.id === current.id);
      if (m) return { k: 'mob', id: m.id, x: m.pos.x, z: m.pos.z };
    }
    const alive = [...this.players.values()].filter((p) => !p.dead);
    if (alive.length) {
      const p = alive[Math.floor(Math.random() * alive.length)];
      return { k: 'player', id: p.id, x: p.pos.x, z: p.pos.z };
    }
    if (this.mobs.mobs.length) {
      const m = this.mobs.mobs[Math.floor(Math.random() * this.mobs.mobs.length)];
      return { k: 'mob', id: m.id, x: m.pos.x, z: m.pos.z };
    }
    return { k: null, id: null, x: 0, z: 0 };
  }

  // nearest living player to a position, or null if nobody qualifies
  nearestPlayer(pos) {
    let best = null;
    let bestD = Infinity;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = p.pos.distanceTo(pos);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  handle(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'join': {
        // display name, sent once by the client; re-sent on reconnect
        if (typeof msg.name !== 'string') return;
        const name = msg.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16);
        player.name = (name && censorName(name)) || 'Guest';
        break;
      }
      case 'input': {
        const i = player.input;
        i.tx = num(msg.tx);
        i.tz = num(msg.tz);
        i.ax = Math.max(-1, Math.min(1, num(msg.ax)));
        i.az = Math.max(-1, Math.min(1, num(msg.az)));
        i.fps = !!msg.fps;
        i.yaw = num(msg.yaw);
        i.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, num(msg.pitch)));
        i.atk = !!msg.atk;
        i.def = !!msg.def;
        break;
      }
      case 'swapSlot': {
        const i = msg.i;
        if (Number.isInteger(i) && i >= 0 && i < SLOTS) player.petals.swapSlot(i);
        break;
      }
      case 'swapRows':
        player.petals.swapRows();
        break;
      case 'rotSpeed':
        player.petals.changeRotSpeed(Math.max(-1, Math.min(1, num(msg.delta))));
        break;
      case 'equip': {
        const { row, i, key } = msg;
        if ((row !== 'primary' && row !== 'secondary') || !Number.isInteger(i) || i < 0 || i >= SLOTS) return;
        if (typeof key !== 'string') return;
        const item = player.takeFromInventory(key);
        if (!item || !PETAL_TYPES[item.type] || !RARITIES[item.rarity]) return;
        const old = player.petals.equip(row, i, item);
        if (old) player.addToInventory(old.type, old.rarity, true);
        break;
      }
    }
  }

  tick(dt) {
    this.time += dt;
    for (const player of this.players.values()) {
      player.update(dt);
      player.petals.update(dt);
    }
    this.mobs.update(dt);
    this.drops.update(dt);
    updateCombat(this, dt);
  }

  // Per-tick data for the delta wire protocol (ws.js): the live entity
  // lists (DeltaEncoder serializes each once, shared by all connections)
  // plus one lightweight view per recipient — position for interest
  // scoping, identity, nearest-player arrows, private slice, and events.
  // Flushes all one-shot events, so run either this OR buildSnapshots per
  // tick, never both (the worker uses buildSnapshots).
  buildTick(spectators = []) {
    const r2c = r2; // alias for closures below
    const posEvents = this.events.filter((ev) => typeof ev.x === 'number');
    const globalEvents = this.events.filter((ev) => typeof ev.x !== 'number');
    const R2 = VIEW_RADIUS * VIEW_RADIUS;
    const nearEvents = (px, pz) =>
      posEvents.filter((ev) => (ev.x - px) ** 2 + (ev.z - pz) ** 2 <= R2);

    const players = [...this.players.values()];
    const entities = {
      players,
      mobs: this.mobs.mobs,
      missiles: this.mobs.missiles,
      pmissiles: players.flatMap((p) => p.petals.projectiles),
      drops: this.drops.drops,
    };

    const alive = players.filter((pl) => !pl.dead);
    const views = new Map();
    for (const p of players) {
      const px = p.pos.x, pz = p.pos.z;
      const others = alive
        .filter((o) => o.id !== p.id)
        .map((o) => ({ o, d: (o.pos.x - px) ** 2 + (o.pos.z - pz) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map(({ o }) => ({ name: o.name, x: r2c(o.pos.x), z: r2c(o.pos.z) }));
      // private events (toasts) first — they must survive the cap; the
      // rest are cosmetic (flashes, damage numbers) and a crowd fight can
      // generate hundreds per tick, which multiplied across every nearby
      // client during the 145-player wave
      const view = {
        px, pz, you: p.id, time: r2c(this.time), others,
        events: [...p.events, ...globalEvents, ...nearEvents(px, pz)].slice(0, 80),
      };
      if (p.xpDirty) {
        view.xp = Math.floor(p.xp);
        view.xpNext = p.xpForNext();
        p.xpDirty = false;
      }
      if (p.invDirty) {
        view.inventory = [...p.inventory.entries()];
        p.invDirty = false;
      }
      views.set(p.id, view);
    }
    for (const s of spectators) {
      views.set(s.key, {
        px: s.x, pz: s.z, you: null, spec: { k: s.k, id: s.id },
        time: r2c(this.time),
        events: [...globalEvents, ...nearEvents(s.x, s.z)].slice(0, 80),
      });
    }
    this.events = [];
    for (const p of players) p.events = [];
    return { entities, views };
  }

  // Build one snapshot per player. Entity entries are serialized once and
  // shared; each recipient then gets only the entities within VIEW_RADIUS
  // of their own player (interest management — everything farther is deep
  // in the fog and off-camera anyway), plus a private slice — their own
  // inventory, xp, and toasts — which must never be sent to anyone else.
  // Flushes all one-shot events. Only the in-browser worker uses this
  // full-snapshot path; the websocket server uses buildTick + DeltaEncoder.
  //
  // `spectators` is a list of { key, k, id, x, z } views for connections
  // that haven't joined yet (name gate): each gets a snapshot scoped around
  // its spectate target, with `you: null` and no private slice.
  buildSnapshots(spectators = []) {
    const tag = (list, entryOf) => list.map((o) => {
      const pos = o.pos;
      return { x: pos.x, z: pos.z, entry: entryOf(o) };
    });

    const playerEntries = tag([...this.players.values()], (p) => ({
      id: p.id, name: p.name,
      x: r2(p.pos.x), z: r2(p.pos.z), facing: r2(p.facing),
      hp: r2(p.hp), maxHp: p.maxHp, level: p.level,
      dead: p.dead, deadTimer: r2(p.deadTimer),
      ...(p.immunity > 0 ? { imm: true } : {}), // renders as a ghosted flower
      petals: {
        rotFactor: p.petals.rotFactor,
        primary: p.petals.primary,
        secondary: p.petals.secondary,
        instances: p.petals.instances.map((inst) => ({
          id: inst.id, slot: inst.slotIdx, type: inst.type, rarity: inst.rarity,
          alive: inst.alive, x: r2(inst.pos.x), z: r2(inst.pos.z),
          // reload fraction remaining (0 = ready), drives the UI pie sweep
          cd: inst.alive ? 0 : r2(Math.min(1, Math.max(0, inst.cooldown / inst.reload))),
        })),
      },
    }));

    const mobEntries = tag(this.mobs.mobs, (m) => ({
      id: m.id, type: m.type, rarity: m.rarity,
      x: r2(m.pos.x), z: r2(m.pos.z), facing: r2(m.facing),
      hp: r2(m.hp), maxHp: r2(m.maxHp),
      // flight fields only exist for airborne mobs (hornet)
      ...(m.flight ? { y: r2(m.pos.y), pitch: r2(m.pitch), loaded: m.loaded } : {}),
    }));

    const missileEntries = tag(this.mobs.missiles, (mi) => ({
      id: mi.id, rarity: mi.rarity,
      x: r2(mi.pos.x), y: r2(mi.pos.y), z: r2(mi.pos.z),
      yaw: r2(mi.yaw), pitch: r2(mi.pitch),
    }));

    const pmissileEntries = [...this.players.values()].flatMap((p) =>
      tag(p.petals.projectiles, (proj) => ({
        id: proj.id, type: proj.type, rarity: proj.rarity,
        x: r2(proj.pos.x), y: r2(proj.pos.y), z: r2(proj.pos.z),
        yaw: r2(proj.yaw), pitch: r2(proj.pitch),
      })));

    // drops are individual loot: the wrapper keeps the owner so each
    // recipient is only sent their own (the owner never reaches the client)
    const dropEntries = this.drops.drops.map((d) => ({
      x: d.pos.x, z: d.pos.z, owner: d.owner,
      entry: { id: d.id, type: d.type, rarity: d.rarity, x: r2(d.pos.x), z: r2(d.pos.z) },
    }));

    // events with a position (damage numbers) are scoped like entities;
    // positionless ones (flashes) go to everyone — the client no-ops any
    // whose target it isn't rendering
    const posEvents = this.events.filter((ev) => typeof ev.x === 'number');
    const globalEvents = this.events.filter((ev) => typeof ev.x !== 'number');

    const R2 = VIEW_RADIUS * VIEW_RADIUS;
    const near = (list, px, pz) => {
      const outList = [];
      for (const e of list) {
        const dx = e.x - px, dz = e.z - pz;
        if (dx * dx + dz * dz <= R2) outList.push(e.entry ?? e);
      }
      return outList;
    };

    const alive = [...this.players.values()].filter((pl) => !pl.dead);
    const out = new Map(); // playerId -> snapshot
    for (const p of this.players.values()) {
      const px = p.pos.x, pz = p.pos.z;
      // the up-to-3 nearest living flowers, wherever they are on the map —
      // drives the client's direction arrows (unlike `players`, this list
      // isn't interest-scoped, or it couldn't point beyond the fog)
      const others = alive
        .filter((o) => o.id !== p.id)
        .map((o) => ({ o, d: (o.pos.x - px) ** 2 + (o.pos.z - pz) ** 2 }))
        .sort((a, b) => a.d - b.d)
        .slice(0, 3)
        .map(({ o }) => ({ name: o.name, x: r2(o.pos.x), z: r2(o.pos.z) }));
      const snap = {
        t: 'state',
        time: r2(this.time),
        you: p.id,
        players: near(playerEntries, px, pz), // always includes yourself (distance 0)
        mobs: near(mobEntries, px, pz),
        missiles: near(missileEntries, px, pz),
        pmissiles: near(pmissileEntries, px, pz),
        drops: near(dropEntries.filter((d) => d.owner === p.id), px, pz),
        others,
        events: [...globalEvents, ...near(posEvents, px, pz), ...p.events],
      };
      // private slice rides along only when it changed (the client caches
      // the last received values); the first snapshot always has it
      if (p.xpDirty) {
        snap.xp = Math.floor(p.xp);
        snap.xpNext = p.xpForNext();
        p.xpDirty = false;
      }
      if (p.invDirty) {
        snap.inventory = [...p.inventory.entries()];
        p.invDirty = false;
      }
      out.set(p.id, snap);
    }
    for (const s of spectators) {
      out.set(s.key, {
        t: 'state',
        time: r2(this.time),
        you: null,
        spec: { k: s.k, id: s.id },
        players: near(playerEntries, s.x, s.z),
        mobs: near(mobEntries, s.x, s.z),
        missiles: near(missileEntries, s.x, s.z),
        pmissiles: near(pmissileEntries, s.x, s.z),
        drops: [], // drops are private loot — spectators see none
        events: [...globalEvents, ...near(posEvents, s.x, s.z)],
      });
    }
    this.events = [];
    for (const p of this.players.values()) p.events = [];
    return out;
  }
}
