/**
 * art/backgrounds.js — Skies, weather, parallax cityscapes, zone backdrops and the siege street.
 *
 * The sky is the one smooth layer in the game: a gradient lerped through key
 * hours (night → violet pre-dawn → rose dawn → pale amber day → amber dusk → night),
 * a sun or moon on an arc, seeded stars and pixel-art clouds, all drawn in css px.
 * Everything else is chunky unit-resolution pixel art built with the painter:
 * tileable ruined skylines, five instantly distinct scav zones (three parallax
 * layers + ground + foreground occluder) and the asphalt outside the gate.
 * Per-frame functions (drawSky, drawWeather) never allocate once their caches
 * are warm; every generator is a pure function of (params, seed) and is cached.
 *
 * Public API:
 *   ZONE_TYPES · WEATHERS · CITY_H
 *   skyPalette(hour, weather?) → { top, horizon, ambient, key }        (hex; 0.25 h buckets)
 *   drawSky(ctx, W, H, { hour, weather, seed, moonPhase, t, px, horizon })   css px, per frame
 *   makeCityscape(seed, layerIdx 0..2, W) → { spr, emissive }        tileable, W×CITY_H, top-left anchor
 *   makeZoneBackdrop(zoneType, seed, W, H) → { layers:[{ spr, parallax, y, emissive? }],
 *                                              ground:{ spr, y }, groundY, lights:[...], fog, palette }
 *   drawWeather(ctx, W, H, weather, t, { intensity, px }) → { flash }   screen-space overlay, per frame
 *   makeStreet(seed, W) → { spr, roadY, lampLights:[...] }            the street outside the gate
 *   makeSiegeSkyline(seed, W) → { layers:[{ spr, emissive, parallax, y }] }
 */

import { PAL, ramp, mix, adjust, hexToRgb } from './palette.js';
import { makeNoise } from './noise.js';
import { makeSprite, cached } from './sprite.js';
import { makeRng } from '../core/rng.js';

/** Scav zone ids (GDD §6). */
export const ZONE_TYPES = Object.freeze(['suburbs', 'mall', 'hospital', 'forest', 'depot']);
/** Weather ids understood by drawSky / drawWeather / skyPalette. */
export const WEATHERS = Object.freeze(['clear', 'rain', 'ash', 'storm', 'fog']);
/** Height (units) of every cityscape layer. */
export const CITY_H = 120;

const INK = PAL.ink;
const TAU = Math.PI * 2;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
/** Ground line as a fraction of the zone screen height (300 / 422). */
const GROUND_FRAC = 300 / 422;
/** Sky palette buckets per hour. */
const SKY_BUCKETS_PER_HOUR = 4;
const SKY_BUCKETS = 24 * SKY_BUCKETS_PER_HOUR;
/** Cloud tone buckets (one per two hours) plus the overcast and ash tones. */
const CLOUD_TONES = 12;
const TONE_OVERCAST = 12;
const TONE_ASH = 13;
const STAR_COUNT = 160;
const CLOUD_COUNT = 6;
const CLOUD_SHAPES = 4;

// ───────────────────────────── small helpers ─────────────────────────────

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function clampInt(v, a, b) {
  const i = Math.round(Number(v) || 0);
  return i < a ? a : i > b ? b : i;
}

function smooth(t) {
  const k = clamp(t, 0, 1);
  return k * k * (3 - 2 * k);
}

/** Bayer-4 threshold in 0..1 for an (x, y) pixel. */
function bayer(x, y) {
  return (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
}

/** Index of a weather id (unknown → clear). */
function weatherIndex(weather) {
  const i = WEATHERS.indexOf(weather);
  return i < 0 ? 0 : i;
}

/** Wraps an hour into [0, 24). */
function wrapHour(hour) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return 12;
  return ((h % 24) + 24) % 24;
}

/** Clears a rectangle of the painter back to transparent. */
function erase(p, x, y, w, h) {
  const x0 = Math.max(0, x | 0);
  const y0 = Math.max(0, y | 0);
  const x1 = Math.min(p.w, (x | 0) + (w | 0));
  const y1 = Math.min(p.h, (y | 0) + (h | 0));
  const d = p.data;
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) d[(yy * p.w + xx) * 4 + 3] = 0;
  }
}

/** Erases a filled circle (used for moon phases and torn edges). */
function eraseCircle(p, cx, cy, r) {
  const d = p.data;
  for (let yy = Math.floor(cy - r); yy <= Math.ceil(cy + r); yy++) {
    for (let xx = Math.floor(cx - r); xx <= Math.ceil(cx + r); xx++) {
      const dx = xx + 0.5 - cx;
      const dy = yy + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      if (xx < 0 || yy < 0 || xx >= p.w || yy >= p.h) continue;
      d[(yy * p.w + xx) * 4 + 3] = 0;
    }
  }
}

/** Upward-pointing isoceles triangle with its apex at (cx, topY). */
function tri(p, cx, topY, halfW, h, hex) {
  if (h <= 0) return;
  for (let r = 0; r < h; r++) {
    const hw = Math.round((halfW * r) / Math.max(1, h - 1));
    p.rect(cx - hw, topY + r, hw * 2 + 1, 1, hex);
  }
}

/** Upper half of an ellipse standing on baseY (hangar roofs, hedges, bag tops). */
function dome(p, cx, baseY, rx, ry, hex) {
  for (let r = 0; r <= ry; r++) {
    const t = 1 - (r / ry) * (r / ry);
    if (t < 0) continue;
    const hw = Math.round(rx * Math.sqrt(t));
    p.rect(cx - hw, baseY - r, hw * 2 + 1, 1, hex);
  }
}

/**
 * Fills a rectangle with noise-shaded colours from a ramp. When `period` is
 * given the field repeats every `period` px horizontally (tileable layers).
 */
function texFill(p, nz, x, y, w, h, rampArr, scale, period, bias) {
  const n = rampArr.length;
  const b = bias || 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      let v;
      if (period) {
        const u = (xx - x) / period;
        v = nz.fbm(xx / scale, yy / scale, 3) * (1 - u) + nz.fbm((xx - period) / scale, yy / scale, 3) * u;
      } else {
        v = nz.fbm(xx / scale, yy / scale, 3);
      }
      const idx = clampInt((v - 0.5) * n * 1.6 + n * 0.5 + b, 0, n - 1);
      p.set(xx, yy, rampArr[idx]);
    }
  }
}

/** Dithers opaque pixels of a row band toward `hex` with strength rising from 0 at y0 to `k` at y1. */
function hazeRows(p, y0, y1, hex, k) {
  for (let yy = Math.max(0, y0); yy < Math.min(p.h, y1); yy++) {
    const t = ((yy - y0) / Math.max(1, y1 - y0)) * k;
    for (let xx = 0; xx < p.w; xx++) {
      if (p.alpha(xx, yy) === 0) continue;
      if (bayer(xx, yy) < t) p.set(xx, yy, hex);
    }
  }
}

/** Sprinkles single pixels of `hex` over opaque pixels inside a rect. */
function speckle(p, rng, x, y, w, h, hex, density) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (rng.next() < density && p.alpha(xx, yy) > 0) p.set(xx, yy, hex);
    }
  }
}

/** Calls fn(x) and again shifted by ±W when the object crosses a tile edge. */
function tiled(W, x, objW, fn) {
  fn(x);
  if (x + objW > W) fn(x - W);
  if (x < 0) fn(x + W);
}

/** Unit sprite with a top-left anchor (backdrop layers). */
function layerSprite(w, h, draw) {
  return makeSprite(w, h, draw, { ox: 0, oy: 0 });
}

/** Painter pair: the emissive sprite is created first so its painter can be reused. */
function layerPair(w, h, draw) {
  let pe = null;
  const emissive = layerSprite(w, h, (p) => { pe = p; });
  const spr = layerSprite(w, h, (p) => draw(p, pe));
  pe.flush();
  return { spr, emissive };
}

function light(x, y, r, color, intensity, flicker, parallax) {
  return { x, y, r, color, intensity, flicker, parallax };
}

// ───────────────────────────── sky palette ─────────────────────────────

/** Key hours: [hour, top, horizon, ambient, key]. Wraps 22 h → 0 h. */
const SKY_KEYS = [
  [0, '#06081a', '#141c33', '#1a2340', '#8fd3e8'],
  [3.5, '#0a0c22', '#1c1e3e', '#1e2544', '#8fc8e0'],
  [5, '#1a1a3c', '#5a3e6e', '#3a3556', '#b08aa0'],
  [6.5, '#34456a', '#c98878', '#6e7898', '#f0b090'],
  [9, '#4a7396', '#b8b8a8', '#a0a8b0', '#ffe8c0'],
  [13, '#4f7ea6', '#cfc8b0', '#b4bcc2', '#fff0d0'],
  [16.5, '#4c6690', '#d0b090', '#a09aa0', '#ffd8a0'],
  [17.8, '#46527a', '#d89a58', '#8a7e90', '#ffc070'],
  [18.8, '#2e2a52', '#a05a4a', '#55486a', '#e08a5a'],
  [20, '#141838', '#3a2e58', '#2a2a4c', '#9ab8d8'],
  [22, '#08091e', '#161c36', '#1c2340', '#8fd3e8'],
];

/** How each weather pulls the sky toward a flat tone: [colour, top k, horizon k, key k]. */
const WEATHER_TONE = [
  null,
  ['#3e4654', 0.45, 0.5, 0.55],
  ['#6b6157', 0.5, 0.55, 0.5],
  ['#262a34', 0.65, 0.7, 0.75],
  ['#8c9098', 0.4, 0.75, 0.6],
];

/** Interpolated raw palette for an hour (allocates; only called to fill buckets). */
function lerpSkyKeys(hour) {
  const h = wrapHour(hour);
  const n = SKY_KEYS.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (h >= SKY_KEYS[k][0]) i = k;
  }
  const a = SKY_KEYS[i];
  const b = SKY_KEYS[(i + 1) % n];
  let span = b[0] - a[0];
  if (span <= 0) span += 24;
  let d = h - a[0];
  if (d < 0) d += 24;
  const t = smooth(d / span);
  return [mix(a[1], b[1], t), mix(a[2], b[2], t), mix(a[3], b[3], t), mix(a[4], b[4], t)];
}

/** skyPalette bucket cache: [weatherIdx][bucket]. */
const skyPalCache = WEATHERS.map(() => new Array(SKY_BUCKETS));

/**
 * Sky colours for an hour of the day (bucketed to 0.25 h), tinted by weather.
 * Scenes drive `lights.ambient` from `ambient` and their key light from `key`.
 * @param {number} hour 0–24 float
 * @param {string} [weather] 'clear'|'rain'|'ash'|'storm'|'fog'
 * @returns {{ top: string, horizon: string, ambient: string, key: string }} frozen
 */
export function skyPalette(hour, weather) {
  const wi = weatherIndex(weather);
  const bucket = Math.floor(wrapHour(hour) * SKY_BUCKETS_PER_HOUR) % SKY_BUCKETS;
  const hit = skyPalCache[wi][bucket];
  if (hit) return hit;
  const raw = lerpSkyKeys((bucket + 0.5) / SKY_BUCKETS_PER_HOUR);
  const tone = WEATHER_TONE[wi];
  let top = raw[0];
  let horizon = raw[1];
  let ambient = raw[2];
  let key = raw[3];
  if (tone) {
    top = mix(top, tone[0], tone[1]);
    horizon = mix(horizon, tone[0], tone[2]);
    ambient = mix(ambient, tone[0], (tone[1] + tone[2]) * 0.5);
    key = mix(key, tone[0], tone[3]);
  }
  const out = Object.freeze({ top, horizon, ambient, key });
  skyPalCache[wi][bucket] = out;
  return out;
}

/** 1 at night, 0 by day, with soft edges through dawn and dusk. */
function nightFactor(hour) {
  if (hour < 5) return 1;
  if (hour < 7) return 1 - smooth((hour - 5) / 2);
  if (hour < 18) return 0;
  if (hour < 20.5) return smooth((hour - 18) / 2.5);
  return 1;
}

// ───────────────────────────── sky sprites ─────────────────────────────

/** Pixel sun disc coloured for a bucket (warm ramp, dawn/dusk reddened by `key`). */
function sunSprite(bucket, key) {
  return cached('bg:sun:' + bucket, () => makeSprite(11, 11, (p) => {
    const core = mix('#fff2c8', key, 0.35);
    const rim = mix('#ffc27a', key, 0.5);
    p.fillCircle(5.5, 5.5, 5.5, rim);
    p.fillCircle(5, 5, 4, core);
    p.set(3, 3, '#ffffff');
    p.set(4, 3, '#ffffff');
    p.set(3, 4, '#ffffff');
  }));
}

/** Pixel moon with craters, cut to the phase (0 new → 0.5 full → 1 new). */
function moonSprite(phaseBucket) {
  return cached('bg:moon:' + phaseBucket, () => makeSprite(13, 13, (p) => {
    const m = ramp(PAL.base.moon, 5, { dark: 0.4, light: 0.6 });
    p.fillCircle(6.5, 6.5, 6.5, m[3]);
    p.fillCircle(5.5, 5.5, 5, m[4]);
    p.fillCircle(4, 4, 2, '#f4fbff');
    p.set(8, 4, m[2]);
    p.set(9, 5, m[2]);
    p.set(8, 5, m[2]);
    p.set(4, 8, m[2]);
    p.set(7, 9, m[2]);
    p.set(8, 9, m[2]);
    p.set(3, 7, m[2]);
    const phase = phaseBucket / 16;
    const coverage = 1 - Math.abs(phase - 0.5) * 2;
    if (coverage > 0.02) {
      const dir = phase < 0.5 ? 1 : -1;
      eraseCircle(p, 6.5 + dir * (1 - coverage) * 13, 6.5, 6.5);
    }
  }));
}

/** Colours [light, base, shadow, underside] for a cloud tone index. */
function cloudTone(tone) {
  if (tone === TONE_OVERCAST) return ['#5e6270', '#4a4e5c', '#3a3d4a', '#2c2f3a'];
  if (tone === TONE_ASH) return ['#7a7068', '#5e5650', '#4a443f', '#3a3531'];
  const pal = skyPalette(tone * 2 + 1, 'clear');
  const lit = mix(mix(pal.horizon, pal.key, 0.5), '#ffffff', 0.25);
  const base = mix(pal.horizon, pal.top, 0.25);
  const shadow = mix(pal.top, pal.ambient, 0.5);
  return [lit, base, adjust(shadow, { l: 0.02 }), adjust(shadow, { l: -0.06, h: 6 })];
}

