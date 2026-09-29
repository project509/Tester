/**
 * core/util.js — Small pure helpers shared by every layer (math, easing,
 * colour, formatting, function wrappers, platform flags).
 *
 * Safe to import from node (no DOM access at module scope beyond guarded
 * platform sniffing). Nothing here allocates unless it must return a new value.
 *
 * Public API:
 *   TAU, clamp, lerp, invLerp, remap, smoothstep, wrap, dist, approach, damp
 *   easeIn, easeOut, easeInOut, easeOutBack, easeInBack, easeOutElastic, easeOutBounce,
 *   easeOutExpo, easeInQuad, easeOutQuad, easeInOutQuad, EASING (name → fn), getEase(nameOrFn)
 *   uid(prefix), fmt(n), fmtTime(minutes), fmtDur(sec), pad2(n)
 *   hexToRgb, rgbToHex, lerpColor, shade, hsl, rgba, luminance
 *   deepClone, debounce, throttle, once
 *   isIOS, isAndroid, isStandalone, hasTouch
 */

// ───────────────────────────── math ─────────────────────────────

export const TAU = Math.PI * 2;

/** Clamps x into [lo, hi]. */
export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

/** Linear interpolation from a to b by t. */
export const lerp = (a, b, t) => a + (b - a) * t;

/** Inverse lerp: where x sits between a and b (0..1, unclamped; 0 when a === b). */
export const invLerp = (a, b, x) => (a === b ? 0 : (x - a) / (b - a));

/** Maps x from [a0, a1] to [b0, b1] (unclamped). */
export const remap = (x, a0, a1, b0, b1) => lerp(b0, b1, invLerp(a0, a1, x));

