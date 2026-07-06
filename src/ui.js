import { PETAL_TYPES, RARITIES } from './config.js';
import basicIcon from '../basic.svg';
import rockIcon from '../rock.svg';
import roseIcon from '../rose.svg';
import lightIcon from '../light.svg';
import stingerIcon from '../stinger.svg';

// petal types without an entry here fall back to the plain color-dot rendering
const PETAL_ICONS = {
  basic: basicIcon,
  rockPetal: rockIcon,
  rose: roseIcon,
  light: lightIcon,
  stinger: stingerIcon,
};

export class UI {
  constructor(game) {
    this.game = game;
    this.inventory = new Map(); // "type:rarity" -> count
    this.selected = null;       // key selected in inventory, pending equip

    this.el = {
      hp: document.getElementById('hpfill'),
      xp: document.getElementById('xpfill'),
      lvl: document.getElementById('lvltext'),
      rowPrimary: document.getElementById('rowPrimary'),
      rowSecondary: document.getElementById('rowSecondary'),
      inventory: document.getElementById('inventory'),
      death: document.getElementById('death'),
      deathTimer: document.getElementById('deathtimer'),
      toasts: document.getElementById('toasts'),
    };
  }

  // ---- inventory ----

  addToInventory(type, rarity) {
    const key = `${type}:${rarity}`;
    this.inventory.set(key, (this.inventory.get(key) || 0) + 1);
    this.toast(`+ ${RARITIES[rarity].name} ${PETAL_TYPES[type].name}`);
    this.renderInventory();
  }

  takeFromInventory(key) {
    const n = this.inventory.get(key) || 0;
    if (n <= 0) return null;
    if (n === 1) this.inventory.delete(key); else this.inventory.set(key, n - 1);
    const [type, rarity] = key.split(':');
    return { type, rarity: Number(rarity) };
  }

  renderInventory() {
    this.el.inventory.innerHTML = '';
    const keys = [...this.inventory.keys()].sort();
    for (const key of keys) {
      const [type, rarityStr] = key.split(':');
      const rarity = Number(rarityStr);
      const def = PETAL_TYPES[type];
      const icon = PETAL_ICONS[type];
      const tile = document.createElement('div');
      tile.className = 'invtile' + (this.selected === key ? ' selected' : '');
      tile.style.background = RARITIES[rarity].color;
      tile.innerHTML =
        (icon
          ? `<img class="picon" src="${icon}" alt="${def.name}" />`
          : `<div class="dot" style="background:${def.color}"></div><div class="pname">${def.name}</div>`) +
        `<div class="count">${this.inventory.get(key)}</div>`;
      tile.onclick = () => {
        this.selected = this.selected === key ? null : key;
        this.renderInventory();
      };
      this.el.inventory.appendChild(tile);
    }
  }

  // ---- loadout ----

  renderLoadout() {
    const petals = this.game.petals;
    this.renderRow(this.el.rowPrimary, petals.primary, 'primary');
    this.renderRow(this.el.rowSecondary, petals.secondary, 'secondary');
  }

  renderRow(rowEl, slots, rowName) {
    rowEl.innerHTML = '';
    slots.forEach((item, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot' + (item ? '' : ' empty');
      if (item) {
        const def = PETAL_TYPES[item.type];
        const icon = PETAL_ICONS[item.type];
        slot.style.background = RARITIES[item.rarity].color;
        slot.style.borderColor = 'rgba(0,0,0,0.4)';
        slot.innerHTML = icon
          ? `<img class="picon" src="${icon}" alt="${def.name}" />`
          : `<div class="dot" style="background:${def.color}"></div><div class="pname">${def.name}</div>`;
      }
      // empty slots stay fully blank, matching florr's loadout bar
      if (rowName === 'primary' && item) {
        const hk = document.createElement('div');
        hk.className = 'hotkey';
        hk.textContent = i + 1;
        slot.appendChild(hk);
      }
      slot.onclick = () => this.onSlotClick(rowName, i);
      rowEl.appendChild(slot);
    });
  }

  onSlotClick(rowName, i) {
    const petals = this.game.petals;
    if (this.selected) {
      // equip pending inventory petal; previous returns to inventory
      const item = this.takeFromInventory(this.selected);
      this.selected = null;
      if (item) {
        const old = petals.equip(rowName, i, item);
        if (old) {
          const key = `${old.type}:${old.rarity}`;
          this.inventory.set(key, (this.inventory.get(key) || 0) + 1);
        }
      }
      this.renderInventory();
    } else {
      // florr behavior: clicking a petal swaps it with its counterpart row
      petals.swapSlot(i);
    }
  }

  // ---- misc ----

  toast(text) {
    const div = document.createElement('div');
    div.className = 'toast stroke';
    div.textContent = text;
    this.el.toasts.appendChild(div);
    setTimeout(() => div.remove(), 2500);
  }

  showDeath(show) { this.el.death.classList.toggle('show', show); }
  setDeathTimer(t) {
    this.el.deathTimer.textContent = `Respawning in ${Math.max(0, t).toFixed(1)}s`;
  }

  update() {
    const p = this.game.player;
    this.el.hp.style.width = `${(p.hp / p.maxHp) * 100}%`;
    this.el.xp.style.width = `${(p.xp / p.xpForNext()) * 100}%`;
    this.el.lvl.textContent = `Lvl ${p.level}`;

    // dim primary slots whose petals are on cooldown
    const slots = this.el.rowPrimary.children;
    for (let i = 0; i < slots.length; i++) {
      slots[i].classList.toggle('cooling', this.game.petals.slotAliveFrac(i) === 0);
    }
  }
}
