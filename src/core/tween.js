/**
 * core/tween.js — Minimal tween manager for numeric properties on any object
 * (camera, UI values, particles' params). Driven by update(dt) from the loop;
 * no allocations while updating. Callbacks are guarded so a throwing
 * onUpdate/onDone never breaks the frame.
 *
 * Public API:
 *   tweens.to(obj, props, dur, { ease, delay, onUpdate, onDone, repeat, yoyo, from }) → handle
 *   tweens.after(dur, fn) → handle          tweens.cancel(handle)   tweens.cancelAll(obj)
 *   tweens.update(dt)   tweens.clear()      tweens.count
 *   handle.cancel(), handle.done, handle.progress (0..1 of the current cycle)
 *   createTweens() → independent manager
 */

import { getEase } from './util.js';

/**
 * Creates an independent tween manager.
 */
export function createTweens() {
  /** @type {object[]} active tweens (compacted in update) */
  let list = [];

  /** Captures starting values for every tweened key. */
  function captureFrom(tw) {
    for (let i = 0; i < tw.keys.length; i++) {
      const k = tw.keys[i];
      const v = tw.fromOverride && tw.fromOverride[k] !== undefined ? tw.fromOverride[k] : tw.obj[k];
      tw.from[i] = Number.isFinite(v) ? v : 0;
    }
    tw.captured = true;
  }

  /** Applies eased progress p (0..1) to the target object. */
  function apply(tw, p) {
    const e = tw.ease(p);
    for (let i = 0; i < tw.keys.length; i++) {
      tw.obj[tw.keys[i]] = tw.from[i] + (tw.to[i] - tw.from[i]) * e;
    }
  }

  /** Swaps from/to for a yoyo cycle. */
  function reverse(tw) {
    for (let i = 0; i < tw.keys.length; i++) {
      const f = tw.from[i];
      tw.from[i] = tw.to[i];
      tw.to[i] = f;
    }
  }

  function safeCall(fn, a, b) {
    if (!fn) return;
    try {
      fn(a, b);
    } catch (err) {
      if (typeof console !== 'undefined' && console.error) console.error('[tween] callback threw', err);
    }
  }

  /**
   * Tweens numeric props of obj to the given values over dur seconds.
   * @param {object} obj
   * @param {Object<string, number>} props
   * @param {number} dur seconds (≤ 0 completes on the next update)
   * @param {{ ease?: string|Function, delay?: number, onUpdate?: Function, onDone?: Function,
   *           repeat?: number, yoyo?: boolean, from?: Object<string, number> }} [opts]
   * @returns {object} handle
   */
  function to(obj, props, dur, opts = {}) {
    const keys = props ? Object.keys(props) : [];
    const tw = {
      obj: obj || {},
      keys,
      from: new Array(keys.length),
      to: new Array(keys.length),
      fromOverride: opts.from || null,
      dur: Number.isFinite(dur) && dur > 0 ? dur : 0,
      delay: Number.isFinite(opts.delay) && opts.delay > 0 ? opts.delay : 0,
      ease: getEase(opts.ease),
      onUpdate: typeof opts.onUpdate === 'function' ? opts.onUpdate : null,
      onDone: typeof opts.onDone === 'function' ? opts.onDone : null,
      repeat: Number.isFinite(opts.repeat) ? opts.repeat : 0,
      yoyo: !!opts.yoyo,
      t: 0,
      captured: false,
      done: false,
      progress: 0,
      cancel: null,
    };
    for (let i = 0; i < keys.length; i++) {
      const v = props[keys[i]];
      tw.to[i] = Number.isFinite(v) ? v : 0;
    }
    tw.cancel = () => cancel(tw);
    list.push(tw);
    return tw;
  }

  /**
   * Calls fn after dur seconds (a tween with no properties).
   * @param {number} dur
   * @param {Function} fn
   */
  function after(dur, fn) {
    return to(null, null, dur, { onDone: fn });
  }

  /** Cancels a tween without firing onDone (no-op if already finished). */
  function cancel(handle) {
    if (!handle || handle.done) return;
    handle.done = true;
  }

  /** Cancels every tween targeting obj. */
  function cancelAll(obj) {
    for (let i = 0; i < list.length; i++) {
      if (list[i].obj === obj) list[i].done = true;
    }
  }

  /** Steps one tween by dt; returns true when it has finished. */
  function stepTween(tw, dt) {
    tw.t += dt;
    if (tw.t < tw.delay) return false;
    if (!tw.captured) captureFrom(tw);
    // Loop so an overshoot past a cycle end is applied to the next cycle this frame.
    for (;;) {
      const local = tw.t - tw.delay;
      let p = tw.dur > 0 ? local / tw.dur : 1;
      if (p > 1) p = 1;
      tw.progress = p;
      apply(tw, p);
      safeCall(tw.onUpdate, tw.obj, p);
      if (p < 1 || tw.done) return tw.done;
      if (tw.repeat === 0 || tw.dur <= 0) break;
      if (tw.repeat > 0) tw.repeat--;
      if (tw.yoyo) reverse(tw);
      tw.t = tw.delay + (local - tw.dur);
      if (tw.t - tw.delay < tw.dur) {
        // Remaining overshoot is inside the next cycle: apply it now and stop.
        const p2 = (tw.t - tw.delay) / tw.dur;
        tw.progress = p2;
        apply(tw, p2);
        return false;
      }
    }
    tw.done = true;
    safeCall(tw.onDone, tw.obj);
    return true;
  }

  /**
   * Advances all tweens by dt seconds.
   * Tweens added during callbacks start on the next update.
   * @param {number} dt
   */
  function update(dt) {
    if (!(dt > 0)) dt = 0;
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const tw = list[i];
      if (tw.done) continue;
      stepTween(tw, dt);
    }
    // Compact in place (keeps order; includes tweens appended during callbacks).
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const tw = list[i];
      if (!tw.done) list[w++] = tw;
    }
    list.length = w;
  }

  /** Removes all tweens immediately without firing callbacks. */
  function clear() {
    for (let i = 0; i < list.length; i++) list[i].done = true;
    list = [];
  }

  return {
    to,
    after,
    cancel,
    cancelAll,
    update,
    clear,
    /** Number of live tweens. */
    get count() {
      return list.length;
    },
  };
}

/** The shared tween manager (updated once per frame by main.js). */
export const tweens = createTweens();
