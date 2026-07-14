// Rarity table. Mobs and petals scale differently:
// - statMult scales mob health (and xp), dmgMult mob damage (flat x3 per
//   tier), armorMult mob armor — the game's own curves, deliberately
//   steeper than the wiki so high-rarity mobs stay boss-like.
// - petalMult scales petal health, damage, and heal with florr.io's actual
//   in-game curve: a flat x3 per tier (see petal-stats.csv, pulled from the
//   real game). Petals with flatHp opt their health out of this scaling.
// All are relative to Common = 1.
// maxShare caps how much of MOB_CAP a tier may hold at once. High tiers are
// effectively unkillable for most of the population, and mob slots only
// free up on death — without a bound, immortal-tier rolls accumulate until
// they own the whole cap and ambient spawning starves (this killed live
// activity over ~13h on 2026-07-13/14).
export const RARITIES = [
  { name: 'Common',    color: '#7eef6d', petalMult: 1,   statMult: 1,      dmgMult: 1,   armorMult: 1,   weight: 100,  scale: 1.0  },
  { name: 'Unusual',   color: '#ffe65d', petalMult: 2,   statMult: 2,      dmgMult: 2,   armorMult: 2,   weight: 100,  scale: 1.2  },
  { name: 'Rare',      color: '#4d52e3', petalMult: 4,   statMult: 5,      dmgMult: 4,   armorMult: 4,   weight: 50,   scale: 1.5  },
  { name: 'Epic',      color: '#861fde', petalMult: 8,   statMult: 20,     dmgMult: 8,   armorMult: 8,   weight: 20,   scale: 2.0  },
  { name: 'Legendary', color: '#de1f1f', petalMult: 16,  statMult: 120,    dmgMult: 16,  armorMult: 16,  weight: 5,    scale: 2.8,  maxShare: 0.05  },
  { name: 'Mythic',    color: '#1fdbde', petalMult: 32,  statMult: 800,    dmgMult: 32,  armorMult: 32,  weight: 1,    scale: 4.0,  maxShare: 0.02  },
  { name: 'Ultra',     color: '#ff2b75', petalMult: 64,  statMult: 10000,  dmgMult: 64,  armorMult: 64,  weight: 0.2,  scale: 6.0,  maxShare: 0.005 },
];

// Chat/name input limits and the printable-ASCII filter, shared so the
// client's input fields and the server's authoritative sanitizers can't
// drift apart (standard English keyboard characters only — strips emoji,
// accents, other scripts, and control characters).
export const CHAT_MAX_LEN = 100;
export const NAME_MAX_LEN = 16;
export const stripNonAscii = (s) => s.replace(/[^\x20-\x7e]/g, '');

