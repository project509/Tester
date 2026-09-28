// Generates pwa/icon-192.png, icon-512.png, icon-maskable-512.png procedurally via headless Chromium.
const { launch } = require('./browser');
const fs = require('fs'); const path = require('path');
const DRAW = `(size, maskable) => {
  const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d');
  const pad = maskable ? size * 0.1 : 0; const r = maskable ? 0 : size * 0.22;
  // background rounded square
  x.save(); x.beginPath(); x.moveTo(r, 0); x.lineTo(size - r, 0); x.quadraticCurveTo(size, 0, size, r); x.lineTo(size, size - r); x.quadraticCurveTo(size, size, size - r, size); x.lineTo(r, size); x.quadraticCurveTo(0, size, 0, size - r); x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0); x.closePath(); x.clip();
  const g = x.createLinearGradient(0, 0, 0, size); g.addColorStop(0, '#141a2b'); g.addColorStop(0.55, '#0c0f18'); g.addColorStop(1, '#2a1410'); x.fillStyle = g; x.fillRect(0, 0, size, size);
  // moon glow
  const mg = x.createRadialGradient(size * 0.72, size * 0.25, 0, size * 0.72, size * 0.25, size * 0.35); mg.addColorStop(0, 'rgba(180,200,255,0.55)'); mg.addColorStop(1, 'rgba(180,200,255,0)'); x.fillStyle = mg; x.fillRect(0, 0, size, size);
  x.fillStyle = '#dfe7ff'; x.beginPath(); x.arc(size * 0.72, size * 0.25, size * 0.09, 0, 7); x.fill();
  x.fillStyle = '#141a2b'; x.beginPath(); x.arc(size * 0.75, size * 0.22, size * 0.075, 0, 7); x.fill();
  // stars
  x.fillStyle = '#ffffff'; const rs = [[0.15,0.12],[0.3,0.2],[0.5,0.09],[0.85,0.45],[0.2,0.35],[0.62,0.4]]; for (const [sx, sy] of rs) { x.globalAlpha = 0.6; x.fillRect(sx * size, sy * size, Math.max(1, size * 0.008), Math.max(1, size * 0.008)); } x.globalAlpha = 1;
  // ground fog
  const fg = x.createLinearGradient(0, size * 0.6, 0, size); fg.addColorStop(0, 'rgba(255,120,60,0)'); fg.addColorStop(1, 'rgba(255,120,60,0.35)'); x.fillStyle = fg; x.fillRect(0, 0, size, size);
  // tower silhouette
  const tw = size * 0.34, th = size * 0.62, tx = (size - tw) / 2, ty = size * 0.9 - th;
  x.fillStyle = '#1d2230'; x.fillRect(tx, ty, tw, th);
  x.fillStyle = '#0b0d12'; x.fillRect(tx - size * 0.03, ty - size * 0.02, tw + size * 0.06, size * 0.04);
  // floors + windows (warm)
  const floors = 4; for (let f = 0; f < floors; f++) { const fy = ty + size * 0.06 + f * (th - size * 0.14) / floors; for (let w = 0; w < 3; w++) { const wx = tx + size * 0.05 + w * (tw - size * 0.1) / 3; const lit = !(f === 1 && w === 2) && !(f === 3 && w === 0); x.fillStyle = lit ? '#ffb15c' : '#2a2f3d'; const ww = (tw - size * 0.1) / 3 - size * 0.03, wh = size * 0.08; x.fillRect(wx, fy, ww, wh); if (lit) { const wg = x.createRadialGradient(wx + ww / 2, fy + wh / 2, 0, wx + ww / 2, fy + wh / 2, size * 0.12); wg.addColorStop(0, 'rgba(255,170,80,0.45)'); wg.addColorStop(1, 'rgba(255,170,80,0)'); x.fillStyle = wg; x.fillRect(wx - size * 0.12, fy - size * 0.12, ww + size * 0.24, wh + size * 0.24); } } }
  // barricade at base
  x.fillStyle = '#3a2a1c'; x.fillRect(tx - size * 0.06, size * 0.86, tw + size * 0.12, size * 0.05);
  x.fillStyle = '#5a4630'; for (let i = 0; i < 6; i++) x.fillRect(tx - size * 0.05 + i * (tw + size * 0.1) / 6, size * 0.84, size * 0.02, size * 0.08);
  // zombie silhouettes at the base
  x.fillStyle = '#0a0c10'; for (let i = 0; i < 5; i++) { const zx = size * (0.08 + i * 0.2) + (i % 2) * size * 0.03; const zh = size * (0.1 + (i % 3) * 0.02); x.fillRect(zx, size * 0.92 - zh, size * 0.04, zh); x.beginPath(); x.arc(zx + size * 0.02, size * 0.92 - zh, size * 0.025, 0, 7); x.fill(); }
  x.fillStyle = '#000'; x.fillRect(0, size * 0.92, size, size * 0.08);
  x.restore();
  return c.toDataURL('image/png');
}`;
(async () => {
  const b = await launch({ url: 'about:blank' });
  const out = path.join(__dirname, '..', 'pwa');
  for (const [file, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
    const data = await b.page.evaluate(`(${DRAW})(${size}, ${maskable})`);
    fs.writeFileSync(path.join(out, file), Buffer.from(data.split(',')[1], 'base64'));
    console.log('wrote', file);
  }
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
