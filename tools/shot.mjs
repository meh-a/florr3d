// Screenshot the local dev game as a spectator (name gate stays up; the
// camera follows a random joined player — run waterbot.mjs first).
// Usage: node tools/shot.mjs <out.png> [waitMs]
import { chromium } from 'playwright';

const out = process.argv[2] || '/tmp/shot.png';
const waitMs = Number(process.argv[3] || 8000);

const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 750 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[console]', m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(waitMs);
await page.screenshot({ path: out });
await browser.close();
console.log('saved', out);
