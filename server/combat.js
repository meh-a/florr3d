import * as THREE from 'three';
import { HIT_COOLDOWN, PLAYER_BODY_DAMAGE } from '../shared/config.js';

// per-pair damage tick limiter, stored on the entity that owns the map
function canHit(owner, otherId, time) {
  const last = owner.hitCooldowns.get(otherId) || -Infinity;
  if (time - last < HIT_COOLDOWN) return false;
  owner.hitCooldowns.set(otherId, time);
  return true;
}

export function updateCombat(game, dt) {
  const t = game.time;
  const player = game.player;

  for (const mob of game.mobs.mobs) {
    if (mob.deadFlag) continue;

    // mob vs player body
    if (!player.dead) {
      const d = mob.pos.distanceTo(player.pos);
      if (d < mob.radius + player.radius) {
        if (canHit(mob, player.id, t)) {
          player.damage(mob.dmg);
          mob.damage(PLAYER_BODY_DAMAGE, player.pos);
          const push = player.pos.clone().sub(mob.pos).setY(0).normalize();
          player.knock.addScaledVector(push, 12);
        }
      }
    }
    if (mob.deadFlag) continue;

    // mob vs petals
    for (const petal of game.petals.instances) {
      if (!petal.alive) continue;
      const d = mob.pos.distanceTo(petal.pos);
      if (d < mob.radius + petal.radius) {
        if (canHit(mob, petal.id, t)) {
          mob.damage(petal.dmg, petal.pos);
          petal.hp -= mob.dmg;
          if (petal.hp <= 0) game.petals.destroyInstance(petal);
          if (mob.deadFlag) break;
        }
      }
    }
  }

  // player missile projectiles vs mobs. Projectiles fly in the ground plane
  // (y=0, like all petal combat), so a mob's altitude counts against the
  // hit: airborne hornets are only reachable during their swoop.
  for (const proj of game.petals.projectiles) {
    if (proj.dead) continue;
    for (const mob of game.mobs.mobs) {
      if (mob.deadFlag) continue;
      if (proj.pos.distanceTo(mob.pos) < proj.radius + mob.radius) {
        mob.damage(proj.dmg, proj.pos);
        proj.dead = true;
        break;
      }
    }
  }

  // hornet missiles: hit the player, or get shot down by petals. The flower
  // body and orbiting petals both live visually at y=1.1, so collisions test
  // against that height rather than the server's ground-level positions.
  const hitPoint = new THREE.Vector3();
  for (const mi of game.mobs.missiles) {
    if (mi.dead) continue;

    if (!player.dead) {
      hitPoint.set(player.pos.x, 1.1, player.pos.z);
      if (mi.pos.distanceTo(hitPoint) < mi.radius + player.radius) {
        player.damage(mi.dmg);
        mi.dead = true;
        continue;
      }
    }

    for (const petal of game.petals.instances) {
      if (!petal.alive) continue;
      hitPoint.set(petal.pos.x, 1.1, petal.pos.z);
      if (mi.pos.distanceTo(hitPoint) < mi.radius + petal.radius) {
        petal.hp -= mi.dmg;
        mi.hp -= petal.dmg;
        game.events.push({
          e: 'dmg', a: Math.round(petal.dmg),
          x: Math.round(mi.pos.x * 100) / 100, z: Math.round(mi.pos.z * 100) / 100,
        });
        if (petal.hp <= 0) game.petals.destroyInstance(petal);
        if (mi.hp <= 0) {
          mi.dead = true;
          break;
        }
      }
    }
  }
}
