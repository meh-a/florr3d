import * as THREE from 'three';
import { PETAL_TYPES, RARITIES } from './config.js';
import { makePetalMesh } from './models.js';
import { uid, damp, disposeObject3D } from './utils.js';

const SLOTS = 5;
const BASE_ROT_SPEED = 2.4; // rad/s
const ORBIT_NEUTRAL = 2.7;
const ORBIT_ATTACK = 4.8;
const ORBIT_DEFEND = 1.7;

// A petal instance orbiting the flower. Slots hold {type, rarity} items;
// multi-count petals (light) create several instances for one slot.
export class PetalManager {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.primary = Array.from({ length: SLOTS }, () => ({ type: 'basic', rarity: 0 }));
    this.secondary = Array.from({ length: SLOTS }, () => null);
    this.instances = [];
    this.rot = 0;
    this.rotFactor = 1;
    this.radius = ORBIT_NEUTRAL;
    this.rebuildAll();
  }

  changeRotSpeed(delta) {
    this.rotFactor = Math.max(0.3, Math.min(1, this.rotFactor + delta));
    this.game.ui.toast(`Rotation ${Math.round(this.rotFactor * 100)}%`);
  }

  swapSlot(i) {
    [this.primary[i], this.secondary[i]] = [this.secondary[i], this.primary[i]];
    this.rebuildAll();
    this.game.ui.renderLoadout();
  }

  swapRows() {
    [this.primary, this.secondary] = [this.secondary, this.primary];
    this.rebuildAll();
    this.game.ui.renderLoadout();
  }

  // place item into row/slot, returning whatever was there
  equip(row, i, item) {
    const slots = row === 'primary' ? this.primary : this.secondary;
    const old = slots[i];
    slots[i] = item;
    if (row === 'primary') this.rebuildAll();
    this.game.ui.renderLoadout();
    return old;
  }

  rebuildAll() {
    for (const inst of this.instances) {
      this.game.scene.remove(inst.mesh);
      disposeObject3D(inst.mesh);
    }
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
        const mesh = makePetalMesh(slot.type, size);
        this.game.scene.add(mesh);
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
          mesh,
        });
        posIdx++;
      }
    });
  }

  destroyInstance(inst) {
    inst.alive = false;
    inst.cooldown = inst.reload;
    inst.mesh.visible = false;
  }

  // fraction of a slot's petals currently alive, for the UI cooldown dim
  slotAliveFrac(i) {
    const mine = this.instances.filter((p) => p.slotIdx === i);
    if (mine.length === 0) return 1;
    return mine.filter((p) => p.alive).length / mine.length;
  }

  update(dt) {
    const input = this.game.input;
    const targetR = input.attack ? ORBIT_ATTACK : input.defend ? ORBIT_DEFEND : ORBIT_NEUTRAL;
    this.radius += (targetR - this.radius) * damp(8, dt);
    this.rot += BASE_ROT_SPEED * this.rotFactor * dt;

    const p = this.player;
    for (const inst of this.instances) {
      if (!inst.alive) {
        inst.cooldown -= dt;
        if (inst.cooldown <= 0 && !p.dead) {
          inst.alive = true;
          inst.hp = inst.maxHp;
          inst.mesh.visible = true;
          inst.pos.copy(p.pos); // pop out from the flower
        }
        continue;
      }
      if (p.dead) { inst.mesh.visible = false; continue; }
      inst.mesh.visible = true;

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
          continue;
        }
      } else {
        inst.pos.lerp(target, damp(12, dt));
      }

      inst.mesh.position.set(inst.pos.x, 1.1, inst.pos.z);
      inst.mesh.rotation.y += dt * 1.5;
    }
  }
}
