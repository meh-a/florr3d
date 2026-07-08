import * as THREE from 'three';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { ARENA_HALF, TILE_SIZE, MAP_TILES } from '../../shared/config.js';
import { damp } from './utils.js';
import { getQuality } from './settings.js';
import { makeTiles } from './tiles.js';
import { makeGrass } from './grass.js';
import grassColorUrl from '../assets/grass_color.jpg';

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
      // the ground is a ShapeGeometry whose UVs are raw world coordinates,
      // so one texture repeat per TILE_WORLD_SIZE units
      texture.repeat.set(1 / TILE_WORLD_SIZE, 1 / TILE_WORLD_SIZE);
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

// Puffy cartoon clouds: clusters of overlapping flattened spheres sharing one
// geometry/material. They live well above the arena, so they're mostly scenery
// for first-person mode and the horizon, where the fog hazes them out.
// kept inside the fog falloff (ends at 190) so nearby clouds read crisp
// white while the far ones haze into the sky instead of popping at the wrap
const CLOUD_COUNT = 26;
const CLOUD_SPREAD = 170; // clouds wrap around at ±this on x/z
const CLOUD_ALT = () => 30 + Math.random() * 24;

function makeCloudField(scene) {
  const geo = new THREE.SphereGeometry(1, 16, 12);
  // emissive lift keeps the shaded undersides fluffy-white instead of grey
  const mat = new THREE.MeshToonMaterial({
    color: '#ffffff', emissive: '#ffffff', emissiveIntensity: 0.22,
  });
  const clouds = [];

  for (let i = 0; i < CLOUD_COUNT; i++) {
    const group = new THREE.Group();
    const puffs = 3 + Math.floor(Math.random() * 4);
    const base = 5 + Math.random() * 4; // core puff radius
    let x = -(puffs - 1) * base * 0.45;
    for (let j = 0; j < puffs; j++) {
      const r = base * (0.55 + Math.random() * 0.5);
      const puff = new THREE.Mesh(geo, mat);
      puff.scale.set(r, r * 0.6, r * (0.8 + Math.random() * 0.4));
      puff.position.set(x, (Math.random() - 0.5) * base * 0.3, (Math.random() - 0.5) * base * 0.8);
      group.add(puff);
      x += r * 0.9;
    }
    group.position.set(
      (Math.random() * 2 - 1) * CLOUD_SPREAD,
      CLOUD_ALT(),
      (Math.random() * 2 - 1) * CLOUD_SPREAD
    );
    scene.add(group);
    clouds.push({ group, speed: 1.2 + Math.random() * 1.6 });
  }

  return (dt) => {
    for (const cloud of clouds) {
      cloud.group.position.x += cloud.speed * dt;
      if (cloud.group.position.x > CLOUD_SPREAD) {
        // drift off one side, re-enter on the other at a fresh height/depth
        cloud.group.position.set(
          -CLOUD_SPREAD,
          CLOUD_ALT(),
          (Math.random() * 2 - 1) * CLOUD_SPREAD
        );
      }
    }
  };
}

// Raymarched volumetric clouds, baked: the expensive shadertoy-style
// raymarch (fbm noise slab, front-to-back accumulation, sun-shadow samples
// per step) runs exactly once at startup, rendered into an equirect texture
// that gets draped over a sky dome. Per-frame cost after that is one
// textured mesh; slow dome rotation stands in for wind drift.
const DOME_ELEV = Math.PI * 0.55; // dome extends slightly past the horizon

