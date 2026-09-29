/**
 * art/sprite.js — The procedural pixel toolkit.
 *
 * A sprite is `{ canvas, w, h, ox, oy }` at unit resolution (ox/oy = anchor,
 * default bottom-centre). `makeSprite` hands the draw callback a painter that
 * works on a raw ImageData buffer (fast, exact, no anti-aliasing) and commits
 * it to the canvas when the callback returns. Canvases are OffscreenCanvas
 * where available, else DOM canvases; both are valid drawImage sources.
 *
 * Public API:
 *   makeSprite(w, h, draw(p), { ox, oy }?) → spr
 *     p.w p.h p.data p.canvas p.ctx
 *     p.set(x,y,hex,a?) p.get(x,y)→hex|null p.alpha(x,y)→0..255 p.clear() p.fill(hex)
 *     p.rect(x,y,w,h,hex,a?) p.frame(x,y,w,h,hex) p.line(x0,y0,x1,y1,hex) p.ellipse(cx,cy,rx,ry,hex)
 *     p.fillCircle(cx,cy,r,hex) p.ring(cx,cy,r,hex) p.outline(hex, diagonal?) p.shadeVertical(ramp,x?,y?,w?,h?)
 *     p.dither(x,y,w,h,hexA,hexB,t?) p.noise(rng,x,y,w,h,hex,density,a?) p.shade(x,y,w,h,amt)
 *     p.blit(spr,x,y,{flip,alpha}?) p.hflip() p.vflip() p.flush() p.sync()
 *   cached(key, factory) → any             cacheSize() / clearCache()
 *   compose(w, h, layers [{spr,x,y,flip,alpha}], { ox, oy }?) → spr
 *   tint(spr, hex, amount, mode='mix'|'multiply') → spr
 *   outline(spr, hex, diagonal?) → spr     (canvas grows by 2, anchor shifts by 1)
 *   anim(frames, fps, loop=true) → { frames, fps, loop }
 *   toDataURL(spr, scale=1) → string       (nearest-neighbour upscale; '' without a DOM)
 *   createCanvas(w, h, forceDom?) → canvas
 */

const colorCache = new Map();
const spriteCache = new Map();
const dataUrlCache = new WeakMap();
const HAS_DOM = typeof document !== 'undefined' && !!document.createElement;
const HAS_OFFSCREEN = typeof OffscreenCanvas !== 'undefined';
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// ───────────────────────────── helpers ─────────────────────────────

/**
 * Parses a hex colour into a packed 0xRRGGBB integer (cached per string).
 * Invalid strings parse as black.
 * @param {string} hex
 * @returns {number}
 */
function packHex(hex) {
  const hit = colorCache.get(hex);
  if (hit !== undefined) return hit;
  let s = typeof hex === 'string' ? hex : '';
  if (s.charCodeAt(0) === 35) s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  else if (s.length === 8) s = s.slice(0, 6);
  let v = s.length === 6 ? parseInt(s, 16) : 0;
  if (Number.isNaN(v)) v = 0;
  colorCache.set(hex, v);
  return v;
}

const HEX = '0123456789abcdef';
function byteHex(v) {
  return HEX[v >> 4] + HEX[v & 15];
}

/**
 * Creates a w×h canvas: OffscreenCanvas when available (unless forceDom), else a DOM canvas.
 * @param {number} w @param {number} h @param {boolean} [forceDom]
 * @returns {HTMLCanvasElement|OffscreenCanvas}
 */
export function createCanvas(w, h, forceDom) {
  const cw = w >= 1 ? Math.floor(w) : 1;
  const ch = h >= 1 ? Math.floor(h) : 1;
  if (HAS_OFFSCREEN && !forceDom) return new OffscreenCanvas(cw, ch);
  if (HAS_DOM) {
    const c = document.createElement('canvas');
    c.width = cw;
    c.height = ch;
    return c;
  }
  throw new Error('sprite: no canvas implementation available');
}

