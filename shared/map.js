// Normalizes a map-builder export (tools/map-builder.html, formatVersion 1)
// into what the game consumes: centered tile coordinates plus the arena
// extent. The builder grid is corner-origin (gx in [0, width)); the game's
// implicit grass grid is centered on the world origin with cell centers at
// gx * TILE_SIZE, so builder coords shift by half the grid.
//
// The normalized payload is deliberately compact — it's served to every
// client at /map.json. Tiles are grouped by type as flat [gx, gz, gx, gz,
// ...] coordinate arrays (applyMap in shared/config.js expands them), so a
// big painted map costs a few bytes per tile instead of an object each.
//
// Walls are stacks of blocks in the builder (one entry per gy level); the
// game only needs the column: walls come out as [gx, gz, h, ...] triplets
// per type, where h is the stack height in blocks. Per-tile mob spawn
// weights are ignored for now — they stay in the builder file for later,
// but the game doesn't read or serve them.
import { TILE_SIZE, TILE_TYPES, WALL_HEIGHT } from './config.js';

export function normalizeMap(data) {
  const warnings = [];
  if (data?.formatVersion !== 1) {
    throw new Error(`unsupported map formatVersion: ${data?.formatVersion}`);
  }
  if (data.tileSize !== TILE_SIZE) {
    warnings.push(`map tileSize ${data.tileSize} != game TILE_SIZE ${TILE_SIZE}; using game size`);
  }
  const width = data.width || 20;
  const depth = data.depth || 20;
  const ox = Math.floor(width / 2);
  const oz = Math.floor(depth / 2);

  const tiles = {};
  let skipped = 0;
  for (const t of data.floor || []) {
    const def = TILE_TYPES[t.type];
    if (!def || def.isWall) { skipped++; continue; }
    if (t.type === 'grass') continue; // grass is the implicit base — not an override
    (tiles[t.type] ??= []).push(t.gx - ox, t.gz - oz);
  }
  if (skipped) warnings.push(`${skipped} floor tile(s) of unknown type skipped`);
  if (data.wallHeight && data.wallHeight !== WALL_HEIGHT) {
    warnings.push(`map wallHeight ${data.wallHeight} != game WALL_HEIGHT ${WALL_HEIGHT}; using game height`);
  }

  // collapse per-level wall blocks into columns: key -> stack height
  const columns = new Map(); // 'gx,gz' -> { type, h }
  let wallsSkipped = 0;
  for (const w of data.walls || []) {
    if (!TILE_TYPES[w.type]?.isWall) { wallsSkipped++; continue; }
    const key = `${w.gx - ox},${w.gz - oz}`;
    const col = columns.get(key);
    // a column keeps the type of its base block; height covers the top
    // level even if the builder left gaps in the stack
    if (!col) columns.set(key, { type: w.type, h: w.gy + 1 });
    else col.h = Math.max(col.h, w.gy + 1);
  }
  if (wallsSkipped) warnings.push(`${wallsSkipped} wall tile(s) of unknown type skipped`);
  const walls = {};
  for (const [key, col] of columns) {
    const [gx, gz] = key.split(',').map(Number);
    (walls[col.type] ??= []).push(gx, gz, col.h);
  }

  const arenaHalf = (Math.max(width, depth) * TILE_SIZE) / 2;
  return { arenaHalf, tiles, walls, warnings };
}
