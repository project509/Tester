/**
 * core/loop.js — requestAnimationFrame game loop with a fixed-step simulation
 * accumulator and a once-per-frame render. Auto-pauses while the document is
 * hidden and never "spirals" after a tab resume (accumulator is reset).
 *
 * Public API:
 *   createLoop({ update(dtSec), render(dtSec), step = 1/30, maxSubSteps = 5 }) → loop
 *   loop.start() / loop.stop() / loop.running
 *   loop.paused (settable; sim halts, render continues)   loop.hidden (read-only)
 *   loop.fps (EMA)   loop.time (sim seconds since start)   loop.frame (count)
 *   loop.rawDt / loop.dt (last frame, unscaled / scaled seconds)
 *   loop.setTimeScale(x) / loop.timeScale   loop.tick(nowMs) (drive one frame manually; tests)
 * Emits on the global bus: 'app:hidden', 'app:visible'.
 */

import { bus } from './events.js';

const MAX_FRAME_DT = 0.1;
const FPS_SMOOTHING = 0.08;
const MAX_LOGGED_ERRORS = 32;

const hasDoc = typeof document !== 'undefined';
const nowMs =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();
const raf =
  typeof requestAnimationFrame === 'function'
    ? (fn) => requestAnimationFrame(fn)
    : (fn) => setTimeout(() => fn(nowMs()), 16);
const caf =
  typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

/**
 * Creates a game loop. Neither callback is required; both are guarded so a
 * throwing scene never kills the loop (each unique error message is logged once).
 * @param {{ update?: (dt: number) => void, render?: (dt: number) => void, step?: number, maxSubSteps?: number }} opts
 */
export function createLoop({ update, render, step = 1 / 30, maxSubSteps = 5 } = {}) {
  const fixedStep = step > 0 ? step : 1 / 30;
  const maxSteps = Math.max(1, Math.floor(maxSubSteps));
  const logged = new Set();

  let rafId = 0;
  let lastMs = 0;
  let accumulator = 0;
  let timeScale = 1;

  const loop = {
    running: false,
    paused: false,
    hidden: false,
    fps: 60,
    time: 0,
    frame: 0,
    rawDt: 0,
    dt: 0,
    /** @returns {number} */
    get timeScale() {
      return timeScale;
    },
    set timeScale(x) {
      timeScale = Number.isFinite(x) && x >= 0 ? x : 1;
    },
    start,
    stop,
    setTimeScale,
    tick,
  };

  /** Logs an exception once per unique message. */
  function report(where, err) {
    const msg = where + ': ' + (err && err.message ? err.message : String(err));
    if (logged.has(msg)) return;
    if (logged.size < MAX_LOGGED_ERRORS) logged.add(msg);
    if (typeof console !== 'undefined' && console.error) console.error('[loop] ' + where + ' threw', err);
  }

  /** Sets the simulation speed multiplier (0 = frozen sim, render continues). */
  function setTimeScale(x) {
    loop.timeScale = x;
  }

  /**
   * Runs one frame at the given timestamp. Called by rAF; exposed for tests.
   * @param {number} ms
   */
  function tick(ms) {
    if (!loop.running) return;
    if (loop.hidden) {
      // Still schedule so we pick up as soon as the tab is visible again.
      rafId = raf(tick);
      return;
    }
    let raw = (ms - lastMs) / 1000;
    lastMs = ms;
    if (!(raw > 0)) raw = 0;
    if (raw > MAX_FRAME_DT) raw = MAX_FRAME_DT;
    loop.rawDt = raw;
    if (raw > 0) loop.fps += (1 / raw - loop.fps) * FPS_SMOOTHING;

    const scaled = raw * timeScale;
    loop.dt = scaled;
    loop.frame++;

    if (!loop.paused && scaled > 0) {
      loop.time += scaled;
      accumulator += scaled;
      let steps = 0;
      while (accumulator >= fixedStep && steps < maxSteps) {
        accumulator -= fixedStep;
        steps++;
        if (update) {
          try {
            update(fixedStep);
          } catch (err) {
            report('update', err);
          }
        }
      }
      // Too far behind: drop the backlog instead of spiralling.
      if (accumulator >= fixedStep) accumulator = 0;
    }

    if (render) {
      try {
        render(scaled);
      } catch (err) {
        report('render', err);
      }
    }
    rafId = raf(tick);
  }

  /** Resets timing so the next frame measures from "now" (after resume/start). */
  function resync() {
    lastMs = nowMs();
    accumulator = 0;
  }

  function onVisibility() {
    const hidden = !!(hasDoc && document.hidden);
    if (hidden === loop.hidden) return;
    loop.hidden = hidden;
    if (hidden) {
      bus.emit('app:hidden');
    } else {
      resync();
      bus.emit('app:visible');
    }
  }

  /** Starts the loop (idempotent). */
  function start() {
    if (loop.running) return;
    loop.running = true;
    loop.hidden = !!(hasDoc && document.hidden);
    resync();
    if (hasDoc && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    rafId = raf(tick);
  }

  /** Stops the loop and detaches listeners (idempotent). */
  function stop() {
    if (!loop.running) return;
    loop.running = false;
    caf(rafId);
    rafId = 0;
    if (hasDoc && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  return loop;
}
