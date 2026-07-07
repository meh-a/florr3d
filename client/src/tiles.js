import * as THREE from 'three';
import { Water } from 'three/addons/objects/Water.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE_SIZE, MAP_TILES } from '../../shared/config.js';
import waterNormalsUrl from '../assets/waternormals.jpg';

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
  const wallMat = new THREE.MeshToonMaterial({ color: DIRT, side: THREE.DoubleSide });
  const floorMat = new THREE.MeshToonMaterial({ color: DIRT_DARK });
  const half = TILE_SIZE / 2;

  for (const t of waterTiles) {
    const cx = t.gx * TILE_SIZE, cz = t.gz * TILE_SIZE;

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, -BASIN_DEPTH, cz);
    scene.add(floor);

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
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(TILE_SIZE, BASIN_DEPTH), wallMat);
      wall.rotation.y = s.rotY;
      wall.position.set(cx + s.dx * half, -BASIN_DEPTH / 2, cz + s.dz * half);
      scene.add(wall);
    }
  }
}

// one merged surface geometry for all water tiles (they share one y plane),
// so the reflective version costs a single reflection pass no matter how
// many tiles there are. PlaneGeometry is XY; rotation.x = -PI/2 maps
// (x, y) -> (x, -y) in world xz, hence the -gz translate.
function waterSurfaceGeometry(waterTiles) {
  return mergeGeometries(waterTiles.map((t) =>
    new THREE.PlaneGeometry(TILE_SIZE, TILE_SIZE)
      .translate(t.gx * TILE_SIZE, -t.gz * TILE_SIZE, 0)
  ));
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
  water.rotation.x = -Math.PI / 2;
  water.position.y = WATER_LEVEL;
  scene.add(water);
  return (dt) => { water.material.uniforms.time.value += dt * 0.2; };
}

// Low quality: a flat translucent plane at the same recessed level.
function makeFlatWater(scene, waterTiles) {
  const mesh = new THREE.Mesh(
    waterSurfaceGeometry(waterTiles),
    new THREE.MeshToonMaterial({ color: '#2f8fbf', transparent: true, opacity: 0.9 })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = WATER_LEVEL;
  scene.add(mesh);
}

export function makeTiles(scene, quality, sunDir) {
  const updates = [];

  const waterTiles = MAP_TILES.filter((t) => t.type === 'water');
  // future tile types: filter and render them here
  if (waterTiles.length) {
    buildBasin(scene, waterTiles);
    if (quality === 'high') updates.push(makeReflectiveWater(scene, waterTiles, sunDir));
    else makeFlatWater(scene, waterTiles);
  }

  return (dt) => { for (const u of updates) u(dt); };
}
