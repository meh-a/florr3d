import * as THREE from 'three';
import { createWorld } from './world.js';
import { Input } from './input.js';
import { UI } from './ui.js';
import { Effects } from './effects.js';
import { EntitySync } from './entities.js';
import { Net } from './net.js';
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

// wait for Ubuntu to be ready so damage numbers don't flash a fallback font
Promise.all([
  document.fonts.load('bold 52px Ubuntu'),
  document.fonts.load('bold 40px Ubuntu'),
]).catch(() => {}).then(() => {
  game.entities = new EntitySync(game);
  game.net = new Net({
    onState: (state) => {
      game.entities.apply(state);
      game.ui.applyState(state);
    },
    onStatus: (mode) => game.ui.toast({
      online: 'Connected',
      offline: 'Connection lost — retrying…',
      local: 'No server found — running locally',
    }[mode]),
  });

  // hotkeys — the view toggle is local, everything else is a server intent
  game.input.on('f', () => {
    game.fpsMode = !game.fpsMode;
    if (game.fpsMode) {
      // start looking the way the flower is facing
      const facing = game.entities.state?.player.facing ?? 0;
      game.input.look.yaw = facing + Math.PI;
      game.input.look.pitch = 0;
      game.input.lockPointer();
      game.ui.toast('First person — WASD to move, F to exit');
    } else {
      game.input.unlockPointer();
      game.ui.toast('Top-down view');
    }
  });
  game.input.on('r', () => game.net.send({ t: 'swapRows' }));
  game.input.on('q', () => game.net.send({ t: 'rotSpeed', delta: -0.175 }));
  game.input.on('e', () => game.net.send({ t: 'rotSpeed', delta: +0.175 }));
  for (let i = 1; i <= 5; i++) {
    game.input.on(String(i), () => game.net.send({ t: 'swapSlot', i: i - 1 }));
  }

  let inputAccum = 0;
  function sendInput(dt) {
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
      atk: game.input.attack,
      def: game.input.defend,
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
    renderer.render(scene, camera);
  }
  loop();
});
