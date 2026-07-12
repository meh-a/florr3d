import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE_SIZE, WALL_HEIGHT, MAP_WALLS, isWallCell, tileTypeAt } from '../../shared/config.js';
import { tileTexture } from './tiles.js';
import dirtTileUrl from '../assets/dirttile.svg';
import desertTileUrl from '../assets/deserttile.svg';
import jungleTileUrl from '../assets/jungletile.svg';
import grassTileUrl from '../assets/grasstile.svg';

// Renders the map's wall columns (shared/config.js MAP_WALLS) as textured
// plateaus: dirt-pattern sides with baked shading, flat grass tops. Shading
// (lambert vs the sun + darkening toward the base) is baked into vertex
// colors, which multiply the texture on an unlit material — the scene's
// hemisphere light washes vertical faces flat, so lit materials made every
// column read as one uniform slab. Two merged meshes total (boxes + top
// planes); collision lives server-side (collideWalls).

// sides get a fixed sun bias matching the scene's directional light at
// (30, 60, 20): +x/+z faces catch light, -x/-z sit in shade
const SUN = new THREE.Vector3(30, 60, 20).normalize();
const FACE_NORMALS = {
  px: new THREE.Vector3(1, 0, 0), nx: new THREE.Vector3(-1, 0, 0),
  py: new THREE.Vector3(0, 1, 0), ny: new THREE.Vector3(0, -1, 0),
  pz: new THREE.Vector3(0, 0, 1), nz: new THREE.Vector3(0, 0, -1),
};
// BoxGeometry vertex layout: 4 verts per face, faces ordered +x -x +y -y +z -z
const FACE_ORDER = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

// texture tint per type (multiplies the dirt pattern); stone gets a cool tint
const SIDE_TINTS = {
  dirtWall: new THREE.Color('#ffffff'),
  stoneWall: new THREE.Color('#9a9aa8'),
};
// desert-biome wall sides: the desert pattern, uniformly darkened so the
// cliff face reads as shaded sandstone under the bright sand cap
const DESERT_SIDE_TINT = new THREE.Color('#a89a80');
// matches the lawn's olive blade palette so plateaus read as grassy ground
const TOP_COLOR = new THREE.Color('#4e7d20');
const BASE_DARKEN = 0.5;  // brightness at the foot of a column
const REPEATS = 2;        // texture repeats per TILE_SIZE (smaller = bigger speckles)

function columnGeometry(w, tint) {
  const h = w.h * WALL_HEIGHT;
  const geo = new THREE.BoxGeometry(TILE_SIZE, h, TILE_SIZE);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const vScale = (h / TILE_SIZE) * REPEATS;
  for (let i = 0; i < pos.count; i++) {
    const face = FACE_ORDER[Math.floor(i / 4)];
    // uniform texel density: REPEATS per tile width, scaled by height on
    // the vertical axis of side faces
    uv.setX(i, uv.getX(i) * REPEATS);
    uv.setY(i, uv.getY(i) * (face === 'py' || face === 'ny' ? REPEATS : vScale));
    // lambert against the fixed sun, then darken toward the base
    const light = 0.62 + 0.38 * Math.max(0, FACE_NORMALS[face].dot(SUN));
    const t = (pos.getY(i) + h / 2) / h; // 0 at foot, 1 at rim
    c.copy(tint).multiplyScalar(light * (BASE_DARKEN + (1 - BASE_DARKEN) * t));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo.translate(w.gx * TILE_SIZE, h / 2, w.gz * TILE_SIZE);
}

// Biome cap: a shallow, slightly-oversized box at the rim rather than a
// flat plane, so the cap wraps down over the top of the side faces —
// visible from ground level / first person, where the top itself never is.
// Each column is capped with the terrain of the biome it stands in, taken
// from the nearest non-wall cell (walls have no tile of their own).
const CAP_LIP = 1.6;      // how far the cap runs down the sides
const CAP_OVERHANG = 0.25; // slight outward lip so the rim casts a clean line

function capGeometry(w) {
  const top = w.h * WALL_HEIGHT + 0.02;
  const geo = new THREE.BoxGeometry(TILE_SIZE + CAP_OVERHANG * 2, CAP_LIP, TILE_SIZE + CAP_OVERHANG * 2);
  // sides get a thin slice of the texture instead of the whole image
  // squashed into the lip; top keeps its one-repeat-per-tile mapping
  const uv = geo.attributes.uv;
  const vScale = CAP_LIP / TILE_SIZE;
  for (let i = 0; i < 24; i++) {
    const face = FACE_ORDER[Math.floor(i / 4)];
    if (face !== 'py' && face !== 'ny') uv.setY(i, uv.getY(i) * vScale);
  }
  return geo.translate(w.gx * TILE_SIZE, top - CAP_LIP / 2, w.gz * TILE_SIZE);
}

// biome of the nearest non-wall cell, ring-searching outward
function biomeOf(w) {
  for (let ring = 1; ring <= 12; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const gx = w.gx + dx, gz = w.gz + dz;
        if (isWallCell(gx, gz)) continue;
        return tileTypeAt(gx * TILE_SIZE, gz * TILE_SIZE);
      }
    }
  }
  return 'grass';
}

