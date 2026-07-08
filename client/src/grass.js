import * as THREE from 'three';
import { ARENA_HALF, TILE_SIZE, MAP_TILES } from '../../shared/config.js';

// Ultra-quality photorealistic grass: one InstancedBufferGeometry of tapered
// blades, positioned and animated entirely in the vertex shader. The blades
// live in a square "patch" that follows the player; each instance owns a
// fixed offset within the patch and the shader wraps it to the unique world
// position ≡ offset (mod PATCH) nearest the focus, so blades stay anchored
// to the world as the patch slides (no swimming), and the visible edge is
// hidden by a scale fade before the wrap.
//
// Per-frame cost is one draw call; wind, lighting, and the base->tip color
// gradient are all vertex work, so the fragment shader stays trivial.

const BLADE_COUNT = 80000;
const PATCH = 96;              // patch side length (world units)
const BLADE_HEIGHT = 0.8;      // nominal height, scaled ±~40% per blade
const BLADE_HALF_WIDTH = 0.055;
const GROUND_HALF = ARENA_HALF + 5; // matches the ground plane extent

// blades must not sprout inside recessed water basins (or their dirt lip)
const WATER_CULL_GLSL = MAP_TILES
  .filter((t) => t.type === 'water')
  .map((t) => {
    const cx = (t.gx * TILE_SIZE).toFixed(1);
    const cz = (t.gz * TILE_SIZE).toFixed(1);
    const half = (TILE_SIZE / 2 + 0.4).toFixed(1);
    return `if (max(abs(anchor.x - (${cx})), abs(anchor.y - (${cz}))) < ${half}) scale = 0.0;`;
  })
  .join('\n        ');

// A single blade: three tapering quad rows plus a pointed tip, in the XY
// plane (x = width, y = 0..1 along the blade). 7 verts / 5 tris.
function bladeGeometry() {
  const geo = new THREE.InstancedBufferGeometry();
  const w = BLADE_HALF_WIDTH;
  geo.setAttribute('position', new THREE.Float32BufferAttribute([
    -w, 0, 0,        w, 0, 0,
    -w * 0.72, 1 / 3, 0,  w * 0.72, 1 / 3, 0,
    -w * 0.38, 2 / 3, 0,  w * 0.38, 2 / 3, 0,
    0, 1, 0,
  ], 3));
  geo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6]);

  const offsets = new Float32Array(BLADE_COUNT * 2);
  const rands = new Float32Array(BLADE_COUNT * 4);
  for (let i = 0; i < BLADE_COUNT; i++) {
    offsets[i * 2] = Math.random() * PATCH;
    offsets[i * 2 + 1] = Math.random() * PATCH;
    rands[i * 4] = Math.random() * Math.PI * 2;   // yaw
    rands[i * 4 + 1] = 0.7 + Math.random() * 0.6; // height scale
    rands[i * 4 + 2] = Math.random();             // color lean
    rands[i * 4 + 3] = Math.random() * Math.PI * 2; // wind phase
  }
  geo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(offsets, 2));
  geo.setAttribute('aRand', new THREE.InstancedBufferAttribute(rands, 4));
  return geo;
}

