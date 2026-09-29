/**
 * core/save.js — Persistence wrapper around localStorage: game state (KEY),
 * meta progression (META_KEY), debounced writes, versioned migration and
 * unicode-safe share codes. Never throws: every operation is guarded and
 * returns a boolean / null on failure (quota, private mode, no storage).
 *
 * Public API:
 *   save.KEY, save.META_KEY, save.VERSION
 *   save.load() → G|null      save.store(G) → bool     save.storeSoon(G)    save.flush() → bool
 *   save.clear() → bool       save.loadMeta() → meta|null   save.storeMeta(meta) → bool   save.clearMeta() → bool
 *   save.exportCode(G) → string (base64 JSON) | ''      save.importCode(str) → G|null
 *   save.migrate(obj) → obj   save.available() → bool   save.setStorage(storageLike|null) (tests/fallback)
 */

export const SAVE_KEY = 'holdout.v1';
export const META_KEY = 'holdout.meta.v1';
/** Current save schema version (mirrors game/state.js SAVE_VERSION). */
export const VERSION = 1;
const DEBOUNCE_MS = 500;

/**
 * Sequential migrations keyed by the version they upgrade FROM.
 * v1 is the first schema, so nothing to do yet; add `1: (o) => ...` when v2 lands.
 * @type {Object<number, (obj: object) => object>}
 */
const MIGRATIONS = {};

let storageOverride = null;
let warned = false;
let pendingTimer = null;
let pendingState = null;

/** Logs one warning for the first storage failure, then stays quiet. */
function warnOnce(msg, err) {
  if (warned) return;
  warned = true;
  if (typeof console !== 'undefined' && console.warn) console.warn('[save] ' + msg, err || '');
}

/** Returns a usable Storage-like object or null. */
function getStorage() {
  if (storageOverride) return storageOverride;
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch (_) {
    /* accessing localStorage can itself throw (sandboxed iframes) */
  }
  return null;
}

function readJSON(key) {
  const ls = getStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    warnOnce('read failed for ' + key, err);
    return null;
  }
}

function writeJSON(key, obj) {
  const ls = getStorage();
  if (!ls) {
    warnOnce('localStorage unavailable; progress will not persist');
    return false;
  }
  try {
    ls.setItem(key, JSON.stringify(obj));
    return true;
  } catch (err) {
    warnOnce('write failed for ' + key + ' (quota or private mode)', err);
    return false;
  }
}

function removeKey(key) {
  const ls = getStorage();
  if (!ls) return false;
  try {
    ls.removeItem(key);
    return true;
  } catch (err) {
    warnOnce('remove failed for ' + key, err);
    return false;
  }
}

// ───────────────────────────── base64 (unicode-safe) ─────────────────────────────

function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CHUNK, bytes.length)));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function encodeUtf8(str) {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(str);
  return new Uint8Array(Buffer.from(str, 'utf8'));
}

function decodeUtf8(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return Buffer.from(bytes).toString('utf8');
}

/** Normalises pasted codes: trims, strips whitespace, accepts url-safe alphabet, restores padding. */
function normalizeBase64(str) {
  let s = String(str).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const rem = s.length % 4;
  if (rem === 2) s += '==';
  else if (rem === 3) s += '=';
  return s;
}

// ───────────────────────────── migration ─────────────────────────────

/**
 * Upgrades a save object to the current VERSION by applying MIGRATIONS in order.
 * Objects without a numeric `v` are assumed to be v1. Newer-than-known versions
 * are returned unchanged. Never throws.
 * @param {object} obj
 * @returns {object}
 */
function migrate(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  let cur = obj;
  let v = Number.isInteger(cur.v) && cur.v > 0 ? cur.v : 1;
  while (v < VERSION) {
    const step = MIGRATIONS[v];
    if (!step) break;
    try {
      cur = step(cur) || cur;
    } catch (err) {
      warnOnce('migration from v' + v + ' failed', err);
      break;
    }
    v++;
    cur.v = v;
  }
  if (!Number.isInteger(cur.v)) cur.v = v;
  return cur;
}

/** True for a plausible game-state object. */
function looksLikeState(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj);
}

// ───────────────────────────── public API ─────────────────────────────

/** Loads and migrates the game save, or null when absent/corrupt. */
function load() {
  const obj = readJSON(SAVE_KEY);
  return looksLikeState(obj) ? migrate(obj) : null;
}

/** Writes the game save immediately (cancels a pending storeSoon). Returns success. */
function store(G) {
  cancelPending();
  if (!looksLikeState(G)) return false;
  return writeJSON(SAVE_KEY, G);
}

/** Schedules a write of G in 500 ms; repeated calls within the window coalesce. */
function storeSoon(G) {
  if (!looksLikeState(G)) return;
  pendingState = G;
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(flush, DEBOUNCE_MS);
}

/** Writes any pending storeSoon state now (call on pagehide). Returns success (true if nothing pending). */
function flush() {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  const G = pendingState;
  pendingState = null;
  if (!G) return true;
  return writeJSON(SAVE_KEY, G);
}

function cancelPending() {
  if (pendingTimer !== null) clearTimeout(pendingTimer);
  pendingTimer = null;
  pendingState = null;
}

/** Removes the game save (meta progression is kept). */
function clear() {
  cancelPending();
  return removeKey(SAVE_KEY);
}

/** Loads meta progression (unlocks, legacy, stats) or null. */
function loadMeta() {
  const obj = readJSON(META_KEY);
  return looksLikeState(obj) ? obj : null;
}

/** Writes meta progression. Returns success. */
function storeMeta(meta) {
  if (!looksLikeState(meta)) return false;
  return writeJSON(META_KEY, meta);
}

/** Removes meta progression. */
function clearMeta() {
  return removeKey(META_KEY);
}

/**
 * Serialises G to a shareable base64 string (unicode-safe). Returns '' on failure.
 * @param {object} G
 * @returns {string}
 */
function exportCode(G) {
  if (!looksLikeState(G)) return '';
  try {
    return bytesToBase64(encodeUtf8(JSON.stringify(G)));
  } catch (err) {
    warnOnce('export failed', err);
    return '';
  }
}

/**
 * Parses a code produced by exportCode (tolerates whitespace / url-safe alphabet),
 * migrates it and returns the state, or null when invalid.
 * @param {string} str
 * @returns {object|null}
 */
function importCode(str) {
  if (typeof str !== 'string' || str.trim().length === 0) return null;
  try {
    const obj = JSON.parse(decodeUtf8(base64ToBytes(normalizeBase64(str))));
    return looksLikeState(obj) ? migrate(obj) : null;
  } catch (_) {
    return null;
  }
}

/** True when a storage backend can be used right now. */
function available() {
  const ls = getStorage();
  if (!ls) return false;
  try {
    const probe = SAVE_KEY + '.probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Overrides the storage backend (any object with getItem/setItem/removeItem),
 * or restores auto-detection with null. Used by tests and memory fallbacks.
 * @param {object|null} storageLike
 */
function setStorage(storageLike) {
  storageOverride = storageLike && typeof storageLike.getItem === 'function' ? storageLike : null;
}

export const save = {
  KEY: SAVE_KEY,
  META_KEY,
  VERSION,
  load,
  store,
  storeSoon,
  flush,
  clear,
  loadMeta,
  storeMeta,
  clearMeta,
  exportCode,
  importCode,
  migrate,
  available,
  setStorage,
};
