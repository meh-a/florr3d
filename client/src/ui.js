import { PETAL_TYPES, RARITIES } from '../../shared/config.js';
import basicIcon from '../assets/basic.svg';
import rockIcon from '../assets/rock.svg';
import roseIcon from '../assets/rose.svg';
import lightIcon from '../assets/light.svg';
import stingerIcon from '../assets/stinger.svg';
import orangeIcon from '../assets/orange.svg';
import missileIcon from '../assets/missile.svg';

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
  orange: orangeIcon,
  missile: missileIcon,
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
      tooltip: document.getElementById('tooltip'),
    };
    this.tt = {
      name: this.el.tooltip.querySelector('.tt-name'),
      reload: this.el.tooltip.querySelector('.tt-reload'),
      rarity: this.el.tooltip.querySelector('.tt-rarity'),
      desc: this.el.tooltip.querySelector('.tt-desc'),
      health: this.el.tooltip.querySelector('.tt-health'),
      damage: this.el.tooltip.querySelector('.tt-damage'),
      heal: this.el.tooltip.querySelector('.tt-heal'),
    };
  }

  applyState(state) {
    this.state = state;

    const loadoutKey = JSON.stringify([state.petals.primary, state.petals.secondary]);
    if (loadoutKey !== this.loadoutKey) {
      this.loadoutKey = loadoutKey;
      this.renderLoadout();
      this.hideTooltip(); // the hovered element's slot may just have been rebuilt
    }
    const inventoryKey = JSON.stringify(state.inventory);
    if (inventoryKey !== this.inventoryKey) {
      this.inventoryKey = inventoryKey;
      this.renderInventory();
      this.hideTooltip();
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
      tile.draggable = true;
      tile.ondragstart = (e) => {
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.effectAllowed = 'move';
        tile.classList.add('dragging');
      };
      tile.ondragend = () => tile.classList.remove('dragging');
      tile.onmouseenter = () => this.showTooltip(tile, type, rarity);
      tile.onmouseleave = () => this.hideTooltip();
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
        slot.onmouseenter = () => this.showTooltip(slot, item.type, item.rarity);
        slot.onmouseleave = () => this.hideTooltip();
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
      slot.ondragover = (e) => {
        e.preventDefault(); // required for the element to accept a drop
        slot.classList.add('dragover');
      };
      slot.ondragleave = () => slot.classList.remove('dragover');
      slot.ondrop = (e) => {
        e.preventDefault();
        slot.classList.remove('dragover');
        const key = e.dataTransfer.getData('text/plain');
        if (key) this.equipInto(rowName, i, key);
      };
      rowEl.appendChild(slot);
    });
  }

  onSlotClick(rowName, i) {
    if (this.selected) this.equipInto(rowName, i, this.selected);
    // florr behavior: clicking a petal with nothing selected swaps it with
    // its counterpart row
    else this.game.net.send({ t: 'swapSlot', i });
  }

  // ask the server to equip an inventory petal (by key) into row/slot —
  // shared by both click-to-select and drag-and-drop
  equipInto(rowName, i, key) {
    this.game.net.send({ t: 'equip', row: rowName, i, key });
    this.selected = null;
    this.renderInventory();
  }

  // ---- tooltip ----

  showTooltip(target, type, rarityIdx) {
    const def = PETAL_TYPES[type];
    const rarity = RARITIES[rarityIdx];
    this.tt.name.textContent = def.name;
    this.tt.reload.textContent = `${def.reload}s ⟳`;
    this.tt.rarity.textContent = rarity.name;
    this.tt.rarity.style.color = rarity.color;
    this.tt.desc.textContent = def.desc || '';
    this.tt.health.textContent = `Health: ${Math.round(def.hp * (def.flatHp ? 1 : rarity.petalMult) * 10) / 10}`;
    this.tt.damage.textContent = `Damage: ${Math.round(def.dmg * rarity.petalMult * 10) / 10}`;
    if (def.heal) {
      this.tt.heal.textContent = `Heal: ${Math.round(def.heal * rarity.petalMult * 10) / 10}`;
      this.tt.heal.style.display = '';
    } else {
      this.tt.heal.style.display = 'none';
    }

    const rect = target.getBoundingClientRect();
    this.el.tooltip.style.left = `${rect.left + rect.width / 2}px`;
    this.el.tooltip.style.top = `${rect.top - 10}px`;
    this.el.tooltip.classList.add('show');
  }

  hideTooltip() {
    this.el.tooltip.classList.remove('show');
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