// drops: [petalType|null, weight]
export const MOB_TYPES = {
  rock: {
    name: 'Rock', hp: 45, dmg: 8, armor: 2, radius: 1.6, speed: 0, xp: 2,
    drops: [['rockPetal', 1]],
    spawnWeight: 0.5, // scenery shouldn't be a third of the population
  },
  ladybug: {
    name: 'Ladybug', hp: 35, dmg: 12, armor: 0, radius: 1.5, speed: 2.4, xp: 4,
    drops: [['rose', 0.45], ['light', 0.3]],
  },
  bee: {
    name: 'Bee', hp: 15, dmg: 40, armor: 0, radius: 1.4, speed: 2.8, xp: 5,
    drops: [['stinger', 1]],
  },
  hornet: {
    name: 'Hornet', hp: 62.5, dmg: 30, armor: 1, radius: 1.7, speed: 2.0, xp: 12,
    drops: [['missile', 0.5], ['orange', 0.5]],
    // rarer spawn than the basic mobs, and never more than a handful alive
    // at once — it's much more dangerous
    spawnWeight: 0.35,
    maxAlive: 6,
    missile: { hp: 5, dmg: 6, speed: 16, radius: 0.45 },
  },
  soldier: {
    name: 'Soldier Ant', hp: 40, dmg: 10, armor: 0, radius: 1.5, speed: 1.8, xp: 7,
    drops: [], // ant drops come in a later pass
    // aggressive on sight like the hornet, but with a much shorter reach —
    // florr lets you walk fairly close — and a leash distance past which it
    // gives up the chase (both handled in the ground AI)
    sightAggro: 14,
    leash: 40,
    // kept scarce in the wild — ant holes garrison plenty of them already,
    // and an on-sight aggro mob everywhere gets oppressive fast
    spawnWeight: 0.3,
  },
  worker: {
    name: 'Worker Ant', hp: 25, dmg: 10, armor: 0, radius: 1.3, speed: 1.8, xp: 5,
    drops: [], // ant drops come in a later pass
    // neutral: fights back when hurt at any rarity (most mobs only Rare+),
    // and turns aggressive when its ant hole is attacked
    retaliates: true,
  },
  baby: {
    name: 'Baby Ant', hp: 10, dmg: 10, armor: 0, radius: 1.0, speed: 1.4, xp: 2,
    drops: [], // ant drops come in a later pass
    // never fights back, even when hit or when its ant hole is under attack
    // (florr's egg-spawned aggression arrives with the queen later)
    passive: true,
    spawnWeight: 0.6, // walking free xp — don't blanket the map in it
  },
  anthole: {
    name: 'Ant Hole', hp: 500, dmg: 10, armor: 2, radius: 2.5, speed: 0, xp: 50,
    drops: [], // ant drops come in a later pass
    // an event-structure more than a mob: it garrisons ants as it takes
    // damage (see ANTHOLE in server/ants.js), so a live one should be a
    // rare find even on a big map
    spawnWeight: 0.15,
    maxAlive: 1,
  },
};

// hp values come from petal-stats.csv (actual florr data); for the count:3
// petals (light, orange) the sheet lists set totals, so hp and dmg here are
// the totals split across the 3 petals.
export const PETAL_TYPES = {
  basic:     { name: 'Basic',   hp: 10, dmg: 10, reload: 2.5, radius: 0.42, count: 1, color: '#ffffff',
               desc: 'A nice petal, not too strong but not too weak.' },
  rockPetal: { name: 'Rock',    hp: 30, dmg: 10, reload: 4,   radius: 0.5,  count: 1, color: '#7d7d84',
               desc: 'Heavy and durable, with a slow reload.' },
  rose:      { name: 'Rose',    hp: 5,  dmg: 5,  reload: 3.5, radius: 0.42, count: 1, color: '#ff94c9', heal: 11,
               desc: 'Flies home to heal you when you’re hurt.' },
  light:     { name: 'Light',   hp: 5 / 3, dmg: 13 / 3, reload: 0.6, radius: 0.28, count: 3, color: '#ffffff',
               desc: 'Fires in a rapid volley of three.' },
  // in florr a stinger has 1 hp no matter the rarity — flatHp skips petalMult
  stinger:   { name: 'Stinger', hp: 1,  dmg: 35, reload: 8,   radius: 0.35, count: 1, color: '#333333', flatHp: true,
               desc: 'Fragile, but deals heavy damage.' },
  orange:    { name: 'Orange',  hp: 2,  dmg: 8 / 3, reload: 1, radius: 0.3, count: 3, color: '#eb9c2d',
               desc: 'A weaker but faster version of Light.' },
  // fired as a straight-line projectile while attacking, florr's legacy petal
  missile:   { name: 'Missile', hp: 2,  dmg: 35, reload: 3,   radius: 0.4,  count: 1, color: '#333333',
               projectile: { speed: 24, life: 1.8 },
               desc: 'Launches forward as a projectile when attacking.' },
};

// playable half-extent; ground drawn a bit larger. `let` (not const) so a
// loaded map can size the arena via applyMap before the sim/scene start —
// every consumer reads the live binding at call time.
export let ARENA_HALF = 185;

// vertical aim clamp for projectile petals, shared so the client's input
// sampling and the server's input validation agree on the same range
export const PITCH_LIMIT = Math.PI / 2 - 0.12;

