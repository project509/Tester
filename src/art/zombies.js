/**
 * art/zombies.js — Procedural zombie sprites and animation sets (unit resolution).
 *
 * Every zombie is a small articulated rig (head, torso, two arms, two legs) drawn
 * as pixel primitives — rotated boxes, discs and thick segments — each part
 * bevel-shaded with a hue-shifted ramp (cool shadows, warm highlights) and
 * inked with a 1px #14121a line so parts read against each other. Poses are
 * joint angles, so the same rig produces distinct gaits per type (dragging
 * shambler, leaning runner, head-back screamer, knuckle-dragging brute,
 * waddling bloater). The seed picks flesh ramp, clothes, hair and wounds so a
 * horde never looks cloned. Sprites face RIGHT; draw with flip for leftward.
 * All frames carry `glints` (eye pixels) and optional `glow` pixels used by the
 * emissive rim overlay. Everything is deterministic (makeRng) and cached.
 *
 * Public API:
 *   ZOMBIE_TYPES                                   ['shambler','runner','screamer','brute','bloater','familiar']
 *   ZOMBIE_SIZE                                    { [type]: { w, h } } unit frame size (die/scream frames are wider)
 *   makeZombieAnims(type, seed, appearance=null)   → { idle, walk, attack, hit, die, scream?, roar? }
 *        each { frames:[spr], fps, loop }; spr = { canvas, w, h, ox, oy, glints:[[x,y]], glow:[[x,y,hex,a]] }
 *        `appearance` (familiar only) = { skin, hair, hairStyle, beard, outfit, outfitColor, ... } where colours are
 *        hex strings, shadow→light ramps, or indices into PAL.skin / PAL.hair (all accepted).
 *   makeZombieRim(anim)                            → emissive-only overlay anim (moon rim + eye glints + glow)
 *   makeCorpse(type, seed, appearance=null)        → spr (lying body with blood pool, for the street / zones)
 */

import { PAL, ramp, mix, adjust, pick } from './palette.js';
import { makeSprite, cached, anim } from './sprite.js';
import { makeRng } from '../core/rng.js';

/** Zombie type ids (GDD §5). */
export const ZOMBIE_TYPES = Object.freeze(['shambler', 'runner', 'screamer', 'brute', 'bloater', 'familiar']);

/** Unit frame size per type (walk/idle/attack/hit). */
export const ZOMBIE_SIZE = Object.freeze({
  shambler: Object.freeze({ w: 20, h: 32 }),
  runner: Object.freeze({ w: 20, h: 32 }),
  screamer: Object.freeze({ w: 20, h: 32 }),
  brute: Object.freeze({ w: 28, h: 40 }),
  bloater: Object.freeze({ w: 24, h: 32 }),
  familiar: Object.freeze({ w: 20, h: 32 }),
});

const INK = PAL.ink;
const MOON = PAL.base.moon;
const GLINT = '#d6f8ff';
const ROT = PAL.base.rot;
const BONE = PAL.bone;
const BLOOD = PAL.blood;
const BLOOD_DRY = PAL.bloodDry;
const TAU = Math.PI * 2;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/** Rim overlays are cached per source anim object. */
const rimCache = new WeakMap();

// ───────────────────────────── colour helpers ─────────────────────────────

/** Packs a hex string into 0xRRGGBB. */
function packHex(hex) {
  let s = hex.charCodeAt(0) === 35 ? hex.slice(1) : hex;
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const v = parseInt(s, 16);
  return Number.isNaN(v) ? 0 : v;
}

/** Builds a 5-step ramp (deep, shadow, base, light, highlight) with a strong hue shift. */
function ramp5(hex) {
  return ramp(hex, 5, { hueShift: 0.35, dark: 0.62, light: 0.5 });
}

/**
 * Resolves an appearance colour field (hex | ramp array | index into `list`) into a base hex.
 * @param {*} v @param {readonly (readonly string[])[]} list @param {string} fallback
 */
function colourOf(v, list, fallback) {
  if (typeof v === 'string' && v.length >= 4) return v;
  if (Array.isArray(v) && v.length) return v[Math.min(v.length - 1, v.length >> 1)];
  if (typeof v === 'number' && list && list.length) {
    const r = list[((v % list.length) + list.length) % list.length];
    return r[r.length >> 1];
  }
  return fallback;
}

// ───────────────────────────── raster core ─────────────────────────────

/**
 * A part-based rasteriser over a painter's ImageData. Each part is drawn as
 * primitives into a mask, then bevelled (light from the top-left) and inked
 * around its silhouette, including where it overlaps earlier parts.
 * @param {object} p painter from makeSprite
 */
