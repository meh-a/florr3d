import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE_SIZE, MAP_TILES } from '../../shared/config.js';
import waterNormalsUrl from '../assets/waternormals.jpg';
import desertTileUrl from '../assets/deserttile.svg';
import jungleTileUrl from '../assets/jungletile.svg';

// Renders the sparse terrain-tile overrides from shared/config.js. Adding a
// new tile type means one case in makeTiles (plus its TILE_TYPES entry).
//
// Water tiles are recessed basins: the grass plane has holes cut over them
// (see buildGroundGeometry in world.js), and this module adds the brown dirt
// walls/floor plus the water surface sitting below grass level, leaving a
// visible earth bank around the edge.

export const WATER_LEVEL = -0.55; // water surface, below the y=0 grass lip
const BASIN_DEPTH = 1.8;

const DIRT = '#8a6b42';
const DIRT_DARK = '#63482a';

function buildBasin(scene, waterTiles) {
  const isWater = new Set(waterTiles.map((t) => `${t.gx},${t.gz}`));
  const half = TILE_SIZE / 2;
  // geometries are baked in world space and merged, so any size of lake is
  // two draw calls (floor + rim walls)
  const floors = [];
  const walls = [];

  for (const t of waterTiles) {
    const cx = t.gx * TILE_SIZE, cz = t.gz * TILE_SIZE;

    floors.push(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)
      .rotateX(-Math.PI / 2)
      .translate(cx, -BASIN_DEPTH, cz));

    // walls only where the neighboring cell isn't water, so joined tiles
    // form one open basin
    const sides = [
      { dx: 1, dz: 0, rotY: Math.PI / 2 },
      { dx: -1, dz: 0, rotY: Math.PI / 2 },
      { dx: 0, dz: 1, rotY: 0 },
      { dx: 0, dz: -1, rotY: 0 },
    ];
    for (const s of sides) {
      if (isWater.has(`${t.gx + s.dx},${t.gz + s.dz}`)) continue;
      walls.push(new THREE.PlaneGeometry(TILE_SIZE, BASIN_DEPTH)
        .rotateY(s.rotY)
        .translate(cx + s.dx * half, -BASIN_DEPTH / 2, cz + s.dz * half));
    }
  }

  scene.add(new THREE.Mesh(mergeGeometries(floors),
    new THREE.MeshToonMaterial({ color: DIRT_DARK })));
  if (walls.length) scene.add(new THREE.Mesh(mergeGeometries(walls),
    new THREE.MeshToonMaterial({ color: DIRT, side: THREE.DoubleSide })));
}

// one merged surface geometry for all tiles of a kind (they share one y
// plane), so each kind is a single draw call (and the reflective water a
// single reflection pass) no matter how many tiles there are. PlaneGeometry
// is XY; rotation.x = -PI/2 maps (x, y) -> (x, -y) in world xz, hence the
// -gz translate. Each tile keeps its own 0..1 UVs, so a seamless texture
// repeats once per tile.
function mergedTileGeometry(tiles) {
  return mergeGeometries(tiles.map((t) =>
    new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)
      .translate(t.gx * TILE_SIZE, -t.gz * TILE_SIZE, 0)
  ));
}

// Ground-level tile types are thin overlays floating just above the grass
// plane (the plane only gets holes cut for water). The grass shader culls
// its blades over these cells (see grass.js) so turf doesn't poke through.
const OVERLAY_Y = 0.02;

function makeOverlay(scene, tiles, material) {
  const mesh = new THREE.Mesh(mergedTileGeometry(tiles), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = OVERLAY_Y;
  scene.add(mesh);
}

// browsers rasterize SVG in TextureLoader like any image; the tile art is a
// 256x256 seamless pattern designed to cover exactly one tile
// (walls.js reuses this for the wall texture)
export function tileTexture(url) {
  const tx = new THREE.TextureLoader().load(url);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  tx.anisotropy = 4;
  return tx;
}

// flood-fill 4-connected water tiles into lakes, so ripple strength can
// scale with the size of each body of water
function lakeComponents(waterTiles) {
  const byKey = new Map(waterTiles.map((t) => [`${t.gx},${t.gz}`, t]));
  const seen = new Set();
  const lakes = [];
  for (const t of waterTiles) {
    if (seen.has(`${t.gx},${t.gz}`)) continue;
    seen.add(`${t.gx},${t.gz}`);
    const lake = [];
    const stack = [t];
    while (stack.length) {
      const cur = stack.pop();
      lake.push(cur);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nk = `${cur.gx + dx},${cur.gz + dz}`;
        if (byKey.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(byKey.get(nk)); }
      }
    }
    lakes.push(lake);
  }
  return lakes;
}

