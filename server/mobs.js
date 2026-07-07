import * as THREE from 'three';
import {
  MOB_TYPES, RARITIES, MOB_CAP, ARENA_HALF, clampToArena, pickRarity, pickDrop,
} from '../shared/config.js';
import { uid } from './utils.js';

class Mob {
  constructor(game, type, rarityIdx, pos) {
    this.game = game;
    this.id = uid();
    this.type = type;
    this.def = MOB_TYPES[type];
    this.rarity = rarityIdx;
    const r = RARITIES[rarityIdx];
    this.maxHp = this.def.hp * r.statMult;
    this.hp = this.maxHp;
    this.dmg = this.def.dmg * r.dmgMult;
    this.armor = this.def.armor * (1 + rarityIdx);
    this.radius = this.def.radius * r.scale;
    this.speed = this.def.speed;
    this.xp = this.def.xp * r.statMult;

    this.pos = pos.clone();
    this.heading = Math.random() * Math.PI * 2;
    this.facing = this.heading;
    this.wanderTimer = 0;
    this.sinePhase = Math.random() * Math.PI * 2;
    this.aggro = false;
    this.knock = new THREE.Vector3();
    this.hitCooldowns = new Map();
    this.deadFlag = false;
  }

  damage(amount, source = null) {
    const dealt = Math.max(1, amount - this.armor);
    this.hp -= dealt;
    this.game.events.push({ e: 'flash', id: this.id });
    this.game.events.push({
      e: 'dmg', a: Math.round(dealt),
      x: Math.round(this.pos.x * 100) / 100, z: Math.round(this.pos.z * 100) / 100,
    });
    // Rare+ mobs retaliate when attacked
    if (this.rarity >= 2) this.aggro = true;
    if (source) {
      const push = this.pos.clone().sub(source).setY(0).normalize().multiplyScalar(9);
      this.knock.add(push);
    }
    if (this.hp <= 0) this.die();
  }

  die() {
    if (this.deadFlag) return;
    this.deadFlag = true;
    this.game.player.gainXp(this.xp);
    const dropType = pickDrop(this.type);
    if (dropType) this.game.drops.spawn(dropType, this.rarity, this.pos);
  }

  update(dt) {
    const player = this.game.player;
    let vel = new THREE.Vector3();

    if (this.speed > 0) {
      if (this.aggro && !player.dead) {
        const toPlayer = player.pos.clone().sub(this.pos).setY(0);
        if (toPlayer.lengthSq() > 0.01) toPlayer.normalize();
        if (this.type === 'bee') {
          // fast sine-wave swerve toward the player
          this.sinePhase += dt * 6;
          const perp = new THREE.Vector3(-toPlayer.z, 0, toPlayer.x);
          vel = toPlayer.add(perp.multiplyScalar(Math.sin(this.sinePhase) * 0.8))
            .normalize().multiplyScalar(this.speed * 3);
        } else {
          vel = toPlayer.multiplyScalar(this.speed * 1.8);
        }
      } else {
        // wander: re-pick heading every few seconds
        this.wanderTimer -= dt;
        if (this.wanderTimer <= 0) {
          this.wanderTimer = 2 + Math.random() * 3;
          this.heading = Math.random() * Math.PI * 2;
        }
        let dir = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
        if (this.type === 'bee') {
          this.sinePhase += dt * 3;
          const perp = new THREE.Vector3(-dir.z, 0, dir.x);
          dir = dir.add(perp.multiplyScalar(Math.sin(this.sinePhase) * 0.6)).normalize();
        }
        vel = dir.multiplyScalar(this.speed);
      }
      this.pos.addScaledVector(vel, dt);
    }

    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-6 * dt));
    clampToArena(this.pos, this.radius);

    if (vel.lengthSq() > 0.01) this.facing = Math.atan2(vel.x, vel.z);
  }
}

export class MobManager {
  constructor(game) {
    this.game = game;
    this.mobs = [];
    this.spawnTimer = 0;
    for (let i = 0; i < 16; i++) this.trySpawn(true);
  }

  trySpawn(initial = false) {
    if (this.mobs.length >= MOB_CAP) return;
    const player = this.game.player;
    for (let attempt = 0; attempt < 12; attempt++) {
      const pos = new THREE.Vector3(
        (Math.random() * 2 - 1) * (ARENA_HALF - 8), 0,
        (Math.random() * 2 - 1) * (ARENA_HALF - 8)
      );
      const dist = pos.distanceTo(player.pos);
      if (dist < 30 || (!initial && dist > 130)) continue;
      const types = Object.keys(MOB_TYPES);
      const type = types[Math.floor(Math.random() * types.length)];
      this.mobs.push(new Mob(this.game, type, pickRarity(), pos));
      return;
    }
  }

  update(dt) {
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 1;
      this.trySpawn();
    }

    for (const mob of this.mobs) mob.update(dt);

    // gentle mob-mob separation so they don't stack
    for (let i = 0; i < this.mobs.length; i++) {
      for (let j = i + 1; j < this.mobs.length; j++) {
        const a = this.mobs[i], b = this.mobs[j];
        const d = a.pos.distanceTo(b.pos);
        const min = a.radius + b.radius;
        if (d < min && d > 0.001) {
          const push = b.pos.clone().sub(a.pos).setY(0).normalize()
            .multiplyScalar((min - d) * 0.5);
          if (a.speed > 0) a.pos.sub(push);
          if (b.speed > 0) b.pos.add(push);
        }
      }
    }

    this.mobs = this.mobs.filter((m) => !m.deadFlag);
  }
}
