import { chromium } from 'playwright';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console.error: ' + msg.text()); });

await page.goto('http://localhost:8899/map-builder.html');
await page.waitForSelector('#viewport canvas');
await page.waitForTimeout(500); // let three.js boot + first render settle

// confirm layer control visible in Floor mode (default mode)
const layerVisibleFloor = await page.isVisible('#layerGroup');

// raise layer to 2
await page.click('#layerUp');
await page.click('#layerUp');
const layerLabel = await page.textContent('#layerLabel');

// paint a drag-run of grass at layer 2
const canvas = await page.$('#viewport canvas');
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
await page.mouse.move(cx - 60, cy);
await page.mouse.down();
await page.mouse.move(cx - 20, cy, { steps: 5 });
await page.mouse.move(cx + 20, cy, { steps: 5 });
await page.mouse.up();
await page.screenshot({ path: '/tmp/claude-1000/-home-meh-fl/d98535b7-38fe-4a28-932a-32347e860188/scratchpad/01-raised-floor.png' });

// switch to wall mode, confirm layer group still visible
await page.click('.modebtn[data-mode="wall"]');
const layerVisibleWall = await page.isVisible('#layerGroup');
await page.click('.modebtn[data-mode="floor"]');

// select a slope tool and place it
const slopeBtnText = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#toolGroup .toolbtn')];
  const btn = btns.find(b => b.textContent.includes('Slope (+Z)'));
  if (!btn) return null;
  btn.click();
  return btn.textContent;
});
await page.mouse.click(cx + 60, cy);
await page.waitForTimeout(200);
await page.screenshot({ path: '/tmp/claude-1000/-home-meh-fl/d98535b7-38fe-4a28-932a-32347e860188/scratchpad/02-slope-placed.png' });

// orbit camera a bit for a clearer angled view, then screenshot again
await page.mouse.move(cx, cy);
await page.mouse.down({ button: 'right' });
await page.mouse.move(cx + 150, cy - 100, { steps: 10 });
await page.mouse.up({ button: 'right' });
await page.waitForTimeout(200);
await page.screenshot({ path: '/tmp/claude-1000/-home-meh-fl/d98535b7-38fe-4a28-932a-32347e860188/scratchpad/03-orbited.png' });

console.log(JSON.stringify({
  layerVisibleFloor, layerVisibleWall, layerLabel, slopeBtnText, errors,
}, null, 2));

await browser.close();
