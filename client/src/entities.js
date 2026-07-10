import * as THREE from 'three';
import { PETAL_TYPES, MOB_TYPES, RARITIES } from '../../shared/config.js';
import { makeFlower, makeMobMesh, makeHealthBar, makePetalMesh, makeDropMesh, makeMissileMesh } from './models.js';
import { damp, flashMaterials, updateFlash, disposeMaterials, disposeObject3D } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);
const PLAYER_RADIUS = 1.1;

// name tag rendered the same way as damage numbers: a canvas-text sprite
// living in the scene, so it billboards and scales with distance for free
function makeNameSprite(text) {
  const fontSize = 48;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${fontSize}px Ubuntu, sans-serif`;
  const pad = fontSize * 0.3;
  canvas.width = Math.ceil(ctx.measureText(text).width + pad * 2);
  canvas.height = Math.ceil(fontSize * 1.35);
  ctx.font = `bold ${fontSize}px Ubuntu, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = fontSize * 0.14;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#fff';
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture, transparent: true, depthTest: false, depthWrite: false,
  }));
  const height = 0.95;
  sprite.scale.set(height * (canvas.width / canvas.height), height, 1);
  sprite.renderOrder = 991;
  return sprite;
}

// Pure view layer over server snapshots: keeps a mesh per server entity id,
// creating/removing them as snapshots come in, and lerps toward the latest
// authoritative positions each render frame so 30Hz snapshots look smooth.
export class EntitySync {
  constructor(game) {
    this.game = game;
    this.state = null;
    this.mobs = new Map();     // id -> view
    this.players = new Map();  // id -> view (other players; never yourself)
    this.petals = new Map();   // id -> view
    this.drops = new Map();    // id -> view
    this.missiles = new Map();  // id -> view (hornet missiles)
    this.pmissiles = new Map(); // id -> view (player-fired petals)

    this.playerMesh = makeFlower(PLAYER_RADIUS);
    this.playerMesh.position.set(0, PLAYER_RADIUS, 0);
    game.scene.add(this.playerMesh);
    this.playerTarget = new THREE.Vector3(0, PLAYER_RADIUS, 0);
    this.playerFacing = 0;
  }

  apply(state) {
    const first = !this.state;
    this.state = state;

    this.playerTarget.set(state.player.x, PLAYER_RADIUS, state.player.z);
    this.playerFacing = state.player.facing;
    if (first) this.playerMesh.position.copy(this.playerTarget);

    // other players: synced collection just like mobs, keyed by player id
    this.syncCollection(this.players, state.players.filter((p) => p.id !== state.you),
      (p) => this.createPlayer(p), (v) => this.removePlayer(v),
      (v, p) => {
        v.target.set(p.x, PLAYER_RADIUS, p.z);
        v.facing = p.facing;
        v.dead = p.dead;
        v.hp = p.hp;
        v.maxHp = p.maxHp;
        if (p.name !== v.name) this.renamePlayer(v, p.name);
      });

    this.syncCollection(this.mobs, state.mobs, (m) => this.createMob(m), (v) => this.removeMob(v),
      (v, m) => {
        v.target.set(m.x, m.y || 0, m.z);
        v.facing = m.facing;
        v.pitch = m.pitch || 0;
        v.loaded = m.loaded !== false;
        v.hp = m.hp;
        v.maxHp = m.maxHp;
      });

    this.syncCollection(this.missiles, state.missiles || [], (mi) => this.createMissile(mi), (v) => this.removeMissile(v),
      (v, mi) => {
        v.target.set(mi.x, mi.y, mi.z);
        v.mesh.rotation.set(mi.pitch, mi.yaw, 0, 'YXZ');
      });

    this.syncCollection(this.pmissiles, state.pmissiles || [], (p) => this.createPlayerMissile(p), (v) => this.removePetal(v),
      (v, p) => {
        v.target.set(p.x, 1.1, p.z);
      });

    // every player's orbiting petals share one synced collection (ids are
    // globally unique); each item carries its owner's position/death so
    // pop-out and visibility work per owner
    const petalItems = [];
    for (const pl of state.players) {
      for (const inst of pl.petals.instances) {
        petalItems.push({ ...inst, ox: pl.x, oz: pl.z, ownerDead: pl.dead });
      }
    }
    this.syncCollection(this.petals, petalItems, (p) => this.createPetal(p), (v) => this.removePetal(v),
      (v, p) => {
        // respawning petals pop out from their owner's flower instead of gliding back
        if (!v.alive && p.alive) v.mesh.position.set(p.ox, 1.1, p.oz);
        v.alive = p.alive;
        v.ownerDead = p.ownerDead;
        v.target.set(p.x, 0, p.z);
      });

    this.syncCollection(this.drops, state.drops, (d) => this.createDrop(d), (v) => this.removeDrop(v), () => {});

    for (const ev of state.events) this.handleEvent(ev);
  }