function createRig(p) {
  const w = p.w;
  const h = p.h;
  const data = p.data;
  const mask = new Uint8Array(w * h);
  const prims = [];
  const glints = [];
  const glow = [];
  let bx0 = w, by0 = h, bx1 = -1, by1 = -1;
  let base = 0;

  function paintIndex(i, c) {
    const j = i * 4;
    data[j] = c >> 16;
    data[j + 1] = (c >> 8) & 255;
    data[j + 2] = c & 255;
    data[j + 3] = 255;
  }

  function put(x, y) {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    mask[i] = 1;
    paintIndex(i, base);
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }

  /** Rotated box centred at (cx, cy), `ang` radians clockwise. */
  function box(cx, cy, bw, bh, ang) {
    const c = Math.cos(ang || 0);
    const s = Math.sin(ang || 0);
    const hw = bw * 0.5;
    const hh = bh * 0.5;
    const ext = Math.abs(hw * c) + Math.abs(hh * s);
    const eyt = Math.abs(hw * s) + Math.abs(hh * c);
    const x0 = Math.max(0, Math.floor(cx - ext));
    const x1 = Math.min(w - 1, Math.ceil(cx + ext));
    const y0 = Math.max(0, Math.floor(cy - eyt));
    const y1 = Math.min(h - 1, Math.ceil(cy + eyt));
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        const u = dx * c + dy * s;
        const v = -dx * s + dy * c;
        if (u > -hw && u <= hw && v > -hh && v <= hh) put(x, y);
      }
    }
  }

  /** Axis-aligned ellipse centred at (cx, cy). */
  function disc(cx, cy, rx, ry) {
    const x0 = Math.max(0, Math.floor(cx - rx));
    const x1 = Math.min(w - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(h - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y + 0.5 - cy) / ry;
      for (let x = x0; x <= x1; x++) {
        const dx = (x + 0.5 - cx) / rx;
        if (dx * dx + dy * dy <= 1) put(x, y);
      }
    }
  }

  /** Thick segment (round caps) from (x0,y0) to (x1,y1), `th` units wide. */
  function seg(ax, ay, bx, by, th) {
    const r = th * 0.5;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const r2 = r * r;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        let t = len2 > 0 ? ((px - ax) * vx + (py - ay) * vy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = px - (ax + vx * t);
        const dy = py - (ay + vy * t);
        if (dx * dx + dy * dy <= r2) put(x, y);
      }
    }
  }

  /**
   * Starts a part: subsequent primitives fill with ramp[2] and are shaded/inked by end().
   * @param {readonly string[]} rampArr 5-step ramp
   */
  function begin(rampArr) {
    prims.length = 0;
    if (bx1 >= bx0) {
      for (let y = by0; y <= by1; y++) mask.fill(0, y * w + bx0, y * w + bx1 + 1);
    }
    bx0 = w; by0 = h; bx1 = -1; by1 = -1;
    base = packHex(rampArr[2]);
    cur = rampArr;
  }
  let cur = null;

  /**
   * Finishes the part: bevel (highlight on top/left edges, shadow on bottom/right),
   * optional lower-half dither, then a 1px ink line around the silhouette.
   * @param {{ ink?: boolean, shade?: number, dark?: boolean, flat?: boolean }} [o]
   *   shade: 0..1 fraction of the part height (from the bottom) that receives dithered shadow
   *   dark: draw the whole part one ramp step darker (back limbs)
   */
  function end(o) {
    if (bx1 < bx0) return;
    const rampArr = cur;
    const dark = o && o.dark;
    const hi = packHex(rampArr[dark ? 2 : 3]);
    const mid = packHex(rampArr[dark ? 1 : 2]);
    const lo = packHex(rampArr[dark ? 0 : 1]);
    const deep = packHex(rampArr[0]);
    const flat = o && o.flat;
    const shade = o && o.shade > 0 ? o.shade : 0;
    const shadeY = by1 - (by1 - by0 + 1) * shade;
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const up = y > 0 && mask[i - w];
        const left = x > 0 && mask[i - 1];
        const down = y < h - 1 && mask[i + w];
        const right = x < w - 1 && mask[i + 1];
        let c = mid;
        if (!flat) {
          if (!up || !left) c = hi;
          else if (!down || !right) c = lo;
          else if (shade > 0 && y > shadeY) {
            const b = BAYER4[(y & 3) * 4 + (x & 3)];
            const t = (y - shadeY) / Math.max(1, by1 - shadeY);
            if (b / 16 < t * 0.8) c = lo;
          }
          if ((!up || !left) && (!down || !right) && !(up || down)) c = mid; // 1px-tall slivers stay mid
        }
        paintIndex(i, c);
      }
    }
    if (o && o.ink === false) return;
    const ink = packHex(INK);
    const ix0 = Math.max(0, bx0 - 1);
    const iy0 = Math.max(0, by0 - 1);
    const ix1 = Math.min(w - 1, bx1 + 1);
    const iy1 = Math.min(h - 1, by1 + 1);
    for (let y = iy0; y <= iy1; y++) {
      for (let x = ix0; x <= ix1; x++) {
        const i = y * w + x;
        if (mask[i]) continue;
        if ((x > 0 && mask[i - 1]) || (x < w - 1 && mask[i + 1]) || (y > 0 && mask[i - w]) || (y < h - 1 && mask[i + w])) {
          paintIndex(i, ink);
        }
      }
    }
    void deep;
  }

  /** Paints a detail pixel (no mask, no ink). */
  function px(x, y, hex, a) {
    p.set(x, y, hex, a);
  }

  /** Paints a detail pixel only where the current part's mask is set. */
  function pxIn(x, y, hex) {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    if (mask[yi * w + xi]) paintIndex(yi * w + xi, packHex(hex));
  }

  /** Records an eye glint at (x, y) and paints it. */
  function glint(x, y) {
    p.set(x, y, GLINT);
    glints.push([x | 0, y | 0]);
  }

  /** Records an emissive glow pixel (painted at low strength on the base sprite). */
  function glowPx(x, y, hex, a) {
    p.set(x, y, hex, 0.55);
    glow.push([x | 0, y | 0, hex, a === undefined ? 1 : a]);
  }

  return { w, h, mask, glints, glow, begin, end, box, disc, seg, px, pxIn, glint, glowPx };
}
