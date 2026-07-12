import * as THREE from 'three';
import {
  PETAL_TYPES, RARITIES, TILE_TYPES, SPAWN_IMMUNITY, SPAWN_POS,
  clampToArena, collideWalls, tileTypeAt,
} from '../shared/config.js';
import { uid } from './utils.js';
import { PetalManager } from './petals.js';

// Authoritative player. Movement is driven by the last input the client
// sent (cursor target in top-down mode, yaw + move axes in first person);
// hp/xp/death are decided here and only reported to the client. Each
// player owns its own input state, inventory, petal loadout, and toast
// events — none of that is shared with the rest of the world.
export class Player {
  constructor(world) {
    this.world = world;
    this.id = uid();
    this.name = 'Flower';
    this.input = { tx: 0, tz: 0, ax: 0, az: 0, fps: false, yaw: 0, atk: false, def: false };
    this.inventory = new Map(); // "type:rarity" -> count
    this.events = []; // private one-shot events (toasts), flushed per snapshot
    // private-slice dirty flags: inventory and xp are only put in a
    // snapshot when they changed since the last one (they're the bulkiest
    // per-tick payload and change rarely). True at construction so the
    // first snapshot always carries the full slice.
    this.invDirty = true;
    this.xpDirty = true;
    this.pos = new THREE.Vector3(SPAWN_POS.x, 0, SPAWN_POS.z);
    this.radius = 1.1;
    this.maxHp = 200;
    this.hp = this.maxHp;
    this.speed = 13;
    this.regen = 2; // small passive regen for playability (florr itself has none)
    this.level = 1;
    this.xp = 0;
    this.dead = false;
    this.deadTimer = 0;
    this.immunity = SPAWN_IMMUNITY; // fresh spawns can't be hit for a moment
    this.hitCooldowns = new Map();
    this.knock = new THREE.Vector3();
    this.facing = 0;
    this.zoneToasts = new Set(); // biomes already announced this session
    this.petals = new PetalManager(world, this);
  }

  toast(text) { this.events.push({ e: 'toast', text }); }

  // ---- account persistence: what survives across sessions ----

  serializeSave() {
    return {
      v: 1,
      level: this.level,
      xp: Math.floor(this.xp),
      inventory: [...this.inventory.entries()],
      primary: this.petals.primary,
      secondary: this.petals.secondary,
    };
  }

  applySave(save) {
    if (!save || save.v !== 1) return;
    const slot = (s) => (s && PETAL_TYPES[s.type] && RARITIES[s.rarity]
      ? { type: s.type, rarity: s.rarity } : null);
    if (Number.isInteger(save.level) && save.level >= 1) this.level = Math.min(save.level, 200);
    if (Number.isFinite(save.xp) && save.xp >= 0) this.xp = save.xp;
    if (Array.isArray(save.inventory)) {
      for (const [key, count] of save.inventory) {
        if (typeof key !== 'string' || !Number.isInteger(count) || count <= 0) continue;
        const [type, rarity] = key.split(':');
        if (PETAL_TYPES[type] && RARITIES[Number(rarity)]) this.inventory.set(key, count);
      }
    }
    if (Array.isArray(save.primary)) {
      this.petals.primary = this.petals.primary.map((cur, i) => slot(save.primary[i]) ?? cur);
    }
    if (Array.isArray(save.secondary)) {
      this.petals.secondary = this.petals.secondary.map((cur, i) => slot(save.secondary[i]));
    }
    this.invDirty = true;
    this.xpDirty = true;
    this.petals.rebuildAll();
  }

  addToInventory(type, rarity, silent = false) {
    const key = `${type}:${rarity}`;
    this.inventory.set(key, (this.inventory.get(key) || 0) + 1);
    this.invDirty = true;
    if (!silent) this.toast(`+ ${RARITIES[rarity].name} ${PETAL_TYPES[type].name}`);
  }

  takeFromInventory(key) {
    const n = this.inventory.get(key) || 0;
    if (n <= 0) return null;
    if (n === 1) this.inventory.delete(key); else this.inventory.set(key, n - 1);
    this.invDirty = true;
    const [type, rarity] = key.split(':');
    return { type, rarity: Number(rarity) };
  }

  xpForNext() { return Math.floor(60 * Math.pow(1.25, this.level - 1)); }

  gainXp(amount) {
    this.xp += amount;
    this.xpDirty = true;
    while (this.xp >= this.xpForNext()) {
      this.xp -= this.xpForNext();
      this.level++;
      this.toast(`Level ${this.level}!`);
    }
  }

  damage(amount) {
    if (this.dead || this.immunity > 0) return;
    this.hp -= amount;
    this.world.events.push({ e: 'flash', k: 'player', id: this.id });
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.deadTimer = 3;
    }
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  update(dt) {
    const input = this.input;

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.dead = false;
        this.hp = this.maxHp;
        this.pos.set(SPAWN_POS.x, 0, SPAWN_POS.z);
        this.knock.set(0, 0, 0);
        this.immunity = SPAWN_IMMUNITY;
      }
      return;
    }

    // immunity runs out on its own, or the moment you go on the offensive
    if (this.immunity > 0) {
      this.immunity = input.atk ? 0 : Math.max(0, this.immunity - dt);
    }

    this.heal(this.regen * dt);

    if (input.fps) {
      // first-person: WASD relative to the look direction
      const yaw = input.yaw;
      let { ax, az } = input;
      const len = Math.hypot(ax, az);
      if (len > 1) { ax /= len; az /= len; }
      if (ax !== 0 || az !== 0) {
        const delta = new THREE.Vector3(
          -Math.sin(yaw) * az + Math.cos(yaw) * ax, 0,
          -Math.cos(yaw) * az - Math.sin(yaw) * ax
        ).multiplyScalar(this.speed * dt);
        this.pos.add(delta);
      }
      this.facing = yaw + Math.PI;
    } else {
      // florr-style movement: flower chases the cursor, speed scales with distance
      const delta = new THREE.Vector3(input.tx - this.pos.x, 0, input.tz - this.pos.z);
      const dist = delta.length();
      if (dist > 0.6) {
        const speedFrac = Math.min(1, dist / 8);
        delta.normalize().multiplyScalar(this.speed * speedFrac * dt);
        this.pos.add(delta);
        this.facing = Math.atan2(delta.x, delta.z);
      }
    }
    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-6 * dt));
    clampToArena(this.pos, this.radius);
    collideWalls(this.pos, this.radius);

    // stepping into a biome that has no mob pool yet gets a heads-up,
    // once per biome per session (water is scenery, not a future zone)
    const tile = tileTypeAt(this.pos.x, this.pos.z);
    if (tile !== 'grass' && tile !== 'water' && !this.zoneToasts.has(tile)) {
      this.zoneToasts.add(tile);
      this.toast(`${TILE_TYPES[tile]?.name ?? tile} mobs aren't ready yet, coming soon!`);
    }
  }
}