export function makeWalls(scene) {
  if (!MAP_WALLS.length) return;
  const byType = new Map();
  for (const w of MAP_WALLS) {
    if (!byType.has(w.type)) byType.set(w.type, []);
    byType.get(w.type).push(w);
  }
  for (const [type, cols] of byType) {
    if (type === 'dirtWall') {
      // dirt walls take their biome's ground pattern on the sides: desert
      // walls are darkened desert (dirt there read as snow next to the
      // sand), everything else keeps the dirt texture
      const desertCols = [], dirtCols = [];
      for (const w of cols) (biomeOf(w) === 'desert' ? desertCols : dirtCols).push(w);
      if (desertCols.length) {
        const geo = mergeGeometries(desertCols.map((w) => columnGeometry(w, DESERT_SIDE_TINT)));
        scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          vertexColors: true, map: tileTexture(desertTileUrl),
        })));
      }
      if (dirtCols.length) {
        const geo = mergeGeometries(dirtCols.map((w) => columnGeometry(w, SIDE_TINTS.dirtWall)));
        scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          vertexColors: true, map: tileTexture(dirtTileUrl),
        })));
      }
      continue;
    }
    const tint = SIDE_TINTS[type] || SIDE_TINTS.dirtWall;
    const geo = mergeGeometries(cols.map((w) => columnGeometry(w, tint)));
    scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, map: tileTexture(dirtTileUrl),
    })));
  }

  // caps merged per biome; biomes with tile art get it, the rest (water)
  // fall back to grass
  const capMaterials = {
    grass: () => new THREE.MeshBasicMaterial({ map: tileTexture(grassTileUrl) }),
    desert: () => new THREE.MeshBasicMaterial({ map: tileTexture(desertTileUrl) }),
    jungle: () => new THREE.MeshBasicMaterial({ map: tileTexture(jungleTileUrl) }),
    dirt: () => new THREE.MeshBasicMaterial({ map: tileTexture(dirtTileUrl) }),
  };
  const byBiome = new Map();
  for (const w of MAP_WALLS) {
    const biome = biomeOf(w);
    const key = capMaterials[biome] ? biome : 'grass';
    if (!byBiome.has(key)) byBiome.set(key, []);
    byBiome.get(key).push(w);
  }
  for (const [biome, cols] of byBiome) {
    const material = capMaterials[biome]
      ? capMaterials[biome]()
      : new THREE.MeshBasicMaterial({ color: TOP_COLOR });
    scene.add(new THREE.Mesh(mergeGeometries(cols.map(capGeometry)), material));
  }
}
