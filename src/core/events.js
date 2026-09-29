/**
 * core/events.js — Synchronous, exception-safe publish/subscribe bus.
 *
 * Cross-cutting reactions (game → UI, loop → everything) go through `bus` so
 * modules never import each other for side effects. Listener arrays are
 * copy-on-write, so emit() never allocates and subscribing/unsubscribing
 * from inside a listener (or emitting recursively) is always safe.
 *
 * Public API:
 *   bus.on(name, fn) → off      bus.once(name, fn) → off      bus.off(name, fn)
 *   bus.emit(name, payload)     bus.clear(name?)              bus.count(name) → number
 *   createBus() → an independent bus with the same shape (used for local input events)
 */

const MAX_LOGGED_ERRORS = 64;

/**
 * Creates an independent event bus.
 * @returns {{
 *   on(name: string, fn: Function): () => void,
 *   once(name: string, fn: Function): () => void,
 *   off(name: string, fn: Function): void,
 *   emit(name: string, payload?: *): void,
 *   clear(name?: string): void,
 *   count(name: string): number
 * }}
 */
export function createBus() {
  /** @type {Map<string, Function[]>} name → immutable listener array */
  const listeners = new Map();
  /** @type {Set<string>} messages already reported, to avoid log floods */
  const logged = new Set();

  /** Reports a listener failure once per unique (event, message) pair. */
  function report(name, err) {
    const msg = name + ': ' + (err && err.message ? err.message : String(err));
    if (logged.has(msg)) return;
    if (logged.size < MAX_LOGGED_ERRORS) logged.add(msg);
    if (typeof console !== 'undefined' && console.error) {
      console.error('[bus] listener error on "' + name + '"', err);
    }
  }

  /** Subscribes; returns an unsubscribe function. */
  function on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    const cur = listeners.get(name);
    listeners.set(name, cur ? cur.concat(fn) : [fn]);
    return () => off(name, fn);
  }

  /** Unsubscribes a listener (no-op if not present). */
  function off(name, fn) {
    const cur = listeners.get(name);
    if (!cur) return;
    const idx = cur.indexOf(fn);
    if (idx < 0) return;
    if (cur.length === 1) {
      listeners.delete(name);
      return;
    }
    const nextArr = cur.slice();
    nextArr.splice(idx, 1);
    listeners.set(name, nextArr);
  }

  /** Subscribes for a single emission; returns an unsubscribe function. */
  function once(name, fn) {
    if (typeof fn !== 'function') return () => {};
    const wrapper = (payload) => {
      off(name, wrapper);
      fn(payload);
    };
    return on(name, wrapper);
  }

  /** Calls every listener synchronously; listener exceptions are caught and logged. */
  function emit(name, payload) {
    const arr = listeners.get(name);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (err) {
        report(name, err);
      }
    }
  }

  /** Removes all listeners of one event, or of every event when name is omitted. */
  function clear(name) {
    if (name === undefined) listeners.clear();
    else listeners.delete(name);
  }

  /** Number of listeners currently subscribed to an event. */
  function count(name) {
    const arr = listeners.get(name);
    return arr ? arr.length : 0;
  }

  return { on, once, off, emit, clear, count };
}

/** The global application bus (event catalogue in ARCHITECTURE.md §8). */
export const bus = createBus();
