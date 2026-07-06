import * as THREE from 'three';
import { toonMat, addOutline, makeRockGeometry, enableShadows } from './utils.js';
import { PETAL_TYPES, RARITIES } from './config.js';

const YELLOW = '#ffe763';
const BLACK = '#2b2b2b';

// Mob part geometries are identical across every instance of a given type
// (rarity scaling is applied to the whole group, not baked into the mesh),
// so we cache and reuse them instead of re-allocating GPU buffers per spawn.
// Rock is excluded on purpose — its jittered geometry is meant to vary.
const geoCache = new Map();
function sharedGeo(key, factory) {
  let geo = geoCache.get(key);
  if (!geo) {
    geo = factory();
    geoCache.set(key, geo);
  }
  return geo;
}

// The player flower: yellow sphere with a simple face on its +Z side.
export function makeFlower(radius = 1.1) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 18), toonMat(YELLOW));
  addOutline(body, 0.1);
  group.add(body);

  const eyeGeo = new THREE.SphereGeometry(radius * 0.16, 12, 10);
  const eyeMat = toonMat(BLACK);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.scale.set(0.55, 1, 0.6);
    eye.position.set(sx * radius * 0.32, radius * 0.22, radius * 0.86);
    group.add(eye);
  }
  const mouth = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.28, radius * 0.05, 8, 20, Math.PI * 0.75),
    toonMat(BLACK)
  );
  // arc centered at the bottom of the torus so it reads as a smile
  mouth.rotation.z = Math.PI + (Math.PI - Math.PI * 0.75) / 2;
  mouth.position.set(0, -radius * 0.18, radius * 0.92);
  group.add(mouth);
  enableShadows(group, { cast: true, receive: true });
  return group;
}

function makeRockMob(radius) {
  const group = new THREE.Group();
  const mat = toonMat('#77777f');
  mat.flatShading = true;
  const body = new THREE.Mesh(makeRockGeometry(radius), mat);
  addOutline(body, 0.1);
  body.position.y = radius * 0.8;
  body.rotation.y = Math.random() * Math.PI * 2;
  group.add(body);
  enableShadows(group, { cast: true, receive: true });
  return group;
}

function makeLadybugMob(radius) {
  const group = new THREE.Group();
  // shell is squashed to 0.72 height and outlined ~1.1x, so it needs
  // 0.72 * 1.1 * radius of clearance for the bottom to sit on the ground
  const lift = radius * 0.8;

  const shellGeo = sharedGeo(`ladybug-shell-${radius}`, () => new THREE.SphereGeometry(radius, 24, 18));
  const shell = new THREE.Mesh(shellGeo, toonMat('#d1291b'));
  shell.scale.set(1, 0.72, 1.08);
  addOutline(shell, 0.1);
  shell.position.y = lift;
  group.add(shell);

  const headGeo = sharedGeo(`ladybug-head-${radius}`, () => new THREE.SphereGeometry(radius * 0.45, 16, 12));
  const head = new THREE.Mesh(headGeo, toonMat(BLACK));
  head.position.set(0, lift * 0.75, radius * 0.95);
  group.add(head);

  const spotGeo = sharedGeo(`ladybug-spot-${radius}`, () => new THREE.SphereGeometry(radius * 0.22, 10, 8));
  const spotMat = toonMat(BLACK);
  const spots = [
    [0.45, 0.62, -0.25], [-0.5, 0.58, 0.15], [0.05, 0.68, -0.65],
  ];
  for (const [x, y, z] of spots) {
    const spot = new THREE.Mesh(spotGeo, spotMat);
    spot.scale.set(1, 0.45, 1);
    spot.position.set(x * radius, lift + y * radius * 0.72, z * radius);
    group.add(spot);
  }
  enableShadows(group, { cast: true, receive: true });
  return group;
}

function makeBeeMob(radius) {
  const group = new THREE.Group();
  const lift = radius * 0.8;
  const a = radius * 0.78; // ellipsoid x/y radius
  const c = radius * 1.18; // ellipsoid z radius

  const bodyGeo = sharedGeo('bee-body', () => new THREE.SphereGeometry(1, 24, 18));
  const body = new THREE.Mesh(bodyGeo, toonMat(YELLOW));
  body.scale.set(a, a * 0.95, c);
  addOutline(body, 0.1);
  body.position.y = lift;
  group.add(body);

  // black stripes: torus rings hugging the ellipsoid. TorusGeometry's radius
  // is measured to the tube's *center*, so the ring radius must be shrunk by
  // the tube radius or the band bulges out past the body surface.
  const stripeMat = toonMat(BLACK);
  const tube = radius * 0.15;
  for (const zFrac of [-0.45, 0.05, 0.5]) {
    const z = zFrac * c;
    const surfaceR = a * Math.sqrt(Math.max(0.05, 1 - (z / c) ** 2));
    const ringR = Math.max(0.05, surfaceR - tube * 0.9);
    const ringGeo = sharedGeo(`bee-ring-${radius}-${zFrac}`, () => new THREE.TorusGeometry(ringR, tube, 10, 28));
    const ring = new THREE.Mesh(ringGeo, stripeMat);
    ring.position.set(0, lift, z);
    group.add(ring);
  }

  const stingerGeo = sharedGeo(`bee-stinger-${radius}`, () => new THREE.ConeGeometry(radius * 0.28, radius * 0.7, 10));
  const stinger = new THREE.Mesh(stingerGeo, stripeMat);
  stinger.rotation.x = -Math.PI / 2; // point toward -Z (rear)
  stinger.position.set(0, lift, -c - radius * 0.2);
  group.add(stinger);

  const antGeo = sharedGeo(`bee-ant-${radius}`, () => new THREE.CylinderGeometry(0.04, 0.04, radius * 0.65, 6));
  const antTipGeo = sharedGeo(`bee-anttip-${radius}`, () => new THREE.SphereGeometry(radius * 0.11, 8, 6));
  for (const sx of [-1, 1]) {
    const ant = new THREE.Mesh(antGeo, stripeMat);
    ant.rotation.x = 0.9;
    ant.rotation.z = -sx * 0.35;
    ant.position.set(sx * radius * 0.28, lift + a * 0.75, c * 0.75);
    group.add(ant);
    const tip = new THREE.Mesh(antTipGeo, stripeMat);
    tip.position.set(sx * radius * 0.42, lift + a * 0.95, c * 0.95);
    group.add(tip);
  }
  enableShadows(group, { cast: true, receive: true });
  return group;
}

