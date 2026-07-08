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
  constructor(game) {
    this.game = game;
    this.player = game.player;
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
    this.game.toast(`Rotation ${Math.round(this.rotFactor * 100)}%`);
  }

  swapSlot(i) {
    [this.primary[i], this.secondary[i]] = [this.secondary[i], this.primary[i]];
    this.rebuildAll();
  }

  swapRows() {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.rebuildAll();
  }

  // place item into row/slot, returning whatever was there
  equip(row, i, item) {
    const slots = row === 'primary' ? this.primary : this.secondary;
    const old = slots[i];
    slots[i] = item;
    if (row === 'primary') this.rebuildAll();
    return old;
  }

  rebuildAll() {
    this.instances = [];

    // count total orbit positions so all instances spread evenly, like florr
    const counts = this.primary.map((s) => (s ? PETAL_TYPES[s.type].count : 0));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total === 0) return;

    let posIdx = 0;
    this.primary.forEach((slot, slotIdx) => {
      if (!slot) return;
      const def = PETAL_TYPES[slot.type];
      const mult = RARITIES[slot.rarity].statMult;
      const size = def.radius * (1 + slot.rarity * 0.12);
      for (let j = 0; j < def.count; j++) {
        this.instances.push({
          id: uid(),
          slotIdx,
          type: slot.type,
          rarity: slot.rarity,
          angleFrac: posIdx / total,
          radius: size,
          maxHp: def.hp * mult,
          hp: def.hp * mult,
          dmg: def.dmg * mult,
          heal: (def.heal || 0) * mult,
          reload: def.reload,
          alive: true,
          cooldown: 0,
          pos: this.player.pos.clone(),
        });
        posIdx++;
      }
    });
  }

  destroyInstance(inst) {
    inst.alive = false;
    inst.cooldown = inst.reload;
  }

  update(dt) {
    const input = this.game.input;
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