/** A puffy pixel cloud shape in a tone; shapes get wider with `shape`. */
function cloudSprite(seed, shape, tone) {
  return cached('bg:cloud:' + seed + ':' + shape + ':' + tone, () => {
    const w = 28 + shape * 18;
    const h = 10 + shape * 3;
    const nz = makeNoise(seed + ':cloud:' + shape);
    const c = cloudTone(tone);
    return makeSprite(w, h, (p) => {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w * 2 - 1;
          const v = (y + 0.5) / h * 2 - 1;
          const env = 1 - (u * u + v * v * (v > 0 ? 1.6 : 0.9));
          const n = nz.fbm(x / 6, y / 3.5, 3);
          if (env * 0.9 + n * 0.5 - 0.42 > 0) p.set(x, y, c[1]);
        }
      }
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (p.alpha(x, y) === 0) continue;
          const above = p.alpha(x, y - 1) === 0 || p.alpha(x, y - 2) === 0;
          const below = p.alpha(x, y + 1) === 0;
          if (y === h - 1 || below) p.set(x, y, c[3]);
          else if (above && y < h * 0.6) p.set(x, y, c[0]);
          else if (y > h * 0.55 && (p.alpha(x, y + 2) === 0 || nz.v2(x / 4, y / 2) > 0.62)) p.set(x, y, c[2]);
        }
      }
    });
  });
}

// ───────────────────────────── drawSky ─────────────────────────────

/** Per-seed star and cloud descriptors (Float32Array, generated once). */
const starCache = new Map();
const cloudDescCache = new Map();

function starsFor(seed) {
  let arr = starCache.get(seed);
  if (arr) return arr;
  const rng = makeRng(seed).fork('stars');
  arr = new Float32Array(STAR_COUNT * 4);
  for (let i = 0; i < STAR_COUNT; i++) {
    arr[i * 4] = rng.next();
    arr[i * 4 + 1] = Math.pow(rng.next(), 1.3) * 0.96;
    arr[i * 4 + 2] = rng.chance(0.14) ? 2 : 1;
    arr[i * 4 + 3] = rng.next() * TAU;
  }
  starCache.set(seed, arr);
  return arr;
}

function cloudsFor(seed) {
  let arr = cloudDescCache.get(seed);
  if (arr) return arr;
  const rng = makeRng(seed).fork('clouds');
  arr = new Float32Array(CLOUD_COUNT * 4);
  for (let i = 0; i < CLOUD_COUNT; i++) {
    arr[i * 4] = rng.next();
    arr[i * 4 + 1] = 0.06 + rng.next() * 0.5;
    arr[i * 4 + 2] = 0.5 + rng.next() * 1.6;
    arr[i * 4 + 3] = rng.int(0, CLOUD_SHAPES - 1);
  }
  cloudDescCache.set(seed, arr);
  return arr;
}

/** Sky frame cache: one entry per (weather, bucket); gradients rebuilt on size change. */
const skyEntries = WEATHERS.map(() => new Array(SKY_BUCKETS));

function skyEntry(wi, bucket, W, H, hy) {
  let e = skyEntries[wi][bucket];
  if (!e) {
    const pal = skyPalette((bucket + 0.5) / SKY_BUCKETS_PER_HOUR, WEATHERS[wi]);
    const c = hexToRgb(pal.key);
    e = {
      pal,
      W: -1, H: -1, hy: -1,
      grad: null, sunGlow: null, moonGlow: null,
      keyRgb: c.r + ',' + c.g + ',' + c.b,
      below: mix(pal.horizon, pal.ambient, 0.55),
      mid: mix(pal.top, pal.horizon, 0.5),
      sun: sunSprite(bucket, pal.key),
    };
    skyEntries[wi][bucket] = e;
  }
  if (e.W !== W || e.H !== H || e.hy !== hy) {
    e.W = W;
    e.H = H;
    e.hy = hy;
    e.grad = null;
    e.sunGlow = null;
    e.moonGlow = null;
  }
  return e;
}

function buildGradient(ctx, e, H, hy) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, e.pal.top);
  g.addColorStop(clamp((hy / H) * 0.5, 0.05, 0.9), e.mid);
  g.addColorStop(clamp(hy / H, 0.1, 0.98), e.pal.horizon);
  g.addColorStop(1, e.below);
  return g;
}

function buildGlow(ctx, R, rgb, a) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
  g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
  g.addColorStop(0.25, 'rgba(' + rgb + ',' + (a * 0.45).toFixed(3) + ')');
  g.addColorStop(0.6, 'rgba(' + rgb + ',' + (a * 0.12).toFixed(3) + ')');
  g.addColorStop(1, 'rgba(' + rgb + ',0)');
  return g;
}

/**
 * Draws the sky for a frame in css px. Cheap: gradients, glows and cloud
 * sprites are cached per 0.25 h bucket; stars/clouds are seeded Float32Arrays.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} W @param {number} H viewport css px
 * @param {{ hour?: number, weather?: string, seed?: number|string, moonPhase?: number,
 *           t?: number, px?: number, horizon?: number }} opts
 *        hour 0–24 · weather (WEATHERS) · seed (stars/clouds) · moonPhase 0..1 (0.5 full) ·
 *        t seconds (twinkle/drift; default derived from hour) · px pixel scale (2) ·
 *        horizon fraction of H where the horizon sits (0.72)
 */
