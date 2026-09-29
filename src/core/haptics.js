// src/core/haptics.js — Named vibration vocabulary + priority-throttled playback.
// Responsibility: the game's only "audio": every feedback moment maps to a named
// vibration pattern (ms arrays: [vibrate, pause, vibrate, ...]). Handles throttling
// (≥ 30 ms between calls; a higher-priority pattern preempts a playing one, lower ones
// are dropped while busy), per-call strength + global intensity scaling, the iOS
// `<input type="checkbox" switch>` click trick when navigator.vibrate is missing, and
// emits bus 'haptic:played' {name, strength, method} for tests. Never throws.
// Public API:
//   haptics = { supported, enabled, intensity, method, vocabulary, priority,
//               setEnabled(bool), setIntensity(0..1), play(name, strength=1) → bool,
//               pulse(ms) → bool, pattern(msArray, priority?) → bool, stop(), canPlay(name) → bool }
//   HAPTIC_PRIORITY = { LOW, NORMAL, HIGH, CRITICAL }

import { bus } from './events.js';

/** Priority levels: higher preempts lower; lower is dropped while higher is still playing. */
export const HAPTIC_PRIORITY = Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2, CRITICAL: 3 });

/** Named patterns in ms: [vibrate, pause, vibrate, ...]. Exported for UI/tests. */
export const VOCABULARY = Object.freeze({
  // UI
  tap: [8],
  tapSoft: [4],
  tick: [3],
  confirm: [10, 40, 18],
  cancel: [6, 30, 6],
  error: [30, 40, 30, 40, 30],
  warning: [20, 60, 40],
  countdown: [30],
  success: [12, 30, 12, 30, 60],
  fail: [60, 60, 120],
  // fortress
  build: [12, 30, 12, 30, 40],
  upgrade: [10, 20, 14, 20, 18, 20, 40],
  craft: [8, 25, 8, 25, 8, 60, 30],
  loot: [10, 30, 20],
  lootRare: [10, 30, 10, 30, 10, 60, 60],
  levelup: [15, 30, 15, 30, 15, 30, 70],
  dawn: [8, 60, 12, 60, 18, 60, 26],
  dusk: [26, 60, 18, 60, 12, 60, 8],
  extract: [20, 40, 20, 40, 80],
  // combat
  shot: [14],
  shotHeavy: [35, 20, 12],
  reload: [6, 50, 6, 80, 20],
  hit: [18],
  kill: [12, 30, 40],
  headshot: [25, 20, 60],
  footstep: [5],
  bite: [60, 40, 90],
  infected: [30, 60, 30, 60, 30, 60, 120],
  breach: [120, 40, 60, 40, 200],
  alarm: [80, 80, 80, 80, 80, 80, 80],
  heartbeat: [40, 120, 25],
  heartbeatFast: [30, 70, 20],
  drum: [50, 100, 50, 100, 50, 250, 90],
  explosion: [200, 30, 40, 30, 20],
  // outcomes
  death: [150, 80, 100, 120, 60, 200, 300],
  gameOver: [200, 100, 200, 100, 400],
  victory: [20, 40, 20, 40, 20, 40, 60, 60, 120],
});

/** Priority per name; names not listed are NORMAL. */
export const PRIORITY = Object.freeze({
  tick: HAPTIC_PRIORITY.LOW, footstep: HAPTIC_PRIORITY.LOW, tapSoft: HAPTIC_PRIORITY.LOW,
  heartbeat: HAPTIC_PRIORITY.LOW, heartbeatFast: HAPTIC_PRIORITY.LOW, drum: HAPTIC_PRIORITY.LOW,
  hit: HAPTIC_PRIORITY.HIGH, kill: HAPTIC_PRIORITY.HIGH, headshot: HAPTIC_PRIORITY.HIGH,
  levelup: HAPTIC_PRIORITY.HIGH, lootRare: HAPTIC_PRIORITY.HIGH, alarm: HAPTIC_PRIORITY.HIGH,
  bite: HAPTIC_PRIORITY.HIGH, infected: HAPTIC_PRIORITY.HIGH, error: HAPTIC_PRIORITY.HIGH,
  breach: HAPTIC_PRIORITY.CRITICAL, explosion: HAPTIC_PRIORITY.CRITICAL, death: HAPTIC_PRIORITY.CRITICAL,
  gameOver: HAPTIC_PRIORITY.CRITICAL, victory: HAPTIC_PRIORITY.CRITICAL,
});

