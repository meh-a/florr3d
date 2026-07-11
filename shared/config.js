// Rarity table. Mobs and petals scale differently:
// - statMult scales mob health (and xp), dmgMult mob damage (flat x3 per
//   tier), armorMult mob armor — the game's own curves, deliberately
//   steeper than the wiki so high-rarity mobs stay boss-like.
// - petalMult scales petal health, damage, and heal with the florr.io
//   wiki's uniform per-rarity sequence.
// All are relative to Common = 1.
export const RARITIES = [
  { name: 'Common',    color: '#7eef6d', petalMult: 1,     statMult: 1,      dmgMult: 1,   armorMult: 1,   weight: 55,   scale: 1.0  },
  { name: 'Unusual',   color: '#ffe65d', petalMult: 1.5,   statMult: 3.75,   dmgMult: 3,   armorMult: 2,   weight: 25,   scale: 1.3  },
  { name: 'Rare',      color: '#4d52e3', petalMult: 4.5,   statMult: 13.5,   dmgMult: 9,   armorMult: 7,   weight: 12,   scale: 1.7  },
  { name: 'Epic',      color: '#861fde', petalMult: 9,     statMult: 54,     dmgMult: 27,  armorMult: 22,  weight: 6,    scale: 2.2  },
  { name: 'Legendary', color: '#de1f1f', petalMult: 27,    statMult: 324,    dmgMult: 81,  armorMult: 65,  weight: 2,    scale: 3.0  },
  { name: 'Mythic',    color: '#1fdbde', petalMult: 48.6,  statMult: 3159,   dmgMult: 243, armorMult: 194, weight: 0.4,  scale: 4.2  },
  { name: 'Ultra',     color: '#ff2b75', petalMult: 145.8, statMult: 196830, dmgMult: 729, armorMult: 583, weight: 0.08, scale: 5.5  },
];

// drops: [petalType|null, weight]
export const MOB_TYPES = {
  rock: {
    name: 'Rock', hp: 45, dmg: 8, armor: 2, radius: 1.6, speed: 0, xp: 2,
    drops: [['rockPetal', 0.7], [null, 0.3]],
  },
  ladybug: {
    name: 'Ladybug', hp: 35, dmg: 12, armor: 0, radius: 1.5, speed: 2.4, xp: 4,
    drops: [['rose', 0.45], ['light', 0.3], [null, 0.25]],
  },
  bee: {
    name: 'Bee', hp: 15, dmg: 40, armor: 0, radius: 1.4, speed: 2.8, xp: 5,
    drops: [['stinger', 0.55], [null, 0.45]],
  },
  hornet: {
    name: 'Hornet', hp: 62.5, dmg: 50, armor: 1, radius: 1.7, speed: 2.0, xp: 12,
    drops: [['missile', 0.5], ['orange', 0.5]],
    // rarer spawn than the basic mobs, and never more than a few alive at
    // once — it's much more dangerous
    spawnWeight: 0.35,
    maxAlive: 6,
    missile: { hp: 5, dmg: 10, speed: 16, radius: 0.45 },
  },
};

export const PETAL_TYPES = {
  basic:     { name: 'Basic',   hp: 10, dmg: 10, reload: 2.5, radius: 0.42, count: 1, color: '#ffffff',
               desc: 'A nice petal, not too strong but not too weak.' },
  rockPetal: { name: 'Rock',    hp: 45, dmg: 10, reload: 8,   radius: 0.5,  count: 1, color: '#7d7d84',
               desc: 'Heavy and durable, with a slow reload.' },
  rose:      { name: 'Rose',    hp: 5,  dmg: 5,  reload: 3.5, radius: 0.42, count: 1, color: '#ff94c9', heal: 11,
               desc: 'Flies home to heal you when you’re hurt.' },
  light:     { name: 'Light',   hp: 5,  dmg: 13, reload: 0.6, radius: 0.28, count: 3, color: '#ffffff',
               desc: 'Fires in a rapid volley of three.' },
  stinger:   { name: 'Stinger', hp: 8,  dmg: 35, reload: 4,   radius: 0.35, count: 1, color: '#333333',
               desc: 'Fragile, but deals heavy damage.' },
  orange:    { name: 'Orange',  hp: 6.6, dmg: 8, reload: 1,   radius: 0.3,  count: 3, color: '#eb9c2d',
               desc: 'A weaker but faster version of Light.' },
  // fired as a straight-line projectile while attacking, florr's legacy petal
  missile:   { name: 'Missile', hp: 2,  dmg: 35, reload: 3,   radius: 0.4,  count: 1, color: '#333333',
               projectile: { speed: 24, life: 1.8 },
               desc: 'Launches forward as a projectile when attacking.' },
};

export const ARENA_HALF = 185;       // playable half-extent; ground drawn a bit larger

// ---- terrain tiles ----
// The arena is an implicit grass grid; MAP_TILES sparsely overrides cells by
// grid coordinate (cell centers at gx/gz * TILE_SIZE). Tile types carry no
// gameplay yet, but they live here (not client-side) so the server can add
// per-tile effects later (slows, damage, spawns) without a protocol change.
export const TILE_SIZE = 20;
export const TILE_TYPES = {
  grass: { name: 'Grass' },
  water: { name: 'Water' },
  // future tile types (mud, rock, ...) get an entry here plus a renderer
  // case in client/src/tiles.js
};
// debug placement: two water tiles just east of spawn
export const MAP_TILES = [
  { gx: 1, gz: 0, type: 'water' },
  { gx: 2, gz: 0, type: 'water' },
];
export const MOB_CAP = 44;
// interest management: each client only receives entities within this range
// of its own player. Past ~110 units everything is deep in the fog (which
// runs 90->190) and far outside the top-down camera's view, so the cutoff
// is invisible in practice while capping per-client snapshot size.
export const VIEW_RADIUS = 110;
export const PLAYER_BODY_DAMAGE = 10;
export const HIT_COOLDOWN = 0.45;    // seconds between damage ticks for a touching pair
// individual loot: everyone who dealt at least this share of the damage
// recorded from still-connected players gets their own copy of the drop
// (visible/lootable only by them)
export const DROP_DAMAGE_FRAC = 0.1;
// seconds of invulnerability after (re)spawning; attacking ends it early
export const SPAWN_IMMUNITY = 3;

// works on anything with mutable x/z (THREE.Vector3 or plain objects)
export function clampToArena(pos, margin = 0) {
  const half = ARENA_HALF - margin;
  pos.x = Math.max(-half, Math.min(half, pos.x));
  pos.z = Math.max(-half, Math.min(half, pos.z));
}

export function pickRarity(rng = Math.random) {
  const total = RARITIES.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (let i = 0; i < RARITIES.length; i++) {
    roll -= RARITIES[i].weight;
    if (roll <= 0) return i;
  }
  return 0;
}

export function pickDrop(mobType, rng = Math.random) {
  const drops = MOB_TYPES[mobType].drops;
  const total = drops.reduce((s, [, w]) => s + w, 0);
  let roll = rng() * total;
  for (const [type, w] of drops) {
    roll -= w;
    if (roll <= 0) return type;
  }
  return null;
}