// bigger water, bigger waves: a pond barely stirs, an open lake gets real
// chop. Log so it saturates instead of growing without bound.
const rippleFactor = (tiles) => Math.min(2.5, 0.55 + 0.45 * Math.log2(tiles + 1));

// water surface with a per-vertex aRipple attribute (per-lake constant)
function waterSurfaceGeometry(waterTiles) {
  const geos = [];
  for (const lake of lakeComponents(waterTiles)) {
    const f = rippleFactor(lake.length);
    for (const t of lake) {
      const g = new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)
        .translate(t.gx * TILE_SIZE, -t.gz * TILE_SIZE, 0);
      g.setAttribute('aRipple', new THREE.Float32BufferAttribute([f, f, f, f], 1));
      geos.push(g);
    }
  }
  return mergeGeometries(geos);
}

// High quality: three's classic Water — real-time planar reflections of the
// scene (sky, clouds, mobs), scrolling normal-map ripples, sun glint.
function makeReflectiveWater(scene, waterTiles, sunDir) {
  const waterNormals = new THREE.TextureLoader().load(waterNormalsUrl, (tx) => {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
  });
  const water = new Water(waterSurfaceGeometry(waterTiles), {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals,
    sunDirection: sunDir.clone().normalize(),
    sunColor: 0xffffff,
    waterColor: 0x0e6b8e,
    distortionScale: 0.9,
    fog: true,
  });
  // patch the Water shader to carry the per-lake ripple factor through to
  // the reflection distortion (one merged mesh, one uniform otherwise)
  const mat = water.material;
  mat.vertexShader = mat.vertexShader
    .replace('varying vec4 mirrorCoord;', 'varying vec4 mirrorCoord;\n\tattribute float aRipple;\n\tvarying float vRipple;')
    .replace('void main() {', 'void main() {\n\tvRipple = aRipple;');
  mat.fragmentShader = mat.fragmentShader
    .replace('varying vec4 mirrorCoord;', 'varying vec4 mirrorCoord;\n\tvarying float vRipple;')
    .replace(
      'vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / distance ) * distortionScale;',
      'vec2 distortion = surfaceNormal.xz * ( 0.001 + 1.0 / distance ) * distortionScale * vRipple;'
    );
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  scene.add(water);
  return (dt) => { water.material.uniforms.time.value += dt * 0.2; };
}

// Low quality: a flat translucent plane at the same recessed level.
function makeFlatWater(scene, waterTiles) {
  const mesh = new THREE.Mesh(
    mergedTileGeometry(waterTiles),
    new THREE.MeshToonMaterial({ color: '#2f8fbf', transparent: true, opacity: 0.9 })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = WATER_LEVEL;
  scene.add(mesh);
}

export function makeTiles(scene, quality, sunDir) {
  const updates = [];

  const byType = new Map();
  for (const t of MAP_TILES) {
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type).push(t);
  }

  const waterTiles = byType.get('water');
  if (waterTiles) {
    buildBasin(scene, waterTiles);
    if (quality !== 'low') updates.push(makeReflectiveWater(scene, waterTiles, sunDir));
    else makeFlatWater(scene, waterTiles);
  }

  const desertTiles = byType.get('desert');
  if (desertTiles) {
    makeOverlay(scene, desertTiles, new THREE.MeshToonMaterial({ map: tileTexture(desertTileUrl) }));
  }
  const jungleTiles = byType.get('jungle');
  if (jungleTiles) {
    makeOverlay(scene, jungleTiles, new THREE.MeshToonMaterial({ map: tileTexture(jungleTileUrl) }));
  }
  const dirtTiles = byType.get('dirt');
  if (dirtTiles) {
    makeOverlay(scene, dirtTiles, new THREE.MeshToonMaterial({ color: DIRT }));
  }
  // future tile types: add a case here

  return (dt) => { for (const u of updates) u(dt); };
}