const THROTTLE_MS = 30;
const STRENGTH_MIN = 0.3, STRENGTH_MAX = 1.5;
const DROP_BELOW = 0.6;          // effective strength under this drops alternate pulses...
const DROP_MIN_PULSES = 4;       // ...of patterns with at least this many pulses
const SWITCH_MAX_PULSES = 3;     // iOS switch trick only for short patterns
const SWITCH_MAX_MS = 400;
const GESTURE_WINDOW_MS = 1000;  // switch trick only this soon after a pointerdown
const SCRATCH = [];              // reused output pattern (browser copies it synchronously)

const nav = typeof navigator !== 'undefined' ? navigator : null;
const hasVibrate = !!(nav && typeof nav.vibrate === 'function');
const ua = (nav && nav.userAgent) || '';
const isAppleTouch = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav && nav.maxTouchPoints > 1);
const canSwitch = !hasVibrate && isAppleTouch && typeof document !== 'undefined';

let lastPlayAt = -Infinity;
let busyUntil = -Infinity;
let busyPriority = HAPTIC_PRIORITY.LOW;
let lastGestureAt = -Infinity;
let switchEl = null;
const warnedNames = new Set();

function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Sum of a pattern's total duration (vibrate + pause). */
function totalMs(arr) {
  let s = 0;
  for (let i = 0; i < arr.length; i++) s += arr[i];
  return s;
}

/**
 * Scales a source pattern into SCRATCH: vibrate segments × scale (pauses keep their rhythm);
 * when dropAlternate, every other pulse of a long pattern becomes silence (merged into pauses).
 * The final pulse is always kept so a pattern's accent survives.
 * @returns {number[]} SCRATCH (length set)
 */
function buildPattern(src, scale, dropAlternate) {
  const pulses = (src.length + 1) >> 1;
  const drop = dropAlternate && pulses >= DROP_MIN_PULSES;
  const lastPulse = pulses - 1;
  let n = 0;
  let pendingPause = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if ((i & 1) === 0) { // vibrate segment
      const k = i >> 1;
      if (drop && (k & 1) === 1 && k !== lastPulse) { pendingPause += v; continue; }
      if (n > 0) SCRATCH[n++] = Math.max(1, Math.round(pendingPause));
      pendingPause = 0;
      SCRATCH[n++] = Math.max(1, Math.round(v * scale));
    } else {
      pendingPause += v;
    }
  }
  SCRATCH.length = n;
  return SCRATCH;
}

/**
 * Throttle/priority gate. Returns 'play', 'preempt' or null (dropped).
 */
function gate(priority, t) {
  if (t < busyUntil) return priority > busyPriority ? 'preempt' : null;
  if (t - lastPlayAt < THROTTLE_MS && priority <= busyPriority) return null;
  return 'play';
}

function ensureSwitch() {
  if (switchEl || !canSwitch || !document.body) return switchEl;
  try {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.setAttribute('switch', '');
    el.setAttribute('aria-hidden', 'true');
    el.tabIndex = -1;
    const s = el.style;
    s.position = 'fixed'; s.left = '-100px'; s.top = '0'; s.width = '1px'; s.height = '1px';
    s.opacity = '0.01'; s.pointerEvents = 'none'; s.margin = '0';
    document.body.appendChild(el);
    switchEl = el;
  } catch (_) { switchEl = null; }
  return switchEl;
}

function clickSwitch() {
  const el = ensureSwitch();
  if (!el) return;
  try { el.click(); } catch (_) { /* ignore */ }
}

/** iOS: one switch toggle per pulse, scheduled at the pulse offsets (only for short patterns). */
function playViaSwitch(arr, t) {
  if (t - lastGestureAt > GESTURE_WINDOW_MS) return false;
  const pulses = (arr.length + 1) >> 1;
  if (pulses > SWITCH_MAX_PULSES || totalMs(arr) > SWITCH_MAX_MS) return false;
  if (!ensureSwitch()) return false;
  let offset = 0;
  for (let i = 0; i < arr.length; i++) {
    if ((i & 1) === 0) { if (i === 0) clickSwitch(); else setTimeout(clickSwitch, offset); }
    offset += arr[i];
  }
  return true;
}

function vibrate(arr) {
  try { return !!nav.vibrate(arr); } catch (_) { return false; }
}

