/**
 * render/particles.js — Pooled 2D particle system (max 1500, struct-of-arrays).
 *
 * Every particle lives in preallocated typed arrays; emit/update/draw never
 * allocate. Types have distinct physics and looks: smoke, spark, ember, blood,
 * dust, debris, muzzle, rain, snowash, glow, shell, flash, text. Positions are
 * world css px and are integer-snapped when drawn (circles/rects only, pixel
 * look). draw() paints the non-additive types; drawEmissive() paints the
 * additive ones and is meant to run inside lights.drawEmissive(). Both expect
 * the context already in world space (camera applied); `cam` is used only for
 * view culling when setView(W, H) has been called.
 *
 * Public API:
 *   createParticles() → ps
 *   ps.emit(type, x, y, opts) → slot|-1     opts: { speed, dir, spread, vx, vy, life, size, scale, color, groundY, text }
 *   ps.burst(type, x, y, n, opts) → number emitted
 *   ps.update(dt) · ps.draw(ctx, cam) · ps.drawEmissive(ctx, cam) · ps.clear() · ps.count
 *   ps.setView(W, H) · ps.time · PARTICLE_TYPES · MAX_PARTICLES
 */

import { makeRng } from '../core/rng.js';
import { lerpColor, shade } from '../core/util.js';

/** Pool capacity. */
export const MAX_PARTICLES = 1500;
/** Supported particle type names. */
export const PARTICLE_TYPES = Object.freeze([
  'smoke', 'spark', 'ember', 'blood', 'dust', 'debris', 'muzzle', 'rain', 'snowash', 'glow', 'shell', 'flash', 'text',
]);

const T_NONE = 0;
const T_SMOKE = 1;
const T_SPARK = 2;
const T_EMBER = 3;
const T_BLOOD = 4;
const T_DUST = 5;
const T_DEBRIS = 6;
const T_MUZZLE = 7;
const T_RAIN = 8;
const T_SNOWASH = 9;
const T_GLOW = 10;
const T_SHELL = 11;
const T_FLASH = 12;
const T_TEXT = 13;

/** name → type id */
const TYPE_ID = { smoke: 1, spark: 2, ember: 3, blood: 4, dust: 5, debris: 6, muzzle: 7, rain: 8, snowash: 9, glow: 10, shell: 11, flash: 12, text: 13 };
/** Types drawn on the emissive (additive) layer. */
const ADDITIVE = new Uint8Array([0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0]);

/** Colour ramp resolution (index = life fraction × (RAMP_N - 1)). */
const RAMP_N = 8;
/** flags bits */
const F_STUCK = 1;
const F_BOUNCED = 2;
/** Life a blood particle keeps once it has splatted onto the ground. */
const SPLAT_LIFE_MIN = 4;
const SPLAT_LIFE_MAX = 8;
const TAU = Math.PI * 2;
const EMPTY = Object.freeze({});
const MAX_CUSTOM_RAMPS = 64;
const TEXT_FONT_FAMILY = '"Courier New", Menlo, ui-monospace, monospace';

/** Cosmetic randomness only (jitter, wobble phases); never affects game state. */
const rng = makeRng('particles');

/**
 * Expands a few key colours into an RAMP_N-entry array of hex strings.
 * @param {string[]} stops
 * @returns {string[]}
 */
function makeRamp(stops) {
  const out = new Array(RAMP_N);
  const segs = stops.length - 1;
  for (let i = 0; i < RAMP_N; i++) {
    const t = segs === 0 ? 0 : (i / (RAMP_N - 1)) * segs;
    const k = Math.min(segs - 1, Math.floor(t));
    out[i] = segs === 0 ? stops[0] : lerpColor(stops[k], stops[k + 1], t - k);
  }
  return out;
}

