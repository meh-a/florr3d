import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { ARENA_HALF } from './config.js';
import { damp } from './utils.js';

const TILE_WORLD_SIZE = 10; // units per tile.svg repeat

// Rasterize tile.svg onto a canvas ourselves rather than letting the browser
// pick a default size for the <img> (SVGs without width/height attributes
// don't reliably rasterize at their viewBox's aspect ratio otherwise).
function loadTileTexture(renderer) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 512;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, size, size);

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const repeat = (ARENA_HALF * 2 + 10) / TILE_WORLD_SIZE;
      texture.repeat.set(repeat, repeat);
      texture.needsUpdate = true;
      resolve(texture);
    };
    img.src = `${import.meta.env.BASE_URL}tile.svg`;
  });
}

// Lensflare textures drawn on canvases so we don't need image assets.
// 'sun' is the bright core, 'ghost' a soft blob, 'ring' a hollow halo.
function makeFlareTexture(kind) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  if (kind === 'sun') {
    g.addColorStop(0, 'rgba(255,255,245,1)');
    g.addColorStop(0.18, 'rgba(255,244,190,1)');
    g.addColorStop(0.32, 'rgba(255,220,120,0.5)');
    g.addColorStop(0.6, 'rgba(255,200,90,0.12)');
    g.addColorStop(1, 'rgba(255,190,80,0)');
  } else if (kind === 'ring') {
    g.addColorStop(0.62, 'rgba(255,235,180,0)');
    g.addColorStop(0.74, 'rgba(255,235,180,0.28)');
    g.addColorStop(0.86, 'rgba(255,235,180,0)');
    g.addColorStop(1, 'rgba(255,235,180,0)');
  } else {
    g.addColorStop(0, 'rgba(255,240,200,0.5)');
    g.addColorStop(0.5, 'rgba(255,230,170,0.2)');
    g.addColorStop(1, 'rgba(255,220,150,0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createWorld(container) {
  const scene = new THREE.Scene();
  const SKY = '#7ec8f5';
  scene.background = new THREE.Color(SKY);
  // fog matches the sky so distant ground hazes into the horizon
  scene.fog = new THREE.Fog(SKY, 90, 190);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(0, 28, 16);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x668866, 1.6));
  const sunOffset = new THREE.Vector3(30, 60, 20);
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.copy(sunOffset);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 180;
  sun.shadow.camera.left = -55;
  sun.shadow.camera.right = 55;
  sun.shadow.camera.top = 55;
  sun.shadow.camera.bottom = -55;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  // the shadow camera is a fixed-size box, so it has to re-center on the
  // player each frame rather than covering the whole (much larger) arena
  const sunTarget = new THREE.Object3D();
  scene.add(sunTarget);
  sun.target = sunTarget;
  scene.add(sun);

  // visible sun + lens flare, placed far along the light direction
  const sunAnchor = new THREE.Object3D();
  sunAnchor.position.copy(sun.position).normalize().multiplyScalar(380);
  const flare = new Lensflare();
  flare.addElement(new LensflareElement(makeFlareTexture('sun'), 420, 0));
  flare.addElement(new LensflareElement(makeFlareTexture('ghost'), 70, 0.35));
  flare.addElement(new LensflareElement(makeFlareTexture('ghost'), 110, 0.55));
  flare.addElement(new LensflareElement(makeFlareTexture('ring'), 160, 0.8));
  flare.addElement(new LensflareElement(makeFlareTexture('ghost'), 55, 1.0));
  sunAnchor.add(flare);
  scene.add(sunAnchor);

  // playable ground + darker apron outside the bounds
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(700, 700),
    new THREE.MeshBasicMaterial({ color: '#157a47' })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  scene.add(apron);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_HALF * 2 + 10, ARENA_HALF * 2 + 10),
    new THREE.MeshToonMaterial({ color: '#1ea761' })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  loadTileTexture(renderer).then((texture) => {
    ground.material.map = texture;
    ground.material.color.set(0xffffff);
    ground.material.needsUpdate = true;
  });

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const camTarget = new THREE.Vector3();
  const FPS_EYE_HEIGHT = 1.2;
  const TOPDOWN_FOV = 55;
  const FPS_FOV = 75;
  // look = { yaw, pitch } for first-person mode, or null for the top-down chase cam
  function updateCamera(dt, focus, look = null) {
    sun.position.set(focus.x + sunOffset.x, sunOffset.y, focus.z + sunOffset.z);
    sunTarget.position.set(focus.x, 0, focus.z);

    const fov = look ? FPS_FOV : TOPDOWN_FOV;
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    if (look) {
      camTarget.copy(focus);
      camera.position.set(focus.x, focus.y + FPS_EYE_HEIGHT, focus.z);
      camera.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
      return;
    }
    camTarget.lerp(focus, damp(6, dt));
    camera.position.set(camTarget.x, camTarget.y + 28, camTarget.z + 16);
    camera.lookAt(camTarget.x, 0, camTarget.z);
  }

  return { scene, camera, renderer, updateCamera };
}

export function clampToArena(pos, margin = 0) {
  const half = ARENA_HALF - margin;
  pos.x = Math.max(-half, Math.min(half, pos.x));
  pos.z = Math.max(-half, Math.min(half, pos.z));
}
