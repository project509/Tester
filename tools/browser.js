// Shared headless-mobile browser helper for tests/tools. Emulates a modern phone in portrait.
const { chromium } = require('playwright-core');
const path = require('path');
const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const DEVICES = {
  iphone14: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  pixel7: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36' },
  se: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  tablet: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
async function launch(opts = {}) {
  const browser = await chromium.launch({ executablePath: EXEC, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'] });
  const dev = DEVICES[opts.device || 'iphone14'];
  const context = await browser.newContext({ ...dev, deviceScaleFactor: opts.dpr || Math.min(2, dev.deviceScaleFactor) });
  const page = await context.newPage();
  const errors = []; const logs = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
  page.on('console', (m) => { const t = m.type(); const s = `[${t}] ${m.text()}`; logs.push(s); if (t === 'error') errors.push(s); });
  const url = opts.url || ('file://' + path.join(__dirname, '..', 'dist', 'index.html'));
  await page.goto(url, { waitUntil: 'load' });
  return { browser, context, page, errors, logs, close: () => browser.close() };
}
module.exports = { launch, DEVICES };
