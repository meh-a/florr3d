// Loads the map-builder export at boot and installs it into the shared
// config. The same normalized payload is served to clients at /map.json
// (see index.js and the vite plugin) so both sides simulate/draw the same
// world. No map file is not an error — the game falls back to the built-in
// debug tiles in shared/config.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeMap } from '../shared/map.js';
import { applyMap } from '../shared/config.js';

const MAP_PATH = process.env.MAP_PATH
  || fileURLToPath(new URL('../map.json', import.meta.url));

// normalized { arenaHalf, tiles } if a map was loaded, else null
export const mapPayload = load();

function load() {
  let raw;
  try {
    raw = readFileSync(MAP_PATH, 'utf8');
  } catch {
    return null; // no map file — implicit grass arena with config defaults
  }
  try {
    const { warnings, ...payload } = normalizeMap(JSON.parse(raw));
    for (const w of warnings) console.warn(`map: ${w}`);
    applyMap(payload);
    const count = Object.values(payload.tiles).reduce((n, c) => n + c.length / 2, 0);
    console.log(`map: loaded ${count} tiles from ${MAP_PATH} (arenaHalf ${payload.arenaHalf})`);
    return payload;
  } catch (err) {
    console.error(`map: failed to load ${MAP_PATH} — using defaults:`, err.message);
    return null;
  }
}