/** Core playback used by play/pulse/pattern. Returns true when the pattern was dispatched. */
function dispatch(name, src, priority, strength) {
  if (!haptics.enabled || haptics.intensity <= 0 || !src || !src.length) return false;
  const t = now();
  const verdict = gate(priority, t);
  if (!verdict) return false;
  const eff = clamp(strength, STRENGTH_MIN, STRENGTH_MAX) * clamp(haptics.intensity, 0, 1);
  const arr = buildPattern(src, eff, eff < DROP_BELOW);
  let method = 'none';
  if (hasVibrate) {
    if (verdict === 'preempt') vibrate(0);
    method = vibrate(arr) ? 'vibrate' : 'none';
  } else if (canSwitch) {
    method = playViaSwitch(arr, t) ? 'switch' : 'none';
  }
  lastPlayAt = t;
  busyUntil = t + totalMs(arr);
  busyPriority = priority;
  try { bus.emit('haptic:played', { name, strength: eff, method, priority }); } catch (_) { /* bus guards itself */ }
  return true;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pointerdown', () => { lastGestureAt = now(); }, { passive: true, capture: true });
}

/** The haptics singleton (see file header for the API). */
export const haptics = {
  supported: hasVibrate || canSwitch,
  method: hasVibrate ? 'vibrate' : (canSwitch ? 'switch' : 'none'),
  enabled: true,
  intensity: 1,
  vocabulary: VOCABULARY,
  priority: PRIORITY,

  /** @param {boolean} on */
  setEnabled(on) {
    haptics.enabled = !!on;
    if (!haptics.enabled) haptics.stop();
  },

  /** @param {number} x global multiplier 0..1 (clamped) */
  setIntensity(x) {
    const v = Number(x);
    haptics.intensity = Number.isFinite(v) ? clamp(v, 0, 1) : 1;
  },

  /**
   * Plays a named pattern from the vocabulary.
   * @param {string} name       key of `haptics.vocabulary`
   * @param {number} [strength] 0.3–1.5 scales vibrate durations; effective strength < 0.6
   *                            also drops every other pulse of long (≥ 4 pulse) patterns
   * @returns {boolean} true when dispatched (false: disabled, throttled, unknown name)
   */
  play(name, strength = 1) {
    try {
      const src = VOCABULARY[name];
      if (!src) {
        if (!warnedNames.has(name)) { warnedNames.add(name); console.warn('[haptics] unknown pattern:', name); }
        return false;
      }
      const pr = PRIORITY[name] !== undefined ? PRIORITY[name] : HAPTIC_PRIORITY.NORMAL;
      return dispatch(name, src, pr, Number.isFinite(strength) ? strength : 1);
    } catch (_) { return false; }
  },

  /**
   * Single vibration of `ms` milliseconds (NORMAL priority).
   * @param {number} ms
   * @returns {boolean}
   */
  pulse(ms) {
    try {
      const v = Math.round(Number(ms));
      if (!(v > 0)) return false;
      return dispatch('pulse', [v], HAPTIC_PRIORITY.NORMAL, 1);
    } catch (_) { return false; }
  },

  /**
   * Plays a raw ms pattern.
   * @param {number[]} msArray  [vibrate, pause, vibrate, ...]
   * @param {number} [priority] HAPTIC_PRIORITY level (default NORMAL)
   * @returns {boolean}
   */
  pattern(msArray, priority = HAPTIC_PRIORITY.NORMAL) {
    try {
      if (!Array.isArray(msArray) || !msArray.length) return false;
      for (let i = 0; i < msArray.length; i++) if (!(Number(msArray[i]) >= 0)) return false;
      return dispatch('pattern', msArray, clamp(priority | 0, 0, 3), 1);
    } catch (_) { return false; }
  },

  /** Stops any vibration in progress and clears the busy/throttle window. */
  stop() {
    busyUntil = -Infinity;
    lastPlayAt = -Infinity;
    busyPriority = HAPTIC_PRIORITY.LOW;
    if (hasVibrate) vibrate(0);
  },

  /**
   * Would `play(name)` pass the throttle/priority gate right now? (No side effects.)
   * @param {string} name
   * @returns {boolean}
   */
  canPlay(name) {
    if (!haptics.enabled || !VOCABULARY[name]) return false;
    const pr = PRIORITY[name] !== undefined ? PRIORITY[name] : HAPTIC_PRIORITY.NORMAL;
    return gate(pr, now()) !== null;
  },

  /** Timestamp (performance.now ms) of the last pointerdown seen on window; -Infinity if none. */
  get lastGestureAt() { return lastGestureAt; },
};
