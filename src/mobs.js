import * as THREE from 'three';
import { MOB_TYPES, RARITIES, MOB_CAP, ARENA_HALF, pickRarity, pickDrop } from './config.js';
import { makeMobMesh, makeHealthBar } from './models.js';
import { uid, damp, flashMaterials, updateFlash, disposeMaterials, disposeObject3D } from './utils.js';
import { clampToArena } from './world.js';

const UP = new THREE.Vector3(0, 1, 0);

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
    this.wanderTimer = 0;
    this.sinePhase = Math.random() * Math.PI * 2;
    this.aggro = false;
    this.knock = new THREE.Vector3();
    this.hitCooldowns = new Map();
    this.deadFlag = false;

    this.mesh = makeMobMesh(type, this.def.radius);
    this.mesh.scale.setScalar(r.scale);
    this.mesh.position.copy(this.pos);
    game.scene.add(this.mesh);

    this.displayHp = this.hp;
    this.barOffsetY = this.radius * 2.1 + 0.35;
    this.hpBar = makeHealthBar(
      Math.max(1.4, this.radius * 1.7),
      game.renderer.capabilities.getMaxAnisotropy()
    );
    game.scene.add(this.hpBar.mesh);
  }

  damage(amount, source = null) {
    const dealt = Math.max(1, amount - this.armor);
    this.hp -= dealt;
    flashMaterials(this.mesh);
    this.game.effects.spawnDamageNumber(dealt, this.pos);
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
    this.game.scene.remove(this.mesh);
    // rock geometry is per-instance (jittered) and safe to free fully;
    // ladybug/bee part geometries are cached and shared across other live
    // mobs of the same type, so only their materials get disposed here
    if (this.type === 'rock') disposeObject3D(this.mesh);
    else disposeMaterials(this.mesh);
    this.game.scene.remove(this.hpBar.mesh);
    this.hpBar.mesh.geometry.dispose();
    this.hpBar.mesh.material.dispose();
    this.hpBar.texture.dispose();
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

    // lerped visuals + facing
    this.mesh.position.lerp(this.pos, damp(10, dt));
    if (vel.lengthSq() > 0.01) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(vel.x, vel.z));
      this.mesh.quaternion.slerp(q, damp(6, dt));
    }
    updateFlash(this.mesh);

    this.displayHp += (this.hp - this.displayHp) * damp(3, dt);
    this.hpBar.draw(this.hp / this.maxHp, this.displayHp / this.maxHp);
    this.hpBar.mesh.position.set(
      this.mesh.position.x, this.mesh.position.y + this.barOffsetY, this.mesh.position.z
    );
    this.hpBar.mesh.quaternion.copy(this.game.camera.quaternion);
    // bars skip depth testing, so order them by distance — nearer bars draw
    // later (on top) but always below damage numbers at renderOrder 999
    const camDist = this.hpBar.mesh.position.distanceTo(this.game.camera.position);
    this.hpBar.mesh.renderOrder = 998 - Math.min(camDist, 500) * 0.016;
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
