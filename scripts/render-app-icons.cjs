/**
 * Renders the PWA PNG icons from an inline SVG using the system Playwright/Chromium.
 * Optional dev tool; outputs are committed. Run: node scripts/render-app-icons.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const svg = (size, pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#34d399"/><stop offset="1" stop-color="#14b8a6"/></linearGradient>
<radialGradient id="bg" cx=".2" cy="0" r="1"><stop offset="0" stop-color="#11241d"/><stop offset=".6" stop-color="#0c0e12"/></radialGradient></defs>
<rect width="64" height="64" rx="${pad ? 0 : 14}" fill="url(#bg)"/>
<g transform="translate(${32 - 12 * (pad ? 1.3 : 1.75)} ${32 - 12 * (pad ? 1.3 : 1.75)}) scale(${pad ? 1.3 : 1.75})" fill="none" stroke="url(#g)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></g></svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const out = path.join(__dirname, '..', 'public', 'icons');
  for (const [name, size, pad] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true], ['apple-touch-icon.png', 180, true]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, pad)}</body></html>`);
    fs.writeFileSync(path.join(out, name), await page.screenshot({ omitBackground: !pad, clip: { x: 0, y: 0, width: size, height: size } }));
    console.log('wrote', name);
  }
  await browser.close();
})();