export function makeGrass(scene, sunDir) {
  const material = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uFocus: { value: new THREE.Vector2() },
        uSunDir: { value: sunDir.clone().normalize() },
      },
    ]),
    side: THREE.DoubleSide,
    fog: true,
    vertexShader: /* glsl */ `
      attribute vec2 aOffset;
      attribute vec4 aRand;
      uniform float uTime;
      uniform vec2 uFocus;
      uniform vec3 uSunDir;
      varying vec3 vColor;
      varying float vY;
      #include <fog_pars_vertex>

      const float PATCH = ${PATCH.toFixed(1)};
      const float HALF_P = ${(PATCH / 2).toFixed(1)};
      const float BLADE_HEIGHT = ${BLADE_HEIGHT.toFixed(2)};
      const float GROUND_HALF = ${GROUND_HALF.toFixed(1)};

      void main() {
        // wrap this instance's patch offset to the world cell nearest uFocus;
        // the anchor (and everything derived from it) is stable in world
        // space, so the field doesn't crawl as the player moves
        vec2 anchor = uFocus + mod(aOffset - uFocus + HALF_P, PATCH) - HALF_P;

        float scale = aRand.y;
        // shrink blades to nothing before the patch edge so the wrap seam
        // is never visible; fog handles everything beyond
        scale *= 1.0 - smoothstep(HALF_P * 0.72, HALF_P * 0.97, distance(anchor, uFocus));
        if (max(abs(anchor.x), abs(anchor.y)) > GROUND_HALF) scale = 0.0;
        ${WATER_CULL_GLSL}

        float h = position.y; // 0 at root, 1 at tip
        float ca = cos(aRand.x), sa = sin(aRand.x);

        // two out-of-phase sines read as gusts rolling across the field
        float sway =
          sin(uTime * 1.6 + anchor.x * 0.35 + anchor.y * 0.28 + aRand.w) +
          0.5 * sin(uTime * 2.7 + anchor.x * 0.13 - anchor.y * 0.19 + aRand.w * 1.7);
        float bend = 0.07 + sway * 0.085; // constant lean + gust
        vec2 windDir = vec2(0.842, 0.539);

        // static per-blade slouch in a hashed random direction, so the field
        // reads tousled instead of combed straight up
        float hl = fract(sin(dot(aOffset, vec2(12.9898, 78.233))) * 43758.5453);
        vec2 leanDir = vec2(cos(hl * 6.2832), sin(hl * 6.2832));
        float lean = 0.05 + hl * 0.3;

        float height = BLADE_HEIGHT * scale;
        vec3 p = vec3(position.x * ca * scale, h * height, position.x * sa * scale);
        // quadratic falloff: roots stay planted, tips do the swaying
        p.xz += (windDir * bend + leanDir * lean) * (h * h * height);
        p.y -= lean * lean * h * h * height * 0.5; // tip drop from the arc

        vec3 worldPos = vec3(anchor.x + p.x, p.y, anchor.y + p.z);

        // fake lighting: blade-facing normal tilted toward up (blades are
        // thin, so precise normals matter less than plausible variation),
        // plus root-darkening AO where blades crowd each other
        vec3 n = normalize(vec3(-sa, 1.1, ca));
        float ndl = max(dot(n, uSunDir), 0.0);
        float light = (0.55 + 0.45 * ndl) * mix(0.42, 1.0, h);

        // olive palette matched to the ground's photo turf so blades read as
        // part of the same lawn rather than decoration sitting on top of it
        vec3 base = vec3(0.05, 0.13, 0.03);
        vec3 tip = mix(vec3(0.20, 0.36, 0.10), vec3(0.38, 0.48, 0.16), aRand.z);
        vColor = mix(base, tip, h) * light * 1.2;
        vY = h;

        vec4 mvPosition = modelViewMatrix * vec4(worldPos, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying float vY;
      #include <fog_pars_fragment>

      void main() {
        // waxy sheen where the sun catches the blade tips
        vec3 col = vColor + vec3(0.05, 0.09, 0.03) * smoothstep(0.75, 1.0, vY);
        gl_FragColor = vec4(col, 1.0);
        #include <fog_fragment>
        #include <colorspace_fragment>
      }
    `,
  });

  const mesh = new THREE.Mesh(bladeGeometry(), material);
  // the patch repositions itself in the shader, so three's culling (which
  // only sees the untranslated geometry) must not reject it
  mesh.frustumCulled = false;
  scene.add(mesh);

  return (dt, focus) => {
    material.uniforms.uTime.value += dt;
    material.uniforms.uFocus.value.set(focus.x, focus.z);
  };
}
