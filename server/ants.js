// The ant family (florr-authentic, see antdata.txt for source behavior).
// Shipped so far: baby, worker, soldier, ant hole. Coming: queen (released
// at low hole hp, same rarity as hole; lays eggs at Rare+).
//
// Design notes:
// - Temperament is data on the MOB_TYPES entry, not per-type AI branches:
//   sightAggro/leash (soldier), retaliates (worker), and passive (baby) are
//   handled generically in Mob.updateGround / Mob.damage.
// - The ant hole is a stationary spawner: its garrison is its health bar
//   made flesh. Releases deliberately bypass MOB_CAP.
import { MOB_TYPES, RARITIES, clampToArena } from '../shared/config.js';

export const ANTHOLE = {
  // patrols spawned alongside the hole itself
  escort: { baby: 3, worker: 2, soldier: 1 },
  // florr's full garrison, paid out steadily as the hole loses health —
  // every hit past the next 1/total-of-max-hp threshold releases another
  // already-aggro ant (babies excepted — they stay passive) at the hole's
  // own rarity. Listed in release order: babies and workers stream out
  // before the soldiers, per florr.
  reinforcements: [['baby', 5], ['worker', 8], ['soldier', 26]],
};

// Hole-spawned ants ride on top of MOB_CAP, so they MUST eventually leave
// the world again: they still count in mobs.length, and trySpawn stops
// dead while that's >= MOB_CAP. Without this, every farmed hole donates
// its leftover garrison to the population forever and ambient spawning
// slowly starves to nothing (this took down live activity for ~13h on
// 2026-07-13). Once the hole is gone, its ants despawn silently — no loot,
// no xp — after a grace period with no player around to fight.
const IDLE_DESPAWN_GRACE = 30; // seconds without a nearby player
const IDLE_DESPAWN_RADIUS = 60;

export function tickHoleAnt(ant, dt) {
  if (!ant.hole.deadFlag) return; // guards of a living hole stay forever
  const p = ant.world.nearestPlayer(ant.pos);
  if (p && p.pos.distanceTo(ant.pos) < IDLE_DESPAWN_RADIUS) {
    ant.idleTime = 0; // someone is here — stay and fight
    return;
  }
  ant.idleTime = (ant.idleTime || 0) + dt;
  if (ant.idleTime > IDLE_DESPAWN_GRACE) ant.deadFlag = true;
}

// an ant pops out of the hole onto a random point of its rim; the
// separation pass nudges simultaneous arrivals apart on the next ticks
export function spawnHoleAnt(mobs, hole, type, aggro) {
  const angle = Math.random() * Math.PI * 2;
  const dist = hole.radius + MOB_TYPES[type].radius * RARITIES[hole.rarity].scale * 0.6;
  const pos = hole.pos.clone();
  pos.x += Math.sin(angle) * dist;
  pos.z += Math.cos(angle) * dist;
  const ant = mobs.spawn(type, hole.rarity, pos);
  clampToArena(ant.pos, ant.radius);
  ant.aggro = aggro && !ant.def.passive;
  ant.hole = hole; // ties its lifetime to the hole's — see tickHoleAnt
  return ant;
}

// the calm patrol that walks out with a freshly spawned hole; remembered on
// the hole so the whole colony can turn hostile the moment it's attacked
export function spawnEscort(mobs, hole) {
  hole.escortAnts = [];
  for (const [type, n] of Object.entries(ANTHOLE.escort)) {
    for (let i = 0; i < n; i++) hole.escortAnts.push(spawnHoleAnt(mobs, hole, type, false));
  }
}

// pay out the hole's garrison in proportion to health lost: each
// 1/total of max hp chipped off releases one aggro ant, so a killing blow
// floods out whatever remained
export function releaseGarrison(mobs, hole) {
  // attacking the hole angers its still-living escort too (babies excepted)
  for (const ant of hole.escortAnts ?? []) {
    if (!ant.deadFlag && !ant.def.passive) ant.aggro = true;
  }
  hole.reinforced ??= 0; // ants released so far, attached like the other hole-only fields
  const total = ANTHOLE.reinforcements.reduce((sum, [, n]) => sum + n, 0);
  const due = Math.min(total, Math.ceil(
    (1 - Math.max(0, hole.hp) / hole.maxHp) * total));
  while (hole.reinforced < due) {
    let idx = hole.reinforced++;
    for (const [type, n] of ANTHOLE.reinforcements) {
      if (idx < n) { spawnHoleAnt(mobs, hole, type, true); break; }
      idx -= n;
    }
  }
}
