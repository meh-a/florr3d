import { uid } from './utils.js';

const LIFETIME = 30;

export class DropManager {
  constructor(world) {
    this.world = world;
    this.drops = [];
  }

  spawn(type, rarity, pos) {
    this.drops.push({ id: uid(), type, rarity, pos: pos.clone(), age: 0 });
  }

  update(dt) {
    for (const drop of this.drops) {
      drop.age += dt;
      if (drop.age > LIFETIME) { drop.gone = true; continue; }
      // first player to touch it gets it
      for (const player of this.world.players.values()) {
        if (!player.dead && drop.pos.distanceTo(player.pos) < player.radius + 1.4) {
          player.addToInventory(drop.type, drop.rarity);
          drop.gone = true;
          break;
        }
      }
    }
    this.drops = this.drops.filter((d) => !d.gone);
  }
}
