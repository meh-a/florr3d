import { PETAL_TYPES, RARITIES } from '../shared/config.js';
import { Player } from './player.js';
import { PetalManager } from './petals.js';
import { MobManager } from './mobs.js';
import { DropManager } from './drops.js';
import { updateCombat } from './combat.js';

const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const SLOTS = 5;

// One authoritative game session (this is a singleplayer game, so each
// websocket connection gets its own world). The client only ever sends
// intents — movement input and loadout requests — and everything with
// gameplay consequences (damage, xp, drops, inventory) is decided here.
export class Game {
  constructor() {
    this.time = 0;
    this.events = []; // one-shot events for the client, flushed per snapshot
    this.input = { tx: 0, tz: 0, ax: 0, az: 0, fps: false, yaw: 0, atk: false, def: false };
    this.inventory = new Map(); // "type:rarity" -> count
    this.player = new Player(this);
    this.petals = new PetalManager(this);
    this.mobs = new MobManager(this);
    this.drops = new DropManager(this);
  }

  toast(text) { this.events.push({ e: 'toast', text }); }

  addToInventory(type, rarity, silent = false) {
    const key = `${type}:${rarity}`;
    this.inventory.set(key, (this.inventory.get(key) || 0) + 1);
    if (!silent) this.toast(`+ ${RARITIES[rarity].name} ${PETAL_TYPES[type].name}`);
  }

  takeFromInventory(key) {
    const n = this.inventory.get(key) || 0;
    if (n <= 0) return null;
    if (n === 1) this.inventory.delete(key); else this.inventory.set(key, n - 1);
    const [type, rarity] = key.split(':');
    return { type, rarity: Number(rarity) };
  }

  handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'input': {
        const i = this.input;
        i.tx = num(msg.tx);
        i.tz = num(msg.tz);
        i.ax = Math.max(-1, Math.min(1, num(msg.ax)));
        i.az = Math.max(-1, Math.min(1, num(msg.az)));
        i.fps = !!msg.fps;
        i.yaw = num(msg.yaw);
        i.atk = !!msg.atk;
        i.def = !!msg.def;
        break;
      }
      case 'swapSlot': {
        const i = msg.i;
        if (Number.isInteger(i) && i >= 0 && i < SLOTS) this.petals.swapSlot(i);
        break;
      }
      case 'swapRows':
        this.petals.swapRows();
        break;
      case 'rotSpeed':
        this.petals.changeRotSpeed(Math.max(-1, Math.min(1, num(msg.delta))));
        break;
      case 'equip': {
        const { row, i, key } = msg;
        if ((row !== 'primary' && row !== 'secondary') || !Number.isInteger(i) || i < 0 || i >= SLOTS) return;
        if (typeof key !== 'string') return;
        const item = this.takeFromInventory(key);
        if (!item || !PETAL_TYPES[item.type] || !RARITIES[item.rarity]) return;
        const old = this.petals.equip(row, i, item);
        if (old) this.addToInventory(old.type, old.rarity, true);
        break;
      }
    }
  }

  tick(dt) {
    this.time += dt;
    this.player.update(dt);
    this.petals.update(dt);
    this.mobs.update(dt);
    this.drops.update(dt);
    updateCombat(this, dt);
  }

  snapshot() {
    const p = this.player;
    const state = {
      t: 'state',
      time: r2(this.time),
      player: {
        x: r2(p.pos.x), z: r2(p.pos.z), facing: r2(p.facing),
        hp: r2(p.hp), maxHp: p.maxHp,
        level: p.level, xp: Math.floor(p.xp), xpNext: p.xpForNext(),
        dead: p.dead, deadTimer: r2(p.deadTimer),
      },
      petals: {
        rotFactor: this.petals.rotFactor,
        primary: this.petals.primary,
        secondary: this.petals.secondary,
        instances: this.petals.instances.map((inst) => ({
          id: inst.id, slot: inst.slotIdx, type: inst.type, rarity: inst.rarity,
          alive: inst.alive, x: r2(inst.pos.x), z: r2(inst.pos.z),
          // reload fraction remaining (0 = ready), drives the UI pie sweep
          cd: inst.alive ? 0 : r2(Math.min(1, Math.max(0, inst.cooldown / inst.reload))),
        })),
      },
      mobs: this.mobs.mobs.map((m) => ({
        id: m.id, type: m.type, rarity: m.rarity,
        x: r2(m.pos.x), z: r2(m.pos.z), facing: r2(m.facing),
        hp: r2(m.hp), maxHp: r2(m.maxHp),
      })),
      drops: this.drops.drops.map((d) => ({
        id: d.id, type: d.type, rarity: d.rarity, x: r2(d.pos.x), z: r2(d.pos.z),
      })),
      inventory: [...this.inventory.entries()],
      events: this.events,
    };
    this.events = [];
    return state;
  }
}
