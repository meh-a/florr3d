import * as THREE from 'three';
import { makeFlower } from './models.js';
import { uid, damp, flashMaterials, updateFlash } from './utils.js';
import { clampToArena } from './world.js';

export class Player {
  constructor(game) {
    this.game = game;
    this.id = uid();
    this.pos = new THREE.Vector3(0, 0, 0);
    this.radius = 1.1;
    this.maxHp = 200;
    this.hp = this.maxHp;
    this.speed = 13;
    this.regen = 2; // small passive regen for playability (florr itself has none)
    this.level = 1;
    this.xp = 0;
    this.dead = false;
    this.deadTimer = 0;
    this.hitCooldowns = new Map();
    this.knock = new THREE.Vector3();

    this.mesh = makeFlower(this.radius);
    this.mesh.position.set(0, this.radius, 0);
    game.scene.add(this.mesh);
    this.facing = 0;
  }

  xpForNext() { return Math.floor(60 * Math.pow(1.25, this.level - 1)); }

  gainXp(amount) {
    this.xp += amount;
    while (this.xp >= this.xpForNext()) {
      this.xp -= this.xpForNext();
      this.level++;
      this.game.ui.toast(`Level ${this.level}!`);
    }
  }

  damage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    flashMaterials(this.mesh);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.deadTimer = 3;
      this.mesh.visible = false;
      this.game.ui.showDeath(true);
    }
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  update(dt) {
    if (this.dead) {
      this.deadTimer -= dt;
      this.game.ui.setDeathTimer(this.deadTimer);
      if (this.deadTimer <= 0) {
        this.dead = false;
        this.hp = this.maxHp;
        this.pos.set(0, 0, 0);
        this.mesh.position.set(0, this.radius, 0);
        this.mesh.visible = true;
        this.game.ui.showDeath(false);
      }
      return;
    }

    this.heal(this.regen * dt);

    if (this.game.fpsMode) {
      // first-person: WASD relative to the look direction
      const { yaw } = this.game.input.look;
      const axes = this.game.input.moveAxes();
      if (axes.x !== 0 || axes.z !== 0) {
        const delta = new THREE.Vector3(
          -Math.sin(yaw) * axes.z + Math.cos(yaw) * axes.x, 0,
          -Math.cos(yaw) * axes.z - Math.sin(yaw) * axes.x
        ).multiplyScalar(this.speed * dt);
        this.pos.add(delta);
      }
      this.facing = yaw + Math.PI;
    } else {
      // florr-style movement: flower chases the cursor, speed scales with distance
      const target = this.game.input.cursorWorld();
      const delta = new THREE.Vector3(target.x - this.pos.x, 0, target.z - this.pos.z);
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

    // the camera sits inside the flower in first person
    this.mesh.visible = !this.game.fpsMode;

    // lerped visuals
    this.mesh.position.lerp(
      new THREE.Vector3(this.pos.x, this.radius, this.pos.z), damp(14, dt)
    );
    const targetQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), this.facing
    );
    this.mesh.quaternion.slerp(targetQ, damp(8, dt));
    updateFlash(this.mesh);
  }
}
