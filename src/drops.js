import { makeDropMesh } from './models.js';
import { uid } from './utils.js';

const LIFETIME = 30;

export class DropManager {
  constructor(game) {
    this.game = game;
    this.drops = [];
  }

  spawn(type, rarity, pos) {
    const mesh = makeDropMesh(type, rarity);
    mesh.position.set(pos.x, 0, pos.z);
    this.game.scene.add(mesh);
    this.drops.push({ id: uid(), type, rarity, pos: pos.clone(), mesh, age: 0 });
  }

  update(dt) {
    const player = this.game.player;
    for (const drop of this.drops) {
      drop.age += dt;
      const petal = drop.mesh.userData.petal;
      petal.rotation.y += dt * 1.8;
      petal.position.y = 1.1 + Math.sin(drop.age * 3) * 0.18;

      if (drop.age > LIFETIME) { drop.gone = true; }
      else if (!player.dead && drop.pos.distanceTo(player.pos) < player.radius + 1.4) {
        this.game.ui.addToInventory(drop.type, drop.rarity);
        drop.gone = true;
      }
      if (drop.gone) this.game.scene.remove(drop.mesh);
    }
    this.drops = this.drops.filter((d) => !d.gone);
  }
}
