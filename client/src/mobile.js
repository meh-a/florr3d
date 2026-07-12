import * as THREE from 'three';

// Touch controls, created only on coarse-pointer devices: a movement
// joystick (bottom-left), attack/defend buttons and a camera-swap button
// (right edge), and drag-to-look in first person. Movement becomes
// joystick-only on touch — releasing the stick stops the flower instead of
// it chasing the last tap (emulated mouse events used to do that).
//
// The joystick publishes itself as game.input.joy = { x, y, active }
// (screen space: x right, y down); main.js maps it to a cursor target
// (top-down, camera-relative) or WASD axes (first person).

const PITCH_LIMIT = Math.PI / 2 - 0.12;

// inline stroke icons (lucide-style paths) — crisp at any DPI, tinted by CSS
const icon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  camera: icon('<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>'),
  shield: icon('<path d="M12 3l7 3v6c0 4.7-3.1 7.6-7 9-3.9-1.4-7-4.3-7-9V6z"/>'),
  sword: icon('<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/>'),
};

function button(id, iconSvg, bottom) {
  const b = document.createElement('div');
  b.id = id;
  b.className = 'touchbtn';
  b.innerHTML = iconSvg;
  b.style.bottom = `${bottom}px`;
  return b;
}

export function setupMobileControls(game, toggleCamera) {
  if (!matchMedia('(pointer: coarse)').matches) return false;
  const hud = document.getElementById('hud');
  const input = game.input;

  // ---- joystick ----
  const base = document.createElement('div');
  base.id = 'joy';
  const knob = document.createElement('div');
  knob.id = 'joyknob';
  base.appendChild(knob);
  hud.appendChild(base);

  const joy = { x: 0, y: 0, active: false };
  input.joy = joy;
  const RANGE = 44; // knob travel in px
  let joyTouch = null;
  let cx = 0, cy = 0;

  const setKnob = () => {
    knob.style.transform = `translate(${joy.x * RANGE}px, ${joy.y * RANGE}px)`;
  };
  base.addEventListener('touchstart', (e) => {
    e.preventDefault(); // no emulated mouse events / scrolling from the stick
    if (joyTouch !== null) return;
    const t = e.changedTouches[0];
    joyTouch = t.identifier;
    const r = base.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    joy.active = true;
  }, { passive: false });
  base.addEventListener('touchmove', (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joyTouch) continue;
      const dx = (t.clientX - cx) / RANGE, dy = (t.clientY - cy) / RANGE;
      const len = Math.hypot(dx, dy);
      const s = len > 1 ? 1 / len : 1;
      joy.x = dx * s;
      joy.y = dy * s;
      setKnob();
    }
  }, { passive: false });
  const joyEnd = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joyTouch) continue;
      joyTouch = null;
      joy.x = joy.y = 0;
      joy.active = false;
      setKnob();
    }
  };
  base.addEventListener('touchend', joyEnd);
  base.addEventListener('touchcancel', joyEnd);

  // ---- action buttons: camera swap, defend, attack ----
  const camBtn = button('cambtn', ICONS.camera, 330);
  const defBtn = button('defbtn', ICONS.shield, 262);
  const atkBtn = button('atkbtn', ICONS.sword, 194);
  hud.append(camBtn, defBtn, atkBtn);

  camBtn.addEventListener('touchstart', (e) => { e.preventDefault(); toggleCamera(); }, { passive: false });
  const hold = (btn, field) => {
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); input[field] = true; btn.classList.add('held'); }, { passive: false });
    const off = (e) => { e.preventDefault(); input[field] = false; btn.classList.remove('held'); };
    btn.addEventListener('touchend', off, { passive: false });
    btn.addEventListener('touchcancel', off, { passive: false });
  };
  hold(atkBtn, 'attack');
  hold(defBtn, 'defend');

  // ---- first-person look: drag anywhere on the canvas ----
  const canvas = game.renderer.domElement;
  let lookTouch = null, lastX = 0, lastY = 0;
  canvas.addEventListener('touchstart', (e) => {
    if (!game.fpsMode || lookTouch !== null) return;
    const t = e.changedTouches[0];
    lookTouch = t.identifier;
    lastX = t.clientX;
    lastY = t.clientY;
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (lookTouch === null) return;
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== lookTouch) continue;
      input.look.yaw -= (t.clientX - lastX) * 0.006;
      input.look.pitch -= (t.clientY - lastY) * 0.006;
      input.look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, input.look.pitch));
      lastX = t.clientX;
      lastY = t.clientY;
    }
  }, { passive: false });
  const lookEnd = (e) => {
    for (const t of e.changedTouches) if (t.identifier === lookTouch) lookTouch = null;
  };
  canvas.addEventListener('touchend', lookEnd);
  canvas.addEventListener('touchcancel', lookEnd);

  return true;
}

// map the joystick's screen-space vector to a world-space offset from the
// player: stick-up moves toward the top of the screen wherever the camera
// points. Scaled so a full deflection is comfortably past the server's
// full-speed cursor distance.
const fwd = new THREE.Vector3();
export function joyWorldOffset(camera, joy, out = { x: 0, z: 0 }) {
  camera.getWorldDirection(fwd);
  fwd.y = 0;
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  else fwd.normalize();
  // screen right = fwd x up
  const rx = -fwd.z, rz = fwd.x;
  const SCALE = 16;
  out.x = (rx * joy.x - fwd.x * joy.y) * SCALE;
  out.z = (rz * joy.x - fwd.z * joy.y) * SCALE;
  return out;
}