/** Per-type colour ramps (variants picked at emit time). Index 0 = birth, last = death. */
const RAMPS = [
  null,
  [makeRamp(['#b9bcc4', '#8a8e97', '#5c6069']), makeRamp(['#a7a9ae', '#7d7f86', '#4e5058']), makeRamp(['#8e9199', '#6b6e76', '#43454c'])],
  [makeRamp(['#ffffff', '#ffe27a', '#ff9b2e', '#b3331a']), makeRamp(['#fff6c8', '#ffc84a', '#ff6a1f', '#8a2410'])],
  [makeRamp(['#ffd27a', '#ff8b2a', '#c8401a', '#5a1a0c']), makeRamp(['#ffe9a8', '#ffa040', '#d9502a', '#4b1409'])],
  [makeRamp(['#c41d2b', '#8f1420', '#4a0a12']), makeRamp(['#a8172a', '#6e0f1c', '#3a0810']), makeRamp(['#d5283a', '#7c1220', '#2e070d'])],
  [makeRamp(['#c8b9a0', '#a89a82', '#7d7364']), makeRamp(['#b3ab9c', '#8d8677', '#6b665c'])],
  [makeRamp(['#7a7268', '#5b554c', '#3a3631']), makeRamp(['#8c6f4f', '#6a5238', '#42321f']), makeRamp(['#9a9a9a', '#6c6c6c', '#454545'])],
  [makeRamp(['#ffffff', '#fff3a0', '#ffb040'])],
  [makeRamp(['#b8c7d9', '#93a4b8']), makeRamp(['#a7b7cb', '#7f91a6'])],
  [makeRamp(['#9d9a94', '#75726d', '#4f4d49']), makeRamp(['#b5b2ab', '#8a8781', '#5b5955'])],
  [makeRamp(['#ffe9b3', '#ffc76a']), makeRamp(['#b8f0ff', '#62c6ff']), makeRamp(['#c8ffb0', '#6fe07a'])],
  [makeRamp(['#f2d16b', '#c9a441', '#8f7028']), makeRamp(['#e8c25a', '#b08c33', '#7a5f20'])],
  [makeRamp(['#ffffff', '#fff1c4'])],
  [makeRamp(['#ffffff'])],
];

/** Per-type base life (s), size (css px), gravity (px/s²), drag (1/s), and base velocity. */
const DEF = [
  null,
  { life: 1.7, size: 5, grav: 0, drag: 0.8, vx: 0, vy: -28, jitter: 0.35 },   // smoke
  { life: 0.38, size: 1.5, grav: 320, drag: 0.6, vx: 0, vy: 0, jitter: 0.4 },  // spark
  { life: 2.4, size: 1.5, grav: -6, drag: 0.5, vx: 0, vy: -26, jitter: 0.4 },  // ember
  { life: 0.9, size: 2, grav: 520, drag: 0.4, vx: 0, vy: -40, jitter: 0.3 },   // blood
  { life: 1.6, size: 1.5, grav: -4, drag: 0.9, vx: 0, vy: -6, jitter: 0.4 },   // dust
  { life: 1.6, size: 2.5, grav: 620, drag: 0.2, vx: 0, vy: -140, jitter: 0.3 }, // debris
  { life: 0.085, size: 8, grav: 0, drag: 0, vx: 0, vy: 0, jitter: 0.15 },      // muzzle
  { life: 1.4, size: 11, grav: 0, drag: 0, vx: -120, vy: 720, jitter: 0.25 },  // rain
  { life: 6, size: 1.5, grav: 0, drag: 0, vx: 4, vy: 24, jitter: 0.35 },       // snowash
  { life: 1.5, size: 4, grav: 0, drag: 2, vx: 0, vy: -4, jitter: 0.3 },        // glow
  { life: 1.6, size: 2, grav: 720, drag: 0.3, vx: 70, vy: -170, jitter: 0.3 }, // shell
  { life: 0.06, size: 26, grav: 0, drag: 0, vx: 0, vy: 0, jitter: 0.2 },       // flash
  { life: 1.05, size: 11, grav: 0, drag: 3.2, vx: 0, vy: -38, jitter: 0 },     // text
];

/** Per-type default burst spread (radians) and speed (px/s) when opts.speed is given without dir. */
const DEF_SPEED = [0, 12, 150, 20, 120, 18, 110, 0, 0, 0, 0, 0, 0, 0];

/**
 * Creates a particle system.
 * @returns {object} ps (see file header)
 */
