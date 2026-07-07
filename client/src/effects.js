import * as THREE from 'three';

const UP_OFFSET = new THREE.Vector3(0, 1.2, 0);
const spriteCache = new Map(); // text+crit -> reusable canvas texture

function getDamageTexture(text, crit) {
  const key = `${text}:${crit}`;
  let entry = spriteCache.get(key);
  if (entry) return entry;

  const fontSize = 64;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontSize}px Ubuntu, sans-serif`;
  const pad = fontSize * 0.3;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = Math.ceil(fontSize * 1.35);

  // measureText resets after resizing the canvas, so re-set the font
  ctx.font = `bold ${fontSize}px Ubuntu, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = fontSize * 0.14;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = crit ? '#ffd23f' : '#fff';
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.strokeText(text, cx, cy);
  ctx.fillText(text, cx, cy);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  entry = { texture, aspect: canvas.width / canvas.height };
  spriteCache.set(key, entry);
  return entry;
}

// Floating combat text rendered as camera-facing sprites living in the 3D
// scene, rather than a DOM overlay — they billboard and scale with distance
// for free and never need manual screen-space projection.
export class Effects {
  constructor(game) {
    this.game = game;
    this.numbers = [];
  }

  spawnDamageNumber(amount, worldPos, crit = false) {
    const text = Math.round(amount).toString();
    const { texture, aspect } = getDamageTexture(text, crit);
    const material = new THREE.SpriteMaterial({
      map: texture, transparent: true, depthTest: false, depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    const height = crit ? 1.5 : 1.1;
    sprite.scale.set(height * aspect, height, 1);
    sprite.position.copy(worldPos).add(UP_OFFSET);
    sprite.renderOrder = 999;
    this.game.scene.add(sprite);

    this.numbers.push({
      sprite,
      vx: (Math.random() * 2 - 1) * 1.4,
      vy: 3.4 + Math.random() * 0.6,
      age: 0,
      life: 0.85,
      baseScale: sprite.scale.clone(),
    });
  }

  update(dt) {
    for (const n of this.numbers) {
      n.age += dt;
      n.vy -= dt * 4.5;
      n.sprite.position.y += n.vy * dt;
      n.sprite.position.x += n.vx * dt;

      const t = n.age / n.life;
      const pop = t < 0.15 ? 0.7 + 0.3 * (t / 0.15) : 1;
      n.sprite.scale.copy(n.baseScale).multiplyScalar(pop);
      n.sprite.material.opacity = t < 0.6 ? 1 : Math.max(0, 1 - (t - 0.6) / 0.4);
    }

    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      if (n.age >= n.life) {
        this.game.scene.remove(n.sprite);
        n.sprite.material.dispose();
        this.numbers.splice(i, 1);
      }
    }
  }
}