// ---- terrain tiles ----
// The arena is an implicit grass grid; MAP_TILES sparsely overrides cells by
// grid coordinate (cell centers at gx/gz * TILE_SIZE). Tile types carry no
// gameplay yet, but they live here (not client-side) so the server can add
// per-tile effects later (slows, damage, spawns) without a protocol change.
export const TILE_SIZE = 20;
export const TILE_TYPES = {
  grass:     { name: 'Grass' },
  water:     { name: 'Water' },
  dirt:      { name: 'Dirt' },
  desert:    { name: 'Desert' },
  jungle:    { name: 'Jungle' },
  dirtWall:  { name: 'Dirt Wall',  isWall: true },
  stoneWall: { name: 'Stone Wall', isWall: true },
  // future tile types get an entry here plus a renderer case in
  // client/src/tiles.js (walls: client/src/walls.js)
};
// world-height of one wall block; columns stack (see MAP_WALLS h)
export const WALL_HEIGHT = 4;
// debug placement: two water tiles just east of spawn (replaced wholesale
// when a map.json is loaded)
export let MAP_TILES = [
  { gx: 1, gz: 0, type: 'water' },
  { gx: 2, gz: 0, type: 'water' },
];

// wall columns: {gx, gz, h, type} where h is the stack height in blocks
// (world height = h * WALL_HEIGHT). Solid to ground movement regardless of
// height; only projectiles care how tall a column is.
export let MAP_WALLS = [];
// 'gx,gz' -> column top in world units, for O(1) collision lookups
const wallTops = new Map();
// where flowers (re)spawn — world origin unless a loaded map has a wall
// there, in which case applyMap moves it to the nearest clear cell
export const SPAWN_POS = { x: 0, z: 0 };

// 'gx,gz' -> override tile type; cells not present are implicit grass
const tileTypes = new Map([['1,0', 'water'], ['2,0', 'water']]); // matches MAP_TILES default

export function isWallCell(gx, gz) {
  return wallTops.has(gx + ',' + gz);
}
// terrain type at a world position ('grass' unless overridden; walls are
// tracked separately — check isWallCell/wallTopAt)
export function tileTypeAt(x, z) {
  return tileTypes.get(Math.round(x / TILE_SIZE) + ',' + Math.round(z / TILE_SIZE)) || 'grass';
}
// column top height at a world position (0 = no wall)
export function wallTopAt(x, z) {
  return wallTops.get(Math.round(x / TILE_SIZE) + ',' + Math.round(z / TILE_SIZE)) || 0;
}

// Resolve a ground circle against wall-cell AABBs. Only the 3x3 cells
// around the entity can overlap it (radii stay below TILE_SIZE/2 + a cell),
// so this is O(1) however many walls the map has.
export function collideWalls(pos, radius) {
  if (wallTops.size === 0) return;
  const cgx = Math.round(pos.x / TILE_SIZE);
  const cgz = Math.round(pos.z / TILE_SIZE);
  const half = TILE_SIZE / 2;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const gx = cgx + dx, gz = cgz + dz;
      if (!wallTops.has(gx + ',' + gz)) continue;
      const cx = gx * TILE_SIZE, cz = gz * TILE_SIZE;
      // closest point on the cell's square to the circle center
      const px = Math.max(cx - half, Math.min(cx + half, pos.x));
      const pz = Math.max(cz - half, Math.min(cz + half, pos.z));
      const ex = pos.x - px, ez = pos.z - pz;
      const d2 = ex * ex + ez * ez;
      if (d2 >= radius * radius) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2);
        pos.x = px + (ex / d) * radius;
        pos.z = pz + (ez / d) * radius;
      } else {
        // center is inside the wall — eject through the nearest face
        const ox = pos.x - cx, oz = pos.z - cz;
        if (Math.abs(ox) > Math.abs(oz)) pos.x = cx + Math.sign(ox || 1) * (half + radius);
        else pos.z = cz + Math.sign(oz || 1) * (half + radius);
      }
    }
  }
}

