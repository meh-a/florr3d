import { uid } from './utils.js';

const LIFETIME = 30;

export class DropManager {
  constructor(game) {
    this.game = game;
    this.drops = [];
  }

  spawn(type, rarity, pos) {
    this.drops.push({ id: uid(), type, rarity, pos: pos.clone(), age: 0 });
  }

  update(dt) {
    const player = this.game.player;
    for (const drop of this.drops) {
      drop.age += dt;
      if (drop.age > LIFETIME) { drop.gone = true; }
      else if (!player.dead && drop.pos.distanceTo(player.pos) < player.radius + 1.4) {
        this.game.addToInventory(drop.type, drop.rarity);
        drop.gone = true;
      }
    }
    this.drops = this.drops.filter((d) => !d.gone);
  }
}
