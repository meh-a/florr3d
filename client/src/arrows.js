import * as THREE from 'three';

// Screen-edge arrows pointing toward the nearest flowers. The server sends
// up to three in `state.others`, deliberately not interest-scoped — unlike
// `state.players` they can sit far beyond the fog, which is the whole
// point: they lead you to people you can't see yet. Each arrow hugs the
// screen border along the direction of its target (with name + distance)
// and hides while the target is actually visible on screen.
const EDGE = 0.86;   // border position in NDC (0 = center, 1 = screen edge)
const VISIBLE = 0.9; // targets projecting inside this NDC box need no arrow

export class Arrows {
  constructor(game) {
    this.game = game;
    this.targets = [];
    this.enabled = false; // off by default; toggled with a hotkey
    this.v = new THREE.Vector3();
    this.root = document.createElement('div');
    this.root.id = 'arrows';
    document.body.appendChild(this.root);
    this.els = Array.from({ length: 3 }, () => {
      const el = document.createElement('div');
      el.className = 'arrow hidden';
      el.innerHTML = '<div class="glyph">➤</div><div class="label stroke"></div>';
      this.root.appendChild(el);
      return el;
    });
  }

  setTargets(others) { this.targets = others || []; }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  update() {
    const me = this.game.entities?.playerPos();
    for (let i = 0; i < this.els.length; i++) {
      const el = this.els[i];
      const t = this.targets[i];
      if (!this.enabled || !t || !me) { el.classList.add('hidden'); continue; }

      this.v.set(t.x, 1.1, t.z).project(this.game.camera);
      const behind = this.v.z > 1; // projection flips sign behind the camera
      const nx = behind ? -this.v.x : this.v.x;
      const ny = behind ? -this.v.y : this.v.y;
      if (!behind && Math.abs(nx) < VISIBLE && Math.abs(ny) < VISIBLE) {
        el.classList.add('hidden');
        continue;
      }

      // clamp the direction to the EDGE box; rotate the glyph to point
      // outward along it (screen y grows downward, NDC y upward)
      const s = EDGE / Math.max(Math.abs(nx), Math.abs(ny), 1e-6);
      const x = (nx * s * 0.5 + 0.5) * innerWidth;
      const y = (-ny * s * 0.5 + 0.5) * innerHeight;
      const rot = Math.atan2(-ny * innerHeight, nx * innerWidth);
      el.classList.remove('hidden');
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      el.firstChild.style.transform = `translate(-50%,-50%) rotate(${rot}rad)`;
      el.lastChild.textContent = `${t.name} · ${Math.round(Math.hypot(t.x - me.x, t.z - me.z))}m`;
    }
  }
}
