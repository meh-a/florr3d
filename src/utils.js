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
  mesh.add(outline);
  return outline;
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

export function flashMaterials(root, duration = 0.12) {
  root.traverse((obj) => {
    if (obj.isMesh && obj.material && obj.material.emissive !== undefined) {
      obj.material.emissive.setScalar(0.55);
      obj.material.userData.flashUntil = performance.now() + duration * 1000;
    }
  });
}

export function updateFlash(root) {
  const now = performance.now();
  root.traverse((obj) => {
    if (obj.isMesh && obj.material && obj.material.userData.flashUntil) {
      if (now > obj.material.userData.flashUntil) {
        obj.material.emissive.setScalar(0);
        delete obj.material.userData.flashUntil;
      }
    }
  });
}