export function drawSky(ctx, W, H, opts) {
  const o = opts || {};
  const hour = wrapHour(o.hour === undefined ? 12 : o.hour);
  const wi = weatherIndex(o.weather);
  const px = o.px >= 1 ? Math.round(o.px) : 2;
  const t = typeof o.t === 'number' ? o.t : hour * 600;
  const seed = o.seed === undefined ? 1 : o.seed;
  const hy = Math.round(H * (typeof o.horizon === 'number' ? clamp(o.horizon, 0.2, 0.95) : 0.72));
  const bucket = Math.floor(hour * SKY_BUCKETS_PER_HOUR) % SKY_BUCKETS;
  const e = skyEntry(wi, bucket, W, H, hy);
  if (!e.grad) e.grad = buildGradient(ctx, e, H, hy);

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.fillStyle = e.grad;
  ctx.fillRect(0, 0, W, H);

  // Stars (hidden under storm/fog, dimmed by rain/ash).
  const nf = nightFactor(hour) * (wi === 3 || wi === 4 ? 0 : wi === 0 ? 1 : 0.35);
  if (nf > 0.01) {
    const stars = starsFor(seed);
    ctx.fillStyle = '#e4ecff';
    for (let i = 0; i < STAR_COUNT; i++) {
      const s = stars[i * 4 + 2];
      const ph = stars[i * 4 + 3];
      const tw = s > 1 ? 0.75 + 0.25 * Math.sin(t * 1.1 + ph) : 0.35 + 0.65 * Math.abs(Math.sin(t * (0.9 + ph * 0.3) + ph * 5));
      ctx.globalAlpha = nf * tw * (s > 1 ? 0.95 : 0.7);
      const sx = Math.floor((stars[i * 4] * W) / px) * px;
      const sy = Math.floor((stars[i * 4 + 1] * hy) / px) * px;
      ctx.fillRect(sx, sy, s * px, s * px);
      if (s > 1 && tw > 0.9) {
        ctx.globalAlpha = nf * 0.4;
        ctx.fillRect(sx - px, sy, px, px * 2);
        ctx.fillRect(sx + px * 2, sy, px, px * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Sun and moon on their arcs (sun 6 h → 18 h, moon opposite).
  ctx.imageSmoothingEnabled = false;
  const overcast = wi === 3 || wi === 4 ? 0.25 : wi === 1 ? 0.55 : wi === 2 ? 0.7 : 1;
  const su = (hour - 6) / 12;
  if (su > -0.06 && su < 1.06) {
    const sx = W * (0.1 + 0.8 * su);
    const sy = hy - Math.sin(clamp(su, 0, 1) * Math.PI) * hy * 0.85;
    const low = 1 - Math.sin(clamp(su, 0, 1) * Math.PI);
    const R = Math.min(W, H) * (0.3 + low * 0.25);
    if (!e.sunGlow) e.sunGlow = buildGlow(ctx, R, e.keyRgb, 0.55);
    ctx.save();
    ctx.translate(sx, sy);
    ctx.globalAlpha = overcast;
    ctx.fillStyle = e.sunGlow;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
    if (wi !== 3 && wi !== 4) {
      ctx.globalAlpha = wi === 2 ? 0.8 : 1;
      const spr = e.sun;
      ctx.drawImage(spr.canvas, Math.round(sx / px) * px - spr.w * px * 0.5, Math.round(sy / px) * px - spr.h * px * 0.5, spr.w * px, spr.h * px);
      ctx.globalAlpha = 1;
    }
  }
  const mu = (((hour + 12) % 24) - 6) / 12;
  const nfm = nightFactor(hour);
  if (mu > -0.06 && mu < 1.06 && nfm > 0.02 && wi !== 3 && wi !== 4) {
    const mx = W * (0.12 + 0.76 * mu);
    const my = hy - Math.sin(clamp(mu, 0, 1) * Math.PI) * hy * 0.8;
    const R = Math.min(W, H) * 0.28;
    if (!e.moonGlow) e.moonGlow = buildGlow(ctx, R, '150,200,230', 0.32);
    ctx.save();
    ctx.translate(mx, my);
    ctx.globalAlpha = nfm * (wi === 0 ? 1 : 0.5);
    ctx.fillStyle = e.moonGlow;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
    const phase = typeof o.moonPhase === 'number' ? clamp(o.moonPhase, 0, 1) : 0.5;
    const spr = moonSprite(Math.round(phase * 16));
    ctx.globalAlpha = nfm * (wi === 0 ? 1 : 0.6);
    ctx.drawImage(spr.canvas, Math.round(mx / px) * px - spr.w * px * 0.5, Math.round(my / px) * px - spr.h * px * 0.5, spr.w * px, spr.h * px);
    ctx.globalAlpha = 1;
  }

  // Clouds: pixel sprites crossfaded between two-hour tones; overcast tones for weather.
  if (wi !== 4) {
    const clouds = cloudsFor(seed);
    let toneA;
    let toneB;
    let f = 0;
    if (wi === 0) {
      const ht = hour / 2 - 0.5;
      const a = Math.floor(((ht % CLOUD_TONES) + CLOUD_TONES) % CLOUD_TONES);
      toneA = a;
      toneB = (a + 1) % CLOUD_TONES;
      f = ht - Math.floor(ht);
    } else {
      toneA = wi === 2 ? TONE_ASH : TONE_OVERCAST;
      toneB = toneA;
    }
    const passes = wi === 0 ? 1 : 2;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < CLOUD_COUNT; i++) {
        const shape = clouds[i * 4 + 3] | 0;
        const sprA = cloudSprite(seed, shape, toneA);
        const cw = sprA.w * px;
        const span = W + cw;
        const cx = ((((clouds[i * 4] + pass * 0.5) * span + t * clouds[i * 4 + 2] * px) % span) + span) % span - cw;
        const cy = Math.round((clouds[i * 4 + 1] * hy * (wi === 0 ? 1 : 0.6) - pass * 12) / px) * px;
        const dx = Math.round(cx / px) * px;
        ctx.globalAlpha = wi === 0 ? 0.92 : 0.96;
        ctx.drawImage(sprA.canvas, dx, cy, cw, sprA.h * px);
        if (f > 0.04 && toneB !== toneA) {
          const sprB = cloudSprite(seed, shape, toneB);
          ctx.globalAlpha = f * 0.92;
          ctx.drawImage(sprB.canvas, dx, cy, cw, sprB.h * px);
        }
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// ───────────────────────────── cityscape ─────────────────────────────

/** Per-layer tones: far layers are fog-toned, the near layer sits close to ink. */
const CITY_TONES = [
  { body: '#3f4560', edge: '#4b5273', dark: '#373d56', win: '#454b68', haze: '#4f5878', rust: '#4a4558' },
  { body: '#282b3c', edge: '#353a52', dark: '#20233a', win: '#1a1d2c', haze: '#343a54', rust: '#3a3040' },
  { body: '#1a1a25', edge: '#2b2d3e', dark: '#131320', win: '#0e0f17', haze: '#22232f', rust: '#3a2a26' },
];
const WINDOW_GLOW = ['#ffb347', '#e8c78a', '#ffd98a', '#8fd3e8', '#ffb347'];
const BILLBOARD_FACE = ['#8a8070', '#6e6458', '#5a4e48'];

/** Draws one building (and its rooftop clutter) at x; `pe` receives emissive pixels. */
function drawBuilding(p, pe, rng, x, bw, bh, style, tone, li, H, hasBillboard, tallest) {
  const top = H - bh;
  p.rect(x, top, bw, bh, tone.body);
  p.rect(x, top, 1, bh, tone.edge);
  p.rect(x + bw - 1, top, 1, bh, tone.dark);
  p.rect(x, top, bw, 1, tone.edge);
  if (li === 0) {
    // Far layer: a couple of hazy lit windows only.
    if (rng.chance(0.5)) {
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        const wx = x + rng.int(2, Math.max(2, bw - 3));
        const wy = top + rng.int(4, Math.max(4, bh - 8));
        pe.set(wx, wy, mix(WINDOW_GLOW[0], tone.body, 0.5));
      }
    }
    return;
  }
  // Ground floor strip (shopfront / lobby) is darker.
  const groundH = li === 2 ? 7 : 5;
  p.rect(x + 1, H - groundH, bw - 2, groundH, tone.dark);
  if (li === 2) {
    const dx = x + 2 + rng.int(0, Math.max(0, bw - 6));
    p.rect(dx, H - 5, 3, 5, tone.win);
    p.set(dx + 1, H - 3, tone.edge);
  }
  // Windows grid.
  const pitchX = li === 2 ? 4 : 3;
  const pitchY = li === 2 ? 5 : 4;
  const ww = li === 2 ? 2 : 1;
  const wh = li === 2 ? 3 : 2;
  for (let wy = top + 3; wy + wh < H - groundH - 1; wy += pitchY) {
    for (let wx = x + 2; wx + ww <= x + bw - 2; wx += pitchX) {
      const r = rng.next();
      if (r < 0.6) {
        p.rect(wx, wy, ww, wh, tone.win);
      } else if (r < 0.78) {
        // Broken: jagged pane showing the pale interior wall.
        p.rect(wx, wy, ww, wh, tone.edge);
        p.set(wx + rng.int(0, ww - 1), wy + rng.int(0, wh - 1), tone.win);
        p.set(wx, wy + wh - 1, INK);
      } else if (r < 0.88) {
        // Boarded.
        p.rect(wx, wy, ww, wh, tone.rust);
        p.set(wx, wy + 1, tone.dark);
      } else if (r < (li === 2 ? 0.95 : 0.93)) {
        const g = rng.pick(WINDOW_GLOW);
        p.rect(wx, wy, ww, wh, g);
        pe.rect(wx, wy, ww, wh, g);
      } else {
        p.rect(wx, wy, ww, wh, tone.dark);
      }
    }
  }
  if (style === 'ruin') {
    // Collapsed corner: erase a stepped wedge, expose floor slabs, leave rebar.
    const zx = x + Math.floor(bw * 0.45);
    let depth = 0;
    const depths = [];
    for (let cx = zx; cx < x + bw; cx++) {
      depth += rng.int(0, 3);
      const d = Math.min(bh - groundH - 2, depth + rng.int(0, 2));
      depths.push(d);
      erase(p, cx, top, 1, d);
      erase(pe, cx, top, 1, d);
    }
    for (let i = 0; i < depths.length; i++) {
      const cx = zx + i;
      const ny = top + depths[i];
      p.set(cx, ny, tone.edge);
      if ((ny - top) % 6 === 0 && rng.chance(0.6)) p.rect(cx - 2, ny, 3, 1, tone.edge);
      if (rng.chance(0.25)) p.line(cx, ny - 1, cx, ny - rng.int(2, 4), tone.rust);
    }
    const eh = depths[depths.length - 1] || 0;
    if (eh > 6 && rng.chance(0.7)) {
      // A dangling wire off the broken edge.
      const wx = x + bw - rng.int(1, 3);
      for (let k = 0; k < rng.int(5, 12); k++) p.set(wx + ((k * k) >> 4), top + eh + k, tone.dark);
    }
  } else if (style === 'tower') {
    // Parapet with a stepped crown.
    p.rect(x + 1, top - 1, bw - 2, 1, tone.edge);
    if (bw > 14) p.rect(x + 3, top - 2, bw - 6, 1, tone.edge);
  }
  // Fire escape on the left face of the near layer.
  if (li === 2 && bw > 12 && rng.chance(0.4)) {
    for (let fy = top + 8; fy < H - groundH - 3; fy += 6) {
      p.rect(x - 4, fy, 5, 1, tone.edge);
      p.line(x - 4, fy - 1, x - 1, fy - 5, tone.edge);
      p.set(x - 4, fy - 2, tone.edge);
      p.set(x - 1, fy - 2, tone.edge);
    }
  }
  // Rooftop clutter.
  const roofY = style === 'tower' ? top - 2 : top;
  if (rng.chance(0.45)) {
    const ax = x + rng.int(2, Math.max(2, bw - 3));
    const ah = rng.int(5, 14);
    p.rect(ax, roofY - ah, 1, ah, tone.dark);
    if (tallest) {
      p.set(ax, roofY - ah - 1, '#ff4d3d');
      pe.set(ax, roofY - ah - 1, '#ff4d3d');
    }
  }
  if (li === 2 && bw > 16 && rng.chance(0.3)) {
    const tx = x + rng.int(2, bw - 9);
    p.rect(tx, roofY - 7, 7, 5, tone.edge);
    p.rect(tx + 1, roofY - 6, 5, 1, tone.body);
    p.rect(tx, roofY - 2, 1, 2, tone.dark);
    p.rect(tx + 6, roofY - 2, 1, 2, tone.dark);
  }
  if (rng.chance(0.4)) {
    const cx = x + rng.int(1, Math.max(1, bw - 4));
    p.rect(cx, roofY - 2, 3, 2, tone.edge);
    p.set(cx + 1, roofY - 2, tone.dark);
  }
  if (hasBillboard && bw >= 20) {
    // Crashed billboard: leaning frame, torn face, faded text blocks.
    const bx = x + 2;
    const by = roofY - 14;
    p.rect(bx + 3, roofY - 6, 1, 6, tone.dark);
    p.rect(bx + 12, roofY - 6, 1, 6, tone.dark);
    for (let r = 0; r < 9; r++) {
      const shear = r >> 2;
      p.rect(bx + shear, by + r, 16, 1, r === 0 || r === 8 ? tone.edge : BILLBOARD_FACE[r < 3 ? 0 : r < 6 ? 1 : 2]);
      p.set(bx + shear, by + r, tone.edge);
      p.set(bx + shear + 15, by + r, tone.edge);
    }
    p.rect(bx + 3, by + 2, 4, 2, '#5a4a44');
    p.rect(bx + 8, by + 2, 6, 2, '#5a4a44');
    p.rect(bx + 4, by + 5, 8, 2, '#6a3a34');
    for (let r = 4; r < 9; r++) {
      erase(p, bx + 10 + (r - 4) * 1.4, by + r, 16, 1);
    }
    p.set(bx + 10, by + 4, tone.edge);
    p.set(bx + 11, by + 5, tone.edge);
  }
}

/** Builds one tileable cityscape layer at unit resolution. */
function buildCityscape(seed, li, W) {
  const tone = CITY_TONES[li];
  const rng = makeRng(seed).fork('city' + li);
  const H = CITY_H;
  // Plan the buildings first so wires and the tallest antenna can refer to neighbours.
  const plan = [];
  let x = 0;
  const minW = li === 0 ? 14 : li === 1 ? 12 : 10;
  const maxW = li === 0 ? 40 : li === 1 ? 32 : 30;
  while (x < W) {
    const bw = rng.int(minW, maxW);
    const bh = li === 0 ? rng.int(40, 112) : li === 1 ? rng.int(28, 92) : rng.int(22, 78);
    const style = rng.weighted([['tower', 40], ['ruin', 35], ['slab', 25]]);
    plan.push({ x, bw, bh, style });
    x += bw + (li === 2 ? rng.int(1, 4) : rng.int(0, 2));
  }
  let tallest = 0;
  for (let i = 1; i < plan.length; i++) if (plan[i].bh > plan[tallest].bh) tallest = i;
  const billboardAt = li === 2 ? rng.int(0, plan.length - 1) : -1;
  return layerPair(W, H, (p, pe) => {
    for (let i = 0; i < plan.length; i++) {
      const b = plan[i];
      tiled(W, b.x, b.bw + 6, (ox) => drawBuilding(p, pe, rng.fork('b' + i), ox, b.bw, b.bh, b.style, tone, li, H, i === billboardAt, i === tallest));
    }
    if (li === 2) {
      // Wires strung between rooftops (catenaries).
      for (let i = 0; i < plan.length; i++) {
        if (!rng.chance(0.55)) continue;
        const a = plan[i];
        const b = plan[(i + 1) % plan.length];
        const ax = a.x + a.bw - 1;
        const ay = H - a.bh + (a.style === 'ruin' ? Math.floor(a.bh * 0.35) : 0);
        const bx = i + 1 < plan.length ? b.x : b.x + W;
        const by = H - b.bh + (b.style === 'ruin' ? 2 : 0);
        const sag = rng.int(3, 7);
        const n = Math.max(1, bx - ax);
        for (let k = 0; k <= n; k++) {
          const u = k / n;
          const wy = Math.round(ay + (by - ay) * u + sag * 4 * u * (1 - u));
          p.set(ax + k, wy, tone.dark);
          if (ax + k >= W) p.set(ax + k - W, wy, tone.dark);
        }
      }
    }
    if (li < 2) {
      // Smoke column from one ruin.
      const ruins = plan.filter((b) => b.style === 'ruin');
      if (ruins.length) {
        const r = rng.pick(ruins);
        let sx = r.x + Math.floor(r.bw * 0.7);
        for (let sy = H - r.bh + 2; sy > 4; sy--) {
          sx += rng.int(-1, 1);
          const w = 1 + Math.floor((H - r.bh - sy) / 10);
          for (let k = -w; k <= w; k++) {
            if (rng.chance(0.55)) p.set(((sx + k) % W + W) % W, sy, mix(tone.haze, tone.dark, 0.5));
          }
        }
      }
      hazeRows(p, H - 34, H, tone.haze, li === 0 ? 0.85 : 0.6);
    } else {
      hazeRows(p, H - 16, H, tone.haze, 0.35);
    }
  });
}

/**
 * A tileable ruined-skyline parallax layer. Layer 0 is a hazy far silhouette,
 * layer 2 the detailed near one (broken/boarded windows, fire escapes, wires,
 * a crashed billboard). Lit windows and the antenna beacon are returned
 * separately in `emissive` for the bloom layer. Sprites are W×CITY_H with a
 * top-left anchor.
 * @param {number|string} seed @param {number} layerIdx 0 (far) … 2 (near) @param {number} W width in units
 * @returns {{ spr: object, emissive: object }}
 */
export function makeCityscape(seed, layerIdx, W) {
  const li = clampInt(layerIdx, 0, 2);
  const w = Math.max(32, W | 0);
  return cached('bg:city:' + seed + ':' + li + ':' + w, () => buildCityscape(seed, li, w));
}

/**
 * Three cityscape layers stacked for the siege, nearer layers sitting lower.
 * @param {number|string} seed @param {number} W width in units
 * @returns {{ layers: Array<{ spr: object, emissive: object, parallax: number, y: number }> }}
 */
export function makeSiegeSkyline(seed, W) {
  return cached('bg:siege-sky:' + seed + ':' + (W | 0), () => {
    const layers = [];
    const par = [0.12, 0.28, 0.5];
    const ys = [0, 12, 26];
    for (let i = 0; i < 3; i++) {
      const c = makeCityscape(seed, i, W);
      layers.push({ spr: c.spr, emissive: c.emissive, parallax: par[i], y: ys[i] });
    }
    return { layers };
  });
}

// ───────────────────────────── zone prop kit ─────────────────────────────

const R_ASPHALT = ramp('#3b3a44', 5);
const R_CONCRETE = PAL.concrete;
const R_SAND = PAL.sand;
const R_WOOD = PAL.wood;
const R_METAL = PAL.metal;
const R_METAL_DARK = PAL.metalDark;
const R_OLIVE = ramp('#5a6642', 5);
const R_DIRT = ramp('#4a3e32', 5);
const R_LINO_A = ramp('#6e7c6a', 4);
const R_LINO_B = ramp('#7e8c78', 4);
const R_RUST = PAL.rust;
const BLOOD_DRY = PAL.bloodDry[1];
const HAZARD_YELLOW = '#c9a63a';

/** Paints a 1px light rim on the left/top silhouette edge and a shadow on the bottom edge inside a bbox. */
function rim(p, x, y, w, h, lightHex, shadowHex) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (p.alpha(xx, yy) === 0) continue;
      if (lightHex && (p.alpha(xx - 1, yy) === 0 || p.alpha(xx, yy - 1) === 0)) p.set(xx, yy, lightHex);
      else if (shadowHex && p.alpha(xx, yy + 1) === 0) p.set(xx, yy, shadowHex);
    }
  }
}

/** Layered conifer: stacked tiers, lit left edge, needle speckle. c = [shadow, base, light, trunk]. */
function pine(p, rng, x, baseY, h, c) {
  const trunkH = Math.max(3, Math.floor(h * 0.14));
  p.rect(x - 1, baseY - trunkH, 2, trunkH, c[3]);
  const tiers = 3 + Math.floor(h / 22);
  const tierH = Math.floor((h - trunkH) / tiers) + 5;
  let halfW = Math.max(4, Math.floor(h * 0.2));
  let y = baseY - trunkH + 2;
  let top = y;
  for (let i = 0; i < tiers; i++) {
    top = y - tierH;
    tri(p, x + (i & 1 ? rng.int(-1, 1) : 0), top, halfW, tierH, c[1]);
    p.rect(x - halfW, y - 1, halfW * 2 + 1, 1, c[0]);
    y = top + Math.floor(tierH * 0.5);
    halfW = Math.max(2, Math.floor(halfW * 0.78));
  }
  const bx = x - Math.floor(h * 0.22) - 1;
  const bw = Math.floor(h * 0.44) + 3;
  speckle(p, rng, bx, top, bw, baseY - top, c[0], 0.14);
  rim(p, bx, top, bw, baseY - top - trunkH, c[2], null);
}

/** Leafless dead tree: trunk plus two levels of branches. */
function bareTree(p, rng, x, baseY, h, hex) {
  p.rect(x, baseY - h, 2, h, hex);
  for (let i = 0; i < rng.int(3, 5); i++) {
    const by = baseY - h + rng.int(2, Math.floor(h * 0.6));
    const dir = rng.sign();
    const len = rng.int(4, 9);
    p.line(x + (dir > 0 ? 1 : 0), by, x + dir * len, by - rng.int(3, len), hex);
    if (rng.chance(0.6)) p.line(x + dir * (len >> 1), by - rng.int(1, 3), x + dir * (len >> 1) + dir * rng.int(2, 4), by - rng.int(4, 8), hex);
  }
}

/** Picket fence: posts every 12, thin pickets, some leaning or missing. */
function picketFence(p, rng, x0, x1, baseY, h, c) {
  p.rect(x0, baseY - h + 2, x1 - x0, 1, c[0]);
  p.rect(x0, baseY - 3, x1 - x0, 1, c[0]);
  for (let x = x0; x < x1; x += 3) {
    const r = rng.next();
    if (r < 0.1) continue;
    if (r < 0.2) {
      p.line(x, baseY - 1, x + 2, baseY - h + 1, c[1]);
      continue;
    }
    p.rect(x, baseY - h, 1, h, c[1]);
    p.set(x, baseY - h, c[2]);
    if ((x - x0) % 12 === 0) {
      p.rect(x, baseY - h - 1, 2, h + 1, c[1]);
      p.set(x, baseY - h - 1, c[2]);
    }
  }
}

function mailbox(p, rng, x, baseY) {
  p.rect(x, baseY - 9, 1, 9, R_WOOD[1]);
  dome(p, x + 3, baseY - 12, 3, 2, R_METAL[2]);
  p.rect(x - 1, baseY - 12, 7, 3, R_METAL[2]);
  p.rect(x - 1, baseY - 10, 7, 1, R_METAL_DARK[1]);
  p.rect(x + 5, baseY - 14, 1, 3, rng.chance(0.5) ? '#a83232' : R_METAL_DARK[2]);
  p.set(x - 1, baseY - 12, R_METAL[3]);
}

function hedge(p, rng, x, baseY, w, h, c) {
  dome(p, x + (w >> 1), baseY, w >> 1, h, c[1]);
  speckle(p, rng, x, baseY - h, w, h, c[0], 0.2);
  rim(p, x, baseY - h, w, h, c[2], c[0]);
}

function trashBin(p, x, baseY, hex) {
  p.rect(x, baseY - 8, 6, 8, hex);
  p.rect(x - 1, baseY - 9, 8, 1, mix(hex, '#ffffff', 0.15));
  p.rect(x + 1, baseY - 7, 1, 6, mix(hex, '#ffffff', 0.12));
  p.rect(x + 4, baseY - 7, 1, 6, mix(hex, INK, 0.3));
}

/** Suburban house with gable roof, porch, boarded/lit windows and a chimney. */
function house(p, pe, rng, x, baseY, w, h, wall, roof, lit) {
  const top = baseY - h;
  p.rect(x, top, w, h, wall[1]);
  for (let y = top + 2; y < baseY; y += 3) p.rect(x, y, w, 1, wall[0]);
  p.rect(x, top, 1, h, wall[2]);
  p.rect(x + w - 1, top, 1, h, wall[0]);
  const roofH = Math.floor(w * 0.32);
  tri(p, x + (w >> 1), top - roofH, (w >> 1) + 3, roofH + 1, roof[1]);
  for (let r = 1; r < roofH; r += 2) {
    const hw = Math.round((((w >> 1) + 3) * r) / roofH);
    p.dither(x + (w >> 1) - hw, top - roofH + r, hw * 2 + 1, 1, roof[1], roof[0], 0.5);
  }
  rim(p, x - 4, top - roofH - 1, w + 8, roofH + 2, roof[3], null);
  p.rect(x - 3, top, w + 6, 1, roof[0]);
  if (rng.chance(0.7)) {
    const cx = x + w - rng.int(5, 8);
    p.rect(cx, top - roofH + 2, 3, roofH - 1, PAL.brick[1]);
    p.rect(cx, top - roofH + 1, 3, 1, PAL.brick[2]);
  }
  // Door and porch.
  const dx = x + (w >> 1) - 2;
  p.rect(dx, baseY - 10, 5, 10, R_WOOD[0]);
  p.rect(dx + 1, baseY - 9, 3, 4, R_WOOD[1]);
  p.set(dx + 3, baseY - 5, R_METAL[3]);
  p.rect(x - 2, baseY - 2, w + 4, 2, R_WOOD[1]);
  p.rect(x - 2, baseY - 2, w + 4, 1, R_WOOD[2]);
  p.rect(x - 2, baseY - 12, 1, 10, R_WOOD[1]);
  p.rect(x + w + 1, baseY - 12, 1, 10, R_WOOD[1]);
  p.rect(x - 3, baseY - 13, w + 6, 1, R_WOOD[0]);
  // Windows either side of the door.
  const wins = [x + 3, x + w - 9];
  for (let i = 0; i < 2; i++) {
    const wx = wins[i];
    const wy = baseY - 12;
    p.rect(wx, wy, 6, 6, wall[2]);
    const r = rng.next();
    if (r < 0.35) {
      p.rect(wx + 1, wy + 1, 4, 4, '#1e2432');
      p.set(wx + 1, wy + 1, '#3a4658');
    } else if (r < 0.7) {
      p.rect(wx + 1, wy + 1, 4, 4, R_WOOD[0]);
      p.line(wx + 1, wy + 1, wx + 4, wy + 4, R_WOOD[1]);
      p.line(wx + 4, wy + 1, wx + 1, wy + 4, R_WOOD[1]);
    } else if (r < 0.85 || lit) {
      p.rect(wx + 1, wy + 1, 4, 4, '#ffcf7a');
      pe.rect(wx + 1, wy + 1, 4, 4, '#ffb347');
      p.set(wx + 3, wy + 1, '#fff0c0');
    } else {
      p.rect(wx + 1, wy + 1, 4, 4, '#1e2432');
      p.set(wx + 2, wy + 2, wall[3]);
      p.set(wx + 3, wy + 3, INK);
    }
  }
  // Attic vent and soot.
  p.rect(x + (w >> 1) - 1, top - roofH + 5, 3, 3, roof[0]);
  if (rng.chance(0.35)) speckle(p, rng, x + 2, top + 2, w - 4, 8, INK, 0.25);
}

/** Street lamp post (cool or sodium head). */
function lampPost(p, pe, x, baseY, h, headHex) {
  p.rect(x, baseY - h, 2, h, R_METAL_DARK[2]);
  p.rect(x, baseY - h, 1, h, R_METAL_DARK[3]);
  p.rect(x - 1, baseY - 1, 4, 1, R_METAL_DARK[1]);
  p.rect(x - 6, baseY - h - 1, 7, 1, R_METAL_DARK[2]);
  p.rect(x - 8, baseY - h, 5, 2, R_METAL_DARK[3]);
  p.rect(x - 7, baseY - h + 2, 3, 1, headHex);
  pe.rect(x - 7, baseY - h + 2, 3, 1, headHex);
}

/** Storefront with sign box, torn awning, glass front and door; `sign` = emissive colour or null. */
function storefront(p, pe, rng, x, baseY, w, h, facade, sign, awningHex) {
  const top = baseY - h;
  const f = ramp(facade, 4);
  p.rect(x, top, w, h, f[1]);
  p.rect(x, top, w, 2, f[2]);
  p.rect(x, top + 2, w, 1, f[0]);
  p.rect(x, top, 1, h, f[2]);
  p.rect(x + w - 1, top, 1, h, f[0]);
  for (let y = top + 6; y < baseY - 26; y += 4) {
    for (let bx = x + ((y >> 2) & 1) * 3; bx < x + w - 1; bx += 6) p.set(bx, y, f[0]);
  }
  // Sign box.
  const sy = top + 5;
  p.rect(x + 3, sy, w - 6, 9, '#22242c');
  p.rect(x + 3, sy, w - 6, 1, '#3a3d48');
  let lx = x + 6;
  const glyphs = rng.int(3, Math.min(6, Math.floor((w - 10) / 5)));
  for (let i = 0; i < glyphs; i++) {
    const missing = rng.chance(0.25);
    const col = missing ? '#3a3d48' : sign ? sign : '#8a8e98';
    p.rect(lx, sy + 2, 3, 5, col);
    p.set(lx + 1, sy + 4, missing ? '#3a3d48' : '#22242c');
    if (!missing && sign) pe.rect(lx, sy + 2, 3, 5, sign);
    lx += 5;
  }
  // Awning: striped, sagging, torn at one end.
  const ay = top + 16;
  const a = ramp(awningHex, 4);
  for (let r = 0; r < 5; r++) {
    for (let ax = x + 1; ax < x + w - 1; ax++) {
      const sag = Math.abs((ax - (x + (w >> 1))) / (w >> 1));
      const yy = ay + r + Math.round((1 - sag) * 2);
      if (r === 4 && ((ax - x) & 3) === 3) continue;
      const stripe = (((ax - x) >> 2) & 1) === 0;
      p.set(ax, yy, r === 0 ? a[3] : r === 4 ? a[0] : stripe ? a[2] : a[1]);
    }
  }
  const tearX = x + w - rng.int(6, 12);
  for (let r = 0; r < 6; r++) erase(p, tearX + r, ay + r, w, 1);
  p.line(tearX, ay + 5, tearX + 2, ay + 9, a[0]);
  // Glass front.
  const gy = ay + 9;
  const gh = baseY - gy - 1;
  p.rect(x + 2, gy, w - 4, gh, '#2a3644');
  p.rect(x + 2, gy, w - 4, 1, '#54687a');
  const panes = w > 56 ? 3 : 2;
  const pw = Math.floor((w - 4) / panes);
  for (let i = 1; i < panes; i++) p.rect(x + 2 + i * pw, gy, 1, gh, R_METAL_DARK[1]);
  for (let i = 0; i < panes; i++) {
    const px0 = x + 2 + i * pw;
    p.line(px0 + 2, gy + gh - 2, px0 + pw - 3, gy + 1, '#3d4c5c');
    if (rng.chance(0.5)) {
      const cx = px0 + rng.int(2, pw - 3);
      const cy = gy + rng.int(2, gh - 3);
      p.line(cx, cy, cx + rng.int(-4, 4), cy + rng.int(3, 6), '#8fa4b8');
      p.line(cx, cy, cx + rng.int(2, 5), cy - rng.int(2, 5), '#8fa4b8');
      p.line(cx, cy, cx - rng.int(3, 6), cy - rng.int(1, 3), '#8fa4b8');
    }
    if (rng.chance(0.3)) {
      erase(p, px0 + 1, gy + 3, pw - 2, gh - 4);
      p.rect(px0 + 1, gy + 3, pw - 2, gh - 4, '#141820');
      for (let k = 0; k < 6; k++) p.set(px0 + rng.int(1, pw - 2), gy + rng.int(3, gh - 2), '#3d4c5c');
    }
  }
  // Door with push bar.
  const dx = x + (w >> 1) - 4;
  p.rect(dx, gy, 8, gh, '#1c2430');
  p.rect(dx, gy, 1, gh, R_METAL_DARK[2]);
  p.rect(dx + 7, gy, 1, gh, R_METAL_DARK[2]);
  p.rect(dx + 1, gy + Math.floor(gh * 0.55), 6, 1, R_METAL[3]);
  if (rng.chance(0.5)) {
    p.rect(dx - 1, gy + 4, 10, 1, HAZARD_YELLOW);
    p.rect(dx - 1, gy + 8, 10, 1, HAZARD_YELLOW);
  }
}

function bollard(p, x, baseY) {
  p.rect(x, baseY - 8, 3, 8, HAZARD_YELLOW);
  p.rect(x, baseY - 6, 3, 2, INK);
  p.rect(x, baseY - 3, 3, 1, INK);
  p.set(x, baseY - 8, '#e8c86a');
  p.rect(x - 1, baseY - 1, 5, 1, R_METAL_DARK[1]);
}

function shoppingCart(p, x, baseY, hex, tipped) {
  if (tipped) {
    p.frame(x, baseY - 6, 12, 6, hex);
    p.line(x + 3, baseY - 5, x + 3, baseY - 1, hex);
    p.line(x + 7, baseY - 5, x + 7, baseY - 1, hex);
    p.fillCircle(x + 13, baseY - 5, 1, hex);
    p.fillCircle(x + 13, baseY - 1, 1, hex);
    return;
  }
  p.frame(x + 1, baseY - 10, 10, 6, hex);
  p.line(x + 4, baseY - 9, x + 4, baseY - 5, hex);
  p.line(x + 7, baseY - 9, x + 7, baseY - 5, hex);
  p.line(x + 11, baseY - 10, x + 13, baseY - 13, hex);
  p.rect(x + 1, baseY - 4, 1, 3, hex);
  p.rect(x + 10, baseY - 4, 1, 3, hex);
  p.set(x + 1, baseY - 1, INK);
  p.set(x + 10, baseY - 1, INK);
}

/** Quonset hangar with corrugated skin and a big dark door. */
function hangar(p, x, baseY, w, h, c) {
  const cx = x + (w >> 1);
  dome(p, cx, baseY, w >> 1, h, c[1]);
  for (let sx = x + 2; sx < x + w - 1; sx += 3) {
    for (let yy = baseY - h; yy <= baseY; yy++) if (p.alpha(sx, yy) > 0) p.set(sx, yy, c[0]);
  }
  rim(p, x - 1, baseY - h - 1, w + 2, h + 2, c[2], null);
  p.rect(cx - (w >> 3), baseY - Math.floor(h * 0.55), (w >> 2), Math.floor(h * 0.55), c[0]);
  p.rect(cx - (w >> 3), baseY - Math.floor(h * 0.55), 1, Math.floor(h * 0.55), c[2]);
}

/** Chain-link fence: mesh dither, posts, top rail and a barbed coil. */
function chainlink(p, rng, x0, x1, baseY, h, mesh, post) {
  for (let y = baseY - h; y < baseY; y++) {
    for (let x = x0; x < x1; x++) {
      if (((x + y) & 3) === 0 || ((x - y) & 3) === 0) p.set(x, y, mesh, 0.55);
    }
  }
  p.rect(x0, baseY - h, x1 - x0, 1, post);
  for (let x = x0; x < x1; x += 28) {
    p.rect(x, baseY - h - 2, 2, h + 2, post);
    p.set(x, baseY - h - 2, mesh);
  }
  for (let x = x0 + 1; x < x1; x += 4) p.ring(x, baseY - h - 2, 2, mesh);
  for (let i = 0; i < 3; i++) {
    const tx = x0 + rng.int(4, Math.max(5, x1 - x0 - 8));
    const ty = baseY - h + rng.int(6, Math.max(7, h - 14));
    p.rect(tx, ty, 7, 5, HAZARD_YELLOW);
    p.rect(tx, ty, 7, 1, INK);
    p.rect(tx + 1, ty + 2, 5, 2, INK);
    p.set(tx + 3, ty + 2, HAZARD_YELLOW);
  }
}

/** Stacked sandbag wall: rows of rounded bags with a dark seam. */
function sandbagWall(p, x, baseY, w, rows) {
  for (let r = 0; r < rows; r++) {
    const y = baseY - r * 3;
    const off = (r & 1) * 4;
    for (let bx = x - off; bx < x + w; bx += 8) {
      const bw = Math.min(8, x + w - bx);
      if (bw < 3) continue;
      p.rect(bx + 1, y - 3, bw - 1, 3, R_SAND[1]);
      p.rect(bx + 1, y - 3, bw - 1, 1, R_SAND[2]);
      p.set(bx + 1, y - 3, R_SAND[3]);
      p.rect(bx + 1, y - 1, bw - 1, 1, R_SAND[0]);
      p.rect(bx, y - 3, 1, 3, PAL.sand[0]);
    }
  }
}

function jerseyBarrier(p, x, baseY, w) {
  p.rect(x, baseY - 4, w, 4, R_CONCRETE[1]);
  p.rect(x + 1, baseY - 7, w - 2, 3, R_CONCRETE[2]);
  p.rect(x + 2, baseY - 10, w - 4, 3, R_CONCRETE[2]);
  p.rect(x + 2, baseY - 10, w - 4, 1, R_CONCRETE[3]);
  p.rect(x, baseY - 1, w, 1, R_CONCRETE[0]);
  p.rect(x + 3, baseY - 9, 3, 1, R_RUST[1]);
}

function crate(p, x, baseY, w, h, c) {
  p.rect(x, baseY - h, w, h, c[1]);
  p.frame(x, baseY - h, w, h, c[0]);
  p.rect(x, baseY - h, w, 1, c[2]);
  p.rect(x + 2, baseY - h + 2, w - 4, 1, c[3]);
  p.rect(x + 2, baseY - 3, 3, 1, c[0]);
}

function oilDrum(p, x, baseY, c) {
  p.rect(x, baseY - 11, 7, 11, c[1]);
  p.rect(x, baseY - 11, 1, 11, c[2]);
  p.rect(x + 6, baseY - 11, 1, 11, c[0]);
  p.rect(x, baseY - 8, 7, 1, c[0]);
  p.rect(x, baseY - 4, 7, 1, c[0]);
  p.rect(x, baseY - 12, 7, 1, c[2]);
}

/** Warning strobe on a pole; the lamp is emissive. */
function strobe(p, pe, x, baseY, h, hex) {
  p.rect(x, baseY - h, 1, h, R_METAL_DARK[1]);
  p.rect(x - 1, baseY - 1, 3, 1, R_METAL_DARK[0]);
  p.rect(x - 1, baseY - h - 3, 3, 3, hex);
  p.set(x, baseY - h - 2, '#ffd0c8');
  pe.rect(x - 1, baseY - h - 3, 3, 3, hex);
}

/** A-frame tent with an open flap and guy lines. */
function tent(p, rng, x, baseY, w, h, c) {
  tri(p, x + (w >> 1), baseY - h, w >> 1, h, c[1]);
  rim(p, x - 1, baseY - h - 1, w + 2, h + 1, c[2], c[0]);
  tri(p, x + (w >> 1), baseY - (h >> 1), w >> 2, h >> 1, c[0]);
  p.line(x - 3, baseY - 1, x + 1, baseY - h + 4, c[0]);
  p.line(x + w + 3, baseY - 1, x + w - 1, baseY - h + 4, c[0]);
  speckle(p, rng, x, baseY - h, w, h, c[0], 0.05);
}

/** Campfire ring with logs and embers (emissive). */
function campfire(p, pe, x, baseY) {
  for (let i = -5; i <= 5; i += 2) p.set(x + i, baseY - 1 + ((i & 2) ? 0 : 1) - 1, R_CONCRETE[1]);
  p.rect(x - 3, baseY - 3, 6, 1, R_WOOD[0]);
  p.line(x - 2, baseY - 2, x + 3, baseY - 5, R_WOOD[1]);
  p.rect(x - 1, baseY - 4, 3, 2, '#ff6a1a');
  p.set(x, baseY - 5, '#ffb347');
  p.set(x + 1, baseY - 6, '#ff6a1a');
  pe.rect(x - 1, baseY - 4, 3, 2, '#ff6a1a');
  pe.set(x, baseY - 5, '#ffb347');
}

/** Gurney silhouette with a sheeted body. */
function gurney(p, x, baseY, c) {
  p.rect(x, baseY - 8, 20, 2, c[1]);
  p.rect(x, baseY - 8, 20, 1, c[2]);
  p.rect(x + 3, baseY - 6, 1, 5, c[1]);
  p.rect(x + 16, baseY - 6, 1, 5, c[1]);
  p.rect(x + 2, baseY - 1, 3, 1, c[0]);
  p.rect(x + 15, baseY - 1, 3, 1, c[0]);
  dome(p, x + 10, baseY - 8, 7, 3, c[2]);
  p.rect(x + 3, baseY - 9, 14, 1, c[2]);
}

function ivStand(p, x, baseY, c) {
  p.rect(x, baseY - 24, 1, 24, c[1]);
  p.rect(x - 2, baseY - 1, 5, 1, c[0]);
  p.rect(x - 3, baseY - 24, 7, 1, c[1]);
  p.rect(x - 4, baseY - 23, 3, 5, c[2]);
  p.set(x - 3, baseY - 22, '#c8e8d0');
}

function wheelchair(p, x, baseY, c) {
  p.ring(x + 3, baseY - 4, 4, c[1]);
  p.fillCircle(x + 9, baseY - 2, 1, c[1]);
  p.rect(x + 3, baseY - 12, 1, 6, c[1]);
  p.rect(x + 3, baseY - 7, 7, 1, c[2]);
  p.rect(x + 2, baseY - 13, 3, 1, c[2]);
}

/** Hospital double doors with porthole windows and kick plates. */
function doubleDoor(p, x, baseY, c) {
  p.rect(x, baseY - 44, 26, 44, c[1]);
  p.rect(x - 1, baseY - 45, 28, 1, c[0]);
  p.rect(x - 1, baseY - 45, 1, 45, c[0]);
  p.rect(x + 26, baseY - 45, 1, 45, c[0]);
  p.rect(x + 12, baseY - 44, 2, 44, c[0]);
  for (let i = 0; i < 2; i++) {
    const wx = x + 3 + i * 14;
    p.rect(wx, baseY - 36, 7, 10, '#26322c');
    p.rect(wx, baseY - 36, 7, 1, '#4a5c52');
    p.set(wx + 1, baseY - 35, '#5c7066');
    p.rect(wx - 1, baseY - 10, 9, 5, R_METAL[2]);
    p.rect(wx - 1, baseY - 10, 9, 1, R_METAL[3]);
    p.rect(wx + 2, baseY - 24, 3, 1, R_METAL[3]);
  }
}

/** Ceiling fluorescent fixture; `state` 0 dead, 1 lit. */
function tubeLight(p, pe, x, y, state) {
  p.rect(x + 11, y - 4, 1, 4, R_METAL_DARK[1]);
  p.rect(x + 22, y - 4, 1, 4, R_METAL_DARK[1]);
  p.rect(x, y, 34, 4, '#6a7468');
  p.rect(x, y, 34, 1, '#7c8a7a');
  if (state) {
    p.rect(x + 2, y + 2, 30, 2, '#d8f4d0');
    p.rect(x + 2, y + 2, 30, 1, '#f0fff0');
    pe.rect(x + 2, y + 2, 30, 2, '#b8f0c0');
  } else {
    p.rect(x + 2, y + 2, 30, 2, '#4e5a52');
    p.set(x + 9, y + 3, '#66706a');
  }
}

/** Steel lattice pylon in a single tone. */
function pylon(p, x, baseY, h, hex) {
  p.line(x - 4, baseY, x - 1, baseY - h, hex);
  p.line(x + 4, baseY, x + 1, baseY - h, hex);
  for (let y = baseY - 4; y > baseY - h; y -= 5) {
    const hw = Math.round((4 * (y - (baseY - h))) / h);
    p.rect(x - hw, y, hw * 2 + 1, 1, hex);
  }
  p.rect(x - 7, baseY - h + 6, 15, 1, hex);
  p.rect(x - 5, baseY - h + 12, 11, 1, hex);
}

// ───────────────────────────── ground tiles ─────────────────────────────

/** Asphalt: kerb strip on top, noise body, worley cracks, optional painted bay lines. */
function groundAsphalt(p, nz, rng, W, h, opts) {
  const kerbH = opts.kerb ? 12 : 0;
  if (kerbH) {
    texFill(p, nz, 0, 0, W, kerbH - 3, R_CONCRETE, 9, W, 0);
    for (let x = 0; x < W; x += 24) p.rect(x, 0, 1, kerbH - 3, R_CONCRETE[0]);
    p.rect(0, kerbH - 3, W, 2, R_CONCRETE[0]);
    p.rect(0, kerbH - 1, W, 1, INK);
    p.rect(0, 0, W, 1, R_CONCRETE[3]);
  }
  texFill(p, nz, 0, kerbH, W, h - kerbH, R_ASPHALT, 7, W, 0);
  for (let y = kerbH; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const e = nz.worleyEdge(x / 22, y / 22) * (1 - u) + nz.worleyEdge((x - W) / 22, y / 22) * u;
      if (e < 0.035) p.set(x, y, R_ASPHALT[0]);
      if (e < 0.012) p.set(x, y, INK);
    }
  }
  if (opts.centreLine) {
    const ly = kerbH + Math.floor((h - kerbH) * 0.45);
    for (let x = 0; x < W; x++) if ((x % 16) < 9 && rng.chance(0.85)) p.set(x, ly, '#b8ad8a');
  }
  if (opts.bays) {
    for (let x = 12; x < W; x += 40) {
      for (let y = kerbH + 4; y < h - 8; y++) if (rng.chance(0.8)) p.rect(x, y, 2, 1, '#a8a394');
    }
    for (let i = 0; i < 2; i++) {
      const ox = rng.int(10, W - 10);
      const oy = kerbH + rng.int(10, h - 20);
      for (let yy = -4; yy <= 4; yy++) {
        for (let xx = -10; xx <= 10; xx++) {
          if (xx * xx / 100 + yy * yy / 16 <= 1 && bayer(ox + xx, oy + yy) < 0.6) p.set(((ox + xx) % W + W) % W, oy + yy, '#1e1d26');
        }
      }
    }
  }
  if (opts.manhole) {
    const mx = rng.int(20, W - 20);
    const my = kerbH + Math.floor((h - kerbH) * 0.6);
    p.ellipse(mx, my, 6, 3, R_METAL_DARK[1]);
    p.ellipse(mx, my - 1, 5, 2, R_METAL_DARK[2]);
    p.rect(mx - 3, my - 1, 6, 1, R_METAL_DARK[0]);
  }
  speckle(p, rng, 0, kerbH, W, h - kerbH, R_ASPHALT[3], 0.015);
  if (opts.leaves) speckle(p, rng, 0, kerbH, W, 14, '#6a4a30', 0.04);
  hazeRows(p, h - 24, h, INK, 0.45);
}

/** Linoleum: two-tone checker tiles, grout, grime, a blood trail, dropped paper. */
function groundLino(p, nz, rng, W, h) {
  const T = 12;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const tx = Math.floor(x / T);
      const ty = Math.floor(y / T);
      const c = ((tx + ty) & 1) ? R_LINO_A : R_LINO_B;
      const grout = (x % T) === 0 || (y % T) === 0;
      const u = x / W;
      const n = nz.fbm(x / 9, y / 9, 3) * (1 - u) + nz.fbm((x - W) / 9, y / 9, 3) * u;
      p.set(x, y, grout ? c[0] : n > 0.62 ? c[2] : n < 0.36 ? c[0] : c[1]);
    }
  }
  p.rect(0, 0, W, 1, R_LINO_A[3]);
  let bx = rng.int(0, W);
  let by = rng.int(8, h - 30);
  for (let i = 0; i < 60; i++) {
    bx = ((bx + rng.int(-2, 3)) % W + W) % W;
    by += rng.int(-1, 1);
    p.rect(bx, by, rng.int(1, 3), 1, BLOOD_DRY);
    if (rng.chance(0.2)) p.set(bx + rng.int(-2, 2), by + rng.int(-2, 2), PAL.bloodDry[0]);
  }
  for (let i = 0; i < 4; i++) {
    const px0 = rng.int(0, W - 6);
    const py0 = rng.int(4, h - 12);
    p.rect(px0, py0, 5, 4, '#d9d2c0');
    p.rect(px0, py0, 5, 1, PAL.paper);
    p.set(px0 + 1, py0 + 2, '#8a8478');
  }
  speckle(p, rng, 0, 0, W, h, '#4c5a48', 0.04);
  hazeRows(p, h - 24, h, INK, 0.45);
}

