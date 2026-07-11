import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { enableShadows } from './utils.js';

// Real mob models (meshopt-compressed .glb, optimized from the source art
// in client/assets-src/). Vite content-hashes the URLs and the server
// serves /assets/ as immutable, so each player downloads a model at most
// once — after that it comes straight from the browser HTTP cache.
//
// Each model is fetched and parsed a single time (the promise is cached);
// every mob instance gets a cheap clone that shares geometry with its
// siblings. Materials ARE cloned per instance: the hit flash mutates
// material.emissive, and a shared material would light up every mob of
// that type at once.
//
// `yaw` turns the artist's forward axis to the game's +Z convention.
// The queen/soldier/worker/baby ants are wired the moment those mob types
// exist in shared/config.js — until referenced they cost nothing.
const YAW = -Math.PI / 2; // this artist models heads along +X; the game faces +Z
const MODELS = {
  bee:     { url: new URL('../assets/bee.glb', import.meta.url), yaw: YAW },
  hornet:  { url: new URL('../assets/hornet.glb', import.meta.url), yaw: YAW },
  ladybug: { url: new URL('../assets/ladybug.glb', import.meta.url), yaw: YAW },
  queen:   { url: new URL('../assets/queen.glb', import.meta.url), yaw: YAW },
  soldier: { url: new URL('../assets/soldier.glb', import.meta.url), yaw: YAW },
  worker:  { url: new URL('../assets/worker.glb', import.meta.url), yaw: YAW },
  baby:    { url: new URL('../assets/baby.glb', import.meta.url), yaw: YAW },
  // not a mob type: the hornet's projectile, docked on its tail and in
  // flight — modeled nose-opposite to the mobs, hence the mirrored yaw
  hornetmissile: { url: new URL('../assets/hornetmissile.glb', import.meta.url), yaw: -YAW },
};

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const cache = new Map(); // type -> Promise<{ template, footprint, height }>

export function hasMobModel(type) {
  return type in MODELS;
}

function loadModel(type) {
  let promise = cache.get(type);
  if (!promise) {
    const def = MODELS[type];
    promise = loader.loadAsync(def.url.href).then((gltf) => {
      // normalize once on the template: forward to +Z, centered on x/z,
      // feet on the ground, and measure the footprint so instances can be
      // scaled to the mob's server-side radius
      const inner = gltf.scene;
      inner.rotation.y = def.yaw;
      const template = new THREE.Group();
      template.add(inner);
      template.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(template);
      const center = box.getCenter(new THREE.Vector3());
      inner.position.x -= center.x;
      inner.position.z -= center.z;
      inner.position.y -= box.min.y;
      const size = box.getSize(new THREE.Vector3());
      // NOTE: don't force DoubleSide here — the models carry inverted-hull
      // outlines that rely on backface culling; double-siding them wraps
      // the whole mob in black. (Cost: single-sided thin bits like the
      // hornet's antennae can vanish edge-on in first person — needs a
      // two-sided material in the source asset instead.)
      enableShadows(template, { cast: true, receive: true });
      // these bodies are elongated; scaling by the longest extent leaves
      // them skinny next to their server hitbox, so fit the mean of
      // length/width to the radius instead (long axis overhangs a little,
      // like the procedural mobs did)
      return { template, footprint: (size.x + size.z) / 4, height: size.y };
    });
    cache.set(type, promise);
  }
  return promise;
}

// kick off all downloads during the name gate so mobs swap to their real
// models before (or shortly after) the player even joins
export function preloadMobModels(types) {
  for (const type of types) if (hasMobModel(type)) loadModel(type);
}

// Replace `group`'s procedural placeholder children with the model once it
// arrives. The placeholder keeps the mob visible while the (cached,
// usually instant) download runs; entity code never notices the swap since
// the group object, its transform, and its userData contract survive.
export function swapInMobModel(group, type, radius, decorate, { centerY = false } = {}) {
  loadModel(type).then(({ template, footprint, height }) => {
    if (group.userData.modelSwapped) return;
    group.userData.modelSwapped = true;
    // shared geometries live in the model cache / geoCache — just detach
    for (const child of [...group.children]) group.remove(child);
    const inst = template.clone();
    inst.traverse((o) => {
      if (o.isMesh) o.material = o.material.clone(); // flash isolation
    });
    const s = radius / footprint;
    inst.scale.setScalar(s);
    // mobs stand on the grass (with an epsilon against z-fighting);
    // airborne props (missiles) center on their group origin instead
    inst.position.y = centerY ? -height * s / 2 : 0.04;
    group.add(inst);
    decorate?.(group, inst, radius);
  }).catch((err) => {
    console.warn(`mob model ${type} failed to load — keeping placeholder`, err);
  });
}
