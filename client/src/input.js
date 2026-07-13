import * as THREE from 'three';

const PITCH_LIMIT = Math.PI / 2 - 0.12;
// Pointer Lock quirk (not this game's sensitivity/DPI handling): some
// browsers occasionally report one huge spurious movementX/Y on the very
// first mousemove after the lock (re)acquires — which happens here on
// every attack click in first person, since regaining a dropped lock is
// tied to mousedown. Unclamped, that single event snaps the camera
// instantly (nothing smooths FPS rotation — see world.js). A per-event
// cap kills that spike outright while never touching a real flick: even
// a fast intentional 360 spins through many small events, none of which
// come close to this on their own.
const MAX_MOVE_PX = 250;

export class Input {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.camera = camera;
    this.mouseNDC = new THREE.Vector2(0, 0);
    this.attack = false;
    this.defend = false;
    this.keys = new Set();
    this.handlers = {}; // key -> fn, fired on keydown

    // first-person look state (pointer lock)
    this.look = { yaw: 0, pitch: 0 };
    this.lookSensitivity = 0.0024;
    this.wantLock = false;

    this.raycaster = new THREE.Raycaster();
    this.groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.groundPoint = new THREE.Vector3();

    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === canvas) {
        const dx = Math.max(-MAX_MOVE_PX, Math.min(MAX_MOVE_PX, e.movementX));
        const dy = Math.max(-MAX_MOVE_PX, Math.min(MAX_MOVE_PX, e.movementY));
        this.look.yaw -= dx * this.lookSensitivity;
        this.look.pitch -= dy * this.lookSensitivity;
        this.look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.look.pitch));
        return;
      }
      this.mouseNDC.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    });
    canvas.addEventListener('mousedown', (e) => {
      // regain pointer lock after the user pressed Esc while in first person
      if (this.wantLock && document.pointerLockElement !== canvas) canvas.requestPointerLock();
      if (e.button === 0) this.attack = true;
      if (e.button === 2) this.defend = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.attack = false;
      if (e.button === 2) this.defend = false;
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return; // typing a name, not playing
      const k = e.key.toLowerCase();
      // space would "click" whatever button was last focused (e.g. Play)
      if (k === ' ') e.preventDefault();
      this.keys.add(k);
      if (!e.repeat && this.handlers[k]) this.handlers[k]();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
  }

  on(key, fn) { this.handlers[key] = fn; }

  // held-intent accessors: mouse buttons or their keyboard equivalents
  attackHeld() { return this.attack || this.keys.has(' '); }
  defendHeld() { return this.defend || this.keys.has('shift'); }

  lockPointer() {
    this.wantLock = true;
    this.canvas.requestPointerLock();
  }

  unlockPointer() {
    this.wantLock = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  // WASD as a normalized {x, z} pair in key-space (z = forward)
  moveAxes() {
    const x = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
    const z = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0);
    const len = Math.hypot(x, z);
    return len > 0 ? { x: x / len, z: z / len } : { x: 0, z: 0 };
  }

  // cursor position projected onto the ground plane
  cursorWorld() {
    this.raycaster.setFromCamera(this.mouseNDC, this.camera);
    this.raycaster.ray.intersectPlane(this.groundPlane, this.groundPoint);
    return this.groundPoint;
  }
}