/** Dirt with roots, pine needles, pebbles and moss. */
function groundDirt(p, nz, rng, W, h) {
  texFill(p, nz, 0, 0, W, h, R_DIRT, 6, W, 0);
  for (let i = 0; i < 5; i++) {
    let rx = rng.int(0, W);
    let ry = rng.int(2, h - 10);
    const dir = rng.sign();
    for (let k = 0; k < rng.int(18, 40); k++) {
      rx = ((rx + dir) % W + W) % W;
      ry += rng.chance(0.3) ? rng.int(-1, 1) : 0;
      p.set(rx, ry, '#2e2418');
      if (k % 3 === 0) p.set(rx, ry - 1, '#5c4a38');
    }
  }
  speckle(p, rng, 0, 0, W, h, '#6a4a30', 0.05);
  speckle(p, rng, 0, 0, W, h, '#8a6a40', 0.015);
  for (let i = 0; i < 14; i++) {
    const px0 = rng.int(0, W - 2);
    const py0 = rng.int(0, h - 2);
    p.rect(px0, py0, 2, 1, R_CONCRETE[2]);
    p.set(px0, py0 + 1, R_CONCRETE[0]);
  }
  for (let i = 0; i < 6; i++) {
    const mx = rng.int(0, W);
    const my = rng.int(0, h - 4);
    for (let yy = 0; yy < 3; yy++) for (let xx = -4; xx <= 4; xx++) if (rng.chance(0.55)) p.set(((mx + xx) % W + W) % W, my + yy, PAL.moss[yy === 0 ? 3 : 2]);
  }
  p.rect(0, 0, W, 1, R_DIRT[3]);
  hazeRows(p, h - 24, h, INK, 0.45);
}

