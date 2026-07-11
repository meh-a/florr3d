import * as THREE from 'three';
import { PETAL_TYPES, RARITIES, ARENA_HALF } from '../shared/config.js';
import { uid, damp } from './utils.js';

const SLOTS = 5;
const BASE_ROT_SPEED = 2.4; // rad/s
const ORBIT_NEUTRAL = 2.7;
const ORBIT_ATTACK = 4.8;
const ORBIT_DEFEND = 1.7;

// Authoritative petal orbit. Slots hold {type, rarity} items; multi-count
// petals (light) create several instances for one slot. Positions are
// simulated here so petal-vs-mob combat can't be spoofed by the client.
export class PetalManager {
  constructor(world, player) {
    this.world = world;
    this.player = player;
    this.primary = Array.from({ length: SLOTS }, () => ({ type: 'basic', rarity: 0 }));
    this.secondary = Array.from({ length: SLOTS }, () => null);
    this.instances = [];
    this.projectiles = []; // in-flight player missiles
    this.rot = 0;
    this.rotFactor = 1;
    this.radius = ORBIT_NEUTRAL;
    this.rebuildAll();
  }

  // Missile-type petals launch off the orbit while attacking: the petal
  // flies out along its orbit direction as a straight projectile and the
  // slot goes on reload, like losing the petal in florr. Server y stays 0
  // (same plane as all petal combat); the client draws it at flower height.
  fireProjectile(inst) {
    const dir = inst.pos.clone().sub(this.player.pos).setY(0);
    if (dir.lengthSq() < 0.25) return; // not visibly extended yet
    dir.normalize();
    const def = PETAL_TYPES[inst.type].projectile;
    this.projectiles.push({
      id: uid(),
      type: inst.type,
      rarity: inst.rarity,
      pos: inst.pos.clone().setY(0),
      vel: dir.multiplyScalar(def.speed),
      radius: inst.radius,
      dmg: inst.dmg,
      life: def.life,
      yaw: Math.atan2(dir.x, dir.z),
      dead: false,
    });
    this.destroyInstance(inst);
  }

  changeRotSpeed(delta) {
    this.rotFactor = Math.max(0.3, Math.min(1, this.rotFactor + delta));
    this.player.toast(`Rotation ${Math.round(this.rotFactor * 100)}%`);
  }

  swapSlot(i) {
    [this.primary[i], this.secondary[i]] = [this.secondary[i], this.primary[i]];
    this.replaceSlot(i);
  }

  swapRows() {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    // every slot changes at once, so rebuild in one atomic pass (all
    // reloading in). Per-slot replaceSlot calls would each read the other
    // slots mid-swap, where new petal counts mismatch the old instances.
    this.rebuildAll(false);
  }

  // place item into row/slot, returning whatever was there
  equip(row, i, item) {
    const slots = row === 'primary' ? this.primary : this.secondary;
    const old = slots[i];
    slots[i] = item;
    if (row === 'primary') this.replaceSlot(i);
    return old;
  }

  makeInstances(slot, slotIdx, total, startPosIdx, readyNow) {
    const def = PETAL_TYPES[slot.type];
    const rarity = RARITIES[slot.rarity];
    const mult = rarity.petalMult;
    const size = def.radius * (1 + slot.rarity * 0.12);
    const out = [];
    for (let j = 0; j < def.count; j++) {
      out.push({
        id: uid(),
        slotIdx,
        type: slot.type,
        rarity: slot.rarity,
        angleFrac: (startPosIdx + j) / total,
        radius: size,
        maxHp: def.hp * mult,
        hp: def.hp * mult,
        dmg: def.dmg * rarity.petalMult,
        heal: (def.heal || 0) * mult,
        reload: def.reload,
        // a freshly-built loadout (construction) is ready immediately; a
        // slot that just got swapped/equipped into has to reload in, same
        // as a destroyed petal recharging — see replaceSlot
        alive: readyNow,
        cooldown: readyNow ? 0 : def.reload,
        pos: this.player.pos.clone(),
      });
    }
    return out;
  }

