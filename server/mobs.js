import * as THREE from 'three';
import {
  MOB_TYPES, RARITIES, MOB_CAP, ARENA_HALF, TILE_SIZE, SPAWN_POS,
  DROP_DAMAGE_FRAC, MIN_LOOTERS, EQUAL_RARITY_DROP_BASE, VIEW_RADIUS,
  clampToArena, collideWalls, isWallCell, wallTopAt,
  tileTypeAt, pickRarity, pickDrop,
} from '../shared/config.js';

// Stale-mob recycling: a mob nobody has been near for this long silently
// despawns (no loot, no xp), freeing its cap slot for a fresh spawn
// elsewhere. This is the structural guard against cap squatters — mob
// slots only free on death, so anything players can't or won't kill
// (Mythic+ hp, armor-walled rocks) otherwise accumulates until the whole
// cap is immortal and ambient spawning starves. Invisible to players by
// construction: it only ever fires outside everyone's VIEW_RADIUS.
const STALE_RECYCLE_AFTER = 600; // 10 min with no player in view
const STALE_SWEEP_INTERVAL = 5;

// spawns this close to the player spawn point never exceed Rare, whatever
// the depth roll says — fresh flowers shouldn't meet an Ultra on tile one
const SAFE_RING = 60;
const SAFE_RING_MAX_RARITY = 2;
import { uid, damp } from './utils.js';
import { notifyUltraSpawn } from './discord.js';
import { spawnEscort, releaseGarrison, tickHoleAnt } from './ants.js';

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
  // slower dive with a longer overshoot means more time at petal height,
  // i.e. a longer punish window per swoop instead of a fast blur-past
  swoopSpeedMult: 1.8,
  swoopOvershoot: 18,
  swoopMaxTime: 8,
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
    this.damageBy = new Map(); // playerId -> total damage dealt, for loot shares

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
    if (attacker) {
      this.lastAttacker = attacker;
      this.damageBy.set(attacker.id, (this.damageBy.get(attacker.id) || 0) + dealt);
    }
    this.world.events.push({ e: 'flash', k: 'mob', id: this.id });
    this.world.events.push({
      e: 'dmg', a: Math.round(dealt),
      x: Math.round(this.pos.x * 100) / 100, z: Math.round(this.pos.z * 100) / 100,
    });
    // Rare+ mobs retaliate when attacked; neutral types (worker ant) always
    // do; passive types (baby ant) never do
    if (!this.def.passive && (this.rarity >= 2 || this.def.retaliates)) this.aggro = true;
    // stationary mobs (ant holes, rocks) don't slide around when hit
    if (source && this.speed > 0) {
      const push = this.pos.clone().sub(source).setY(0).normalize().multiplyScalar(9);
      this.knock.add(push);
    }
    if (this.type === 'anthole') releaseGarrison(this.world.mobs, this);
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
    if (!dropType) return;
    // individual loot: one privately-owned copy of the drop for each of the
    // top MIN_LOOTERS damage contributors, no matter how small their share —
    // past those, a contributor still qualifies with at least
    // DROP_DAMAGE_FRAC of the damage recorded from still-connected players.
    // Shares are relative to actual damage dealt — not max hp — so
    // heavily-armored mobs (where every hit lands as 1) and credit orphaned
    // by disconnects can't push the bar out of reach.
    const connected = [...this.damageBy]
      .filter(([id]) => this.world.players.has(id))
      .sort((a, b) => b[1] - a[1]);
    if (connected.length === 0) return;
    const total = connected.reduce((sum, [, dmg]) => sum + dmg, 0);
    const owners = connected.filter(([, dmg], rank) =>
      rank < MIN_LOOTERS || dmg >= total * DROP_DAMAGE_FRAC);
    // each copy rolls its own rarity: equal to the mob's at a chance that
    // halves per tier (see EQUAL_RARITY_DROP_BASE), one tier below otherwise
    for (const [id] of owners) {
      const equal = Math.random() < EQUAL_RARITY_DROP_BASE / 2 ** this.rarity;
      const rarity = equal ? this.rarity : Math.max(0, this.rarity - 1);
      this.world.drops.spawn(dropType, rarity, this.pos, id);
    }
  }

  update(dt) {
    if (this.hole) tickHoleAnt(this, dt); // orphaned garrison ants despawn
    if (this.deadFlag) return;
    if (this.type === 'hornet') this.updateHornet(dt);
    else this.updateGround(dt);

    this.pos.addScaledVector(this.knock, dt);
    this.knock.multiplyScalar(Math.exp(-6 * dt));
    clampToArena(this.pos, this.radius);
    // fliers ignore walls (they're above all but the tallest columns; AI
    // pathing around terrain isn't worth it for a hover-and-dive mob)
    if (!this.flight) collideWalls(this.pos, this.radius);
  }

  updateGround(dt) {
    const player = this.world.nearestPlayer(this.pos);
    let vel = new THREE.Vector3();

    // sight-aggro types (soldier ant) charge anyone inside their reach and
    // give up past the leash — however the aggro started, so a sniped
    // soldier still stops chasing once you've clearly outrun it
    if (this.def.sightAggro) {
      const d = player ? this.pos.distanceTo(player.pos) : Infinity;
      if (d < this.def.sightAggro) this.aggro = true;
      else if (d > this.def.leash) this.aggro = false;
    }

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
          // dive through the player's position and well past it
          f.target.copy(player.pos).addScaledVector(toPlayer, HORNET.swoopOvershoot).setY(0);
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
    this.staleTimer = STALE_SWEEP_INTERVAL;
    const initial = Math.floor(MOB_CAP * 0.8);
    for (let i = 0; i < initial; i++) this.trySpawn();
  }

  // weighted type pick: types without a spawnWeight count as 1; types at
  // their maxAlive cap are excluded from the roll entirely. maxAlive values
  // are tuned for the default 56-mob arena and scale with the actual cap,
  // so a big map keeps the same population share (never below the tuned
  // number on small arenas).
  pickType() {
    const alive = {};
    for (const m of this.mobs) alive[m.type] = (alive[m.type] || 0) + 1;
    const capOf = (def) => Math.max(def.maxAlive, Math.round(def.maxAlive * MOB_CAP / 56));
    const entries = Object.entries(MOB_TYPES)
      .filter(([type, def]) => !def.maxAlive || (alive[type] || 0) < capOf(def));
    let total = 0;
    for (const [, def] of entries) total += def.spawnWeight ?? 1;
    let r = Math.random() * total;
    for (const [type, def] of entries) {
      r -= def.spawnWeight ?? 1;
      if (r <= 0) return type;
    }
    return entries[0][0];
  }

  trySpawn() {
    if (this.mobs.length >= MOB_CAP) return;
    const players = [...this.world.players.values()];
    // spawns are uniform across the whole map — the world exists on its
    // own terms; zones stay populated whether anyone is nearby or not
    for (let attempt = 0; attempt < 20; attempt++) {
      const pos = new THREE.Vector3(
        (Math.random() * 2 - 1) * (ARENA_HALF - 8), 0,
        (Math.random() * 2 - 1) * (ARENA_HALF - 8)
      );
      // grass only (mobs don't spawn in water/desert/jungle — per-tile mob
      // pools come later with the builder's spawn rates), never inside a
      // wall column, never popping in on top of anyone
      if (tileTypeAt(pos.x, pos.z) !== 'grass') continue;
      if (isWallCell(Math.round(pos.x / TILE_SIZE), Math.round(pos.z / TILE_SIZE))) continue;
      if (players.some((p) => pos.distanceTo(p.pos) < 30)) continue;
      // rarity scales with depth: distance from the spawn point relative to
      // the farthest reach of the arena, so the gradient spans the whole
      // map wherever the spawn sits (corner spawn = diagonal gradient)
      const dist = Math.hypot(pos.x - SPAWN_POS.x, pos.z - SPAWN_POS.z);
      const maxDist = Math.hypot(ARENA_HALF + Math.abs(SPAWN_POS.x), ARENA_HALF + Math.abs(SPAWN_POS.z));
      let rarity = pickRarity(Math.random, Math.min(1, dist / maxDist));
      if (dist < SAFE_RING) rarity = Math.min(rarity, SAFE_RING_MAX_RARITY);
      // per-tier population caps (RARITIES maxShare): a roll for a tier
      // that's full steps down until it finds room — high tiers must stay
      // scarce or they slowly monopolize the cap (see RARITIES comment)
      const aliveByRarity = new Array(RARITIES.length).fill(0);
      for (const m of this.mobs) aliveByRarity[m.rarity]++;
      const tierFull = (r) => RARITIES[r].maxShare !== undefined &&
        aliveByRarity[r] >= Math.max(1, Math.round(RARITIES[r].maxShare * MOB_CAP));
      while (rarity > 0 && tierFull(rarity)) rarity--;
      const type = this.pickType();
      const mob = this.spawn(type, rarity, pos);
      if (type === 'anthole') spawnEscort(this, mob);
      if (rarity === RARITIES.length - 1) notifyUltraSpawn(MOB_TYPES[type].name);
      return;
    }
  }

  // direct spawn, no placement rules or cap check — for callers that manage
  // their own placement (ant hole garrisons); trySpawn is the ambient path
  spawn(type, rarity, pos) {
    const mob = new Mob(this.world, type, rarity, pos);
    this.mobs.push(mob);
    return mob;
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
      this.spawnTimer = 0.25; // faster refill after deaths (spawn-rate buff)
      this.trySpawn();
    }

    for (const mob of this.mobs) mob.update(dt);

    // stale sweep (see STALE_RECYCLE_AFTER): coarse-grained on purpose —
    // checking every mob against every player each tick would be waste
    this.staleTimer -= dt;
    if (this.staleTimer <= 0) {
      this.staleTimer = STALE_SWEEP_INTERVAL;
      const alive = [...this.world.players.values()].filter((p) => !p.dead);
      const r2 = VIEW_RADIUS * VIEW_RADIUS;
      for (const m of this.mobs) {
        if (alive.some((p) => p.pos.distanceToSquared(m.pos) < r2)) {
          m.lonely = 0;
        } else {
          m.lonely = (m.lonely || 0) + STALE_SWEEP_INTERVAL;
          if (m.lonely >= STALE_RECYCLE_AFTER) m.deadFlag = true;
        }
      }
    }

    // Gentle mob-mob separation so they don't stack. Broad phase is a
    // uniform hash grid rebuilt per tick: cells are wider than the largest
    // possible pair reach (two Ultra-scale radii), so only the 3x3
    // neighborhood can contain overlapping pairs — O(n) instead of the old
    // all-pairs O(n^2), which matters once big maps raise the mob cap.
    const CELL = 24;
    const grid = new Map(); // 'cx,cz' -> indices into this.mobs
    const keys = new Array(this.mobs.length);
    for (let i = 0; i < this.mobs.length; i++) {
      const m = this.mobs[i];
      const key = Math.floor(m.pos.x / CELL) + ',' + Math.floor(m.pos.z / CELL);
      keys[i] = key;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    for (let i = 0; i < this.mobs.length; i++) {
      const a = this.mobs[i];
      const [cx, cz] = keys[i].split(',').map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get((cx + dx) + ',' + (cz + dz));
          if (!bucket) continue;
          for (const j of bucket) {
            if (j <= i) continue; // each pair once
            const b = this.mobs[j];
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
      }
    }

    this.mobs = this.mobs.filter((m) => !m.deadFlag);

    for (const mi of this.missiles) {
      mi.pos.addScaledVector(mi.vel, dt);
      mi.life -= dt;
      if (mi.life <= 0 || mi.pos.y <= 0.05 ||
          mi.pos.y < wallTopAt(mi.pos.x, mi.pos.z) || // splats on terrain
          Math.max(Math.abs(mi.pos.x), Math.abs(mi.pos.z)) > ARENA_HALF + 4) {
        mi.dead = true;
      }
    }
    this.missiles = this.missiles.filter((m) => !m.dead);
  }
}
