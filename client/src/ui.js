import { PETAL_TYPES, RARITIES } from '../../shared/config.js';
import basicIcon from '../assets/basic.svg';
import rockIcon from '../assets/rock.svg';
import roseIcon from '../assets/rose.svg';
import lightIcon from '../assets/light.svg';
import stingerIcon from '../assets/stinger.svg';

// darker shade of a rarity color for slot/tile borders, like florr
function shade(hex, f = 0.72) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 0xff) * f);
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}

// petal types without an entry here fall back to the plain color-dot rendering
const PETAL_ICONS = {
  basic: basicIcon,
  rockPetal: rockIcon,
  rose: roseIcon,
  light: lightIcon,
  stinger: stingerIcon,
};

// HUD driven entirely by server snapshots. Inventory and loadout live on the
// server; clicks only send intents and the next snapshot re-renders the truth.
export class UI {
  constructor(game) {
    this.game = game;
    this.state = null;
    this.selected = null; // inventory key pending equip (pure client-side UI state)
    this.loadoutKey = ''; // serialized loadout/inventory, to re-render only on change
    this.inventoryKey = '';

    this.el = {
      hp: document.getElementById('hpfill'),
      hpGhost: document.getElementById('hpghost'),
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

  applyState(state) {
    this.state = state;

    const loadoutKey = JSON.stringify([state.petals.primary, state.petals.secondary]);
    if (loadoutKey !== this.loadoutKey) {
      this.loadoutKey = loadoutKey;
      this.renderLoadout();
    }
    const inventoryKey = JSON.stringify(state.inventory);
    if (inventoryKey !== this.inventoryKey) {
      this.inventoryKey = inventoryKey;
      this.renderInventory();
    }

    const p = state.player;
    const hpFrac = `${(p.hp / p.maxHp) * 100}%`;
    this.el.hp.style.width = hpFrac;
    // the ghost shares the target width but its CSS transition lags behind,
    // leaving a red trail on damage just like the mob bars
    this.el.hpGhost.style.width = hpFrac;
    this.el.xp.style.width = `${(p.xp / p.xpNext) * 100}%`;
    this.el.lvl.textContent = `Lvl ${p.level}`;

    this.el.death.classList.toggle('show', p.dead);
    if (p.dead) {
      this.el.deathTimer.textContent = `Respawning in ${Math.max(0, p.deadTimer).toFixed(1)}s`;
    }

    // reload pies: sweep each primary slot by its deepest-cooldown petal
    const slots = this.el.rowPrimary.children;
    for (let i = 0; i < slots.length; i++) {
      const pie = slots[i].querySelector('.cdpie');
      if (!pie) continue;
      let cd = 0;
      for (const inst of state.petals.instances) {
        if (inst.slot === i && inst.cd > cd) cd = inst.cd;
      }
      pie.style.background = cd > 0
        ? `conic-gradient(rgba(0,0,0,0.5) ${cd * 360}deg, rgba(0,0,0,0) 0deg)`
        : '';
    }
  }

  // ---- inventory ----

  renderInventory() {
    this.el.inventory.innerHTML = '';
    if (!this.state) return;
    const entries = [...this.state.inventory].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [key, count] of entries) {
      const [type, rarityStr] = key.split(':');
      const rarity = Number(rarityStr);
      const def = PETAL_TYPES[type];
      const icon = PETAL_ICONS[type];
      const tile = document.createElement('div');
      tile.className = 'invtile' + (this.selected === key ? ' selected' : '');
      tile.style.background = RARITIES[rarity].color;
      tile.style.borderColor = shade(RARITIES[rarity].color);
      tile.innerHTML =
        (icon
          ? `<img class="picon" src="${icon}" alt="${def.name}" />`
          : `<div class="dot" style="background:${def.color}"></div><div class="pname">${def.name}</div>`) +
        `<div class="count">${count}</div>`;
      tile.onclick = () => {
        this.selected = this.selected === key ? null : key;
        this.renderInventory();
      };
      this.el.inventory.appendChild(tile);
    }
  }

  // ---- loadout ----

  renderLoadout() {
    this.renderRow(this.el.rowPrimary, this.state.petals.primary, 'primary');
    this.renderRow(this.el.rowSecondary, this.state.petals.secondary, 'secondary');
  }

  renderRow(rowEl, slots, rowName) {
    rowEl.innerHTML = '';
    slots.forEach((item, i) => {
      const slot = document.createElement('div');
      slot.className = 'slot' + (item ? '' : ' empty');
      if (item) {
        const def = PETAL_TYPES[item.type];
        const icon = PETAL_ICONS[item.type];
        const rarity = RARITIES[item.rarity];
        slot.style.background = rarity.color;
        slot.style.borderColor = shade(rarity.color);
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
        const pie = document.createElement('div');
        pie.className = 'cdpie';
        slot.appendChild(pie);
      }
      slot.onclick = () => this.onSlotClick(rowName, i);
      rowEl.appendChild(slot);
    });
  }

  onSlotClick(rowName, i) {
    if (this.selected) {
      // ask the server to equip the pending inventory petal into this slot
      this.game.net.send({ t: 'equip', row: rowName, i, key: this.selected });
      this.selected = null;
      this.renderInventory();
    } else {
      // florr behavior: clicking a petal swaps it with its counterpart row
      this.game.net.send({ t: 'swapSlot', i });
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
}
