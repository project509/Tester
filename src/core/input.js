// src/core/input.js — Pointer-Events gesture recognizer for one canvas/element.
// Responsibility: turn raw pointer events on `element` into high-level touch gestures
// (down/up/tap/doubletap/longpress/dragstart/drag/dragend/swipe/pinch/hold) with
// css-px coordinates relative to the element, velocity tracking for flings, and
// mobile hygiene (touch-action:none, pointer capture, blocked zoom/scroll/menus).
// Public API:
//   createInput(element, { camera } = {}) → input
//   input.on(name, fn) → off, input.once(name, fn) → off, input.off(name, fn)
//   input.pointers (live Map id→{x,y,x0,y0,t0,...}), input.enabled, input.camera, input.element
//   input.setEnabled(bool), input.refreshRect(), input.destroy()
// Payload objects are REUSED per event name (no allocation in hot paths): copy fields
// you need to keep; never retain the payload itself.

/** Gesture thresholds (ms / css px / px per second). */
export const INPUT_TUNING = Object.freeze({
  TAP_MS: 250,        // pointer up within this → tap (if it did not move)
  TAP_PX: 8,          // moving further than this cancels tap / longpress and starts a drag
  DOUBLE_MS: 300,     // second tap's pointerdown within this of the first tap's up → doubletap
  DOUBLE_PX: 24,      // ...and within this distance of the first tap
  LONG_MS: 500,       // longpress delay
  HOLD_MS: 160,       // 'hold' starts streaming after this
  SWIPE_V: 600,       // min speed (px/s) at dragend for a swipe
  SWIPE_PX: 40,       // min displacement on the dominant axis for a swipe
  VEL_TAU_MS: 80,     // EMA time constant for velocity
  VEL_STALE_MS: 100,  // no move for this long before release → velocity treated as 0
  MAX_POINTERS: 2,    // 3rd+ pointers are ignored
});

const T = INPUT_TUNING;
const EVENT_NAMES = ['down', 'up', 'cancel', 'tap', 'doubletap', 'longpress', 'dragstart', 'drag', 'dragend', 'swipe', 'pinch', 'hold'];
const EMPTY = Object.freeze([]);
const loggedErrors = new Set();

/** Returns a high-resolution timestamp in ms. */
function now() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

/** Logs an error once per unique message so a broken listener cannot spam the console. */
function logOnce(err) {
  const msg = String(err && err.message || err);
  if (loggedErrors.has(msg)) return;
  loggedErrors.add(msg);
  console.error('[input] listener error:', err);
}

/** Creates a tracked-pointer record (pooled; two exist per input). */
function makePointerRecord() {
  return {
    id: -1, type: '',
    x: 0, y: 0, x0: 0, y0: 0, t0: 0,   // current position, origin, down time
    px: 0, py: 0, pt: 0,               // previous move sample (for dx/dy and velocity)
    vx: 0, vy: 0,                      // EMA velocity in px/s
    moved: false,                      // travelled > TAP_PX from origin
    dragging: false, longPressed: false,
    consumed: false,                   // took part in a pinch → no tap on release
    active: false,
  };
}

/**
 * Creates a gesture recognizer bound to `element`.
 * @param {HTMLElement} element  usually the output canvas
 * @param {{ camera?: { screenToWorld(sx:number, sy:number): {x:number,y:number} } }} [opts]
 *        when a camera is given, tap/doubletap/longpress/down/up/hold payloads also carry
 *        `wx, wy` world coordinates (drag/pinch payloads stay screen-space for speed).
 * @returns {object} input
 */