/** Concrete pads with expansion joints, a faded hazard stripe, tire marks and stains. */
function groundConcrete(p, nz, rng, W, h) {
  texFill(p, nz, 0, 0, W, h, R_CONCRETE, 10, W, -0.5);
  for (let x = 0; x < W; x += 39) p.rect(x, 0, 1, h, R_CONCRETE[0]);
  for (let y = 0; y < h; y += 40) p.rect(0, y, W, 1, R_CONCRETE[0]);
  for (let x = 0; x < W; x++) {
    for (let y = 14; y < 18; y++) if (bayer(x, y) < 0.7 && ((x >> 3) & 1) === 0) p.set(x, y, HAZARD_YELLOW);
  }
  for (let i = 0; i < 2; i++) {
    const tx = rng.int(0, W);
    for (let y = 20; y < h - 10; y++) {
      const xx = tx + Math.floor((y - 20) * 0.35);
      for (let k = 0; k < 5; k++) if (bayer(xx + k, y) < 0.5) p.set(((xx + k) % W + W) % W, y, R_ASPHALT[0]);
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const e = nz.worleyEdge(x / 30, y / 30) * (1 - u) + nz.worleyEdge((x - W) / 30, y / 30) * u;
      if (e < 0.02 && nz.v2(x / 5, y / 5) > 0.5) p.set(x, y, R_CONCRETE[0]);
    }
  }
  const ox = rng.int(10, W - 10);
  const oy = rng.int(30, h - 20);
  for (let yy = -5; yy <= 5; yy++) for (let xx = -12; xx <= 12; xx++) if (xx * xx / 144 + yy * yy / 25 <= 1 && bayer(xx, yy) < 0.7) p.set(((ox + xx) % W + W) % W, oy + yy, '#2a2a30');
  speckle(p, rng, 0, 0, W, h, R_RUST[1], 0.01);
  p.rect(0, 0, W, 1, R_CONCRETE[3]);
  hazeRows(p, h - 24, h, INK, 0.45);
}

