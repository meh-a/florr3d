import * as THREE from 'three';
import { clampToArena } from '../shared/config.js';

// Authoritative player. Movement is driven by the last input the client
// sent (cursor target in top-down mode, yaw + move axes in first person);
// hp/xp/death are decided here and only reported to the client.
export class Player {
  constructor(game) {
    this.game = game;
    this.id = 0; // sentinel id used in flash events; mobs use uid() >= 1
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
    this.facing = 0;
  }

  xpForNext() { return Math.floor(60 * Math.pow(1.25, this.level - 1)); }

  gainXp(amount) {
    this.xp += amount;
    while (this.xp >= this.xpForNext()) {
      this.xp -= this.xpForNext();
      this.level++;
      this.game.toast(`Level ${this.level}!`);
    }
  }

  damage(amount) {
    if (this.dead) return;
    this.hp -= amount;
    this.game.events.push({ e: 'flash', id: this.id });
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
    const input = this.game.input;

    if (this.dead) {
      this.deadTimer -= dt;
      if (this.deadTimer <= 0) {
        this.dead = false;
        this.hp = this.maxHp;
        this.pos.set(0, 0, 0);
        this.knock.set(0, 0, 0);
      }
      return;
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
  }
}