export function createInput(element, opts = {}) {
  const camera = opts.camera || null;
  /** @type {Map<string, Function[]>} copy-on-write listener arrays */
  const listeners = new Map();
  const pool = [makePointerRecord(), makePointerRecord()];
  const pointers = new Map();
  const rect = { left: 0, top: 0 };
  const pinch = { active: false, d0: 1, cx: 0, cy: 0 };
  const lastTap = { t: -Infinity, x: 0, y: 0 };
  const payloads = {};
  for (let i = 0; i < EVENT_NAMES.length; i++) payloads[EVENT_NAMES[i]] = { x: 0, y: 0 };

  let primary = null;       // pointer record driving tap/drag/hold/longpress
  let enabled = true;
  let destroyed = false;
  let longTimer = 0;
  let rafId = 0;
  let lastRafT = 0;
  let holdWx = 0, holdWy = 0, holdSx = NaN, holdSy = NaN;

  // ---------------------------------------------------------------- emitter

  function on(name, fn) {
    if (typeof fn !== 'function') return () => {};
    const cur = listeners.get(name) || EMPTY;
    listeners.set(name, cur.concat(fn));
    return () => off(name, fn);
  }

  function off(name, fn) {
    const cur = listeners.get(name);
    if (!cur) return;
    const idx = cur.indexOf(fn);
    if (idx < 0) return;
    const next = cur.slice(0, idx).concat(cur.slice(idx + 1));
    if (next.length) listeners.set(name, next); else listeners.delete(name);
  }

  function once(name, fn) {
    const wrapped = (e) => { off(name, wrapped); fn(e); };
    return on(name, wrapped);
  }

  function emit(name, payload) {
    const fns = listeners.get(name);
    if (!fns) return;
    for (let i = 0; i < fns.length; i++) {
      try { fns[i](payload); } catch (err) { logOnce(err); }
    }
  }

  // ---------------------------------------------------------------- helpers

  function refreshRect() {
    try {
      const r = element.getBoundingClientRect();
      rect.left = r.left; rect.top = r.top;
    } catch (_) { /* detached element: keep last rect */ }
  }

  function toWorld(payload, sx, sy) {
    if (!camera) return;
    try {
      const w = camera.screenToWorld(sx, sy);
      payload.wx = w.x; payload.wy = w.y;
    } catch (_) { payload.wx = sx; payload.wy = sy; }
  }

  function allocPointer(e, t) {
    const p = pool[0].active ? pool[1] : pool[0];
    p.active = true;
    p.id = e.pointerId; p.type = e.pointerType || 'touch';
    p.x = p.x0 = p.px = e.clientX - rect.left;
    p.y = p.y0 = p.py = e.clientY - rect.top;
    p.t0 = p.pt = t;
    p.vx = p.vy = 0;
    p.moved = p.dragging = p.longPressed = p.consumed = false;
    pointers.set(p.id, p);
    return p;
  }

  function freePointer(p) {
    pointers.delete(p.id);
    p.active = false;
    p.id = -1;
  }

  function otherPointer(p) {
    return pool[0] === p ? pool[1] : pool[0];
  }

  function capture(e) {
    try { if (element.setPointerCapture) element.setPointerCapture(e.pointerId); } catch (_) { /* unsupported / stale id */ }
  }

  function release(id) {
    try { if (element.hasPointerCapture && element.hasPointerCapture(id)) element.releasePointerCapture(id); } catch (_) { /* ignore */ }
  }

  function updateVelocity(p, dx, dy, dt) {
    if (dt <= 0) return;
    const ivx = dx / dt * 1000, ivy = dy / dt * 1000;
    const a = 1 - Math.exp(-dt / T.VEL_TAU_MS);
    p.vx += (ivx - p.vx) * a;
    p.vy += (ivy - p.vy) * a;
  }

  // ---------------------------------------------------------------- timers / rAF

  function startLongPress() {
    cancelLongPress();
    longTimer = setTimeout(fireLongPress, T.LONG_MS);
  }

  function cancelLongPress() {
    if (longTimer) { clearTimeout(longTimer); longTimer = 0; }
  }

  function fireLongPress() {
    longTimer = 0;
    const p = primary;
    if (!p || p.moved || pinch.active || !enabled) return;
    p.longPressed = true;
    const ev = payloads.longpress;
    ev.x = p.x; ev.y = p.y;
    toWorld(ev, p.x, p.y);
    emit('longpress', ev);
  }

  function startRaf() {
    if (rafId || typeof requestAnimationFrame !== 'function') return;
    lastRafT = now();
    holdSx = holdSy = NaN;
    rafId = requestAnimationFrame(rafTick);
  }

  function stopRaf() {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function rafTick() {
    rafId = 0;
    const p = primary;
    if (!p || !enabled || destroyed) return;
    const t = now();
    const dt = Math.min(0.1, (t - lastRafT) / 1000);
    lastRafT = t;
    const held = t - p.t0;
    if (!pinch.active && held >= T.HOLD_MS) {
      const ev = payloads.hold;
      ev.x = p.x; ev.y = p.y; ev.dt = dt; ev.t = held;
      ev.dragging = p.dragging;
      if (camera) {
        if (p.x !== holdSx || p.y !== holdSy) {
          holdSx = p.x; holdSy = p.y;
          toWorld(ev, p.x, p.y);
          holdWx = ev.wx; holdWy = ev.wy;
        } else { ev.wx = holdWx; ev.wy = holdWy; }
      }
      emit('hold', ev);
    }
    rafId = requestAnimationFrame(rafTick);
  }

  // ---------------------------------------------------------------- gesture pieces

  function emitDown(p) {
    const ev = payloads.down;
    ev.x = p.x; ev.y = p.y; ev.id = p.id; ev.t = p.t0; ev.type = p.type;
    toWorld(ev, p.x, p.y);
    emit('down', ev);
  }

  function emitUp(p, t, cancelled) {
    const ev = payloads.up;
    ev.x = p.x; ev.y = p.y; ev.id = p.id; ev.t = t; ev.dur = t - p.t0;
    ev.cancelled = cancelled; ev.type = p.type;
    toWorld(ev, p.x, p.y);
    emit('up', ev);
    if (cancelled) {
      const c = payloads.cancel;
      c.x = p.x; c.y = p.y; c.id = p.id; c.t = t;
      emit('cancel', c);
    }
  }

  function startDrag(p) {
    p.dragging = true;
    const ev = payloads.dragstart;
    ev.x = p.x; ev.y = p.y; ev.x0 = p.x0; ev.y0 = p.y0;
    emit('dragstart', ev);
  }

  function emitDrag(p, dx, dy) {
    const ev = payloads.drag;
    ev.x = p.x; ev.y = p.y; ev.dx = dx; ev.dy = dy; ev.vx = p.vx; ev.vy = p.vy;
    ev.tx = p.x - p.x0; ev.ty = p.y - p.y0;
    emit('drag', ev);
  }

  function endDrag(p, t, cancelled) {
    if (cancelled || t - p.pt > T.VEL_STALE_MS) { p.vx = 0; p.vy = 0; }
    p.dragging = false;
    const ev = payloads.dragend;
    ev.x = p.x; ev.y = p.y; ev.vx = p.vx; ev.vy = p.vy;
    ev.tx = p.x - p.x0; ev.ty = p.y - p.y0; ev.cancelled = cancelled;
    emit('dragend', ev);
    if (!cancelled) maybeSwipe(p);
  }

  function maybeSwipe(p) {
    const tx = p.x - p.x0, ty = p.y - p.y0;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed <= T.SWIPE_V) return;
    const horizontal = Math.abs(tx) >= Math.abs(ty);
    const disp = horizontal ? tx : ty;
    if (Math.abs(disp) <= T.SWIPE_PX) return;
    const ev = payloads.swipe;
    ev.dir = horizontal ? (tx < 0 ? 'left' : 'right') : (ty < 0 ? 'up' : 'down');
    ev.vx = p.vx; ev.vy = p.vy; ev.x = p.x; ev.y = p.y;
    emit('swipe', ev);
  }

  function emitTap(p, t) {
    const ev = payloads.tap;
    ev.x = p.x; ev.y = p.y; ev.id = p.id;
    toWorld(ev, p.x, p.y);
    emit('tap', ev);
    // Doubletap: this tap's DOWN happened within DOUBLE_MS of the previous tap's UP and
    // within DOUBLE_PX of it. 'tap' is still emitted for both taps; 'doubletap' follows the
    // second one, and the chain resets so a triple tap does not produce two doubletaps.
    const isDouble = (p.t0 - lastTap.t) <= T.DOUBLE_MS && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) <= T.DOUBLE_PX;
    if (isDouble) {
      lastTap.t = -Infinity;
      const d = payloads.doubletap;
      d.x = p.x; d.y = p.y; d.id = p.id;
      toWorld(d, p.x, p.y);
      emit('doubletap', d);
    } else {
      lastTap.t = t; lastTap.x = p.x; lastTap.y = p.y;
    }
  }

  function startPinch(a, b) {
    pinch.active = true;
    pinch.d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    pinch.cx = (a.x + b.x) * 0.5;
    pinch.cy = (a.y + b.y) * 0.5;
  }

  function emitPinch() {
    const a = pool[0], b = pool[1];
    const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const cx = (a.x + b.x) * 0.5, cy = (a.y + b.y) * 0.5;
    const ev = payloads.pinch;
    ev.scale = d / pinch.d0; ev.cx = cx; ev.cy = cy;
    ev.dcx = cx - pinch.cx; ev.dcy = cy - pinch.cy; ev.dist = d;
    pinch.cx = cx; pinch.cy = cy;
    emit('pinch', ev);
  }

  /** Second finger lifted: the survivor continues as a fresh drag (never a tap). */
  function endPinchTo(survivor, t) {
    pinch.active = false;
    primary = survivor;
    survivor.x0 = survivor.x; survivor.y0 = survivor.y;
    survivor.px = survivor.x; survivor.py = survivor.y; survivor.pt = t;
    survivor.vx = survivor.vy = 0;
    survivor.consumed = true; survivor.moved = true;
    startDrag(survivor);
  }

  // ---------------------------------------------------------------- DOM handlers

  function onPointerDown(e) {
    if (!enabled || destroyed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (pointers.has(e.pointerId)) return;
    if (pointers.size >= T.MAX_POINTERS) return;
    const t = now();
    refreshRect();
    const p = allocPointer(e, t);
    capture(e);
    if (pointers.size === 1) {
      primary = p;
      startLongPress();
      startRaf();
      emitDown(p);
      return;
    }
    // Second pointer → pinch. Any drag in progress ends now; the first pointer can no longer tap.
    cancelLongPress();
    const first = otherPointer(p);
    if (first.dragging) endDrag(first, t, true);
    first.consumed = true;
    emitDown(p);
    startPinch(first, p);
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p || !enabled) return;
    const t = now();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const dx = x - p.px, dy = y - p.py;
    updateVelocity(p, dx, dy, t - p.pt);
    p.x = x; p.y = y; p.px = x; p.py = y; p.pt = t;
    if (!p.moved && Math.hypot(x - p.x0, y - p.y0) > T.TAP_PX) {
      p.moved = true;
      if (p === primary) cancelLongPress();
    }
    if (pinch.active) { emitPinch(); return; }
    if (p !== primary) return;
    if (!p.dragging) {
      if (!p.moved) return;
      startDrag(p);
    }
    emitDrag(p, dx, dy);
  }

  function onPointerUp(e) { finishPointer(e.pointerId, e, false); }
  function onPointerCancel(e) { finishPointer(e.pointerId, e, true); }
  function onLostCapture(e) { if (pointers.has(e.pointerId)) finishPointer(e.pointerId, null, true); }

  function finishPointer(id, e, cancelled) {
    const p = pointers.get(id);
    if (!p) return;
    const t = now();
    if (e && !cancelled) { p.x = e.clientX - rect.left; p.y = e.clientY - rect.top; }
    release(id);
    emitUp(p, t, cancelled);
    if (pinch.active) {
      const survivor = otherPointer(p);
      freePointer(p);
      if (survivor.active && !cancelled) endPinchTo(survivor, t);
      else { pinch.active = false; if (survivor.active) { survivor.consumed = true; primary = survivor; } else resetPrimary(); }
      return;
    }
    if (p === primary) {
      cancelLongPress();
      if (p.dragging) endDrag(p, t, cancelled);
      else if (!cancelled && !p.longPressed && !p.consumed && !p.moved && (t - p.t0) <= T.TAP_MS) emitTap(p, t);
      resetPrimary();
    }
    freePointer(p);
  }

  function resetPrimary() {
    primary = null;
    stopRaf();
    cancelLongPress();
  }

  function cancelAll() {
    // Iterate the fixed pool (never the live Map) so removal during iteration is safe.
    for (let i = 0; i < pool.length; i++) if (pool[i].active) finishPointer(pool[i].id, null, true);
    pinch.active = false;
    resetPrimary();
  }

  function prevent(e) { e.preventDefault(); }

  // ---------------------------------------------------------------- wiring

  const passive = { passive: true };
  const blocking = { passive: false };
  const bindings = [
    [element, 'pointerdown', onPointerDown, blocking],
    [element, 'pointermove', onPointerMove, passive],
    [element, 'pointerup', onPointerUp, passive],
    [element, 'pointercancel', onPointerCancel, passive],
    [element, 'lostpointercapture', onLostCapture, passive],
    [element, 'touchstart', prevent, blocking],
    [element, 'touchmove', prevent, blocking],
    [element, 'gesturestart', prevent, blocking],
    [element, 'gesturechange', prevent, blocking],
    [element, 'dblclick', prevent, blocking],
    [element, 'contextmenu', prevent, blocking],
    [element, 'selectstart', prevent, blocking],
  ];
  if (typeof window !== 'undefined') {
    bindings.push([window, 'resize', refreshRect, passive], [window, 'orientationchange', refreshRect, passive]);
    if (window.visualViewport) {
      bindings.push([window.visualViewport, 'resize', refreshRect, passive], [window.visualViewport, 'scroll', refreshRect, passive]);
    }
  }
  for (let i = 0; i < bindings.length; i++) bindings[i][0].addEventListener(bindings[i][1], bindings[i][2], bindings[i][3]);

  try {
    const s = element.style;
    s.touchAction = 'none';
    s.userSelect = 'none'; s.webkitUserSelect = 'none';
    s.webkitTouchCallout = 'none';
    s.webkitTapHighlightColor = 'transparent';
  } catch (_) { /* non-element target */ }
  refreshRect();

  /**
   * Enables or disables recognition. Disabling cancels active gestures
   * (emits 'up'/'cancel' and 'dragend' where relevant) and ignores new pointers.
   * @param {boolean} on
   */
  function setEnabled(on) {
    const next = !!on;
    if (next === enabled) return;
    if (!next) cancelAll();
    enabled = next;
    input.enabled = next;
  }

  /** Cancels gestures, removes all listeners and drops all subscriptions. */
  function destroy() {
    if (destroyed) return;
    cancelAll();
    destroyed = true;
    enabled = false;
    input.enabled = false;
    for (let i = 0; i < bindings.length; i++) bindings[i][0].removeEventListener(bindings[i][1], bindings[i][2], bindings[i][3]);
    listeners.clear();
  }

  const input = {
    element, camera, pointers, enabled,
    on, off, once, setEnabled, refreshRect, destroy,
    /** Current pinch state (read-only view). */
    pinch,
  };
  return input;
}
