import * as THREE from 'three';
import {
  MOB_TYPES, RARITIES, MOB_CAP, ARENA_HALF, clampToArena, pickRarity, pickDrop,
} from '../shared/config.js';
import { uid, damp } from './utils.js';

// Hornet flight tuning. The attack rhythm is: hover out of reach and lob
// missiles (dodgeable / shootable), then dive low in a telegraphed strafing
// run to "rearm" — that swoop is the player's window to hit back.
const HORNET = {
  aggroRange: 30,
  // altitudes are clearance above the mob's own radius — a giant Ultra
  // hornet must hover proportionally higher or its huge contact range
  // would reach the ground while it's supposedly out of reach
  cruiseAlt: 5,     // passive drift clearance
  volleyAlt: 5.5,   // firing clearance
  swoopAlt: 0.6,    // low pass, within petal/body reach
  standoff: 13,     // preferred horizontal distance while firing
  fireRange: 45,
  fireInterval: 2.2,
  regrowTime: 0.9,  // missile visibly regrows on the tail after firing
  swoopSpeedMult: 3.1,
  swoopMaxTime: 4.5,
};

class Mob {
  constructor(world, type, rarityIdx, pos) {
    this.world = world;
    this.id = uid();
    this.type = type;
    this.def = MOB_TYPES[type];
    this.rarity = rarityIdx;
    const r = RARITIES[rarityIdx];
    this.maxHp = this.def.hp * r.statMult;
    this.hp = this.maxHp;
    this.dmg = this.def.dmg * r.dmgMult;
    this.armor = this.def.armor * r.armorMult;
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
    this.lastAttacker = null; // Player credited with the kill for xp

    if (this.type === 'hornet') {
      this.pos.y = HORNET.cruiseAlt + this.radius; // spawns already airborne
      this.pitch = 0;
      this.loaded = true; // missile visibly docked on the tail
      this.strafeDir = Math.random() < 0.5 ? 1 : -1;
      this.flight = { state: 'cruise', shots: 0, fireTimer: 0, regrow: 0, timer: 0, target: new THREE.Vector3() };
    }
  }

  damage(amount, source = null, attacker = null) {
    const dealt = Math.max(1, amount - this.armor);
    this.hp -= dealt;
    if (attacker) this.lastAttacker = attacker;
    this.world.events.push({ e: 'flash', k: 'mob', id: this.id });
    this.world.events.push({
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
    // credit the last player who damaged this mob (if they're still here)
    const killer = this.lastAttacker && this.world.players.has(this.lastAttacker.id)
      ? this.lastAttacker : this.world.nearestPlayer(this.pos);
    if (killer) killer.gainXp(this.xp);
    const dropType = pickDrop(this.type);
    if (dropType) this.world.drops.spawn(dropType, this.rarity, this.pos);
  }

  update(dt) {
    if (this.type === 'hornet') this.updateHornet(dt);
    else this.updateGround(dt);

    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-6 * dt));
    clampToArena(this.pos, this.radius);
  }

