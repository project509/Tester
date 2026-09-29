/**
 * art/palette.js — Curated colour palettes and colour math for the HD-2D look.
 *
 * Every sprite generator picks its colours from PAL so the whole game reads as
 * one grim-but-beautiful world: muted mid-tones, cool (blue/violet) shadows and
 * warm (amber/yellow) highlights. `ramp()` is the workhorse: it turns any base
 * colour into a shadow→light ramp with that hue shift baked in.
 *
 * Public API:
 *   PAL                      { skin, hair, cloth, clothMuted, clothAccent, zombie, metal, wood,
 *                              concrete, blood, glass, vegetation, fire, bone, rust, ink, paper, base, ui }
 *   ramp(hex, n, opts?)      → [hex...] shadow→light, cached and frozen (do not mutate)
 *   pick(rng, list)          → element chosen with rng (undefined for empty list)
 *   outlineColor(hex)        → dark, cool-shifted outline colour for a body colour (cached)
 *   mix(hexA, hexB, t)       → hex        hexToRgb(hex) → {r,g,b}      rgbToHex(r,g,b) → hex
 *   hexToHsl(hex) → {h,s,l}  hslToHex(h,s,l) → hex     adjust(hex, {h,s,l}) → hex
 */

const HEX_DIGITS = '0123456789abcdef';
const rampCache = new Map();
const outlineCache = new Map();

/** Hue (degrees) that shadows drift toward and highlights drift toward. */
const SHADOW_HUE = 228;
const LIGHT_HUE = 46;

// ───────────────────────────── colour math ─────────────────────────────

/**
 * Parses '#rgb' / '#rrggbb' / '#rrggbbaa' into {r,g,b} 0–255. Invalid input → black.
 * @param {string} hex
 * @returns {{r:number,g:number,b:number}}
 */