// ───────────────────────────── zone builders ─────────────────────────────

/** Periodic (tileable in W) fbm sample for silhouette edges. */
function ridge(nz, x, W, scale, salt) {
  const u = x / W;
  return nz.fbm(x / scale, salt, 3) * (1 - u) + nz.fbm((x - W) / scale, salt, 3) * u;
}

/** Fills columns from a ridge line down to the sprite bottom. */
function hills(p, nz, W, h, baseH, amp, scale, salt, hex) {
  for (let x = 0; x < W; x++) {
    const top = h - baseH - Math.round(ridge(nz, x, W, scale, salt) * amp);
    p.rect(x, top, 1, h - top, hex);
  }
}

function suburbsBackdrop(seed, W, H, gy) {
  const rng = makeRng(seed).fork('suburbs');
  const nz = makeNoise(seed + ':suburbs');
  const wallHexes = ['#8a8f94', '#a09a8c', '#7d8a94', '#9a9a80', '#8f7f72', '#b0a898'];
  const roofHexes = ['#4a4650', '#5c4a44', '#3c4a52', '#6a5a4a'];
  const lights = [];
  // Far: dawn-blue hills, treeline, distant rooftops, pylons.
  const farH = 150;
  const far = layerPair(W, farH, (p) => {
    hills(p, nz, W, farH, 40, 30, 60, 3.1, '#5c6a8c');
    hills(p, nz, W, farH, 26, 14, 24, 7.7, '#4f5c7c');
    const r2 = rng.fork('farhouses');
    for (let x = r2.int(0, 20); x < W; x += r2.int(16, 30)) {
      const hw = r2.int(4, 7);
      const hh = r2.int(4, 7);
      const base = farH - 26 - Math.round(ridge(nz, x, W, 24, 7.7) * 14) + 2;
      tiled(W, x - hw, hw * 2 + 2, (ox) => {
        p.rect(ox, base - hh, hw * 2, hh, '#46527a');
        tri(p, ox + hw, base - hh - 3, hw + 1, 4, '#3f4a70');
      });
    }
    const px0 = r2.int(20, W - 20);
    pylon(p, px0, farH - 34, 40, '#4a5578');
    pylon(p, (px0 + Math.floor(W * 0.55)) % W, farH - 30, 34, '#4a5578');
    // Water tower.
    const wx = r2.int(10, W - 10);
    tiled(W, wx - 5, 12, (ox) => {
      p.rect(ox + 2, farH - 60, 1, 24, '#46527a');
      p.rect(ox + 8, farH - 60, 1, 24, '#46527a');
      p.rect(ox, farH - 68, 11, 9, '#4d5a80');
      dome(p, ox + 5, farH - 68, 5, 3, '#56648a');
    });
    hazeRows(p, farH - 40, farH, '#6d7a9c', 0.7);
  });
  // Mid: a row of houses on dead lawns with bare trees.
  const midH = 130;
  const mid = layerPair(W, midH, (p, pe) => {
    p.rect(0, midH - 8, W, 8, '#7a7656');
    speckle(p, rng, 0, midH - 8, W, 8, '#8f8a62', 0.25);
    speckle(p, rng, 0, midH - 8, W, 8, '#5e5c40', 0.2);
    let x = rng.int(0, 10);
    let i = 0;
    while (x < W) {
      const w = rng.int(36, 52);
      const h = rng.int(22, 30);
      const wall = ramp(rng.pick(wallHexes), 4);
      const roof = ramp(rng.pick(roofHexes), 4);
      const lit = i === 1;
      const hx = x;
      tiled(W, hx - 4, w + 8, (ox) => house(p, pe, rng.fork('house' + i), ox, midH - 8, w, h, wall, roof, lit));
      if (lit) {
        lights.push(light(hx + 4, midH - 8 - 10, 34, '#ffb347', 0.8, 0.25, 0.32));
        p.rect(hx + 1, midH - 8 - 14, 1, 1, '#ffd98a');
        pe.rect(hx + 1, midH - 8 - 14, 1, 1, '#ffd98a');
      }
      const tx = hx + w + rng.int(4, 10);
      if (rng.chance(0.7)) tiled(W, tx - 10, 22, (ox) => bareTree(p, rng.fork('tree' + i), ox + 10, midH - 8, rng.int(26, 44), '#2f2c3a'));
      x += w + rng.int(14, 26);
      i++;
    }
    hazeRows(p, midH - 30, midH, '#6c7896', 0.3);
  });
  // Near: picket fence, hedges, mailboxes, bins and a street lamp.
  const nearH = 90;
  const near = layerPair(W, nearH, (p, pe) => {
    p.rect(0, nearH - 6, W, 6, '#6e6a4c');
    speckle(p, rng, 0, nearH - 6, W, 6, '#857f58', 0.3);
    const fenceC = ['#8a887c', '#b8b4a8', '#d8d4c8'];
    picketFence(p, rng.fork('fence'), 0, W, nearH - 6, 12, fenceC);
    const hedgeC = ['#2c3a2c', '#3b4a3a', '#4f5a44'];
    const hx = rng.int(0, W);
    tiled(W, hx, 30, (ox) => hedge(p, rng.fork('hedge'), ox, nearH - 4, 30, 11, hedgeC));
    const hx2 = (hx + Math.floor(W * 0.5)) % W;
    tiled(W, hx2, 20, (ox) => hedge(p, rng.fork('hedge2'), ox, nearH - 4, 20, 8, hedgeC));
    const mx = (hx + 42) % W;
    tiled(W, mx - 1, 9, (ox) => mailbox(p, rng.fork('mb'), ox + 1, nearH - 4));
    const bx = (hx + 66) % W;
    tiled(W, bx - 1, 9, (ox) => trashBin(p, ox + 1, nearH - 4, '#4c5a6a'));
    const lx = (hx + Math.floor(W * 0.72)) % W;
    tiled(W, lx - 9, 12, (ox) => lampPost(p, pe, ox + 9, nearH - 4, 52, '#e8f0ff'));
    lights.push(light(lx - 6, nearH - 4 - 50, 58, '#d9e6ff', 0.75, 0.12, 0.55));
    // A tyre and litter.
    const tx = (hx + 100) % W;
    p.ring(tx, nearH - 7, 3, '#1e1c26');
    p.ring(tx, nearH - 7, 2, '#2c2a36');
    speckle(p, rng, 0, nearH - 6, W, 6, '#d9d2c0', 0.01);
  });
  // Foreground occluder: telephone poles with drooping wires.
  const fore = layerSprite(W, H, (p) => {
    const poles = [Math.floor(W * 0.18), Math.floor(W * 0.74)];
    for (let i = 0; i < poles.length; i++) {
      const x = poles[i];
      p.rect(x, 0, 4, H, '#1e1a22');
      p.rect(x, 0, 1, H, '#2c2734');
      p.rect(x - 6, 18, 16, 2, '#1e1a22');
      p.rect(x - 6, 30, 16, 2, '#1e1a22');
      p.rect(x - 5, 16, 1, 2, '#3a3444');
      p.rect(x + 8, 16, 1, 2, '#3a3444');
      p.rect(x - 4, 28, 1, 2, '#3a3444');
    }
    const n = poles[1] - poles[0];
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      p.set(poles[0] + k - 4, Math.round(17 + 22 * u * (1 - u)), '#1e1a22');
      p.set(poles[0] + k + 8, Math.round(29 + 18 * u * (1 - u)), '#1e1a22');
    }
    p.rect(0, H - 30, 26, 30, '#1a1c1a');
    dome(p, 12, H - 28, 16, 10, '#1a1c1a');
  });
  const ground = layerSprite(W, H - gy, (p) => groundAsphalt(p, nz, rng.fork('ground'), W, H - gy, { kerb: true, manhole: true, leaves: true }));
  return {
    layers: [
      { spr: far.spr, parallax: 0.12, y: gy - farH + 4 },
      { spr: mid.spr, emissive: mid.emissive, parallax: 0.32, y: gy - midH + 6 },
      { spr: near.spr, emissive: near.emissive, parallax: 0.55, y: gy - nearH + 4 },
      { spr: fore, parallax: 1.35, y: 0 },
    ],
    ground: { spr: ground, y: gy },
    groundY: gy,
    lights,
    fog: { color: '#7a88a8', alpha: 0.22 },
    palette: { ambient: '#7c86a8', key: '#e0a890' },
  };
}

function mallBackdrop(seed, W, H, gy) {
  const rng = makeRng(seed).fork('mall');
  const nz = makeNoise(seed + ':mall');
  const lights = [];
  const farH = 130;
  const far = layerPair(W, farH, (p, pe) => {
    // Big-box roofline, a pylon sign, parking lamps.
    p.rect(0, farH - 46, W, 46, '#5a5c68');
    for (let x = 0; x < W; x += 36) p.rect(x, farH - 46 - rng.int(0, 6), rng.int(20, 34), 8, '#5a5c68');
    p.rect(0, farH - 46, W, 1, '#6a6c78');
    const r2 = rng.fork('far');
    for (let i = 0; i < 4; i++) {
      const ux = r2.int(0, W);
      p.rect(ux, farH - 54, 6, 8, '#565866');
      p.set(ux, farH - 54, '#6a6c78');
    }
    const sx = r2.int(20, W - 30);
    p.rect(sx + 4, farH - 100, 3, 56, '#4c4e5a');
    p.rect(sx, farH - 116, 12, 18, '#2a2c36');
    p.frame(sx, farH - 116, 12, 18, '#3c3e4a');
    for (let r = 0; r < 3; r++) {
      const lit = r === 1;
      p.rect(sx + 2, farH - 113 + r * 5, 8, 3, lit ? '#ff6a6a' : '#3a3540');
      if (lit) pe.rect(sx + 2, farH - 113 + r * 5, 8, 3, '#ff4d4d');
    }
    lights.push(light(sx + 6, farH - 108 + (gy - farH + 4), 40, '#ff4d3d', 0.5, 0.7, 0.12));
    for (let i = 0; i < 3; i++) {
      const lx = r2.int(0, W);
      p.rect(lx, farH - 78, 1, 32, '#4c4e5a');
      p.rect(lx - 3, farH - 79, 7, 1, '#4c4e5a');
    }
    hazeRows(p, farH - 40, farH, '#6e7080', 0.6);
  });
  // Mid: storefront row with one buzzing sign and one red pharmacy cross.
  const midH = 120;
  const mid = layerPair(W, midH, (p, pe) => {
    const facades = ['#9a9084', '#7e8088', '#7a5a50', '#8c8a7a'];
    const awnings = ['#7a3b2e', '#2f5f6a', '#6a6a3a', '#5a3e6e'];
    const widths = [];
    let total = 0;
    while (total < W) {
      const w = Math.min(W - total, rng.int(56, 72));
      widths.push(w < 40 ? W - total : w);
      total += widths[widths.length - 1];
    }
    let x = 0;
    for (let i = 0; i < widths.length; i++) {
      const w = widths[i];
      const sign = i === 0 ? '#7fe0ff' : i === 2 ? '#ff5a5a' : null;
      storefront(p, pe, rng.fork('shop' + i), x, midH - 6, w, rng.int(72, 84), facades[i % facades.length], sign, awnings[i % awnings.length]);
      if (sign) lights.push(light(x + w * 0.35, midH - 6 - 70 + (gy - midH + 6), 48, sign, 0.7, i === 0 ? 0.6 : 0.85, 0.32));
      x += w;
    }
    // Pavement in front.
    p.rect(0, midH - 6, W, 6, R_CONCRETE[1]);
    p.rect(0, midH - 6, W, 1, R_CONCRETE[2]);
    for (let sx = 0; sx < W; sx += 20) p.rect(sx, midH - 6, 1, 6, R_CONCRETE[0]);
    // Soot above one burnt shop.
    speckle(p, rng, 10, midH - 84, 40, 14, INK, 0.3);
  });
  const nearH = 80;
  const near = layerPair(W, nearH, (p, pe) => {
    p.rect(0, nearH - 6, W, 6, R_CONCRETE[1]);
    p.rect(0, nearH - 6, W, 1, R_CONCRETE[2]);
    p.rect(0, nearH - 1, W, 1, R_CONCRETE[0]);
    for (let sx = 6; sx < W; sx += 26) p.rect(sx, nearH - 6, 1, 6, R_CONCRETE[0]);
    const r2 = rng.fork('near');
    for (let x = r2.int(4, 12); x < W; x += r2.int(28, 44)) {
      const bx = x;
      tiled(W, bx - 1, 5, (ox) => bollard(p, ox + 1, nearH - 4));
    }
    const cx = r2.int(0, W);
    tiled(W, cx, 15, (ox) => shoppingCart(p, ox, nearH - 4, '#9aa3b0', false));
    const cx2 = (cx + Math.floor(W * 0.5)) % W;
    tiled(W, cx2, 15, (ox) => shoppingCart(p, ox, nearH - 4, '#8a93a0', true));
    const bx = (cx + 40) % W;
    tiled(W, bx, 8, (ox) => trashBin(p, ox, nearH - 4, '#3a5a4a'));
    // Newspaper box and a bench.
    const nx = (cx + 72) % W;
    tiled(W, nx, 8, (ox) => {
      p.rect(ox, nearH - 14, 7, 10, '#3a5a8a');
      p.rect(ox + 1, nearH - 12, 5, 4, '#1e2432');
      p.rect(ox, nearH - 14, 7, 1, '#5a7aaa');
    });
    const lx = (cx + 110) % W;
    tiled(W, lx - 9, 12, (ox) => lampPost(p, pe, ox + 9, nearH - 4, 46, '#dfe3ea'));
    lights.push(light(lx - 6, nearH - 4 - 44 + (gy - nearH + 4), 64, '#dfe3ea', 0.7, 0.18, 0.55));
    speckle(p, rng, 0, nearH - 6, W, 6, '#d9d2c0', 0.015);
  });
  const fore = layerSprite(W, H, (p) => {
    const cols = [Math.floor(W * 0.08), Math.floor(W * 0.8)];
    for (let i = 0; i < 2; i++) {
      const x = cols[i];
      p.rect(x, 0, 14, H, '#3a3a44');
      p.rect(x, 0, 2, H, '#4a4a56');
      p.rect(x + 12, 0, 2, H, '#2a2a34');
      // Graffiti tag.
      const gy0 = Math.floor(H * 0.5) + i * 30;
      p.rect(x + 3, gy0, 8, 2, '#a83232');
      p.rect(x + 4, gy0 + 3, 6, 2, '#2f7f7a');
      p.rect(x + 2, gy0 + 6, 9, 1, '#e08a2c');
    }
  });
  const ground = layerSprite(W, H - gy, (p) => groundAsphalt(p, nz, rng.fork('ground'), W, H - gy, { kerb: false, bays: true }));
  return {
    layers: [
      { spr: far.spr, emissive: far.emissive, parallax: 0.12, y: gy - farH + 4 },
      { spr: mid.spr, emissive: mid.emissive, parallax: 0.32, y: gy - midH + 6 },
      { spr: near.spr, emissive: near.emissive, parallax: 0.55, y: gy - nearH + 4 },
      { spr: fore, parallax: 1.35, y: 0 },
    ],
    ground: { spr: ground, y: gy },
    groundY: gy,
    lights,
    fog: { color: '#8a8a90', alpha: 0.12 },
    palette: { ambient: '#8c8c94', key: '#dfe3ea' },
  };
}

