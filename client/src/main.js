import * as THREE from 'three';
import { createWorld } from './world.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Effects } from './effects.js';
import { EntitySync } from './entities.js';
import { Arrows } from './arrows.js';
import { Net } from './net.js';
import { preloadMobModels } from './mobmodels.js';
import { MOB_TYPES } from '../../shared/config.js';
import { initQualityToggle } from './settings.js';

const INPUT_RATE = 1 / 30; // seconds between input packets, matches server tick

const container = document.getElementById('app');
const { scene, camera, renderer, updateCamera } = createWorld(container);

const game = { scene, camera, renderer, fpsMode: false };
window.game = game; // exposed for debugging/beta testing
game.input = new Input(renderer.domElement, camera);
game.ui = new UI(game);
game.effects = new Effects(game);
initQualityToggle();
// fetch mob models while the visitor is still on the name gate — cached
// immutably, so this is a no-op network-wise after the first visit
preloadMobModels([...Object.keys(MOB_TYPES), 'hornetmissile']);

// wait for Ubuntu to be ready so damage numbers don't flash a fallback font
Promise.all([
  document.fonts.load('bold 52px Ubuntu'),
  document.fonts.load('bold 40px Ubuntu'),
]).catch(() => {}).then(() => {
  game.entities = new EntitySync(game);
  game.arrows = new Arrows(game);
  // the private slice (inventory/xp) only rides along in snapshots where
  // it changed; cache the last received values and fill them back in so
  // the UI always sees a complete state
  const priv = { inventory: [], xp: 0, xpNext: 60 };
  game.net = new Net({
    onState: (state) => {
      // the shared world sends all players; pick out our own entry and
      // present it as `player`/`petals` for the view/UI layers (xp is
      // private and arrives top-level, only for us)
      const me = state.players.find((p) => p.id === state.you);
      if (!me) {
        // not joined yet — spectator snapshot from the name gate: render
        // the live world (camera follows state.spec), no own flower, no HUD
        game.entities.apply(state);
        return;
      }
      if (state.inventory) priv.inventory = state.inventory;
      else state.inventory = priv.inventory;
      if (typeof state.xp === 'number') { priv.xp = state.xp; priv.xpNext = state.xpNext; }
      state.player = { ...me, xp: priv.xp, xpNext: priv.xpNext };
      state.petals = me.petals;
      game.entities.apply(state);
      game.arrows.setTargets(state.others);
      game.ui.applyState(state);
    },
    onStatus: (mode) => {
      // a (re)connect is a brand-new server-side player, so the name has
      // to be (re)introduced every time the transport comes up
      if ((mode === 'online' || mode === 'local') && chosenName) {
        game.net.send({ t: 'join', name: chosenName });
      }
      game.ui.toast({
        online: 'Connected',
        offline: 'Connection lost — retrying…',
        local: 'No server found — running locally',
        updating: 'Updating…',
      }[mode]);
    },
  });

  // name gate: pick a display name once, remember it for next visit
  const gate = document.getElementById('namegate');
  const nameInput = document.getElementById('nameinput');
  let chosenName = null;
  nameInput.value = localStorage.getItem('playerName') || '';
  nameInput.focus();
  const submitName = () => {
    chosenName = nameInput.value.trim().slice(0, 16) || 'Flower';
    localStorage.setItem('playerName', chosenName);
    game.net.send({ t: 'join', name: chosenName });
    gate.classList.add('hidden');
    nameInput.blur();
  };
  document.getElementById('playbtn').addEventListener('click', submitName);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitName(); });

  // account state on the gate: logged in -> progress persists; the button
  // only appears once /auth/me confirms a server with auth routes exists
  // (the worker fallback has neither accounts nor persistence)
  const loginBtn = document.getElementById('loginbtn');
  const authState = document.getElementById('authstate');
  fetch('/auth/me').then((r) => (r.ok ? r.json() : null)).then((me) => {
    if (!me) return;
    if (!me.loggedIn) {
      loginBtn.classList.remove('hidden');
      // guests lose everything on a server restart — say so where the
      // decision is made, right next to the login button
      document.getElementById('loginnudge').classList.remove('hidden');
      return;
    }
    authState.textContent = `Signed in as ${me.username}`;
    const logout = document.createElement('a');
    logout.id = 'logoutbtn';
    logout.href = '/auth/logout';
    logout.textContent = 'log out';
    authState.append(logout);
    if (!nameInput.value) nameInput.value = me.username.slice(0, 16);
  }).catch(() => {});

  // hotkeys — the view toggle is local, everything else is a server intent
  game.input.on('f', () => {
    game.fpsMode = !game.fpsMode;
    if (game.fpsMode) {
      // start looking the way the flower is facing
      const facing = game.entities.state?.player?.facing ?? 0;
      game.input.look.yaw = facing + Math.PI;
      game.input.look.pitch = 0;
      game.input.lockPointer();
      game.ui.toast('First person — WASD to move, F to exit');
    } else {
      game.input.unlockPointer();
      game.ui.toast('Top-down view');
    }
  });
  game.input.on('v', () => {
    game.ui.toast(game.arrows.toggle() ? 'Player arrows on' : 'Player arrows off');
  });
  game.input.on('r', () => game.net.send({ t: 'swapRows' }));
  game.input.on('q', () => game.net.send({ t: 'rotSpeed', delta: -0.175 }));
  game.input.on('e', () => game.net.send({ t: 'rotSpeed', delta: +0.175 }));
  for (let i = 1; i <= 5; i++) {
    game.input.on(String(i), () => game.net.send({ t: 'swapSlot', i: i - 1 }));
  }

  let inputAccum = 0;
  function sendInput(dt) {
    if (!chosenName) return; // still on the name gate — nothing to control
    inputAccum += dt;
    if (inputAccum < INPUT_RATE) return;
    inputAccum = 0;
    const target = game.input.cursorWorld();
    const axes = game.input.moveAxes();
    game.net.send({
      t: 'input',
      tx: Math.round(target.x * 100) / 100,
      tz: Math.round(target.z * 100) / 100,
      ax: axes.x, az: axes.z,
      fps: game.fpsMode,
      yaw: game.input.look.yaw,
      atk: game.input.attackHeld(), // left mouse or space
      def: game.input.defendHeld(), // right mouse or shift
    });
  }

  const clock = new THREE.Clock();
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);

    sendInput(dt);
    game.entities.update(dt);
    game.effects.update(dt);

    updateCamera(dt, game.entities.playerPos(), game.fpsMode ? game.input.look : null);
    game.arrows.update(); // after the camera move so arrows don't lag a frame
    renderer.render(scene, camera);
  }
  loop();
});