export function hexToRgb(hex) {
  let s = typeof hex === 'string' ? hex : '';
  if (s.charCodeAt(0) === 35) s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  else if (s.length === 8) s = s.slice(0, 6);
  const v = s.length === 6 ? parseInt(s, 16) : NaN;
  if (Number.isNaN(v)) return { r: 0, g: 0, b: 0 };
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function hex2(c) {
  const v = c < 0 ? 0 : c > 255 ? 255 : Math.round(c);
  return HEX_DIGITS[v >> 4] + HEX_DIGITS[v & 15];
}

/**
 * (r,g,b) 0–255 → '#rrggbb' (components clamped and rounded).
 * @param {number} r @param {number} g @param {number} b
 * @returns {string}
 */
export function rgbToHex(r, g, b) {
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

/**
 * Hex → HSL with h in degrees [0,360), s and l in 0..1.
 * @param {string} hex
 * @returns {{h:number,s:number,l:number}}
 */
export function hexToHsl(hex) {
  const c = hexToRgb(hex);
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * HSL → hex. h in degrees (wrapped), s/l clamped to 0..1.
 * @param {number} h @param {number} s @param {number} l
 * @returns {string}
 */
export function hslToHex(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = s < 0 ? 0 : s > 1 ? 1 : s;
  const ll = l < 0 ? 0 : l > 1 ? 1 : l;
  if (ss === 0) return rgbToHex(ll * 255, ll * 255, ll * 255);
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return rgbToHex(hueToRgb(p, q, hh + 1 / 3) * 255, hueToRgb(p, q, hh) * 255, hueToRgb(p, q, hh - 1 / 3) * 255);
}

/**
 * Linear RGB mix of two hex colours (t clamped to 0..1).
 * @param {string} hexA @param {string} hexB @param {number} t
 * @returns {string}
 */
export function mix(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return rgbToHex(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k);
}

/**
 * Adds HSL deltas to a colour: h in degrees, s and l as absolute 0..1 offsets.
 * @param {string} hex
 * @param {{h?:number,s?:number,l?:number}} d
 * @returns {string}
 */
export function adjust(hex, d) {
  const c = hexToHsl(hex);
  return hslToHex(c.h + (d.h || 0), c.s + (d.s || 0), c.l + (d.l || 0));
}

/** Signed shortest angular distance from hue a to hue b (degrees, −180..180). */
function hueDelta(a, b) {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ───────────────────────────── ramps ─────────────────────────────

/**
 * Builds a shadow→light ramp of n colours from a base colour. Shadows get
 * darker, a touch more saturated and drift toward blue; highlights get lighter,
 * less saturated and drift toward warm yellow. Greys pick up a cool/warm tint.
 * The middle of the ramp is (close to) the base colour.
 *
 * @param {string} hex base colour
 * @param {number} n ramp length (≥ 1)
 * @param {{ hueShift?:number, dark?:number, light?:number }} [opts]
 *        hueShift: fraction of the distance toward the shadow/light hue at the ends (0.25)
 *        dark: how far the darkest step drops toward black (0..1, 0.6)
 *        light: how far the lightest step rises toward white (0..1, 0.5)
 * @returns {readonly string[]}
 */
export function ramp(hex, n, opts) {
  const len = n >= 1 && Number.isFinite(n) ? Math.floor(n) : 1;
  const hueShift = opts && typeof opts.hueShift === 'number' ? opts.hueShift : 0.25;
  const dark = opts && typeof opts.dark === 'number' ? opts.dark : 0.6;
  const light = opts && typeof opts.light === 'number' ? opts.light : 0.5;
  const key = hex + '|' + len + '|' + hueShift + '|' + dark + '|' + light;
  const hit = rampCache.get(key);
  if (hit) return hit;

  const base = hexToHsl(hex);
  const grey = base.s < 0.08;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    const t = len === 1 ? 0 : (i / (len - 1)) * 2 - 1; // −1 shadow … +1 light
    const k = Math.abs(t);
    let h = base.h;
    let s = base.s;
    let l = base.l;
    if (t < 0) {
      l = base.l * (1 - dark * k);
      s = grey ? 0.14 * k : s + (1 - s) * 0.22 * k;
      h = grey ? SHADOW_HUE : h + hueDelta(h, SHADOW_HUE) * hueShift * k;
    } else if (t > 0) {
      l = base.l + (1 - base.l) * light * k;
      s = grey ? 0.1 * k : s * (1 - 0.3 * k);
      h = grey ? LIGHT_HUE : h + hueDelta(h, LIGHT_HUE) * hueShift * k;
    }
    out[i] = hslToHex(h, s, l);
  }
  Object.freeze(out);
  rampCache.set(key, out);
  return out;
}

/**
 * A dark, slightly cool outline colour that sits well around a body colour.
 * @param {string} hex
 * @returns {string}
 */
export function outlineColor(hex) {
  const hit = outlineCache.get(hex);
  if (hit) return hit;
  const c = hexToHsl(hex);
  const h = c.s < 0.08 ? SHADOW_HUE : c.h + hueDelta(c.h, SHADOW_HUE) * 0.4;
  const s = c.s < 0.08 ? 0.2 : Math.min(1, c.s * 0.7 + 0.12);
  const l = Math.max(0.06, Math.min(0.16, c.l * 0.3));
  const out = hslToHex(h, s, l);
  outlineCache.set(hex, out);
  return out;
}

/**
 * Picks one element with the rng (uses rng.pick when present, else rng.next()).
 * @template T
 * @param {{pick?:(a:T[])=>T, next:()=>number}} rng
 * @param {readonly T[]} list
 * @returns {T|undefined}
 */
export function pick(rng, list) {
  if (!list || list.length === 0) return undefined;
  if (rng && typeof rng.pick === 'function') return rng.pick(list);
  const r = rng && typeof rng.next === 'function' ? rng.next() : 0;
  return list[Math.floor(r * list.length) % list.length];
}

// ───────────────────────────── curated sets ─────────────────────────────

const r3 = (hex) => ramp(hex, 3);
const r4 = (hex) => ramp(hex, 4);
const r5 = (hex) => ramp(hex, 5);

/** The GDD's 16 fixed anchor colours (lighting adds continuous colour on top). */
const BASE = Object.freeze({
  ink: '#14121a', slate: '#2b2a33', concrete: '#5c5a57', rust: '#7a3b2e', wood: '#8a5a3c',
  bone: '#d9c9a3', sand: '#d9b27a', amber: '#ffb347', ember: '#ff6a1a', blood: '#8b1a1a',
  rot: '#6fbf73', moss: '#3b4a3a', sky: '#2e4a6b', moon: '#8fd3e8', violet: '#5a3e6e', paper: '#f2ead7',
});

/** Eight skin tones, pale to deep, each [shadow, base, light]. */
const SKIN = Object.freeze([
  '#f1cdb1', '#e8b894', '#d9a077', '#c68b63', '#a86f4c', '#8a5638', '#6c4128', '#4d2d1c',
].map(r3));

/** Ten hair colours: blacks, browns, blondes, reds, greys, one dyed. */
const HAIR = Object.freeze([
  '#1c1a22', '#2f2622', '#4a3427', '#6b4a33', '#8a6a44', '#b8965a', '#d9b877', '#8c3a24', '#7a7480', '#c9c2c4',
].map(r3));

/** Twenty muted survivor cloth colours (worn denim, canvas, wool, flannel). */
const CLOTH_MUTED = Object.freeze([
  '#3e4a5c', '#556474', '#2e3a44', '#4b5a4a', '#5f6b4c', '#6e6a4f', '#7a6b52', '#8a7a62',
  '#5c4a3e', '#6f5546', '#4a3b3d', '#6b4a4e', '#58506a', '#3f3f52', '#77786e', '#9a9382',
  '#2a2d33', '#8c8378', '#5a6d6b', '#7b6f5f',
].map(r3));

/** A few accent colours: hi-vis vest, red bandana, medic white, navy, teal, mustard. */
const CLOTH_ACCENT = Object.freeze([
  '#e08a2c', '#a83232', '#d9d2c0', '#243a63', '#2f7f7a', '#c9a63a',
].map(r3));

/** Five rotten-flesh ramps: grey-green, bruise violet, jaundice, bloated blue, charred. */
const ZOMBIE = Object.freeze([
  '#6f8a68', '#7a6a80', '#9a9a5e', '#5e7d8a', '#4e463f',
].map(r4));

/**
 * All curated palettes. Ramps are shadow→light. Everything is frozen.
 */
export const PAL = Object.freeze({
  base: BASE,
  ink: BASE.ink,
  paper: BASE.paper,
  skin: SKIN,
  hair: HAIR,
  cloth: Object.freeze(CLOTH_MUTED.concat(CLOTH_ACCENT)),
  clothMuted: CLOTH_MUTED,
  clothAccent: CLOTH_ACCENT,
  zombie: ZOMBIE,
  metal: r5('#7c8391'),
  metalDark: r5('#4a4f5a'),
  wood: r5(BASE.wood),
  woodPale: r5('#b08a5c'),
  concrete: r5(BASE.concrete),
  brick: r5('#8a4a3a'),
  rust: r5(BASE.rust),
  blood: r5(BASE.blood),
  bloodDry: r5('#4f1a1a'),
  glass: r5('#7fb2c9'),
  vegetation: r5('#4f7a3f'),
  moss: r5(BASE.moss),
  fire: Object.freeze(['#5a1208', '#a8260f', BASE.ember, BASE.amber, '#ffe08a', '#fff6d6']),
  smoke: r5('#5a5866'),
  bone: r5(BASE.bone),
  sand: r5(BASE.sand),
  ui: Object.freeze({
    bg: '#0e0d14',
    panel: '#1b1a24',
    panel2: '#262432',
    border: '#3a3848',
    text: BASE.paper,
    muted: '#8f8ba0',
    dim: '#5c5a6c',
    accent: BASE.amber,
    accent2: BASE.ember,
    danger: '#e0413b',
    ok: BASE.rot,
    warn: '#f2b134',
    water: '#4fa3e0',
    power: '#ffe25a',
    food: '#e08a3c',
    scrap: '#9aa3b0',
    meds: '#f06a7a',
    ammo: '#c69c4b',
    morale: '#e9a0c4',
    noise: '#c7b6ff',
    threat: '#ff4d3d',
    xp: '#9ad8ff',
    infection: BASE.rot,
    night: BASE.sky,
    moon: BASE.moon,
    ink: BASE.ink,
  }),
});