function makeVolumetricClouds(scene, renderer, sunDir) {
  const bakeMaterial = new THREE.ShaderMaterial({
    uniforms: { uSunDir: { value: sunDir.clone().normalize() } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec2 vUv;
      uniform vec3 uSunDir;

      const float CLOUD_BOTTOM = 60.0;
      const float CLOUD_TOP = 145.0;
      const int STEPS = 64;
      const int LIGHT_STEPS = 5;
      const float DOME_ELEV = ${DOME_ELEV.toFixed(7)};

      float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
      }
      float noise(vec3 x) {
        vec3 i = floor(x), f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
              mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
          mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
              mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
          f.z);
      }
      float fbm(vec3 p) {
        float amp = 0.5, res = 0.0;
        for (int i = 0; i < 5; i++) {
          res += amp * noise(p);
          p *= 2.13;
          amp *= 0.5;
        }
        return res;
      }

      float density(vec3 p) {
        float shape = fbm(p * 0.0075);
        // wispy eroded edges from higher-frequency detail noise
        shape -= 0.16 * fbm(p * 0.03);
        float h = (p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM);
        float grad = smoothstep(0.0, 0.2, h) * smoothstep(1.0, 0.5, h);
        return clamp((shape * grad - 0.27) * 2.6, 0.0, 1.0);
      }

      float lightMarch(vec3 p) {
        float d = 0.0;
        for (int i = 0; i < LIGHT_STEPS; i++) {
          p += uSunDir * 14.0;
          d += density(p);
        }
        return exp(-d * 1.1);
      }

      void main() {
        // equirect texel -> world direction, matching SphereGeometry's UVs
        // (v=1 at the zenith, u wrapping around +Y)
        float elev = (1.0 - vUv.y) * DOME_ELEV;
        float azim = vUv.x * 6.2831853;
        vec3 rd = vec3(cos(azim) * sin(elev), cos(elev), sin(azim) * sin(elev));

        float horizon = smoothstep(0.02, 0.1, rd.y);
        if (horizon <= 0.0) { gl_FragColor = vec4(0.0); return; }

        vec3 ro = vec3(0.0, 15.0, 0.0); // nominal viewer; parallax is negligible
        float t0 = (CLOUD_BOTTOM - ro.y) / rd.y;
        float t1 = (CLOUD_TOP - ro.y) / rd.y;
        t1 = min(t1, t0 + 900.0); // cap shallow rays skimming the slab
        float stepLen = (t1 - t0) / float(STEPS);

        vec3 col = vec3(0.0);
        float acc = 0.0;
        for (int i = 0; i < STEPS; i++) {
          vec3 p = ro + rd * (t0 + (float(i) + 0.5) * stepLen);
          float den = density(p);
          if (den < 0.002) continue;
          float lit = lightMarch(p);
          // shadowed cores go blue-grey, sunlit faces stay warm white
          vec3 c = mix(vec3(0.53, 0.58, 0.70), vec3(1.03, 1.0, 0.96), lit);
          float a = 1.0 - exp(-den * stepLen * 0.075);
          col += c * a * (1.0 - acc);
          acc += a * (1.0 - acc);
          if (acc > 0.99) break;
        }
        gl_FragColor = vec4(col, acc * horizon);
      }
    `,
  });

  // one-time bake into an equirect render target
  const target = new THREE.WebGLRenderTarget(1024, 512, { depthBuffer: false });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bakeMaterial);
  const bakeScene = new THREE.Scene();
  bakeScene.add(quad);
  const bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.setRenderTarget(target);
  renderer.render(bakeScene, bakeCamera);
  renderer.setRenderTarget(null);
  quad.geometry.dispose();
  bakeMaterial.dispose();

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(430, 48, 24, 0, Math.PI * 2, 0, DOME_ELEV),
    new THREE.MeshBasicMaterial({
      map: target.texture, transparent: true, depthWrite: false,
      side: THREE.BackSide, fog: false,
    })
  );
  scene.add(dome);

  // wind drift: rotating baked clouds is indistinguishable from re-marching
  return (dt) => { dome.rotation.y += dt * 0.004; };
}

export function createWorld(container) {
  // 'high': shadows, AA, native pixel ratio, lens flare, baked volumetric
  // clouds, shader water. 'low': none of those — toon clouds, flat water.
  // 'ultra': everything from 'high' plus the instanced grass field (and a
  // muted ground tint so the cartoon grid doesn't glow between the blades).
  const quality = getQuality();
  const highQ = quality !== 'low';
  const ultra = quality === 'ultra';

  const scene = new THREE.Scene();
  const SKY = '#7ec8f5';
  scene.background = new THREE.Color(SKY);
  // fog matches the sky so distant ground hazes into the horizon
  scene.fog = new THREE.Fog(SKY, 90, 190);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
  camera.position.set(0, 28, 16);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: highQ });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(highQ ? Math.min(devicePixelRatio, 2) : 1);
  renderer.shadowMap.enabled = highQ;
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
  if (highQ) {
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
  }

  // darker apron outside the bounds — a frame with the arena cut out so it
  // can never occlude recessed tile basins inside the arena
  const apronShape = new THREE.Shape();
  apronShape.moveTo(-350, -350);
  apronShape.lineTo(350, -350);
  apronShape.lineTo(350, 350);
  apronShape.lineTo(-350, 350);
  const apronHole = new THREE.Path();
  const ah = ARENA_HALF + 5;
  apronHole.moveTo(-ah, -ah);
  apronHole.lineTo(ah, -ah);
  apronHole.lineTo(ah, ah);
  apronHole.lineTo(-ah, ah);
  apronShape.holes.push(apronHole);
  const apron = new THREE.Mesh(
    new THREE.ShapeGeometry(apronShape),
    new THREE.MeshBasicMaterial({ color: '#157a47' })
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.05;
  scene.add(apron);

  // grass plane with holes cut over water tiles so their basins can be
  // recessed below ground level. Shape space (x, y) maps to world (x, -z)
  // under the -PI/2 X rotation.
  const groundShape = new THREE.Shape();
  const groundHalf = ARENA_HALF + 5;
  groundShape.moveTo(-groundHalf, -groundHalf);
  groundShape.lineTo(groundHalf, -groundHalf);
  groundShape.lineTo(groundHalf, groundHalf);
  groundShape.lineTo(-groundHalf, groundHalf);
  for (const t of MAP_TILES) {
    if (t.type !== 'water') continue;
    const cx = t.gx * TILE_SIZE, cy = -t.gz * TILE_SIZE, h = TILE_SIZE / 2;
    const hole = new THREE.Path();
    hole.moveTo(cx - h, cy - h);
    hole.lineTo(cx + h, cy - h);
    hole.lineTo(cx + h, cy + h);
    hole.lineTo(cx - h, cy + h);
    groundShape.holes.push(hole);
  }
  const ground = new THREE.Mesh(
    new THREE.ShapeGeometry(groundShape),
    new THREE.MeshToonMaterial({ color: '#1ea761' })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  if (ultra) {
    // photographic turf (CC0, ambientCG Grass004) instead of the cartoon
    // tile grid — the instanced blades provide depth, the photo provides
    // the fine detail neither could fake alone
    new THREE.TextureLoader().load(grassColorUrl, (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      texture.repeat.set(1 / 8, 1 / 8); // one photo repeat per 8 world units
      ground.material.map = texture;
      ground.material.color.set(0xffffff);
      ground.material.needsUpdate = true;
    });
  } else {
    loadTileTexture(renderer).then((texture) => {
      ground.material.map = texture;
      ground.material.color.set(0xffffff);
      ground.material.needsUpdate = true;
    });
  }

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const updateClouds = highQ
    ? makeVolumetricClouds(scene, renderer, sunOffset)
    : makeCloudField(scene);
  const updateTiles = makeTiles(scene, quality, sunOffset);
  const updateGrass = ultra ? makeGrass(scene, sunOffset) : null;

  const camTarget = new THREE.Vector3();
  const FPS_EYE_HEIGHT = 1.2;
  const TOPDOWN_FOV = 55;
  const FPS_FOV = 75;
  // look = { yaw, pitch } for first-person mode, or null for the top-down chase cam
  function updateCamera(dt, focus, look = null) {
    updateClouds(dt);
    updateTiles(dt);
    if (updateGrass) updateGrass(dt, focus);
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
