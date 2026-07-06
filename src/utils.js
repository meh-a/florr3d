import * as THREE from 'three';

let nextUid = 1;
export function uid() { return nextUid++; }

// frame-rate independent lerp factor
export function damp(k, dt) { return 1 - Math.exp(-k * dt); }

export function toonMat(color) {
  return new THREE.MeshToonMaterial({ color });
}

// florr-style thick border: inverted-hull outline as a child of the mesh.
// Works for the convex, origin-centered primitives we use.
export function addOutline(mesh, thickness = 0.12, color = null) {
  const c = color
    ? new THREE.Color(color)
    : mesh.material.color.clone().multiplyScalar(0.62);
  const outline = new THREE.Mesh(
    mesh.geometry,
    new THREE.MeshBasicMaterial({ color: c, side: THREE.BackSide })
  );
  outline.scale.setScalar(1 + thickness);
  outline.userData.isOutline = true; // excluded from shadow casting, see enableShadows
  mesh.add(outline);
  return outline;
}

// marks the toon-shaded shape meshes in a group as shadow participants,
// skipping outline hulls (their inverted, enlarged backside geometry
// would otherwise cast a warped double-shadow)
export function enableShadows(root, { cast = true, receive = false } = {}) {
  root.traverse((obj) => {
    if (!obj.isMesh || obj.userData.isOutline) return;
    if (cast) obj.castShadow = true;
    if (receive) obj.receiveShadow = true;
  });
}

// randomized rock geometry: jittered icosahedron
export function makeRockGeometry(radius, jitter = 0.16) {
  const geo = new THREE.IcosahedronGeometry(radius, 0);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  // icosahedron vertices are duplicated per-face; jitter consistently by direction
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key = `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`;
    if (!seen.has(key)) seen.set(key, 1 + (Math.random() * 2 - 1) * jitter);
    v.multiplyScalar(seen.get(key));
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

// flash duration is uniform across a call, so track a single expiry on the
// root instead of per-material — lets updateFlash skip the traversal
// entirely on the vast majority of frames where nothing is flashing.
export function flashMaterials(root, duration = 0.12) {
  root.userData.flashUntil = performance.now() + duration * 1000;
  root.traverse((obj) => {
    if (obj.isMesh && obj.material && obj.material.emissive !== undefined) {
      obj.material.emissive.setScalar(0.55);
    }
  });
}

export function updateFlash(root) {
  if (!root.userData.flashUntil) return;
  if (performance.now() > root.userData.flashUntil) {
    root.traverse((obj) => {
      if (obj.isMesh && obj.material && obj.material.emissive !== undefined) {
        obj.material.emissive.setScalar(0);
      }
    });
    delete root.userData.flashUntil;
  }
}

// dispose materials only — safe to call even when geometry is shared
// across other live instances (e.g. cached mob part geometries)
export function disposeMaterials(root) {
  const seen = new Set();
  root.traverse((obj) => {
    if (!obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats) {
      if (seen.has(m)) continue;
      seen.add(m);
      m.dispose();
    }
  });
}

// full teardown: materials plus geometry. Only use this for objects whose
// geometry is never shared with other still-living instances.
export function disposeObject3D(root) {
  disposeMaterials(root);
  const seenGeo = new Set();
  root.traverse((obj) => {
    if (obj.geometry && !seenGeo.has(obj.geometry)) {
      seenGeo.add(obj.geometry);
      obj.geometry.dispose();
    }
  });
}
