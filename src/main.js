import * as THREE from 'three';
import { createWorld } from './world.js';
import { Input } from './input.js';
import { Player } from './player.js';
import { PetalManager } from './petals.js';
import { MobManager } from './mobs.js';
import { DropManager } from './drops.js';
import { UI } from './ui.js';
import { Effects } from './effects.js';
import { updateCombat } from './combat.js';

const container = document.getElementById('app');
const { scene, camera, renderer, updateCamera } = createWorld(container);

const game = { scene, camera, renderer, time: 0 };
window.game = game; // exposed for debugging/beta testing
game.input = new Input(renderer.domElement, camera);
game.ui = new UI(game);
game.effects = new Effects(game);
game.player = new Player(game);
game.petals = new PetalManager(game, game.player);

// wait for Ubuntu to be ready so mob nameplates don't flash a fallback font
Promise.all([
  document.fonts.load('bold 52px Ubuntu'),
  document.fonts.load('bold 40px Ubuntu'),
]).catch(() => {}).then(() => {
  game.mobs = new MobManager(game);
  game.drops = new DropManager(game);

  game.ui.renderLoadout();
  game.ui.renderInventory();

  // hotkeys
  game.fpsMode = false;
  game.input.on('f', () => {
    game.fpsMode = !game.fpsMode;
    if (game.fpsMode) {
      // start looking the way the flower is facing
      game.input.look.yaw = game.player.facing + Math.PI;
      game.input.look.pitch = 0;
      game.input.lockPointer();
      game.ui.toast('First person — WASD to move, F to exit');
    } else {
      game.input.unlockPointer();
      game.ui.toast('Top-down view');
    }
  });
  game.input.on('r', () => game.petals.swapRows());
  game.input.on('q', () => game.petals.changeRotSpeed(-0.175));
  game.input.on('e', () => game.petals.changeRotSpeed(+0.175));
  for (let i = 1; i <= 5; i++) {
    game.input.on(String(i), () => game.petals.swapSlot(i - 1));
  }

  const clock = new THREE.Clock();
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    game.time += dt;

    game.player.update(dt);
    game.petals.update(dt);
    game.mobs.update(dt);
    game.drops.update(dt);
    updateCombat(game, dt);
    game.effects.update(dt);
    game.ui.update();

    updateCamera(dt, game.player.mesh.position, game.fpsMode ? game.input.look : null);
    renderer.render(scene, camera);
  }
  loop();
});