  updateGround(dt) {
    const player = this.world.nearestPlayer(this.pos);
    let vel = new THREE.Vector3();

    if (this.speed > 0) {
      if (this.aggro && player) {
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

    if (vel.lengthSq() > 0.01) this.facing = Math.atan2(vel.x, vel.z);
  }

  // Flying state machine: cruise (passive drift, high up) -> volley (hold a
  // standoff ring, flip 180°, lob missiles) -> swoop (dive through the
  // player at petal height — the punish window) -> back to volley/cruise.
  updateHornet(dt) {
    const player = this.world.nearestPlayer(this.pos); // null if nobody alive
    const f = this.flight;
    const toPlayer = player ? player.pos.clone().sub(this.pos).setY(0) : new THREE.Vector3();
    const hDist = player ? toPlayer.length() : Infinity;
    if (player && hDist > 0.01) toPlayer.multiplyScalar(1 / hDist);

    if (!player) {
      this.aggro = false;
      f.state = 'cruise';
    } else if (hDist < HORNET.aggroRange) {
      this.aggro = true; // hornets are aggressive on sight, not just on hit
    }

    let vel = new THREE.Vector3();
    let altTarget = HORNET.cruiseAlt + this.radius;
    let altRate = 2.2;

    if (f.state === 'cruise') {
      this.wanderTimer -= dt;
      if (this.wanderTimer <= 0) {
        this.wanderTimer = 2 + Math.random() * 3;
        this.heading = Math.random() * Math.PI * 2;
      }
      vel.set(Math.sin(this.heading), 0, Math.cos(this.heading)).multiplyScalar(this.speed);
      this.facing = Math.atan2(vel.x, vel.z);
      if (this.aggro) {
        f.state = 'volley';
        f.shots = 2 + this.rarity; // rarer hornets fire longer volleys
        f.fireTimer = 1.2;
      }
    } else if (f.state === 'volley') {
      altTarget = HORNET.volleyAlt + this.radius;
      // hold the standoff ring: close in, back off, or orbit sideways
      const inRing = hDist < HORNET.standoff + 2;
      if (!inRing) {
        vel.copy(toPlayer).multiplyScalar(this.speed * 1.6);
      } else if (hDist < HORNET.standoff - 2) {
        vel.copy(toPlayer).multiplyScalar(-this.speed * 1.6);
      } else {
        vel.set(-toPlayer.z, 0, toPlayer.x).multiplyScalar(this.speed * 0.7 * this.strafeDir);
      }
      // approach nose-first; the florr-authentic 180° flip (tail and missile
      // toward the player) only happens inside the ring, so the spin reads
      // as a deliberate wind-up right before firing
      this.facing = inRing
        ? Math.atan2(-toPlayer.x, -toPlayer.z)
        : Math.atan2(toPlayer.x, toPlayer.z);

      f.regrow -= dt;
      if (f.regrow <= 0) this.loaded = true;
      f.fireTimer -= dt;
      if (f.fireTimer <= 0 && this.loaded && inRing && hDist < HORNET.fireRange) {
        this.world.mobs.fireMissile(this, player);
        this.loaded = false;
        f.regrow = HORNET.regrowTime;
        f.fireTimer = HORNET.fireInterval;
        f.shots--;
        if (f.shots <= 0) {
          f.state = 'swoop';
          f.timer = HORNET.swoopMaxTime;
          // dive through the player's position and 12 units past it
          f.target.copy(player.pos).addScaledVector(toPlayer, 12).setY(0);
        }
      }
    } else { // swoop
      altTarget = HORNET.swoopAlt;
      altRate = 3.2; // dive and pull up harder than normal climb
      const toTarget = f.target.clone().sub(this.pos).setY(0);
      const dist = toTarget.length();
      if (dist > 0.01) vel.copy(toTarget.multiplyScalar(1 / dist)).multiplyScalar(this.speed * HORNET.swoopSpeedMult);
      this.facing = Math.atan2(vel.x, vel.z);
      f.timer -= dt;
      if (dist < 2.5 || f.timer <= 0) {
        f.state = this.aggro ? 'volley' : 'cruise';
        f.shots = 2 + this.rarity;
        f.fireTimer = 1.4;
      }
    }

    this.pos.addScaledVector(vel, dt);
    const prevY = this.pos.y;
    this.pos.y += (altTarget - this.pos.y) * damp(altRate, dt);

    // nose follows the actual velocity: down when diving, up when climbing
    const vy = (this.pos.y - prevY) / Math.max(dt, 1e-6);
    const targetPitch = Math.atan2(-vy, Math.max(vel.length(), 2));
    this.pitch += (targetPitch - this.pitch) * damp(6, dt);
  }
}

export class MobManager {
  constructor(world) {
    this.world = world;
    this.mobs = [];
    this.missiles = [];
    this.spawnTimer = 0;
    for (let i = 0; i < 16; i++) this.trySpawn(true);
  }

  // weighted type pick: types without a spawnWeight count as 1; types at
  // their maxAlive cap are excluded from the roll entirely
  pickType() {
    const alive = {};
    for (const m of this.mobs) alive[m.type] = (alive[m.type] || 0) + 1;
    const entries = Object.entries(MOB_TYPES)
      .filter(([type, def]) => !def.maxAlive || (alive[type] || 0) < def.maxAlive);
    let total = 0;
    for (const [, def] of entries) total += def.spawnWeight ?? 1;
    let r = Math.random() * total;
    for (const [type, def] of entries) {
      r -= def.spawnWeight ?? 1;
      if (r <= 0) return type;
    }
    return entries[0][0];
  }

  trySpawn(initial = false) {
    if (this.mobs.length >= MOB_CAP) return;
    const players = [...this.world.players.values()];
    for (let attempt = 0; attempt < 12; attempt++) {
      const pos = new THREE.Vector3(
        (Math.random() * 2 - 1) * (ARENA_HALF - 8), 0,
        (Math.random() * 2 - 1) * (ARENA_HALF - 8)
      );
      // never pop in on top of anyone; after the initial fill, also stay
      // within roaming range of at least one player (any spot is fine
      // while the world is empty)
      const dists = players.map((p) => pos.distanceTo(p.pos));
      if (dists.some((d) => d < 30)) continue;
      if (!initial && dists.length > 0 && !dists.some((d) => d <= 130)) continue;
      this.mobs.push(new Mob(this.world, this.pickType(), pickRarity(), pos));
      return;
    }
  }

  // launch the hornet's tail missile at its target player's current
  // position; it flies a straight line, so the lob is dodgeable by moving
  fireMissile(hornet, player) {
    const r = RARITIES[hornet.rarity];
    const mdef = hornet.def.missile;
    const target = new THREE.Vector3(player.pos.x, 1.1, player.pos.z);
    const aim = target.clone().sub(hornet.pos).setY(0).normalize();
    const origin = hornet.pos.clone().addScaledVector(aim, hornet.radius * 1.2);
    const vel = target.sub(origin).normalize().multiplyScalar(mdef.speed);
    this.missiles.push({
      id: uid(),
      pos: origin,
      vel,
      radius: mdef.radius * r.scale,
      hp: mdef.hp * r.statMult,
      dmg: mdef.dmg * r.dmgMult,
      rarity: hornet.rarity,
      life: 4,
      yaw: Math.atan2(vel.x, vel.z),
      pitch: Math.atan2(-vel.y, Math.hypot(vel.x, vel.z)),
      dead: false,
    });
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

    for (const mi of this.missiles) {
      mi.pos.addScaledVector(mi.vel, dt);
      mi.life -= dt;
      if (mi.life <= 0 || mi.pos.y <= 0.05 ||
          Math.max(Math.abs(mi.pos.x), Math.abs(mi.pos.z)) > ARENA_HALF + 4) {
        mi.dead = true;
      }
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
  }
}