const BAR_HEIGHT = 0.26;  // world units
const BAR_CANVAS_H = 48;  // canvas px; width follows the bar's world aspect

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Billboarded mob health bar: pill-shaped, drawn on a canvas texture so the
// rounded ends stay correct at any fill %. A red bar lerps behind the green
// one to show recent damage; draw(greenFrac, redFrac) repaints both.
export function makeHealthBar(width, anisotropy = 1) {
  const height = BAR_HEIGHT;
  const canvas = document.createElement('canvas');
  // match the plane's aspect so the pill isn't stretched, and keep enough
  // resolution to stay crisp at first-person distances
  canvas.width = Math.round(BAR_CANVAS_H * (width / height));
  canvas.height = BAR_CANVAS_H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;

  const material = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  mesh.renderOrder = 990;

  // canvas repaint + texture re-upload are the expensive part here, and this
  // gets called every frame for every mob — skip it once the bar has settled
  // at its current fractions instead of redrawing identical pixels forever
  let lastGreen = -1, lastRed = -1;
  function draw(greenFrac, redFrac, force = false) {
    const g = Math.max(0, Math.min(1, greenFrac));
    const r = Math.max(0, Math.min(1, redFrac));
    if (!force && Math.abs(g - lastGreen) < 0.0008 && Math.abs(r - lastRed) < 0.0008) return;
    lastGreen = g;
    lastRed = r;

    const w = canvas.width, h = canvas.height;
    const pad = h * 0.12; // dark backing's padding around the fill
    ctx.clearRect(0, 0, w, h);

    roundRectPath(ctx, 0, 0, w, h, h / 2);
    ctx.fillStyle = 'rgba(26,26,26,0.75)';
    ctx.fill();

    ctx.save();
    roundRectPath(ctx, pad, pad, w - pad * 2, h - pad * 2, (h - pad * 2) / 2);
    ctx.clip();
    ctx.fillStyle = '#c22a1e';
    ctx.fillRect(0, 0, w * r, h);
    ctx.fillStyle = '#78dd39';
    ctx.fillRect(0, 0, w * g, h);
    ctx.restore();

    texture.needsUpdate = true;
  }

  draw(1, 1, true);
  return { mesh, texture, draw };
}

export function makeMobMesh(type, radius) {
  if (type === 'rock') return makeRockMob(radius);
  if (type === 'ladybug') return makeLadybugMob(radius);
  if (type === 'bee') return makeBeeMob(radius);
  throw new Error(`unknown mob type ${type}`);
}

export function makePetalMesh(type, radius) {
  const def = PETAL_TYPES[type];
  let mesh;
  if (type === 'rockPetal') {
    const mat = toonMat(def.color);
    mat.flatShading = true;
    mesh = new THREE.Mesh(makeRockGeometry(radius, 0.2), mat);
  } else if (type === 'stinger') {
    mesh = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.9, radius * 2, 3), toonMat(def.color));
    mesh.rotation.x = Math.PI / 2;
  } else {
    mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), toonMat(def.color));
  }
  addOutline(mesh, 0.2);
  const group = new THREE.Group();
  group.add(mesh);
  enableShadows(group, { cast: true, receive: false });
  return group;
}

// ground pickup: floating petal over a rarity-colored disc
export function makeDropMesh(type, rarityIdx) {
  const group = new THREE.Group();
  const rarity = RARITIES[rarityIdx];

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshBasicMaterial({ color: rarity.color, transparent: true, opacity: 0.75 })
  );
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.06;
  group.add(disc);

  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.1, 0.09, 8, 28),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(rarity.color).multiplyScalar(0.6) })
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.y = 0.07;
  group.add(rim);

  const petal = makePetalMesh(type, PETAL_TYPES[type].radius * 1.5);
  petal.position.y = 1.1;
  group.add(petal);
  group.userData.petal = petal;
  return group;
}
