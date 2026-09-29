/**
 * art/noise.js — Seeded, allocation-free 2D noise for procedural textures.
 *
 * Value noise on an integer lattice with quintic interpolation, fractal
 * Brownian motion on top of it, and Worley (cellular) noise for cracks, scales
 * and stone. Everything is a pure function of (seed, x, y): the same seed always
 * yields the same field, and none of the samplers allocate.
 *
 * Public API:
 *   makeNoise(seed) → noise
 *   noise.seed                       uint32 the sampler was built with
 *   noise.hash(ix, iy)               → [0,1) white noise for integer lattice coords
 *   noise.v2(x, y)                   → [0,1) smooth value noise (feature size ≈ 1 unit)
 *   noise.fbm(x, y, oct=4, lac=2, gain=0.5) → [0,1) fractal sum of v2
 *   noise.turb(x, y, oct=4)          → [0,1) ridged/turbulent variant (|2v−1| summed)
 *   noise.worley(x, y)               → [0,1) distance to nearest feature point (F1)
 *   noise.worleyEdge(x, y)           → [0,1) F2 − F1: bright cell interiors, dark edges
 *   noise.cell(x, y)                 → [0,1) id of the nearest Worley cell (flat per cell)
 */

const INV_2_32 = 1 / 4294967296;
const ONE_MINUS = 1 - 1e-7;

/** Normalises any seed (number or string) into a uint32. */
function seedToUint(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
  const s = String(seed === undefined || seed === null ? '' : seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Quintic fade curve (C2-continuous), t in 0..1. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Creates a deterministic noise sampler.
 * @param {number|string} seed
 * @returns {{
 *   seed:number,
 *   hash(ix:number, iy:number):number,
 *   v2(x:number, y:number):number,
 *   fbm(x:number, y:number, oct?:number, lac?:number, gain?:number):number,
 *   turb(x:number, y:number, oct?:number):number,
 *   worley(x:number, y:number):number,
 *   worleyEdge(x:number, y:number):number,
 *   cell(x:number, y:number):number
 * }}
 */
export function makeNoise(seed) {
  const S = seedToUint(seed);
  const S2 = Math.imul(S ^ 0x9e3779b9, 0x85ebca6b) >>> 0;

  /** Integer lattice hash → [0,1). `salt` selects independent channels. */
  function hashSalt(ix, iy, salt) {
    let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ salt;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) * INV_2_32;
  }

  function hash(ix, iy) {
    return hashSalt(ix, iy, S);
  }

  function v2(x, y) {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const u = fade(x - x0);
    const v = fade(y - y0);
    const a = hashSalt(x0, y0, S);
    const b = hashSalt(x0 + 1, y0, S);
    const c = hashSalt(x0, y0 + 1, S);
    const d = hashSalt(x0 + 1, y0 + 1, S);
    const top = a + (b - a) * u;
    const bot = c + (d - c) * u;
    const r = top + (bot - top) * v;
    return r < ONE_MINUS ? r : ONE_MINUS;
  }

  function fbm(x, y, oct, lac, gain) {
    const n = oct >= 1 ? Math.floor(oct) : 4;
    const l = lac > 0 ? lac : 2;
    const g = gain > 0 ? gain : 0.5;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < n; i++) {
      sum += v2(fx, fy) * amp;
      norm += amp;
      amp *= g;
      fx = fx * l + 17.31;
      fy = fy * l + 11.07;
    }
    const r = sum / norm;
    return r < ONE_MINUS ? r : ONE_MINUS;
  }

  function turb(x, y, oct) {
    const n = oct >= 1 ? Math.floor(oct) : 4;
    let amp = 1;
    let sum = 0;
    let norm = 0;
    let fx = x;
    let fy = y;
    for (let i = 0; i < n; i++) {
      const v = v2(fx, fy) * 2 - 1;
      sum += (v < 0 ? -v : v) * amp;
      norm += amp;
      amp *= 0.5;
      fx = fx * 2 + 5.17;
      fy = fy * 2 + 9.83;
    }
    const r = sum / norm;
    return r < ONE_MINUS ? r : ONE_MINUS;
  }

  // Worley scratch results (module-closure numbers, no per-call allocation).
  let f1 = 0;
  let f2 = 0;
  let f1cell = 0;

  /** Computes F1/F2 and the nearest cell id for (x, y) into the scratch slots. */
  function worleyScan(x, y) {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    f1 = 8;
    f2 = 8;
    f1cell = 0;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i;
        const gy = cy + j;
        const px = gx + hashSalt(gx, gy, S);
        const py = gy + hashSalt(gx, gy, S2);
        const dx = px - x;
        const dy = py - y;
        const d = dx * dx + dy * dy;
        if (d < f1) {
          f2 = f1;
          f1 = d;
          f1cell = hashSalt(gx, gy, S ^ 0x5bd1e995);
        } else if (d < f2) {
          f2 = d;
        }
      }
    }
    f1 = Math.sqrt(f1);
    f2 = Math.sqrt(f2);
  }

  function worley(x, y) {
    worleyScan(x, y);
    return f1 < ONE_MINUS ? f1 : ONE_MINUS;
  }

  function worleyEdge(x, y) {
    worleyScan(x, y);
    const r = f2 - f1;
    return r < ONE_MINUS ? r : ONE_MINUS;
  }

  function cell(x, y) {
    worleyScan(x, y);
    return f1cell;
  }

  return { seed: S, hash, v2, fbm, turb, worley, worleyEdge, cell };
}
