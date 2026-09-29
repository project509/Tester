/**
 * core/rng.js — Deterministic pseudo-random numbers (mulberry32 + FNV-1a).
 *
 * Every random decision in art/game code derives from one of these generators so
 * a seed always reproduces the same fortress, faces, loot and sieges.
 *
 * Public API:
 *   hashStr(str) → uint32                      FNV-1a hash of a string
 *   makeRng(seed: number|string) → rng          rng.seed, next, float, int, chance,
 *                                               pick, weighted, shuffle, fork, gauss, sign
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const INV_2_32 = 1 / 4294967296;

/**
 * FNV-1a hash of a string, folded to an unsigned 32-bit integer.
 * @param {string} str
 * @returns {number} uint32
 */
export function hashStr(str) {
  const s = String(str);
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  // Final avalanche so short/similar strings spread across the range.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h >>> 0;
}

/**
 * Normalises any seed value to a uint32.
 * @param {number|string|*} seed
 * @returns {number}
 */
function normalizeSeed(seed) {
  if (typeof seed === 'number') {
    if (!Number.isFinite(seed)) return 0;
    if (Number.isInteger(seed)) return seed >>> 0;
    return hashStr(seed.toString());
  }
  if (seed === undefined || seed === null) return 0;
  return hashStr(String(seed));
}

/**
 * Creates a mulberry32 generator. Strings are hashed with {@link hashStr}.
 * @param {number|string} seed
 * @returns {{
 *   seed: number,
 *   next(): number,
 *   float(a?: number, b?: number): number,
 *   int(a: number, b: number): number,
 *   chance(p: number): boolean,
 *   pick<T>(arr: T[]): T,
 *   weighted(items: Array): *,
 *   shuffle<T>(arr: T[]): T[],
 *   fork(label: string|number): object,
 *   gauss(mean?: number, sd?: number): number,
 *   sign(): number
 * }}
 */
export function makeRng(seed) {
  const seed32 = normalizeSeed(seed);
  let state = seed32;
  let spare = 0;
  let hasSpare = false;

  /** Core mulberry32 step → float in [0, 1). */
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) * INV_2_32;
  }

  /** Float in [a, b). */
  function float(a = 0, b = 1) {
    return a + (b - a) * next();
  }

  /** Integer in [a, b] inclusive (order of a/b does not matter). */
  function int(a, b) {
    let lo = Math.ceil(a);
    let hi = Math.floor(b);
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    return lo + Math.floor(next() * (hi - lo + 1));
  }

  /** True with probability p. */
  function chance(p) {
    return next() < p;
  }

  /** Uniformly chosen element (undefined for an empty array). */
  function pick(arr) {
    if (!arr || arr.length === 0) return undefined;
    return arr[Math.floor(next() * arr.length)];
  }

  /**
   * Weighted choice. Accepts `[{w, ...}]` (returns the object) or
   * `[[item, w], ...]` (returns item). Non-positive/NaN weights never win;
   * if every weight is non-positive the choice is uniform.
   */
  function weighted(items) {
    if (!items || items.length === 0) return undefined;
    const pairs = Array.isArray(items[0]);
    let total = 0;
    for (let i = 0; i < items.length; i++) {
      const w = pairs ? items[i][1] : items[i].w;
      if (w > 0) total += w;
    }
    if (!(total > 0)) {
      const it = items[Math.floor(next() * items.length)];
      return pairs ? it[0] : it;
    }
    let r = next() * total;
    for (let i = 0; i < items.length; i++) {
      const w = pairs ? items[i][1] : items[i].w;
      if (!(w > 0)) continue;
      r -= w;
      if (r < 0) return pairs ? items[i][0] : items[i];
    }
    // Floating-point tail: return the last positively weighted entry.
    for (let i = items.length - 1; i >= 0; i--) {
      const w = pairs ? items[i][1] : items[i].w;
      if (w > 0) return pairs ? items[i][0] : items[i];
    }
    return undefined;
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /**
   * Independent generator derived from (seed, label). Does not consume or depend
   * on this generator's draw position, so forks are stable regardless of call order.
   */
  function fork(label) {
    return makeRng(hashStr(seed32.toString(16) + '/' + String(label)));
  }

  /** Normal distribution via Box–Muller (the spare deviate is cached). */
  function gauss(mean = 0, sd = 1) {
    if (hasSpare) {
      hasSpare = false;
      return mean + sd * spare;
    }
    let u, v, s;
    do {
      u = next() * 2 - 1;
      v = next() * 2 - 1;
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    hasSpare = true;
    return mean + sd * u * mul;
  }

  /** -1 or +1 with equal probability. */
  function sign() {
    return next() < 0.5 ? -1 : 1;
  }

  return { seed: seed32, next, float, int, chance, pick, weighted, shuffle, fork, gauss, sign };
}