/** 2D context of a canvas, with smoothing disabled. */
function context2d(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

// ───────────────────────────── painter ─────────────────────────────

/**
 * Builds a painter over an ImageData buffer for the given context.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} w @param {number} h
 */
function createPainter(ctx, canvas, w, h) {
  let img = ctx.createImageData(w, h);
  let data = img.data;

  function set(x, y, hex, a) {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const c = packHex(hex);
    const i = (yi * w + xi) * 4;
    const alpha = a === undefined ? 1 : a;
    if (alpha >= 1) {
      data[i] = c >> 16;
      data[i + 1] = (c >> 8) & 255;
      data[i + 2] = c & 255;
      data[i + 3] = 255;
      return;
    }
    if (alpha <= 0) return;
    const da = data[i + 3] / 255;
    const outA = alpha + da * (1 - alpha);
    if (outA <= 0) return;
    const wS = alpha / outA;
    const wD = 1 - wS;
    data[i] = (c >> 16) * wS + data[i] * wD;
    data[i + 1] = ((c >> 8) & 255) * wS + data[i + 1] * wD;
    data[i + 2] = (c & 255) * wS + data[i + 2] * wD;
    data[i + 3] = outA * 255;
  }

  function get(x, y) {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
    const i = (yi * w + xi) * 4;
    if (data[i + 3] === 0) return null;
    return '#' + byteHex(data[i]) + byteHex(data[i + 1]) + byteHex(data[i + 2]);
  }

  function alpha(x, y) {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return 0;
    return data[(yi * w + xi) * 4 + 3];
  }

  function clear() {
    data.fill(0);
  }

  function fill(hex) {
    rect(0, 0, w, h, hex);
  }

  function rect(x, y, rw, rh, hex, a) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(w, (x | 0) + (rw | 0));
    const y1 = Math.min(h, (y | 0) + (rh | 0));
    if (a !== undefined && a < 1) {
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) set(xx, yy, hex, a);
      return;
    }
    const c = packHex(hex);
    const r = c >> 16;
    const g = (c >> 8) & 255;
    const b = c & 255;
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * w + x0) * 4;
      for (let xx = x0; xx < x1; xx++) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
        i += 4;
      }
    }
  }

  function frame(x, y, rw, rh, hex) {
    if (rw <= 0 || rh <= 0) return;
    rect(x, y, rw, 1, hex);
    rect(x, y + rh - 1, rw, 1, hex);
    rect(x, y, 1, rh, hex);
    rect(x + rw - 1, y, 1, rh, hex);
  }

  function line(x0, y0, x1, y1, hex) {
    let ax = x0 | 0;
    let ay = y0 | 0;
    const bx = x1 | 0;
    const by = y1 | 0;
    const dx = Math.abs(bx - ax);
    const dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1;
    const sy = ay < by ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 4096; guard++) {
      set(ax, ay, hex);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; ax += sx; }
      if (e2 <= dx) { err += dx; ay += sy; }
    }
  }

  function ellipse(cx, cy, rx, ry, hex) {
    if (rx <= 0 || ry <= 0) return;
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let yy = y0; yy <= y1; yy++) {
      const dy = (yy + 0.5 - cy) / ry;
      const t = 1 - dy * dy;
      if (t < 0) continue;
      const half = rx * Math.sqrt(t);
      const xa = Math.max(0, Math.ceil(cx - half - 0.5));
      const xb = Math.min(w - 1, Math.floor(cx + half - 0.5));
      if (xb >= xa) rect(xa, yy, xb - xa + 1, 1, hex);
    }
  }

  function fillCircle(cx, cy, r, hex) {
    ellipse(cx, cy, r, r, hex);
  }

  function ring(cx, cy, r, hex) {
    // Midpoint circle on pixel centres.
    let x = Math.round(r);
    let y = 0;
    let err = 1 - x;
    const ox = Math.floor(cx);
    const oy = Math.floor(cy);
    while (x >= y) {
      set(ox + x, oy + y, hex); set(ox + y, oy + x, hex);
      set(ox - y, oy + x, hex); set(ox - x, oy + y, hex);
      set(ox - x, oy - y, hex); set(ox - y, oy - x, hex);
      set(ox + y, oy - x, hex); set(ox + x, oy - y, hex);
      y++;
      if (err < 0) err += 2 * y + 1;
      else { x--; err += 2 * (y - x) + 1; }
    }
  }

  function opaqueAt(x, y) {
    return x >= 0 && y >= 0 && x < w && y < h && data[(y * w + x) * 4 + 3] > 0;
  }

  function outline(hex, diagonal) {
    const mask = new Uint8Array(w * h);
    for (let i = 0, n = w * h; i < n; i++) mask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (mask[y * w + x]) continue;
        let hit = on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1);
        if (!hit && diagonal) hit = on(x - 1, y - 1) || on(x + 1, y - 1) || on(x - 1, y + 1) || on(x + 1, y + 1);
        if (hit) set(x, y, hex);
      }
    }
  }

  function shadeVertical(rampArr, x, y, rw, rh) {
    if (!rampArr || rampArr.length === 0) return;
    const x0 = Math.max(0, x === undefined ? 0 : x | 0);
    const y0 = Math.max(0, y === undefined ? 0 : y | 0);
    const x1 = Math.min(w, rw === undefined ? w : x0 + (rw | 0));
    const y1 = Math.min(h, rh === undefined ? h : y0 + (rh | 0));
    const n = rampArr.length;
    const span = Math.max(1, y1 - y0);
    for (let yy = y0; yy < y1; yy++) {
      // Top rows take the light end of the ramp, bottom rows the shadow end.
      const idx = n - 1 - Math.min(n - 1, Math.floor(((yy - y0) / span) * n));
      const c = packHex(rampArr[idx]);
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 4;
        if (data[i + 3] === 0) continue;
        data[i] = c >> 16;
        data[i + 1] = (c >> 8) & 255;
        data[i + 2] = c & 255;
      }
    }
  }

  function dither(x, y, rw, rh, hexA, hexB, t) {
    const thr = t === undefined ? 0.5 : t;
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(w, (x | 0) + (rw | 0));
    const y1 = Math.min(h, (y | 0) + (rh | 0));
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const b = (BAYER4[(yy & 3) * 4 + (xx & 3)] + 0.5) / 16;
        set(xx, yy, b < thr ? hexB : hexA);
      }
    }
  }

  function noise(rng, x, y, rw, rh, hex, density, a) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(w, (x | 0) + (rw | 0));
    const y1 = Math.min(h, (y | 0) + (rh | 0));
    const d = density === undefined ? 0.2 : density;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        if (rng.next() >= d) continue;
        if (data[(yy * w + xx) * 4 + 3] === 0) continue;
        set(xx, yy, hex, a);
      }
    }
  }

  function shade(x, y, rw, rh, amt) {
    const x0 = Math.max(0, x | 0);
    const y0 = Math.max(0, y | 0);
    const x1 = Math.min(w, (x | 0) + (rw | 0));
    const y1 = Math.min(h, (y | 0) + (rh | 0));
    const k = amt < -1 ? -1 : amt > 1 ? 1 : amt;
    const target = k < 0 ? 0 : 255;
    const t = k < 0 ? -k : k;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * w + xx) * 4;
        if (data[i + 3] === 0) continue;
        data[i] += (target - data[i]) * t;
        data[i + 1] += (target - data[i + 1]) * t;
        data[i + 2] += (target - data[i + 2]) * t;
      }
    }
  }

  function blit(spr, x, y, opts) {
    if (!spr || !spr.canvas) return;
    const flip = opts ? !!opts.flip : false;
    const a = opts && typeof opts.alpha === 'number' ? opts.alpha : 1;
    const src = readPixels(spr);
    const sw = spr.w;
    const sh = spr.h;
    for (let yy = 0; yy < sh; yy++) {
      const ty = (y | 0) + yy;
      if (ty < 0 || ty >= h) continue;
      for (let xx = 0; xx < sw; xx++) {
        const tx = (x | 0) + (flip ? sw - 1 - xx : xx);
        if (tx < 0 || tx >= w) continue;
        const si = (yy * sw + xx) * 4;
        const sa = src[si + 3];
        if (sa === 0) continue;
        const di = (ty * w + tx) * 4;
        const alphaS = (sa / 255) * a;
        if (alphaS >= 1) {
          data[di] = src[si]; data[di + 1] = src[si + 1]; data[di + 2] = src[si + 2]; data[di + 3] = 255;
          continue;
        }
        const da = data[di + 3] / 255;
        const outA = alphaS + da * (1 - alphaS);
        if (outA <= 0) continue;
        const wS = alphaS / outA;
        const wD = 1 - wS;
        data[di] = src[si] * wS + data[di] * wD;
        data[di + 1] = src[si + 1] * wS + data[di + 1] * wD;
        data[di + 2] = src[si + 2] * wS + data[di + 2] * wD;
        data[di + 3] = outA * 255;
      }
    }
  }

  function hflip() {
    const half = w >> 1;
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < half; xx++) {
        const i = (yy * w + xx) * 4;
        const j = (yy * w + (w - 1 - xx)) * 4;
        for (let k = 0; k < 4; k++) {
          const t = data[i + k];
          data[i + k] = data[j + k];
          data[j + k] = t;
        }
      }
    }
  }

  function vflip() {
    const half = h >> 1;
    const rowBytes = w * 4;
    for (let yy = 0; yy < half; yy++) {
      const i = yy * rowBytes;
      const j = (h - 1 - yy) * rowBytes;
      for (let k = 0; k < rowBytes; k++) {
        const t = data[i + k];
        data[i + k] = data[j + k];
        data[j + k] = t;
      }
    }
  }

  function flush() {
    ctx.putImageData(img, 0, 0);
  }

  function sync() {
    img = ctx.getImageData(0, 0, w, h);
    data = img.data;
    p.data = data;
  }

  const p = {
    w, h, data, canvas, ctx,
    set, get, alpha, clear, fill, rect, frame, line, ellipse, fillCircle, ring,
    outline, shadeVertical, dither, noise, shade, blit, hflip, vflip, flush, sync,
  };
  return p;
}