  syncCollection(map, list, create, remove, refresh) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let view = map.get(item.id);
      if (!view) {
        view = create(item);
        map.set(item.id, view);
      }
      refresh(view, item);
    }
    for (const [id, view] of map) {
      if (!seen.has(id)) {
        remove(view);
        map.delete(id);
      }
    }
  }

  handleEvent(ev) {
    if (ev.e === 'dmg') {
      this.game.effects.spawnDamageNumber(ev.a, new THREE.Vector3(ev.x, 0, ev.z));
    } else if (ev.e === 'flash') {
      // dispatched by kind + id, never by magic id values. Other players'
      // flashes are dropped until their meshes exist (phase 2).
      if (ev.k === 'player') {
        if (ev.id === this.state.you) flashMaterials(this.playerMesh);
        else {
          const view = this.players.get(ev.id);
          if (view) flashMaterials(view.mesh);
        }
      } else {
        const view = this.mobs.get(ev.id);
        if (view) flashMaterials(view.mesh);
      }
    } else if (ev.e === 'toast') {
      this.game.ui.toast(ev.text);
    }
  }

  // ---- other players ----

  createPlayer(p) {
    const mesh = makeFlower(PLAYER_RADIUS);
    mesh.position.set(p.x, PLAYER_RADIUS, p.z);
    this.game.scene.add(mesh);

    const hpBar = makeHealthBar(2.4, this.game.renderer.capabilities.getMaxAnisotropy());
    this.game.scene.add(hpBar.mesh);

    const view = {
      mesh, hpBar, nameSprite: null, name: undefined,
      target: new THREE.Vector3(p.x, PLAYER_RADIUS, p.z), facing: p.facing,
      dead: p.dead, hp: p.hp, maxHp: p.maxHp, displayHp: p.hp, greenHp: p.hp,
    };
    this.renamePlayer(view, p.name);
    return view;
  }

  renamePlayer(view, name) {
    if (view.nameSprite) {
      this.game.scene.remove(view.nameSprite);
      view.nameSprite.material.map.dispose();
      view.nameSprite.material.dispose();
    }
    view.name = name;
    view.nameSprite = makeNameSprite(name || 'Flower');
    this.game.scene.add(view.nameSprite);
  }

  removePlayer(v) {
    this.game.scene.remove(v.mesh);
    disposeObject3D(v.mesh);
    this.game.scene.remove(v.hpBar.mesh);
    v.hpBar.mesh.geometry.dispose();
    v.hpBar.mesh.material.dispose();
    v.hpBar.texture.dispose();
    this.game.scene.remove(v.nameSprite);
    v.nameSprite.material.map.dispose();
    v.nameSprite.material.dispose();
  }

  // ---- mobs ----

  createMob(m) {
    const def = MOB_TYPES[m.type];
    const scale = RARITIES[m.rarity].scale;
    const radius = def.radius * scale;
    const mesh = makeMobMesh(m.type, def.radius);
    mesh.scale.setScalar(scale);
    mesh.position.set(m.x, m.y || 0, m.z);
    this.game.scene.add(mesh);

    const hpBar = makeHealthBar(
      Math.max(1.4, radius * 1.7),
      this.game.renderer.capabilities.getMaxAnisotropy()
    );
    this.game.scene.add(hpBar.mesh);

    // fliers get a soft ground blob so altitude reads from the top-down cam
    let blob = null;
    if (mesh.userData.wingPivots) {
      blob = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 0.9, 20),
        new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.22, depthWrite: false })
      );
      blob.rotation.x = -Math.PI / 2;
      this.game.scene.add(blob);
    }

    return {
      type: m.type, mesh, hpBar, blob,
      target: new THREE.Vector3(m.x, m.y || 0, m.z), facing: m.facing,
      pitch: m.pitch || 0, loaded: m.loaded !== false, wingAge: Math.random() * 10,
      hp: m.hp, maxHp: m.maxHp, displayHp: m.hp, greenHp: m.hp,
      barOffsetY: radius * 2.1 + 0.35,
    };
  }

  removeMob(v) {
    this.game.scene.remove(v.mesh);
    // rock geometry is per-instance (jittered) and safe to free fully;
    // ladybug/bee part geometries are cached and shared across other live
    // mobs of the same type, so only their materials get disposed here
    if (v.type === 'rock') disposeObject3D(v.mesh);
    else disposeMaterials(v.mesh);
    this.game.scene.remove(v.hpBar.mesh);
    v.hpBar.mesh.geometry.dispose();
    v.hpBar.mesh.material.dispose();
    v.hpBar.texture.dispose();
    if (v.blob) {
      this.game.scene.remove(v.blob);
      v.blob.geometry.dispose();
      v.blob.material.dispose();
    }
  }

  // ---- hornet missiles ----

  createMissile(mi) {
    const scale = RARITIES[mi.rarity]?.scale ?? 1;
    const mesh = makeMissileMesh(0.45 * scale);
    mesh.position.set(mi.x, mi.y, mi.z);
    mesh.rotation.set(mi.pitch, mi.yaw, 0, 'YXZ');
    this.game.scene.add(mesh);
    return { mesh, target: new THREE.Vector3(mi.x, mi.y, mi.z) };
  }

  removeMissile(v) {
    this.game.scene.remove(v.mesh);
    // cone geometry is cached/shared across missiles of the same size
    disposeMaterials(v.mesh);
  }

  // ---- petals ----

  createPetal(p) {
    const size = PETAL_TYPES[p.type].radius * (1 + p.rarity * 0.12);
    const mesh = makePetalMesh(p.type, size);
    mesh.position.set(p.x, 1.1, p.z);
    this.game.scene.add(mesh);
    return { mesh, target: new THREE.Vector3(p.x, 0, p.z), alive: p.alive };
  }

  removePetal(v) {
    this.game.scene.remove(v.mesh);
    disposeObject3D(v.mesh);
  }

  // a fired missile petal in flight: same mesh as the petal, nose along yaw
  createPlayerMissile(p) {
    const size = PETAL_TYPES[p.type].radius * (1 + p.rarity * 0.12);
    const mesh = makePetalMesh(p.type, size * 1.15);
    mesh.position.set(p.x, 1.1, p.z);
    mesh.rotation.y = p.yaw;
    this.game.scene.add(mesh);
    return { mesh, target: new THREE.Vector3(p.x, 1.1, p.z) };
  }

  // ---- drops ----

  createDrop(d) {
    const mesh = makeDropMesh(d.type, d.rarity);
    mesh.position.set(d.x, 0, d.z);
    this.game.scene.add(mesh);
    return { mesh, age: 0 };
  }

  removeDrop(v) {
    this.game.scene.remove(v.mesh);
    disposeObject3D(v.mesh);
  }

  // ---- per-frame visuals ----

  update(dt) {
    const playerDead = this.state?.player.dead ?? false;

    // the camera sits inside the flower in first person
    this.playerMesh.visible = !playerDead && !this.game.fpsMode;
    this.playerMesh.position.lerp(this.playerTarget, damp(14, dt));
    const targetQ = new THREE.Quaternion().setFromAxisAngle(UP, this.playerFacing);
    this.playerMesh.quaternion.slerp(targetQ, damp(8, dt));
    updateFlash(this.playerMesh);

    for (const v of this.players.values()) {
      const visible = !v.dead;
      v.mesh.visible = visible;
      v.hpBar.mesh.visible = visible;
      v.nameSprite.visible = visible;
      v.mesh.position.lerp(v.target, damp(14, dt));
      const q = new THREE.Quaternion().setFromAxisAngle(UP, v.facing);
      v.mesh.quaternion.slerp(q, damp(8, dt));
      updateFlash(v.mesh);

      v.greenHp += (v.hp - v.greenHp) * damp(12, dt);
      v.displayHp += (v.hp - v.displayHp) * damp(3, dt);
      v.hpBar.draw(v.greenHp / v.maxHp, v.displayHp / v.maxHp);
      v.hpBar.mesh.position.set(
        v.mesh.position.x, v.mesh.position.y + 2.15, v.mesh.position.z
      );
      v.hpBar.mesh.quaternion.copy(this.game.camera.quaternion);
      const camDist = v.hpBar.mesh.position.distanceTo(this.game.camera.position);
      v.hpBar.mesh.renderOrder = 998 - Math.min(camDist, 500) * 0.016;
      v.nameSprite.position.set(
        v.mesh.position.x, v.mesh.position.y + 3.05, v.mesh.position.z
      );
    }

    for (const v of this.mobs.values()) {
      v.mesh.position.lerp(v.target, damp(10, dt));
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(v.pitch || 0, v.facing, 0, 'YXZ'));
      v.mesh.quaternion.slerp(q, damp(6, dt));
      updateFlash(v.mesh);

      const wings = v.mesh.userData.wingPivots;
      if (wings) {
        v.wingAge += dt;
        // fast small-amplitude flap reads as a wing blur, not a slow wave
        const flap = 0.35 + Math.sin(v.wingAge * 42) * 0.4;
        for (const pivot of wings) pivot.rotation.z = flap;
        if (v.mesh.userData.missile) v.mesh.userData.missile.visible = v.loaded;
        if (v.blob) {
          const alt = Math.max(0, v.mesh.position.y);
          v.blob.position.set(v.mesh.position.x, 0.04, v.mesh.position.z);
          v.blob.scale.setScalar(Math.max(0.4, 1 - alt * 0.05));
          v.blob.material.opacity = Math.max(0.08, 0.26 - alt * 0.018);
        }
      }

      // green tracks the real hp quickly; the red ghost trails behind slowly,
      // so damage reads as a green dip followed by a red wipe
      v.greenHp += (v.hp - v.greenHp) * damp(12, dt);
      v.displayHp += (v.hp - v.displayHp) * damp(3, dt);
      v.hpBar.draw(v.greenHp / v.maxHp, v.displayHp / v.maxHp);
      v.hpBar.mesh.position.set(
        v.mesh.position.x, v.mesh.position.y + v.barOffsetY, v.mesh.position.z
      );
      v.hpBar.mesh.quaternion.copy(this.game.camera.quaternion);
      // bars skip depth testing, so order them by distance — nearer bars draw
      // later (on top) but always below damage numbers at renderOrder 999
      const camDist = v.hpBar.mesh.position.distanceTo(this.game.camera.position);
      v.hpBar.mesh.renderOrder = 998 - Math.min(camDist, 500) * 0.016;
    }

    for (const v of this.petals.values()) {
      v.mesh.visible = v.alive && !v.ownerDead;
      if (!v.mesh.visible) continue;
      v.mesh.position.lerp(new THREE.Vector3(v.target.x, 1.1, v.target.z), damp(12, dt));
      v.mesh.rotation.y += dt * 1.5;
    }

    for (const v of this.missiles.values()) {
      v.mesh.position.lerp(v.target, damp(16, dt));
    }

    for (const v of this.pmissiles.values()) {
      v.mesh.position.lerp(v.target, damp(16, dt));
    }

    for (const v of this.drops.values()) {
      v.age += dt;
      const petal = v.mesh.userData.petal;
      petal.rotation.y += dt * 1.8;
      petal.position.y = 1.1 + Math.sin(v.age * 3) * 0.18;
    }
  }

  playerPos() { return this.playerMesh.position; }
}
