import { HIT_COOLDOWN, PLAYER_BODY_DAMAGE } from './config.js';

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
}