/** Reads a sprite's pixels (fresh ImageData; generation-time only). */
function readPixels(spr) {
  return context2d(spr.canvas).getImageData(0, 0, spr.w, spr.h).data;
}

// ───────────────────────────── public API ─────────────────────────────

/**
 * Creates a unit-resolution sprite by painting into an ImageData buffer.
 * The buffer is committed automatically after `draw` returns; use `p.flush()`
 * inside `draw` before touching `p.ctx`, and `p.sync()` to read ctx work back.
 * @param {number} w @param {number} h
 * @param {(p: object) => void} draw
 * @param {{ ox?: number, oy?: number }} [opts] anchor (default bottom-centre)
 * @returns {{ canvas: HTMLCanvasElement|OffscreenCanvas, w: number, h: number, ox: number, oy: number }}
 */
export function makeSprite(w, h, draw, opts) {
  const cw = w >= 1 ? Math.floor(w) : 1;
  const ch = h >= 1 ? Math.floor(h) : 1;
  const canvas = createCanvas(cw, ch);
  const ctx = context2d(canvas);
  const p = createPainter(ctx, canvas, cw, ch);
  if (typeof draw === 'function') draw(p);
  p.flush();
  return {
    canvas,
    w: cw,
    h: ch,
    ox: opts && typeof opts.ox === 'number' ? opts.ox : cw * 0.5,
    oy: opts && typeof opts.oy === 'number' ? opts.oy : ch,
  };
}