// install a normalized map (see shared/map.js) — server calls this at boot,
// the client before the scene is built (client/src/boot.js). The payload
// keeps tiles compact ({ type: [gx, gz, ...] }, walls { type: [gx, gz, h,
// ...] }); consumers want per-tile object lists, so expand here.
export function applyMap({ arenaHalf, tiles, walls = {} }) {
  // mob population keeps the default map's density: scale the cap with
  // arena area, within sane bounds for the 20Hz tick budget
  MOB_CAP = Math.min(400, Math.max(56, Math.round(56 * (arenaHalf / 185) ** 2)));
  ARENA_HALF = arenaHalf;
  MAP_TILES = [];
  tileTypes.clear();
  for (const [type, coords] of Object.entries(tiles)) {
    for (let i = 0; i < coords.length; i += 2) {
      MAP_TILES.push({ gx: coords[i], gz: coords[i + 1], type });
      tileTypes.set(coords[i] + ',' + coords[i + 1], type);
    }
  }
  MAP_WALLS = [];
  wallTops.clear();
  for (const [type, cols] of Object.entries(walls)) {
    for (let i = 0; i < cols.length; i += 3) {
      const col = { gx: cols[i], gz: cols[i + 1], h: cols[i + 2], type };
      MAP_WALLS.push(col);
      wallTops.set(col.gx + ',' + col.gz, col.h * WALL_HEIGHT);
    }
  }
  // spawn in the top-right (north-east) corner of a loaded map — the mob
  // rarity depth gradient then runs diagonally across the whole map. Ring
  // search outward from the corner for the first clear grass cell (mobs
  // only live on grass, so spawning in another biome would strand new
  // players in an empty zone), inset one cell from the boundary.
  const edge = Math.ceil(ARENA_HALF / TILE_SIZE) - 1;
  SPAWN_POS.x = edge * TILE_SIZE; SPAWN_POS.z = -edge * TILE_SIZE;
  outer: for (let ring = 0; ring <= 2 * edge; ring++) {
    for (let dx = 0; dx <= ring; dx++) {
      for (let dz = 0; dz <= ring; dz++) {
        if (Math.max(dx, dz) !== ring) continue;
        const gx = edge - dx, gz = -edge + dz;
        if (isWallCell(gx, gz)) continue;
        if (tileTypes.has(gx + ',' + gz)) continue; // grass is implicit
        SPAWN_POS.x = gx * TILE_SIZE;
        SPAWN_POS.z = gz * TILE_SIZE;
        break outer;
      }
    }
  }
}
// `let`: applyMap rescales it with arena area (56 on the default arena)
export let MOB_CAP = 56;
// interest management: each client only receives entities within this range
// of its own player. Past ~110 units everything is deep in the fog (which
// runs 90->190) and far outside the top-down camera's view, so the cutoff
// is invisible in practice while capping per-client snapshot size.
export const VIEW_RADIUS = 110;
export const PLAYER_BODY_DAMAGE = 10;
export const HIT_COOLDOWN = 0.45;    // seconds between damage ticks for a touching pair
// chance a mob's drop matches its own rarity, halving per tier (Common 64%,
// Unusual 32%, Rare 16%, ...); on a failed roll the petal drops one tier
// below instead (Common has nothing below, so it stays Common)
export const EQUAL_RARITY_DROP_BASE = 0.64;
// individual loot: everyone who dealt at least this share of the damage
// recorded from still-connected players gets their own copy of the drop
// (visible/lootable only by them)
export const DROP_DAMAGE_FRAC = 0.1;
// the top this-many damage contributors always loot, even below the share
// bar; DROP_DAMAGE_FRAC only gates contributors past this rank
export const MIN_LOOTERS = 10;
// seconds of invulnerability after (re)spawning; attacking ends it early
export const SPAWN_IMMUNITY = 3;

// works on anything with mutable x/z (THREE.Vector3 or plain objects)
export function clampToArena(pos, margin = 0) {
  const half = ARENA_HALF - margin;
  pos.x = Math.max(-half, Math.min(half, pos.x));
  pos.z = Math.max(-half, Math.min(half, pos.z));
}

// Rarity gradient: `depth` in [0, 1] is how deep into the world the spawn
// is (0 = at the player spawn point, 1 = the far reaches). Each tier's
// weight is multiplied by DEPTH_BIAS^(tier * depth), so the base weights
// hold near spawn and high tiers dominate progressively farther out.
const RARITY_DEPTH_BIAS = 2.0;
export function pickRarity(rng = Math.random, depth = 0) {
  const weights = RARITIES.map((r, i) => r.weight * RARITY_DEPTH_BIAS ** (i * depth));
  const total = weights.reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
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