export function createParticles() {
  const N = MAX_PARTICLES;
  const px = new Float32Array(N);
  const py = new Float32Array(N);
  const vx = new Float32Array(N);
  const vy = new Float32Array(N);
  const life = new Float32Array(N);
  const maxLife = new Float32Array(N);
  const size = new Float32Array(N);
  const phase = new Float32Array(N);
  const ground = new Float32Array(N);
  const grav = new Float32Array(N);
  const drag = new Float32Array(N);
  const aux = new Float32Array(N);
  const type = new Uint8Array(N);
  const flags = new Uint8Array(N);
  /** @type {Array<string[]>} colour ramp reference per slot */
  const ramp = new Array(N).fill(null);
  /** @type {Array<string|null>} text label per slot (text type only) */
  const texts = new Array(N).fill(null);
  /** @type {Array<string|null>} text colour per slot (text type only) */
  const textColors = new Array(N).fill(null);

  const active = new Int32Array(N);
  const slotPos = new Int32Array(N);
  const free = new Int32Array(N);
  let activeCount = 0;
  let freeCount = N;
  for (let i = 0; i < N; i++) free[i] = N - 1 - i;

  /** @type {Map<string, string[]>} custom colour ramps keyed by type|color */
  const customRamps = new Map();
  /** @type {Map<number, string>} font strings keyed by pixel size */
  const fonts = new Map();

  let time = 0;
  let viewW = 0;
  let viewH = 0;
  let textCount = 0;

  /** Returns (building on first use) the ramp for a custom colour. */
  function customRamp(t, color) {
    const key = t + '|' + color;
    let r = customRamps.get(key);
    if (r === undefined) {
      if (customRamps.size >= MAX_CUSTOM_RAMPS) customRamps.clear();
      r = t === T_GLOW || t === T_FLASH || t === T_MUZZLE
        ? makeRamp([shade(color, 0.35), color])
        : makeRamp([shade(color, 0.15), color, shade(color, -0.45)]);
      customRamps.set(key, r);
    }
    return r;
  }

  /** Returns the cached font string for a text size. */
  function fontFor(sz) {
    let f = fonts.get(sz);
    if (f === undefined) {
      f = 'bold ' + sz + 'px ' + TEXT_FONT_FAMILY;
      fonts.set(sz, f);
    }
    return f;
  }

  /** Frees the slot at active-list position k (swap-remove). */
  function release(k) {
    const i = active[k];
    if (type[i] === T_TEXT) {
      textCount--;
      texts[i] = null;
      textColors[i] = null;
    }
    type[i] = T_NONE;
    ramp[i] = null;
    const last = active[--activeCount];
    active[k] = last;
    slotPos[last] = k;
    free[freeCount++] = i;
  }

  /** Random multiplier in [1 - j, 1 + j]. */
  function jit(j) {
    return j > 0 ? 1 + rng.float(-j, j) : 1;
  }

  /**
   * Spawns one particle.
   * @param {string} typeName
   * @param {number} x world css px
   * @param {number} y world css px
   * @param {object} [opts]
   * @returns {number} slot index or -1 when the pool is full / type unknown
   */
  function emit(typeName, x, y, opts) {
    const t = TYPE_ID[typeName] | 0;
    if (t === T_NONE || freeCount === 0 || !isFinite(x) || !isFinite(y)) return -1;
    const o = opts || EMPTY;
    const d = DEF[t];
    const i = free[--freeCount];
    slotPos[i] = activeCount;
    active[activeCount++] = i;

    type[i] = t;
    flags[i] = 0;
    px[i] = x;
    py[i] = y;

    const scale = o.scale > 0 ? o.scale : 1;
    life[i] = (o.life > 0 ? o.life : d.life * jit(d.jitter));
    maxLife[i] = life[i];
    size[i] = (o.size > 0 ? o.size : d.size * jit(d.jitter)) * scale;
    grav[i] = typeof o.gravity === 'number' ? o.gravity : d.grav;
    drag[i] = d.drag;
    ground[i] = typeof o.groundY === 'number' ? o.groundY : NaN;
    phase[i] = rng.float(0, TAU);

    // Velocity: type base (jittered) + polar burst (dir/spread/speed) + explicit vx/vy.
    let bvx = d.vx * jit(0.5);
    let bvy = d.vy * jit(d.jitter);
    if (t === T_SHELL) bvx *= rng.chance(0.5) ? 1 : -1;
    if (t === T_SPARK || t === T_DEBRIS || t === T_BLOOD || t === T_DUST || o.speed !== undefined || o.dir !== undefined) {
      const spread = typeof o.spread === 'number' ? o.spread : TAU;
      const dir = (typeof o.dir === 'number' ? o.dir : -Math.PI / 2) + rng.float(-spread * 0.5, spread * 0.5);
      const spd = (o.speed !== undefined ? +o.speed : DEF_SPEED[t]) * jit(0.45);
      bvx += Math.cos(dir) * spd;
      bvy += Math.sin(dir) * spd;
    }
    vx[i] = bvx + (o.vx || 0);
    vy[i] = bvy + (o.vy || 0);

    // Type-specific extras.
    switch (t) {
      case T_EMBER: aux[i] = rng.float(14, 34); break;   // wobble amplitude px/s
      case T_SNOWASH: aux[i] = rng.float(8, 22); break;
      case T_SMOKE: aux[i] = rng.float(0.6, 1.4); break;  // growth factor
      case T_GLOW: aux[i] = rng.float(2.5, 5); break;     // pulse rate
      default: aux[i] = 0;
    }

    const variants = RAMPS[t];
    ramp[i] = typeof o.color === 'string' && t !== T_TEXT ? customRamp(t, o.color) : variants[rng.int(0, variants.length - 1)];
    if (t === T_TEXT) {
      texts[i] = o.text !== undefined && o.text !== null ? String(o.text) : '';
      textColors[i] = typeof o.color === 'string' ? o.color : '#ffffff';
      textCount++;
    }
    return i;
  }

  /**
   * Spawns n particles of one type at a point.
   * @returns {number} how many were actually emitted
   */
  function burst(typeName, x, y, n, opts) {
    let c = 0;
    for (let k = 0; k < n; k++) {
      if (emit(typeName, x, y, opts) >= 0) c++;
      else break;
    }
    return c;
  }

  /** Blood/debris/shell/rain ground interaction for slot i. Returns false to kill. */
  function hitGround(i, t) {
    const g = ground[i];
    if (g !== g || py[i] < g || vy[i] < 0) return true; // NaN check: no ground
    if (t === T_RAIN) return false;
    py[i] = g;
    if (t === T_BLOOD) {
      vx[i] = 0; vy[i] = 0; grav[i] = 0;
      flags[i] |= F_STUCK;
      const l = rng.float(SPLAT_LIFE_MIN, SPLAT_LIFE_MAX);
      life[i] = l; maxLife[i] = l;
      return true;
    }
    if (flags[i] & F_BOUNCED) {
      vy[i] = 0; grav[i] = 0;
      vx[i] *= 0.5;
      if (vx[i] * vx[i] < 4) { vx[i] = 0; flags[i] |= F_STUCK; }
      return true;
    }
    flags[i] |= F_BOUNCED;
    vy[i] = -vy[i] * (t === T_SHELL ? 0.35 : 0.42);
    vx[i] *= 0.6;
    return true;
  }

  /**
   * Advances every particle.
   * @param {number} dt seconds
   */
  function update(dt) {
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;
    time += dt;
    for (let k = activeCount - 1; k >= 0; k--) {
      const i = active[k];
      life[i] -= dt;
      if (life[i] <= 0) { release(k); continue; }
      const t = type[i];
      if (flags[i] & F_STUCK) continue;
      vy[i] += grav[i] * dt;
      const dr = drag[i];
      if (dr > 0) {
        const f = 1 - dr * dt;
        vx[i] *= f;
        vy[i] *= f;
      }
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      switch (t) {
        case T_EMBER:
          px[i] += Math.sin(time * 3.1 + phase[i]) * aux[i] * dt;
          break;
        case T_SNOWASH:
          px[i] += Math.sin(time * 1.3 + phase[i]) * aux[i] * dt;
          break;
        case T_BLOOD:
        case T_DEBRIS:
        case T_SHELL:
        case T_RAIN:
          if (!hitGround(i, t)) release(k);
          break;
        default:
      }
    }
  }

  /** True when slot i is outside the culling rect (only when setView was called). */
  function culled(i, cam) {
    if (viewW === 0 || !cam) return false;
    const z = cam.zoom > 0 ? cam.zoom : 1;
    const hw = viewW / z * 0.5 + 40;
    const hh = viewH / z * 0.5 + 40;
    const cx = cam.x || 0;
    const cy = cam.y || 0;
    return px[i] < cx - hw || px[i] > cx + hw || py[i] < cy - hh || py[i] > cy + hh;
  }

  /** Filled circle at integer-snapped centre. */
  function circle(ctx, x, y, r) {
    ctx.beginPath();
    ctx.arc(Math.round(x), Math.round(y), r, 0, TAU);
    ctx.fill();
  }

  /** Filled rect centred on an integer-snapped point. */
  function rect(ctx, x, y, w, h) {
    ctx.fillRect(Math.round(x - w * 0.5), Math.round(y - h * 0.5), w, h);
  }

  /** Draws one non-additive particle; returns nothing. */
  function drawOne(ctx, i, t, u) {
    const rp = ramp[i];
    const s = size[i];
    switch (t) {
      case T_SMOKE: {
        ctx.globalAlpha = (u < 0.15 ? u / 0.15 : 1 - (u - 0.15) / 0.85) * 0.55;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        circle(ctx, px[i], py[i], Math.round(s * (1 + u * 1.8 * aux[i])));
        break;
      }
      case T_BLOOD: {
        if (flags[i] & F_STUCK) {
          ctx.globalAlpha = u > 0.7 ? (1 - u) / 0.3 : 1;
          ctx.fillStyle = rp[RAMP_N - 1];
          rect(ctx, px[i], py[i], Math.max(2, Math.round(s * 2)), 1);
        } else {
          ctx.globalAlpha = 1;
          ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
          const w = Math.max(1, Math.round(s));
          rect(ctx, px[i], py[i], w, w);
        }
        break;
      }
      case T_DUST: {
        ctx.globalAlpha = (u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8) * 0.7;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        const w = Math.max(1, Math.round(s));
        rect(ctx, px[i], py[i], w, w);
        break;
      }
      case T_DEBRIS: {
        ctx.globalAlpha = u > 0.75 ? (1 - u) / 0.25 : 1;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        const w = Math.max(1, Math.round(s));
        rect(ctx, px[i], py[i], w, w);
        break;
      }
      case T_RAIN: {
        ctx.globalAlpha = 0.38;
        ctx.fillStyle = rp[0];
        const len = Math.max(3, Math.round(s / 3));
        const dx = vx[i] / (vy[i] || 1) * len;
        const x = Math.round(px[i]);
        const y = Math.round(py[i]);
        ctx.fillRect(x, y, 1, len);
        ctx.fillRect(Math.round(x - dx), y - len, 1, len);
        ctx.fillRect(Math.round(x - dx * 2), y - len * 2, 1, len);
        break;
      }
      case T_SNOWASH: {
        ctx.globalAlpha = (u < 0.1 ? u / 0.1 : u > 0.8 ? (1 - u) / 0.2 : 1) * 0.85;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        const w = Math.max(1, Math.round(s));
        rect(ctx, px[i], py[i], w, w);
        break;
      }
      case T_SHELL: {
        ctx.globalAlpha = u > 0.7 ? (1 - u) / 0.3 : 1;
        const flat = (flags[i] & F_STUCK) !== 0 || Math.abs(vx[i]) > Math.abs(vy[i]);
        const x = Math.round(px[i]);
        const y = Math.round(py[i]);
        ctx.fillStyle = rp[RAMP_N >> 1];
        if (flat) { ctx.fillRect(x - 1, y, 2, 1); ctx.fillStyle = rp[0]; ctx.fillRect(x - 1, y, 1, 1); }
        else { ctx.fillRect(x, y - 1, 1, 2); ctx.fillStyle = rp[0]; ctx.fillRect(x, y - 1, 1, 1); }
        break;
      }
      default:
    }
  }

  /** Draws one additive particle. */
  function drawOneEmissive(ctx, i, t, u) {
    const rp = ramp[i];
    const s = size[i];
    switch (t) {
      case T_SPARK: {
        ctx.globalAlpha = u > 0.5 ? (1 - u) * 2 : 1;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        const w = Math.max(1, Math.round(s));
        rect(ctx, px[i], py[i], w, w);
        ctx.globalAlpha *= 0.5;
        rect(ctx, px[i] - vx[i] * 0.016, py[i] - vy[i] * 0.016, w, w);
        break;
      }
      case T_EMBER: {
        const pulse = 0.75 + 0.25 * Math.sin(time * 9 + phase[i]);
        const a = (u < 0.1 ? u / 0.1 : u > 0.6 ? (1 - u) / 0.4 : 1) * pulse;
        ctx.fillStyle = rp[(u * (RAMP_N - 1)) | 0];
        ctx.globalAlpha = a * 0.25;
        circle(ctx, px[i], py[i], Math.round(s * 2.2));
        ctx.globalAlpha = a;
        const w = Math.max(1, Math.round(s));
        rect(ctx, px[i], py[i], w, w);
        break;
      }
      case T_MUZZLE: {
        ctx.fillStyle = rp[u < 0.5 ? 0 : RAMP_N - 1];
        if (u < 0.5) {
          ctx.globalAlpha = 1;
          circle(ctx, px[i], py[i], Math.round(s));
          ctx.globalAlpha = 0.8;
          rect(ctx, px[i], py[i], Math.round(s * 3), 2);
          rect(ctx, px[i], py[i], 2, Math.round(s * 2));
        } else {
          ctx.globalAlpha = 0.7;
          circle(ctx, px[i], py[i], Math.round(s * 0.5));
        }
        break;
      }
      case T_GLOW: {
        const pulse = 0.8 + 0.2 * Math.sin(time * aux[i] + phase[i]);
        const a = (u < 0.15 ? u / 0.15 : u > 0.7 ? (1 - u) / 0.3 : 1) * pulse;
        ctx.fillStyle = rp[0];
        ctx.globalAlpha = a * 0.3;
        circle(ctx, px[i], py[i], Math.round(s * pulse));
        ctx.globalAlpha = a * 0.9;
        ctx.fillStyle = rp[RAMP_N - 1];
        circle(ctx, px[i], py[i], Math.max(1, Math.round(s * 0.4)));
        break;
      }
      case T_FLASH: {
        ctx.globalAlpha = (1 - u) * 0.85;
        ctx.fillStyle = rp[0];
        circle(ctx, px[i], py[i], Math.round(s * (1 + u * 0.6)));
        break;
      }
      default:
    }
  }

  /** Draws every floating-text particle (stroke + fill, pop-in scale). */
  function drawTexts(ctx, cam) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000000';
    for (let k = 0; k < activeCount; k++) {
      const i = active[k];
      if (type[i] !== T_TEXT || culled(i, cam)) continue;
      const u = 1 - life[i] / maxLife[i];
      const pop = u < 0.12 ? 1 + 0.4 * (1 - u / 0.12) : 1;
      ctx.globalAlpha = u > 0.6 ? (1 - u) / 0.4 : 1;
      ctx.font = fontFor(Math.round(size[i]));
      ctx.fillStyle = textColors[i];
      const x = Math.round(px[i]);
      const y = Math.round(py[i]);
      if (pop !== 1) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(pop, pop);
        ctx.strokeText(texts[i], 0, 0);
        ctx.fillText(texts[i], 0, 0);
        ctx.restore();
      } else {
        ctx.strokeText(texts[i], x, y);
        ctx.fillText(texts[i], x, y);
      }
    }
  }

  /**
   * Draws the non-additive particles (world space; ctx already has the camera applied).
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} [cam] used for culling when setView() was called
   */
  function draw(ctx, cam) {
    if (!ctx || activeCount === 0) return;
    try {
      ctx.save();
      for (let k = 0; k < activeCount; k++) {
        const i = active[k];
        const t = type[i];
        if (ADDITIVE[t] || t === T_TEXT || culled(i, cam)) continue;
        drawOne(ctx, i, t, 1 - life[i] / maxLife[i]);
      }
      if (textCount > 0) drawTexts(ctx, cam);
      ctx.restore();
    } catch (err) {
      ctx.restore();
      if (typeof console !== 'undefined' && console.error) console.error('[particles] draw', err);
    }
  }

  /**
   * Draws the additive particles onto the emissive layer (call inside lights.drawEmissive).
   * @param {CanvasRenderingContext2D} ctx emissive context in world space
   * @param {object} [cam]
   */
  function drawEmissive(ctx, cam) {
    if (!ctx || activeCount === 0) return;
    try {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < activeCount; k++) {
        const i = active[k];
        const t = type[i];
        if (!ADDITIVE[t] || culled(i, cam)) continue;
        drawOneEmissive(ctx, i, t, 1 - life[i] / maxLife[i]);
      }
      ctx.restore();
    } catch (err) {
      ctx.restore();
      if (typeof console !== 'undefined' && console.error) console.error('[particles] drawEmissive', err);
    }
  }

  /** Kills every particle. */
  function clear() {
    for (let k = activeCount - 1; k >= 0; k--) release(k);
  }

  /**
   * Sets the viewport size (css px) used with cam.x/y/zoom for culling.
   * Pass 0,0 to disable culling.
   */
  function setView(W, H) {
    viewW = W > 0 ? W : 0;
    viewH = H > 0 ? H : 0;
  }

  return {
    emit,
    burst,
    update,
    draw,
    drawEmissive,
    clear,
    setView,
    /** Live particle count. */
    get count() { return activeCount; },
    /** Seconds accumulated through update(). */
    get time() { return time; },
  };
}