function hospitalBackdrop(seed, W, H, gy) {
  const rng = makeRng(seed).fork('hospital');
  const nz = makeNoise(seed + ':hospital');
  const lights = [];
  const wallH = gy + 4;
  const wallC = ramp('#7f9481', 5, { dark: 0.4, light: 0.3 });
  const doorC = ['#4e5c54', '#6f7f74', '#8a9a90'];
  const far = layerPair(W, wallH, (p) => {
    p.rect(0, 0, W, wallH, wallC[2]);
    texFill(p, nz, 0, 0, W, wallH, [wallC[1], wallC[2], wallC[2], wallC[3]], 14, W, 0);
    p.rect(0, 0, W, 6, wallC[1]);
    p.rect(0, 6, W, 1, wallC[0]);
    // Wainscot tiles and handrail.
    const wy = wallH - 64;
    for (let y = wy; y < wallH - 4; y++) {
      for (let x = 0; x < W; x++) {
        const grout = (x % 6) === 0 || ((y - wy) % 6) === 0;
        const alt = ((Math.floor(x / 6) + Math.floor((y - wy) / 6)) & 1) === 0;
        p.set(x, y, grout ? '#6e7e6c' : alt ? '#98a894' : '#8fa08c');
      }
    }
    p.rect(0, wy - 3, W, 3, R_WOOD[1]);
    p.rect(0, wy - 3, W, 1, R_WOOD[3]);
    p.rect(0, wy, W, 1, R_WOOD[0]);
    p.rect(0, wallH - 4, W, 4, '#5c6a58');
    p.rect(0, wallH - 4, W, 1, '#6c7a68');
    // Doors, signs, notice board, clock, extinguisher.
    const r2 = rng.fork('doors');
    const d1 = r2.int(6, 30);
    tiled(W, d1 - 2, 30, (ox) => doubleDoor(p, ox + 1, wallH - 4, doorC));
    const d2 = (d1 + r2.int(96, 120)) % W;
    tiled(W, d2 - 2, 30, (ox) => doubleDoor(p, ox + 1, wallH - 4, doorC));
    for (const dx of [d1, d2]) {
      tiled(W, dx + 4, 18, (ox) => {
        p.rect(ox, wallH - 56, 18, 6, '#d9d2c0');
        p.rect(ox + 1, wallH - 55, 5, 4, '#2f7f7a');
        p.rect(ox + 8, wallH - 54, 8, 2, '#5a5a5a');
      });
    }
    const nx = (d1 + 52) % W;
    tiled(W, nx, 26, (ox) => {
      p.rect(ox, wallH - 100, 26, 18, '#5a4a3c');
      p.rect(ox + 1, wallH - 99, 24, 16, '#7a6a50');
      for (let i = 0; i < 5; i++) p.rect(ox + 2 + r2.int(0, 16), wallH - 97 + r2.int(0, 8), 5, 4, r2.chance(0.5) ? '#d9d2c0' : '#c9c2a8');
    });
    const cx = (d1 + 82) % W;
    p.fillCircle(cx, wallH - 104, 5, '#e8e8e0');
    p.ring(cx, wallH - 104, 5, '#3a3a40');
    p.rect(cx, wallH - 107, 1, 3, '#3a3a40');
    p.rect(cx, wallH - 104, 3, 1, '#3a3a40');
    const ex = (d2 + 36) % W;
    p.rect(ex, wallH - 78, 8, 14, '#3a3a40');
    p.rect(ex + 2, wallH - 76, 4, 10, '#a83232');
    p.rect(ex + 2, wallH - 76, 1, 10, '#d04848');
    // Blood smears and grime.
    for (let i = 0; i < 3; i++) {
      const bx = r2.int(0, W);
      const by = wallH - r2.int(30, 60);
      for (let k = 0; k < 14; k++) p.rect(((bx + k) % W + W) % W, by + (k >> 2), 1, r2.int(1, 3), BLOOD_DRY);
      p.rect(bx, by - 3, 3, 3, BLOOD_DRY);
      p.set(bx + 1, by - 4, BLOOD_DRY);
      p.set(bx + 3, by - 3, BLOOD_DRY);
    }
    speckle(p, rng, 0, wallH - 30, W, 26, '#4c5a48', 0.08);
    hazeRows(p, wallH - 20, wallH, '#3e4c3c', 0.35);
  });
  // Mid: gurneys, IV stands, wheelchairs.
  const midH = 60;
  const mid = layerPair(W, midH, (p) => {
    const c = ['#2e3a34', '#3f4c44', '#5a6a60'];
    const r2 = rng.fork('mid');
    const gx = r2.int(0, W);
    tiled(W, gx, 22, (ox) => gurney(p, ox, midH - 3, c));
    const ix = (gx + 34) % W;
    tiled(W, ix - 4, 9, (ox) => ivStand(p, ox + 4, midH - 3, c));
    const wx = (gx + Math.floor(W * 0.55)) % W;
    tiled(W, wx - 1, 14, (ox) => wheelchair(p, ox, midH - 3, c));
    const bx = (gx + Math.floor(W * 0.8)) % W;
    tiled(W, bx, 10, (ox) => {
      p.rect(ox, midH - 12, 9, 9, '#a83232');
      p.rect(ox, midH - 12, 9, 1, '#c04848');
      p.rect(ox + 3, midH - 9, 3, 3, INK);
      p.set(ox + 4, midH - 8, '#c9a63a');
    });
    // Body bag on the floor.
    const zx = (gx + 70) % W;
    tiled(W, zx, 18, (ox) => {
      dome(p, ox + 9, midH - 3, 9, 3, '#2a2e34');
      p.rect(ox + 2, midH - 5, 14, 1, '#3c4048');
    });
  });
  // Near (top): ceiling tiles with hanging tube lights.
  const ceilH = 40;
  const near = layerPair(W, ceilH, (p, pe) => {
    for (let y = 0; y < 22; y++) {
      for (let x = 0; x < W; x++) {
        const grout = (x % 12) === 0 || (y % 8) === 0;
        p.set(x, y, grout ? '#7c8878' : ((Math.floor(x / 12) + Math.floor(y / 8)) & 1) ? '#9aa898' : '#93a090');
      }
    }
    p.rect(0, 22, W, 1, '#5c6a58');
    speckle(p, rng, 0, 0, W, 22, '#6e7a66', 0.05);
    const states = [1, 0, 1, 1];
    const r2 = rng.fork('tubes');
    const first = r2.int(4, 20);
    for (let i = 0; i < 4; i++) {
      const tx = (first + i * 48) % W;
      tiled(W, tx, 34, (ox) => tubeLight(p, pe, ox, 26, states[i]));
      if (states[i]) lights.push(light(tx + 17, 30, 76, '#b8f0c0', i === 2 ? 0.55 : 0.85, i === 2 ? 0.9 : 0.25, 0.6));
    }
    // Hanging wayfinding sign.
    const sx = (first + 24) % W;
    tiled(W, sx, 20, (ox) => {
      p.rect(ox + 4, 22, 1, 6, '#5c6a58');
      p.rect(ox + 15, 22, 1, 6, '#5c6a58');
      p.rect(ox, 28, 20, 8, '#2f7f7a');
      p.rect(ox + 2, 30, 10, 4, '#d9d2c0');
      p.rect(ox + 14, 31, 4, 2, '#d9d2c0');
      p.set(ox + 17, 30, '#d9d2c0');
      p.set(ox + 17, 34, '#d9d2c0');
    });
  });
  const fore = layerSprite(W, H, (p) => {
    const cols = [Math.floor(W * 0.1), Math.floor(W * 0.82)];
    for (let i = 0; i < 2; i++) {
      const x = cols[i];
      p.rect(x, 0, 10, H, '#4c5a4a');
      p.rect(x, 0, 1, H, '#5e6c5a');
      p.rect(x + 9, 0, 1, H, '#3a463a');
      p.rect(x + 2, Math.floor(H * 0.3), 6, 1, '#3a463a');
    }
    // Curtain rail with a torn curtain at the left.
    p.rect(0, 40, Math.floor(W * 0.28), 2, '#3a463a');
    for (let x = 4; x < Math.floor(W * 0.22); x++) {
      const len = 40 + Math.round(Math.abs(Math.sin(x * 0.7)) * 26);
      p.rect(x, 42, 1, len, (x & 2) ? '#4c6a5a' : '#5a7868');
    }
  });
  const ground = layerSprite(W, H - gy, (p) => groundLino(p, nz, rng.fork('ground'), W, H - gy));
  return {
    layers: [
      { spr: far.spr, parallax: 0.3, y: 0 },
      { spr: mid.spr, parallax: 0.45, y: gy - midH + 3 },
      { spr: near.spr, emissive: near.emissive, parallax: 0.6, y: 0 },
      { spr: fore, parallax: 1.3, y: 0 },
    ],
    ground: { spr: ground, y: gy },
    groundY: gy,
    lights,
    fog: { color: '#4c6a56', alpha: 0.14 },
    palette: { ambient: '#6e8a78', key: '#bfe8c0' },
  };
}