/**
 * Memoises `factory()` under a stable string key.
 * @template T
 * @param {string} key
 * @param {() => T} factory
 * @returns {T}
 */
export function cached(key, factory) {
  const hit = spriteCache.get(key);
  if (hit !== undefined) return hit;
  const v = factory();
  spriteCache.set(key, v);
  return v;
}

/** @returns {number} number of cached entries. */
export function cacheSize() {
  return spriteCache.size;
}

/** Drops every cached entry (e.g. on memory pressure). */
export function clearCache() {
  spriteCache.clear();
}

/**
 * Draws layers onto a fresh w×h sprite. Each layer is `{spr, x, y, flip, alpha}`
 * with (x, y) the top-left of the layer sprite; null/missing sprites are skipped.
 * @param {number} w @param {number} h
 * @param {Array<{spr:object, x?:number, y?:number, flip?:boolean, alpha?:number}>} layers
 * @param {{ ox?: number, oy?: number }} [opts]
 * @returns {object} spr
 */
export function compose(w, h, layers, opts) {
  const cw = w >= 1 ? Math.floor(w) : 1;
  const ch = h >= 1 ? Math.floor(h) : 1;
  const canvas = createCanvas(cw, ch);
  const ctx = context2d(canvas);
  if (layers) {
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L || !L.spr || !L.spr.canvas) continue;
      const x = L.x ? L.x | 0 : 0;
      const y = L.y ? L.y | 0 : 0;
      const a = typeof L.alpha === 'number' ? L.alpha : 1;
      if (a <= 0) continue;
      ctx.globalAlpha = a > 1 ? 1 : a;
      if (L.flip) {
        ctx.save();
        ctx.scale(-1, 1);
        ctx.drawImage(L.spr.canvas, -x - L.spr.w, y);
        ctx.restore();
      } else {
        ctx.drawImage(L.spr.canvas, x, y);
      }
    }
    ctx.globalAlpha = 1;
  }
  return {
    canvas,
    w: cw,
    h: ch,
    ox: opts && typeof opts.ox === 'number' ? opts.ox : cw * 0.5,
    oy: opts && typeof opts.oy === 'number' ? opts.oy : ch,
  };
}