  rebuildAll(readyNow = true) {
    // full (re)build of every slot: ready immediately at construction,
    // reloading in on a row swap. Single-slot swaps/equips go through
    // replaceSlot instead so they don't disturb untouched slots.
    this.instances = [];
    const counts = this.primary.map((s) => (s ? PETAL_TYPES[s.type].count : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return;

    let posIdx = 0;
    this.primary.forEach((slot, slotIdx) => {
      if (!slot) return;
      this.instances.push(...this.makeInstances(slot, slotIdx, total, posIdx, readyNow));
      posIdx += PETAL_TYPES[slot.type].count;
    });
  }

  // Replace whichever petal is active in one hotbar slot: the old instance
  // is discarded and the new one has to reload in (alive:false), rather
  // than swapping instantly — same "destroyed and recharging" language the
  // client already renders for petals lost in combat. Other slots' existing
  // instances keep their id/hp/cooldown (only angleFrac is refreshed, since
  // the total orbit position count can change if the new petal has a
  // different `count`), so they aren't disturbed by an unrelated swap.
  replaceSlot(slotIdx) {
    const counts = this.primary.map((s) => (s ? PETAL_TYPES[s.type].count : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) {
      this.instances = [];
      return;
    }

    const bySlot = new Map();
    for (const inst of this.instances) {
      if (!bySlot.has(inst.slotIdx)) bySlot.set(inst.slotIdx, []);
      bySlot.get(inst.slotIdx).push(inst);
    }

    const rebuilt = [];
    let posIdx = 0;
    this.primary.forEach((slot, i) => {
      if (!slot) return;
      if (i === slotIdx) {
        rebuilt.push(...this.makeInstances(slot, i, total, posIdx, false));
      } else {
        const existing = bySlot.get(i) || [];
        const stale = existing.length !== counts[i]
          || existing[0].type !== slot.type || existing[0].rarity !== slot.rarity;
        if (stale) {
          // this slot's instances don't match its petal (e.g. leftovers
          // from an interrupted multi-slot change) — rebuild instead of
          // walking off the end of `existing`
          rebuilt.push(...this.makeInstances(slot, i, total, posIdx, false));
        } else {
          for (let j = 0; j < counts[i]; j++) {
            const inst = existing[j];
            inst.angleFrac = (posIdx + j) / total;
            rebuilt.push(inst);
          }
        }
      }
      posIdx += counts[i];
    });
    this.instances = rebuilt;
  }

  destroyInstance(inst) {
    inst.alive = false;
    inst.cooldown = inst.reload;
  }

  update(dt) {
    const input = this.player.input;
    const targetR = input.atk ? ORBIT_ATTACK : input.def ? ORBIT_DEFEND : ORBIT_NEUTRAL;
    this.radius += (targetR - this.radius) * damp(8, dt);
    this.rot += BASE_ROT_SPEED * this.rotFactor * dt;

    const p = this.player;
    for (const inst of this.instances) {
      if (!inst.alive) {
        inst.cooldown -= dt;
        if (inst.cooldown <= 0 && !p.dead) {
          inst.alive = true;
          inst.hp = inst.maxHp;
          inst.pos.copy(p.pos); // pop out from the flower
        }
        continue;
      }
      if (p.dead) continue;

      const angle = this.rot + inst.angleFrac * Math.PI * 2;
      const target = new THREE.Vector3(
        p.pos.x + Math.cos(angle) * this.radius, 0,
        p.pos.z + Math.sin(angle) * this.radius
      );

      // rose homes into the flower to heal when hurt
      if (inst.type === 'rose' && p.hp < p.maxHp * 0.9 && !p.dead) {
        target.set(p.pos.x, 0, p.pos.z);
        inst.pos.lerp(target, damp(6, dt));
        if (inst.pos.distanceTo(target) < 0.8) {
          p.heal(inst.heal);
          this.destroyInstance(inst);
        }
      } else {
        inst.pos.lerp(target, damp(12, dt));
      }

      // missiles launch once the attack orbit has visibly extended
      if (PETAL_TYPES[inst.type].projectile && input.atk && this.radius > 3.6) {
        this.fireProjectile(inst);
      }
    }

    for (const proj of this.projectiles) {
      proj.pos.addScaledVector(proj.vel, dt);
      proj.life -= dt;
      if (proj.life <= 0 ||
          Math.max(Math.abs(proj.pos.x), Math.abs(proj.pos.z)) > ARENA_HALF + 4) {
        proj.dead = true;
      }
    }
    this.projectiles = this.projectiles.filter((proj) => !proj.dead);
  }
}
