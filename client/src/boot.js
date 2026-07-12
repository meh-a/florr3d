// Entry shim: fetch the server's map (if any) and install it into the shared
// config BEFORE the rest of the client evaluates — world.js/grass.js derive
// geometry and shader code from MAP_TILES/ARENA_HALF at module scope, so the
// map has to be in place when their modules first run. The dynamic import
// defers all of that until applyMap has happened. A 404 (or any failure)
// means no map is loaded and the built-in defaults stand.
import { applyMap } from '../../shared/config.js';

(async () => {
  try {
    const res = await fetch('/map.json');
    if (res.ok) applyMap(await res.json());
  } catch { /* offline/dev without a map — defaults are fine */ }

  await import('./main.js');
})();
