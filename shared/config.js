// Rarity table. statMult follows florr's mob/petal scaling (Common x3.75 = Unusual,
// Unusual x3.6 = Rare, Rare x4 = Epic, Epic x6 = Legendary). dmgMult is a gentler
// curve used for mob contact damage so higher rarities are dangerous but not
// guaranteed one-shots.
export const RARITIES = [
  { name: 'Common',    color: '#7eef6d', statMult: 1,    dmgMult: 1,    weight: 55, scale: 1.0  },
  { name: 'Unusual',   color: '#ffe65d', statMult: 3.75, dmgMult: 1.8,  weight: 25, scale: 1.2  },
  { name: 'Rare',      color: '#4d52e3', statMult: 13.5, dmgMult: 3.2,  weight: 12, scale: 1.45 },
  { name: 'Epic',      color: '#861fde', statMult: 54,   dmgMult: 5.6,  weight: 6,  scale: 1.75 },
  { name: 'Legendary', color: '#de1f1f', statMult: 324,  dmgMult: 10,   weight: 2,  scale: 2.1  },
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
};

export const PETAL_TYPES = {
  basic:     { name: 'Basic',   hp: 10, dmg: 10, reload: 2.5, radius: 0.42, count: 1, color: '#ffffff' },
  rockPetal: { name: 'Rock',    hp: 45, dmg: 10, reload: 8,   radius: 0.5,  count: 1, color: '#7d7d84' },
  rose:      { name: 'Rose',    hp: 5,  dmg: 5,  reload: 3.5, radius: 0.42, count: 1, color: '#ff94c9', heal: 11 },
  light:     { name: 'Light',   hp: 5,  dmg: 7,  reload: 0.6, radius: 0.28, count: 3, color: '#ffffff' },
  stinger:   { name: 'Stinger', hp: 8,  dmg: 35, reload: 4,   radius: 0.35, count: 1, color: '#333333' },
};

export const ARENA_HALF = 145;       // playable half-extent; ground drawn a bit larger

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
export const MOB_CAP = 22;
export const PLAYER_BODY_DAMAGE = 10;
export const HIT_COOLDOWN = 0.45;    // seconds between damage ticks for a touching pair

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