/**
 * Returns a recoloured copy of a sprite, keeping alpha.
 * 'mix' (default) blends every pixel toward `hex` by `amount` (flash/freeze);
 * 'multiply' multiplies by `hex`, blended in by `amount` (dye/dirt).
 * @param {object} spr @param {string} hex @param {number} amount 0..1
 * @param {'mix'|'multiply'} [mode]
 * @returns {object} spr
 */
export function tint(spr, hex, amount, mode) {
  if (!spr || !spr.canvas) return spr;
  const k = amount === undefined ? 1 : amount < 0 ? 0 : amount > 1 ? 1 : amount;
  const c = packHex(hex);
  const tr = c >> 16;
  const tg = (c >> 8) & 255;
  const tb = c & 255;
  const multiply = mode === 'multiply';
  return makeSprite(spr.w, spr.h, (p) => {
    p.blit(spr, 0, 0);
    const d = p.data;
    for (let i = 0, n = d.length; i < n; i += 4) {
      if (d[i + 3] === 0) continue;
      if (multiply) {
        d[i] += ((d[i] * tr) / 255 - d[i]) * k;
        d[i + 1] += ((d[i + 1] * tg) / 255 - d[i + 1]) * k;
        d[i + 2] += ((d[i + 2] * tb) / 255 - d[i + 2]) * k;
      } else {
        d[i] += (tr - d[i]) * k;
        d[i + 1] += (tg - d[i + 1]) * k;
        d[i + 2] += (tb - d[i + 2]) * k;
      }
    }
  }, { ox: spr.ox, oy: spr.oy });
}

/**
 * Returns a copy with a 1px outline around every opaque pixel. The canvas grows
 * by 2 in each dimension and the anchor shifts by 1 so it draws in place.
 * @param {object} spr @param {string} hex @param {boolean} [diagonal] also fill diagonal gaps
 * @returns {object} spr
 */
export function outline(spr, hex, diagonal) {
  if (!spr || !spr.canvas) return spr;
  return makeSprite(spr.w + 2, spr.h + 2, (p) => {
    p.blit(spr, 1, 1);
    p.outline(hex, diagonal);
  }, {
    ox: (typeof spr.ox === 'number' ? spr.ox : spr.w * 0.5) + 1,
    oy: (typeof spr.oy === 'number' ? spr.oy : spr.h) + 1,
  });
}

/**
 * Bundles frames into an animation descriptor.
 * @param {object[]} frames @param {number} fps @param {boolean} [loop]
 * @returns {{ frames: object[], fps: number, loop: boolean }}
 */
export function anim(frames, fps, loop) {
  return { frames: frames || [], fps: fps > 0 ? fps : 8, loop: loop === undefined ? true : !!loop };
}

/**
 * Nearest-neighbour upscaled PNG data URL of a sprite (cached per sprite+scale).
 * Returns '' when no DOM canvas is available (workers) — never throws.
 * @param {object} spr @param {number} [scale]
 * @returns {string}
 */
export function toDataURL(spr, scale) {
  if (!spr || !spr.canvas || !HAS_DOM) return '';
  const s = scale >= 1 ? Math.floor(scale) : 1;
  let perScale = dataUrlCache.get(spr);
  if (perScale) {
    const hit = perScale.get(s);
    if (hit) return hit;
  } else {
    perScale = new Map();
    dataUrlCache.set(spr, perScale);
  }
  let url = '';
  try {
    const c = createCanvas(spr.w * s, spr.h * s, true);
    const ctx = context2d(c);
    ctx.drawImage(spr.canvas, 0, 0, spr.w * s, spr.h * s);
    url = c.toDataURL('image/png');
  } catch (e) {
    url = '';
  }
  perScale.set(s, url);
  return url;
}