function forestBackdrop(seed, W, H, gy) {
  const rng = makeRng(seed).fork('forest');
  const nz = makeNoise(seed + ':forest');
  const lights = [];
  const farH = 170;
  const far = layerPair(W, farH, (p) => {
    p.rect(0, farH - 30, W, 30, '#6f8d90');
    const c = ['#587680', '#5f7d82', '#6b8a8e', '#4f6a70'];
    const r2 = rng.fork('far');
    for (let x = r2.int(0, 8); x < W; x += r2.int(9, 15)) {
      const h = r2.int(70, 130);
      const px0 = x;
      tiled(W, px0 - 20, 40, (ox) => pine(p, r2.fork('p' + px0), ox + 20, farH - r2.int(10, 26), h, c));
    }
    hazeRows(p, farH - 70, farH, '#7d9a9c', 0.75);
  });
  const midH = 150;
  const mid = layerPair(W, midH, (p) => {
    const c = ['#2e4846', '#3a5856', '#4a6a66', '#2b3a38'];
    const r2 = rng.fork('mid');
    for (let x = r2.int(0, 10); x < W; x += r2.int(12, 22)) {
      const h = r2.int(80, 140);
      const px0 = x;
      tiled(W, px0 - 22, 44, (ox) => pine(p, r2.fork('p' + px0), ox + 22, midH - r2.int(2, 10), h, c));
    }
    hazeRows(p, midH - 50, midH, '#4f6d70', 0.45);
  });
  const nearH = 120;
  const near = layerPair(W, nearH, (p, pe) => {
    const c = ['#1a2c2e', '#22383a', '#2e4a48', '#1c2624'];
    const r2 = rng.fork('near');
    for (let x = r2.int(0, 20); x < W; x += r2.int(40, 70)) {
      const h = r2.int(90, 116);
      const px0 = x;
      tiled(W, px0 - 26, 52, (ox) => pine(p, r2.fork('p' + px0), ox + 26, nearH - 4, h, c));
    }
    // Camp: two tents, a fire, a cooler, a lantern on a rope.
    const tx = r2.int(10, W - 10);
    const tentA = ramp('#5a6b3c', 4);
    const tentB = ramp('#b8683c', 4, { dark: 0.55 });
    tiled(W, tx - 12, 30, (ox) => tent(p, r2.fork('tent'), ox, nearH - 4, 24, 15, tentA));
    const tx2 = (tx + 56) % W;
    tiled(W, tx2 - 10, 24, (ox) => tent(p, r2.fork('tent2'), ox, nearH - 4, 18, 12, tentB));
    const fx = (tx + 34) % W;
    tiled(W, fx - 6, 13, (ox) => campfire(p, pe, ox + 6, nearH - 4));
    lights.push(light(fx, nearH - 10 + (gy - nearH + 4), 46, '#ff8a3c', 0.85, 0.6, 0.55));
    const cx = (tx + 80) % W;
    tiled(W, cx, 10, (ox) => {
      p.rect(ox, nearH - 10, 9, 6, '#3a5a7a');
      p.rect(ox, nearH - 11, 9, 2, '#5a7a9a');
      p.rect(ox + 3, nearH - 9, 3, 1, '#d9d2c0');
    });
    // Lantern hanging from a rope between two trunks.
    const lx = (tx + 20) % W;
    for (let k = 0; k < 40; k++) p.set(((lx + k) % W + W) % W, nearH - 40 + Math.round(6 * Math.sin((k / 40) * Math.PI)), '#4a4a3a');
    const lxx = (lx + 20) % W;
    p.rect(lxx, nearH - 34, 1, 4, '#4a4a3a');
    p.rect(lxx - 1, nearH - 30, 3, 4, '#3a3a40');
    p.rect(lxx, nearH - 29, 1, 2, '#d0ffe8');
    pe.rect(lxx, nearH - 29, 1, 2, '#d0ffe8');
    lights.push(light(lxx, nearH - 28 + (gy - nearH + 4), 30, '#c8ffe8', 0.6, 0.2, 0.55));
    // Log seats and a fern.
    p.rect((fx + 10) % W, nearH - 7, 8, 3, R_WOOD[1]);
    p.rect((fx + 10) % W, nearH - 7, 8, 1, R_WOOD[2]);
    p.rect(0, nearH - 4, W, 4, '#2a3a2e');
    speckle(p, rng, 0, nearH - 4, W, 4, '#3e5240', 0.3);
  });
  const fore = layerSprite(W, H, (p) => {
    const trunks = [Math.floor(W * 0.05), Math.floor(W * 0.78)];
    for (let i = 0; i < 2; i++) {
      const x = trunks[i];
      p.rect(x, 0, 14, H, '#1a2624');
      for (let y = 0; y < H; y += 3) {
        p.set(x + 2 + ((y >> 2) & 3), y, '#26332f');
        p.set(x + 9 + ((y >> 3) & 2), y + 1, '#111a18');
      }
      p.rect(x, 0, 1, H, '#2c3a36');
      p.rect(x + 13, 0, 1, H, '#0f1614');
      // Branch with needles crossing the top.
      p.line(x + 14, 30 + i * 18, x + 40, 20 + i * 18, '#1a2624');
      for (let k = 0; k < 6; k++) tri(p, x + 18 + k * 4, 12 + i * 18 + (k & 1) * 2, 3, 7, '#1c2e2c');
    }
    // Ferns at the bottom edge.
    for (let i = 0; i < 6; i++) {
      const fx = Math.floor((i / 6) * W) + 8;
      for (let k = -1; k <= 1; k++) p.line(fx, H, fx + k * 8, H - 16, '#243c30');
      for (let k = 0; k < 4; k++) {
        p.rect(fx - 4 - k, H - 12 + k * 3, 3, 1, '#2c4a3a');
        p.rect(fx + 2 + k, H - 12 + k * 3, 3, 1, '#2c4a3a');
      }
    }
  });
  const ground = layerSprite(W, H - gy, (p) => groundDirt(p, nz, rng.fork('ground'), W, H - gy));
  // Dappled canopy light.
  const r3 = rng.fork('dapple');
  for (let i = 0; i < 4; i++) lights.push(light(Math.floor(((i + 0.5) / 4) * W) + r3.int(-12, 12), r3.int(16, 70), 58, '#9fe8e0', 0.55, 0.12, 0.55));
  return {
    layers: [
      { spr: far.spr, parallax: 0.12, y: gy - farH + 6 },
      { spr: mid.spr, parallax: 0.32, y: gy - midH + 6 },
      { spr: near.spr, emissive: near.emissive, parallax: 0.55, y: gy - nearH + 4 },
      { spr: fore, parallax: 1.35, y: 0 },
    ],
    ground: { spr: ground, y: gy },
    groundY: gy,
    lights,
    fog: { color: '#5a7c80', alpha: 0.24 },
    palette: { ambient: '#5a7a80', key: '#a8e8e0' },
  };
}

function depotBackdrop(seed, W, H, gy) {
  const rng = makeRng(seed).fork('depot');
  const nz = makeNoise(seed + ':depot');
  const lights = [];
  const farH = 140;
  const far = layerPair(W, farH, (p, pe) => {
    p.rect(0, farH - 30, W, 30, '#5a5650');
    const hc = ['#3e3e48', '#4a4a52', '#5a5a64'];
    const r2 = rng.fork('far');
    const hx = r2.int(0, W);
    tiled(W, hx, 70, (ox) => hangar(p, ox, farH - 28, 70, 30, hc));
    const hx2 = (hx + 96) % W;
    tiled(W, hx2, 54, (ox) => hangar(p, ox, farH - 30, 54, 24, hc));
    // Control tower with a beacon, radar dish, water tower.
    const cx = (hx + 84) % W;
    tiled(W, cx - 4, 12, (ox) => {
      p.rect(ox + 3, farH - 90, 5, 62, '#44444e');
      p.rect(ox + 3, farH - 90, 1, 62, '#565660');
      p.rect(ox, farH - 100, 12, 11, '#4e4e58');
      p.rect(ox + 1, farH - 98, 10, 4, '#2a3038');
      p.rect(ox, farH - 100, 12, 1, '#5e5e68');
      p.rect(ox + 5, farH - 106, 1, 6, '#44444e');
      p.rect(ox + 5, farH - 107, 1, 1, '#ff4d3d');
      pe.set(ox + 5, farH - 107, '#ff4d3d');
    });
    lights.push(light(cx + 1, farH - 107 + (gy - farH + 4), 34, '#ff3a2e', 0.6, 1, 0.12));
    const rx = (hx + 130) % W;
    p.rect(rx, farH - 60, 1, 32, '#44444e');
    p.ring(rx + 1, farH - 64, 5, '#56565e');
    p.line(rx - 4, farH - 60, rx + 6, farH - 68, '#5e5e68');
    for (let i = 0; i < 2; i++) {
      const bx = r2.int(0, W);
      p.rect(bx, farH - 40, 10, 12, '#4a4a52');
      p.rect(bx, farH - 40, 10, 1, '#5a5a64');
    }
    hazeRows(p, farH - 40, farH, '#6a6058', 0.65);
  });
  const midH = 110;
  const mid = layerPair(W, midH, (p) => {
    // A canvas truck and a guard tower behind the fence.
    const r2 = rng.fork('mid');
    const tx = r2.int(0, W);
    tiled(W, tx, 46, (ox) => {
      p.rect(ox + 12, midH - 30, 32, 16, R_OLIVE[1]);
      p.rect(ox + 12, midH - 30, 32, 1, R_OLIVE[3]);
      p.rect(ox + 13, midH - 29, 30, 1, R_OLIVE[2]);
      p.rect(ox, midH - 22, 13, 8, R_OLIVE[1]);
      p.rect(ox + 2, midH - 20, 6, 4, '#2a3038');
      p.rect(ox, midH - 14, 44, 4, R_OLIVE[0]);
      p.fillCircle(ox + 6, midH - 10, 3, INK);
      p.fillCircle(ox + 34, midH - 10, 3, INK);
      p.set(ox + 6, midH - 11, '#3a3a44');
      p.set(ox + 34, midH - 11, '#3a3a44');
    });
    const gx = (tx + 90) % W;
    tiled(W, gx - 2, 20, (ox) => {
      p.line(ox, midH - 8, ox + 4, midH - 46, '#3a3a40');
      p.line(ox + 16, midH - 8, ox + 12, midH - 46, '#3a3a40');
      p.rect(ox + 2, midH - 30, 12, 1, '#3a3a40');
      p.rect(ox + 1, midH - 58, 14, 12, '#4a4a50');
      p.rect(ox + 2, midH - 56, 12, 4, '#2a3038');
      p.rect(ox, midH - 59, 16, 1, '#5a5a60');
    });
    chainlink(p, r2.fork('fence'), 0, W, midH - 6, 40, '#8a8e96', '#3a3a40');
    p.rect(0, midH - 6, W, 6, '#4e4a44');
    speckle(p, rng, 0, midH - 6, W, 6, '#5e5a52', 0.3);
  });
  const nearH = 80;
  const near = layerPair(W, nearH, (p, pe) => {
    const r2 = rng.fork('near');
    p.rect(0, nearH - 4, W, 4, R_CONCRETE[1]);
    p.rect(0, nearH - 4, W, 1, R_CONCRETE[2]);
    const sx = r2.int(0, W);
    tiled(W, sx - 4, 50, (ox) => sandbagWall(p, ox, nearH - 4, 46, 4));
    const jx = (sx + 70) % W;
    tiled(W, jx, 24, (ox) => jerseyBarrier(p, ox, nearH - 4, 24));
    const cx = (sx + 104) % W;
    tiled(W, cx, 16, (ox) => {
      crate(p, ox, nearH - 4, 16, 10, R_OLIVE);
      crate(p, ox + 3, nearH - 14, 11, 8, R_OLIVE);
    });
    const dx = (sx + 126) % W;
    tiled(W, dx, 8, (ox) => oilDrum(p, ox, nearH - 4, R_RUST));
    tiled(W, dx + 8, 8, (ox) => oilDrum(p, ox, nearH - 4, R_OLIVE));
    const px0 = (sx + 150) % W;
    tiled(W, px0 - 1, 3, (ox) => strobe(p, pe, ox + 1, nearH - 4, 30, '#ff3a2e'));
    lights.push(light(px0, nearH - 36 + (gy - nearH + 4), 64, '#ff3a2e', 0.9, 1, 0.55));
    const px1 = (sx + 40) % W;
    tiled(W, px1 - 1, 3, (ox) => strobe(p, pe, ox + 1, nearH - 4, 22, '#ff3a2e'));
    lights.push(light(px1, nearH - 28 + (gy - nearH + 4), 56, '#ff3a2e', 0.8, 1, 0.55));
    // Cable spool and a sign post.
    const wx = (sx + 170) % W;
    tiled(W, wx, 10, (ox) => {
      p.fillCircle(ox + 5, nearH - 9, 5, R_WOOD[1]);
      p.ring(ox + 5, nearH - 9, 5, R_WOOD[0]);
      p.fillCircle(ox + 5, nearH - 9, 2, R_WOOD[0]);
    });
    lights.push(light(cx + 8, nearH - 20 + (gy - nearH + 4), 44, '#ffb347', 0.5, 0.2, 0.55));
    speckle(p, rng, 0, nearH - 4, W, 4, R_CONCRETE[3], 0.05);
  });
  const fore = layerSprite(W, H, (p) => {
    const x = Math.floor(W * 0.1);
    p.rect(x, 0, 4, H, '#2a2a30');
    p.rect(x, 0, 1, H, '#3c3c44');
    for (let y = 0; y < H; y++) {
      for (let xx = x + 4; xx < x + 30; xx++) if (((xx + y) & 5) === 0 || ((xx - y) & 5) === 0) p.set(xx, y, '#3a3a42', 0.6);
    }
    const bx = Math.floor(W * 0.84);
    p.rect(bx, H - 40, 8, 40, '#3a3a40');
    p.rect(bx, H - 40, 8, 2, HAZARD_YELLOW);
    p.rect(bx, H - 34, 8, 2, HAZARD_YELLOW);
    p.rect(bx, H - 40, 1, 40, '#4a4a50');
  });
  const ground = layerSprite(W, H - gy, (p) => groundConcrete(p, nz, rng.fork('ground'), W, H - gy));
  return {
    layers: [
      { spr: far.spr, emissive: far.emissive, parallax: 0.12, y: gy - farH + 4 },
      { spr: mid.spr, parallax: 0.32, y: gy - midH + 6 },
      { spr: near.spr, emissive: near.emissive, parallax: 0.55, y: gy - nearH + 4 },
      { spr: fore, parallax: 1.35, y: 0 },
    ],
    ground: { spr: ground, y: gy },
    groundY: gy,
    lights,
    fog: { color: '#5a4a40', alpha: 0.12 },
    palette: { ambient: '#6a5c58', key: '#ff5a4a' },
  };
}

const ZONE_BUILDERS = { suburbs: suburbsBackdrop, mall: mallBackdrop, hospital: hospitalBackdrop, forest: forestBackdrop, depot: depotBackdrop };

/**
 * A complete scav-zone backdrop: three parallax layers (far → near), a
 * tileable ground strip and a foreground occluder (parallax > 1), plus the
 * light sources, fog plane and grade palette that make the zone read.
 * Layers are W units wide, tile horizontally, and carry a top-left anchor;
 * `y` is the layer's screen-space top (units) with the camera at 0. Light
 * positions are units in the same space and carry the parallax of their layer.
 * @param {'suburbs'|'mall'|'hospital'|'forest'|'depot'} zoneType
 * @param {number|string} seed
 * @param {number} W screen width in units @param {number} H screen height in units
 * @returns {{ layers: Array<{ spr: object, parallax: number, y: number, emissive?: object }>,
 *   ground: { spr: object, y: number }, groundY: number,
 *   lights: Array<{ x: number, y: number, r: number, color: string, intensity: number, flicker: number, parallax: number }>,
 *   fog: { color: string, alpha: number }, palette: { ambient: string, key: string } }}
 */
export function makeZoneBackdrop(zoneType, seed, W, H) {
  const zone = ZONE_BUILDERS[zoneType] ? zoneType : 'suburbs';
  const w = Math.max(64, W | 0);
  const h = Math.max(120, H | 0);
  return cached('bg:zone:' + zone + ':' + seed + ':' + w + 'x' + h, () => ZONE_BUILDERS[zone](seed, w, h, Math.round(h * GROUND_FRAC)));
}
