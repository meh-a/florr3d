import * as THREE from 'three';
import { HIT_COOLDOWN, PLAYER_BODY_DAMAGE } from '../shared/config.js';

// per-pair damage tick limiter, stored on the entity that owns the map
function canHit(owner, otherId, time) {
  const last = owner.hitCooldowns.get(otherId) || -Infinity;
  if (time - last < HIT_COOLDOWN) return false;
  owner.hitCooldowns.set(otherId, time);
  return true;
}

// CO-OP boundary: every check in here is mob-vs-player or mob-vs-petal.
// Players' petals and bodies never test against *other players* — that
// absence is deliberate and is the entire co-op/PvP toggle. If PvP ever
// ships, it gets added here as its own clearly-scoped block.
export function updateCombat(world, dt) {
  const t = world.time;
  const players = [...world.players.values()];

  for (const mob of world.mobs.mobs) {
    if (mob.deadFlag) continue;

    for (const player of players) {
      // mob vs player body — spawn-immune flowers neither take nor deal
      // body damage (immunity that still let you ram would be a free weapon)
      if (!player.dead && player.immunity <= 0) {
        const d = mob.pos.distanceTo(player.pos);
        if (d < mob.radius + player.radius) {
          if (canHit(mob, player.id, t)) {
            player.damage(mob.dmg);
            mob.damage(PLAYER_BODY_DAMAGE, player.pos, player);
            const push = player.pos.clone().sub(mob.pos).setY(0).normalize();
            player.knock.addScaledVector(push, 12);
          }
        }
      }
      if (mob.deadFlag) break;

      // mob vs this player's petals
      for (const petal of player.petals.instances) {
        if (!petal.alive) continue;
        const d = mob.pos.distanceTo(petal.pos);
        if (d < mob.radius + petal.radius) {
          if (canHit(mob, petal.id, t)) {
            mob.damage(petal.dmg, petal.pos, player);
            petal.hp -= mob.dmg;
            if (petal.hp <= 0) player.petals.destroyInstance(petal);
            if (mob.deadFlag) break;
          }
        }
      }
      if (mob.deadFlag) break;
    }
  }

  // player missile projectiles vs mobs. Projectiles fly in the ground plane
  // (y=0, like all petal combat), so a mob's altitude counts against the
  // hit: airborne hornets are only reachable during their swoop.
  for (const player of players) {
    for (const proj of player.petals.projectiles) {
      if (proj.dead) continue;
      for (const mob of world.mobs.mobs) {
        if (mob.deadFlag) continue;
        if (proj.pos.distanceTo(mob.pos) < proj.radius + mob.radius) {
          mob.damage(proj.dmg, proj.pos, player);
          proj.dead = true;
          break;
        }
      }
    }
  }

  // hornet missiles: hit any player, or get shot down by anyone's petals.
  // The flower body and orbiting petals both live visually at y=1.1, so
  // collisions test against that height rather than the server's
  // ground-level positions.
  const hitPoint = new THREE.Vector3();
  for (const mi of world.mobs.missiles) {
    if (mi.dead) continue;

    for (const player of players) {
      if (!player.dead && player.immunity <= 0) { // missiles pass through immune flowers
        hitPoint.set(player.pos.x, 1.1, player.pos.z);
        if (mi.pos.distanceTo(hitPoint) < mi.radius + player.radius) {
          player.damage(mi.dmg);
          mi.dead = true;
          break;
        }
      }

      for (const petal of player.petals.instances) {
        if (!petal.alive) continue;
        hitPoint.set(petal.pos.x, 1.1, petal.pos.z);
        if (mi.pos.distanceTo(hitPoint) < mi.radius + petal.radius) {
          petal.hp -= mi.dmg;
          mi.hp -= petal.dmg;
          world.events.push({
            e: 'dmg', a: Math.round(petal.dmg),
            x: Math.round(mi.pos.x * 100) / 100, z: Math.round(mi.pos.z * 100) / 100,
          });
          if (petal.hp <= 0) player.petals.destroyInstance(petal);
          if (mi.hp <= 0) {
            mi.dead = true;
            break;
          }
        }
      }
      if (mi.dead) break;
    }
  }
}