/** Hermite smoothstep of x between edges e0 and e1 (clamped). */
export const smoothstep = (e0, e1, x) => {
  const t = clamp(invLerp(e0, e1, x), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Wraps x into the half-open range [lo, hi). */
export const wrap = (x, lo, hi) => {
  const range = hi - lo;
  if (range <= 0) return lo;
  const m = (x - lo) % range;
  return (m < 0 ? m + range : m) + lo;
};

/** Euclidean distance between two points. */
export const dist = (x0, y0, x1, y1) => Math.hypot(x1 - x0, y1 - y0);

/** Moves cur toward target by at most maxDelta. */
export const approach = (cur, target, maxDelta) =>
  cur < target ? Math.min(cur + maxDelta, target) : Math.max(cur - maxDelta, target);

/**
 * Frame-rate independent exponential smoothing of a toward b.
 * lambda ≈ "speed" (higher = snappier); dt in seconds.
 */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

// ───────────────────────────── easing ─────────────────────────────

export const easeLinear = (t) => t;
export const easeInQuad = (t) => t * t;
export const easeOutQuad = (t) => 1 - (1 - t) * (1 - t);
export const easeInOutQuad = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
/** Cubic ease-in. */
export const easeIn = (t) => t * t * t;
/** Cubic ease-out. */
export const easeOut = (t) => 1 - Math.pow(1 - t, 3);
/** Cubic ease-in-out. */
export const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeOutExpo = (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
export const easeInBack = (t) => 2.70158 * t * t * t - 1.70158 * t * t;
export const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
};
export const easeOutElastic = (t) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
export const easeOutBounce = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
  if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
  t -= 2.625 / d1;
  return n1 * t * t + 0.984375;
};

/** Easing functions by name (used by tween.js and camera moves). */
export const EASING = Object.freeze({
  linear: easeLinear,
  in: easeIn,
  out: easeOut,
  inOut: easeInOut,
  easeIn,
  easeOut,
  easeInOut,
  inQuad: easeInQuad,
  outQuad: easeOutQuad,
  inOutQuad: easeInOutQuad,
  inCubic: easeIn,
  outCubic: easeOut,
  inOutCubic: easeInOut,
  outExpo: easeOutExpo,
  inBack: easeInBack,
  outBack: easeOutBack,
  easeOutBack,
  outElastic: easeOutElastic,
  easeOutElastic,
  outBounce: easeOutBounce,
  smooth: (t) => t * t * (3 - 2 * t),
});

/**
 * Resolves an easing name or function; unknown names fall back to linear.
 * @param {string|Function|undefined} e
 * @returns {(t: number) => number}
 */
export function getEase(e) {
  if (typeof e === 'function') return e;
  return (e && EASING[e]) || easeLinear;
}

// ───────────────────────────── ids & formatting ─────────────────────────────

let uidCounter = 0;

/**
 * Runtime-only unique id (counter based; NOT for save data — use state.nextId).
 * @param {string} [prefix='']
 */
export function uid(prefix = '') {
  uidCounter++;
  return prefix + uidCounter.toString(36);
}

/** Two-digit zero padded integer. */
export const pad2 = (n) => (n < 10 ? '0' : '') + n;

/** Strips a trailing ".0" from a fixed(1) string. */
function trimZero(s) {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/**
 * Compact number: 999 → '999', 1200 → '1.2k', 15600 → '15.6k', 156000 → '156k', 2.5e6 → '2.5M'.
 * @param {number} n
 * @returns {string}
 */
export function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const neg = n < 0;
  const a = Math.abs(n);
  let s;
  if (a < 1000) s = String(Math.round(a));
  else if (a < 1e5) s = trimZero((a / 1e3).toFixed(1)) + 'k';
  else if (a < 1e6) s = Math.round(a / 1e3) + 'k';
  else if (a < 1e8) s = trimZero((a / 1e6).toFixed(1)) + 'M';
  else if (a < 1e9) s = Math.round(a / 1e6) + 'M';
  else s = trimZero((a / 1e9).toFixed(1)) + 'B';
  return neg ? '-' + s : s;
}

/**
 * Minutes of the day → 'HH:MM' (24 h, wraps around midnight).
 * @param {number} minutes
 */
export function fmtTime(minutes) {
  const m = Math.floor(wrap(Number.isFinite(minutes) ? minutes : 0, 0, 1440));
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
}

/**
 * Duration in seconds → '45s' | '5m 30s' | '1h 05m' | '2d 3h'.
 * @param {number} sec
 */
export function fmtDur(sec) {
  const s = Math.max(0, Math.floor(Number.isFinite(sec) ? sec : 0));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + pad2(s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + pad2(m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}

// ───────────────────────────── colour ─────────────────────────────

/**
 * Parses '#rgb', '#rrggbb' or '#rrggbbaa' into {r,g,b} (0–255). Invalid → black.
 * @param {string} hex
 * @returns {{r: number, g: number, b: number}}
 */
export function hexToRgb(hex) {
  let s = typeof hex === 'string' ? hex : '';
  if (s.charCodeAt(0) === 35) s = s.slice(1);
  if (s.length === 3 || s.length === 4) {
    s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  } else if (s.length === 8) {
    s = s.slice(0, 6);
  }
  const v = s.length === 6 ? parseInt(s, 16) : NaN;
  if (Number.isNaN(v)) return { r: 0, g: 0, b: 0 };
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

/** Component → 2-digit hex (clamped, rounded). */
function hex2(c) {
  const v = clamp(Math.round(c), 0, 255);
  return (v < 16 ? '0' : '') + v.toString(16);
}

/**
 * {r,g,b} or (r,g,b) → '#rrggbb'.
 * @param {number|{r:number,g:number,b:number}} r
 * @param {number} [g]
 * @param {number} [b]
 */
export function rgbToHex(r, g, b) {
  if (typeof r === 'object' && r !== null) return '#' + hex2(r.r) + hex2(r.g) + hex2(r.b);
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

/** Interpolates two hex colours by t (clamped) → hex. */
export function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  const k = clamp(t, 0, 1);
  return rgbToHex(lerp(a.r, b.r, k), lerp(a.g, b.g, k), lerp(a.b, b.b, k));
}

/**
 * Darkens (amt < 0, toward black) or lightens (amt > 0, toward white) a hex colour.
 * @param {string} hex
 * @param {number} amt -1..1
 */
export function shade(hex, amt) {
  const c = hexToRgb(hex);
  const k = clamp(amt, -1, 1);
  const target = k < 0 ? 0 : 255;
  const t = Math.abs(k);
  return rgbToHex(lerp(c.r, target, t), lerp(c.g, target, t), lerp(c.b, target, t));
}

/**
 * HSL → hex. h in degrees (any value, wrapped), s and l in 0..1.
 */
export function hsl(h, s, l) {
  const hh = wrap(h, 0, 360) / 360;
  const ss = clamp(s, 0, 1);
  const ll = clamp(l, 0, 1);
  if (ss === 0) {
    const v = ll * 255;
    return rgbToHex(v, v, v);
  }
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return rgbToHex(hueToRgb(p, q, hh + 1 / 3) * 255, hueToRgb(p, q, hh) * 255, hueToRgb(p, q, hh - 1 / 3) * 255);
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** hex + alpha → 'rgba(r,g,b,a)' CSS string. */
export function rgba(hex, a) {
  const c = hexToRgb(hex);
  return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + clamp(Number.isFinite(a) ? a : 1, 0, 1) + ')';
}

/** Perceived luminance of a hex colour, 0..1. */
export function luminance(hex) {
  const c = hexToRgb(hex);
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

// ───────────────────────────── data & functions ─────────────────────────────

/**
 * Deep clone of JSON-safe data (plain objects, arrays, primitives).
 * Functions/undefined values are dropped like JSON would; other objects are copied by reference.
 * @template T
 * @param {T} o
 * @returns {T}
 */
export function deepClone(o) {
  if (o === null || typeof o !== 'object') return o;
  if (Array.isArray(o)) {
    const out = new Array(o.length);
    for (let i = 0; i < o.length; i++) {
      const v = o[i];
      out[i] = v === undefined || typeof v === 'function' ? null : deepClone(v);
    }
    return out;
  }
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) return o;
  const out = {};
  for (const k in o) {
    if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
    const v = o[k];
    if (v === undefined || typeof v === 'function') continue;
    out[k] = deepClone(v);
  }
  return out;
}

/** Timer scheduling that works in browsers and node. */
const setTimer = (fn, ms) => setTimeout(fn, ms);
const clearTimer = (id) => clearTimeout(id);

/**
 * Trailing-edge debounce. Returned function has .cancel() and .flush().
 * @param {Function} fn
 * @param {number} ms
 */
export function debounce(fn, ms) {
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  const fire = () => {
    timer = null;
    const args = lastArgs;
    const self = lastThis;
    lastArgs = lastThis = null;
    fn.apply(self, args);
  };
  function debounced(...args) {
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, ms);
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    lastArgs = lastThis = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimer(timer);
    fire();
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/**
 * Throttle with leading call and a trailing call for the last skipped invocation.
 * Returned function has .cancel().
 * @param {Function} fn
 * @param {number} ms
 */
export function throttle(fn, ms) {
  let last = -Infinity;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const fire = () => {
    timer = null;
    last = now();
    const args = lastArgs;
    const self = lastThis;
    lastArgs = lastThis = null;
    fn.apply(self, args);
  };
  function throttled(...args) {
    const t = now();
    const remaining = ms - (t - last);
    lastArgs = args;
    lastThis = this;
    if (remaining <= 0) {
      if (timer !== null) { clearTimer(timer); timer = null; }
      fire();
    } else if (timer === null) {
      timer = setTimer(fire, remaining);
    }
  }
  throttled.cancel = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
    lastArgs = lastThis = null;
  };
  return throttled;
}

/** Wraps fn so it runs at most once; later calls return the first result. */
export function once(fn) {
  let called = false;
  let result;
  return function (...args) {
    if (!called) {
      called = true;
      result = fn.apply(this, args);
    }
    return result;
  };
}

// ───────────────────────────── platform ─────────────────────────────

const nav = typeof navigator !== 'undefined' ? navigator : null;
const ua = nav && typeof nav.userAgent === 'string' ? nav.userAgent : '';

/** True on iPhone/iPad/iPod (including iPadOS reporting as Mac with touch). */
export const isIOS =
  /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && nav !== null && nav.maxTouchPoints > 1);

/** True on Android. */
export const isAndroid = /Android/.test(ua);

/** True when the device reports touch input. */
export const hasTouch = nav !== null && (nav.maxTouchPoints > 0 || 'ontouchstart' in globalThis);

/** True when running as an installed PWA / home-screen app. */
export const isStandalone = (() => {
  try {
    if (nav && nav.standalone === true) return true;
    if (typeof matchMedia === 'function') return matchMedia('(display-mode: standalone)').matches;
  } catch (_) { /* matchMedia unavailable */ }
  return false;
})();
