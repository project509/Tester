/**
 * scenes/manager.js — Scene registry, lifecycle, input routing and screen-space
 * transitions (fade to black / iris wipe / cut) drawn over the live scene. Public API:
 *   createScenes() → scenes
 *   scenes.register(name, scene) / unregister(name) / has(name) / get(name) / names()
 *   scenes.go(name, data, { transition, dur, force }) → bool   scenes.current / currentName / busy / queuedName / transition
 *   scenes.update(dt) / tick(realDt?) / draw(ctx, W?, H?) / postParams() / dispatch(eventName, e) → bool / resize(W, H)
 *   scenes.reducedMotion (settable)   Emits bus 'scene:change' { from, to, data } at the swap.
 */

import { bus } from '../core/events.js';

const DEFAULT_DUR_MS = 450;
const REDUCED_MOTION_MAX_DUR_MS = 250;
/** Soft rim of the iris hole, in css px. */
const IRIS_FEATHER_PX = 18;
const MAX_CLOCK_STEP_SEC = 0.1;
/** Consecutive tick(0) calls during a live transition before tick() self-measures wall time instead. */
const ZERO_TICKS_BEFORE_WALL_FALLBACK = 3;
const MAX_LOGGED_ERRORS = 64;

/** Maps dispatch() event names to scene handler method names. */
const HANDLERS = {
  tap: 'onTap',
  doubletap: 'onDoubleTap',
  longpress: 'onLongPress',
  down: 'onDown',
  up: 'onUp',
  cancel: 'onCancel',
  dragstart: 'onDragStart',
  drag: 'onDrag',
  dragend: 'onDragEnd',
  swipe: 'onSwipe',
  pinch: 'onPinch',
  hold: 'onHold',
};

/** Every key of the postfx params contract, so the merged object keeps one fixed shape. */
const POSTFX_KEYS = [
  'exposure', 'contrast', 'saturation', 'warmth', 'tint', 'bloom', 'bloomThreshold',
  'focusY', 'dof', 'vignette', 'grain', 'aberration', 'flash', 'time', 'quality',
];

const nowMs =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** Smoothstep ease used for both halves of a transition. */
function easeInOut(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

/** Inverse of easeInOut (bisection) so a carried cover maps back to time. */
function easeInverse(c) {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) * 0.5;
    if (easeInOut(mid) < c) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Reads the OS "reduce motion" preference; false when unavailable. */
function prefersReducedMotion() {
  try {
    return typeof matchMedia === 'function' && !!matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (err) {
    return false;
  }
}

/** Copies a {x,y} iris centre out of go() data, or null when absent/invalid. */
function irisCentreOf(data) {
  const at = data && data.irisAt;
  if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  return { x: at.x, y: at.y };
}

/** Resolves a dispatch() event name (or an 'onXxx' handler name) to a handler method name. */
function handlerFor(eventName) {
  if (typeof eventName !== 'string') return null;
  return HANDLERS[eventName] || (eventName.startsWith('on') ? eventName : null);
}

/**
 * Creates the scene manager.
 *
 * A transition fades OUT the current scene during its first half, swaps scenes
 * at the midpoint (exit() → enter(data) → bus 'scene:change'), then fades IN
 * the new scene. Every scene method is optional and every call is guarded, so
 * a broken scene never breaks the loop, and go() may be called re-entrantly
 * from enter()/exit()/listeners.
 *
 * Clocking: `update(dt)` advances both the live scene and the transition, so
 * deterministic tests can drive everything through update()/draw(). A host
 * whose simulation can pause or change speed may instead call `tick()` once
 * per rendered frame (wiring: `render: () => scenes.tick()`); while tick() is
 * being called, update(dt) no longer moves the transition, and the override
 * lapses automatically after one frame without a tick().
 *
 * Input: `dispatch(name, e)` reaches the live scene only while no transition
 * runs; gesture-ending events ('up', 'dragend', 'cancel') are delivered only
 * to the scene on which the gesture started.
 *
 * @returns {object} scenes — see file header for the surface.
 */
export function createScenes() {
  /** @type {Map<string, object>} */
  const registry = new Map();
  /** @type {Set<string>} error messages already logged (once per unique message) */
  const logged = new Set();

  let current = null;
  let currentName = null;
  let reducedMotion = prefersReducedMotion();

  /**
   * Live transition, or null when idle. t/dur/half are seconds. `type`/`irisAt`
   * describe the overlay drawn right now; `toType`/`toIrisAt` take over at the
   * midpoint swap (they differ only when a forced go() inherited a running overlay).
   * @type {null | {type:string, toType:string, t:number, dur:number, half:number, to:string, data:*,
   *                irisAt:{x:number,y:number}|null, toIrisAt:{x:number,y:number}|null, switched:boolean}}
   */
  let tr = null;
  /** The last go() requested while busy; executed when the transition ends. */
  let queued = null;

  /** True when tick() ran during the previous frame: the host owns the transition clock. */
  let hostClock = false;
  /** True once tick() ran since the last draw(). */
  let tickedThisFrame = false;
  /** Seconds update() has advanced the transition since the last draw() (avoids a double step when tick() takes over). */
  let simAdvanced = 0;
  /** performance.now() of the previous tick(); 0 = unknown. */
  let lastTickMs = 0;
  /** Consecutive explicit tick(0) calls seen while a transition is live. */
  let zeroTicks = 0;

  /** Viewport in css px, cached from resize(); used when draw() is called without W/H. */
  let viewW = 0;
  let viewH = 0;

  /** Scene that owns the gesture in progress (null when it started while busy, or when none). */
  let gestureOwner = null;
  /** True between a 'down' and the matching 'up'/'cancel'. */
  let contactLive = false;
  /** True between a 'dragstart' and its 'dragend' when the host wires no 'down' (drag-only wiring). */
  let dragLive = false;

  /** Reused outputs — never allocated per frame; mergedParams keeps a fixed shape (assign, never delete). */
  const mergedParams = {};
  for (let i = 0; i < POSTFX_KEYS.length; i++) mergedParams[POSTFX_KEYS[i]] = undefined;
  const trInfo = { type: 'none', progress: 0, cover: 0, switched: true };

  /** Logs an error once per unique (label, message) pair. */
  function report(label, err) {
    const msg = label + ': ' + (err && err.message ? err.message : String(err));
    if (logged.has(msg)) return;
    if (logged.size < MAX_LOGGED_ERRORS) logged.add(msg);
    if (typeof console !== 'undefined' && console.error) {
      console.error('[scenes] ' + label, err);
    }
  }

  /** Calls scene[method](...args) if it exists; swallows and logs exceptions. */
  function call(scene, method, a, b, c) {
    if (!scene) return undefined;
    const fn = scene[method];
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.call(scene, a, b, c);
    } catch (err) {
      report((nameOf(scene) || '?') + '.' + method, err);
      return undefined;
    }
  }

  /** Finds the registered name of a scene object (for error labels). */
  function nameOf(scene) {
    for (const [name, s] of registry) if (s === scene) return name;
    return null;
  }

  /**
   * Registers a scene under a name. Re-registering replaces the previous
   * scene object (the live scene is swapped only on the next go()).
   * @param {string} name
   * @param {object} scene
   */
  function register(name, scene) {
    if (typeof name !== 'string' || !name || !scene || typeof scene !== 'object') {
      report('register', new Error('invalid scene registration: ' + String(name)));
      return;
    }
    registry.set(name, scene);
  }

  /**
   * Removes a scene from the registry. Refused (returns false) while that scene
   * is live, is the target of the running transition, or is queued.
   * @param {string} name
   * @returns {boolean} true when removed
   */
  function unregister(name) {
    const pending = (tr && tr.to === name) || (queued && queued.name === name);
    if (name === currentName || pending) {
      report('unregister', new Error('scene "' + String(name) + '" is live or pending'));
      return false;
    }
    return registry.delete(name);
  }

  /**
   * Performs the actual swap: exit current → enter next → emit 'scene:change'.
   * Anything it calls may re-enter go(); callers must not touch `tr` afterwards
   * without checking it is still their own transition.
   * @returns {boolean} false when the target vanished from the registry
   */
  function swapTo(name, data) {
    const next = registry.get(name);
    if (!next) {
      report('go', new Error('scene vanished: ' + String(name)));
      return false;
    }
    const from = currentName;
    gestureOwner = null; // a gesture started on the outgoing scene ends with its exit()
    call(current, 'exit');
    current = next;
    currentName = name;
    call(next, 'enter', data);
    bus.emit('scene:change', { from, to: name, data });
    return true;
  }

  /** Cover (0..1 black) of the live transition at its current time. */
  function coverOf(t) {
    if (!t) return 0;
    if (t.t < t.half) return easeInOut(t.t / t.half);
    return 1 - easeInOut((t.t - t.half) / t.half);
  }

  /**
   * Requests a scene change. While a transition runs, a non-forced request is
   * queued for when it ends; a request that duplicates the running target (or
   * re-enters the scene currently fading out) is absorbed instead of queued.
   * @param {string} name registered scene name
   * @param {*} [data] passed to scene.enter(data); data.irisAt {x,y} (css px) centres an iris wipe
   * @param {{transition?:'fade'|'iris'|'cut', dur?:number, force?:boolean}} [opts]
   * @returns {boolean} true when the change started, was queued or was absorbed; false if unknown scene
   */
  function go(name, data, opts) {
    if (!registry.has(name)) {
      report('go', new Error('unknown scene "' + String(name) + '"'));
      return false;
    }
    const o = opts || {};
    if (tr) {
      if (!o.force) {
        if (tr.to === name || (!tr.switched && currentName === name)) return true;
        queued = { name, data, opts: o };
        return true;
      }
      // Forced: abandon the running transition but keep its current cover and
      // overlay shape so the screen never pops; a pending target is dropped.
      const old = tr;
      queued = null;
      tr = null;
      return begin(name, data, o, coverOf(old), old);
    }
    return begin(name, data, o, 0, null);
  }

  /**
   * Starts a transition (or cuts) toward `name`.
   * @param {number} carry starting cover 0..1 inherited from an abandoned transition
   * @param {object|null} old the abandoned transition whose overlay is continued while carry > 0
   * @returns {boolean} true when started
   */
  function begin(name, data, o, carry, old) {
    let toType = o.transition === 'iris' || o.transition === 'cut' ? o.transition : 'fade';
    let durMs = typeof o.dur === 'number' && o.dur >= 0 ? o.dur : DEFAULT_DUR_MS;
    if (reducedMotion) {
      if (toType === 'iris') toType = 'fade';
      durMs = Math.min(durMs, REDUCED_MOTION_MAX_DUR_MS);
    }
    if (toType === 'cut' || durMs <= 0) {
      return swapTo(name, data);
    }
    const inherit = carry > 0 && old !== null;
    const dur = durMs / 1000;
    const half = dur / 2;
    const toIrisAt = toType === 'iris' ? irisCentreOf(data) : null;
    const my = {
      type: inherit ? old.type : toType,
      toType,
      t: half * easeInverse(carry),
      dur,
      half,
      to: name,
      data,
      irisAt: inherit ? old.irisAt : toIrisAt,
      toIrisAt,
      switched: false,
    };
    tr = my;
    if (!current) {
      // Nothing to fade out: swap immediately and only play the fade-in half.
      markSwitched(my);
      if (!swapTo(name, data) && tr === my) tr = null;
    }
    return true;
  }

  /** Flips a transition into its fade-in half (call BEFORE swapTo; it may re-enter). */
  function markSwitched(my) {
    my.switched = true;
    my.type = my.toType;
    my.irisAt = my.toIrisAt;
    if (my.t < my.half) my.t = my.half;
  }

  /** Transition clock step; `my` is captured because any scene call may replace `tr`. */
  function advance(step) {
    const my = tr;
    if (!my || !(step > 0)) return;
    my.t += step;
    if (!my.switched && my.t >= my.half) {
      markSwitched(my);
      if (!swapTo(my.to, my.data) && tr === my) tr = null;
    }
    if (tr === my && my.t >= my.dur) {
      tr = null;
      startQueued();
    }
  }

  /** Begins the queued go(), if any and still valid; a queued re-entry of the live scene is dropped. */
  function startQueued() {
    const q = queued;
    if (!q) return;
    queued = null;
    if (!registry.has(q.name)) {
      report('go', new Error('queued scene vanished: ' + String(q.name)));
      return;
    }
    if (q.name === currentName && !q.opts.force) return;
    begin(q.name, q.data, q.opts, 0, null);
  }

  /**
   * Advances the live scene and, unless the host drives tick(), the transition.
   * @param {number} dt seconds (the simulation step)
   */
  function update(dt) {
    const step = typeof dt === 'number' && dt > 0 ? dt : 0;
    call(current, 'update', step);
    if (!hostClock && !tickedThisFrame) {
      simAdvanced += step;
      advance(step);
    }
  }

  /** Wall-clock seconds since the previous tick(), clamped; 0 on the first call. */
  function wallStep() {
    const now = nowMs();
    const step = lastTickMs > 0 ? Math.min(Math.max(0, (now - lastTickMs) / 1000), MAX_CLOCK_STEP_SEC) : 0;
    lastTickMs = now;
    return step;
  }

  /**
   * Optional wall-clock override for the transition clock, for hosts whose
   * simulation can pause or run at a different speed: call it once per
   * rendered frame (`render: () => scenes.tick()`), never with the loop's
   * scaled dt. With no argument the step is measured from performance.now().
   * An explicit step of 0 repeated for several frames while a transition is
   * live (a paused host passing its scaled dt) falls back to wall time, so a
   * fade can never freeze the screen.
   * @param {number} [realDt] unscaled seconds since the previous frame (tests / loop.rawDt)
   */
  function tick(realDt) {
    const wall = wallStep();
    const explicit = typeof realDt === 'number' && Number.isFinite(realDt) && realDt >= 0;
    let step = explicit ? realDt : wall;
    if (explicit && tr !== null && realDt === 0) {
      zeroTicks++;
      if (zeroTicks > ZERO_TICKS_BEFORE_WALL_FALLBACK) step = wall;
    } else {
      zeroTicks = 0;
    }
    tickedThisFrame = true;
    advance(Math.max(0, step - simAdvanced));
    simAdvanced = 0;
  }

  /** Marks the frame boundary for the clock-source arbitration. */
  function endFrame() {
    hostClock = tickedThisFrame;
    tickedThisFrame = false;
    simAdvanced = 0;
  }

  /**
   * Draws the live scene, then the transition overlay in screen space.
   * @param {CanvasRenderingContext2D} ctx screen-space context (may be pre-scaled by renderScale/dpr)
   * @param {number} [W] viewport width in css px (defaults to the last resize(), then the canvas css size)
   * @param {number} [H] viewport height in css px
   */
  function draw(ctx, W, H) {
    endFrame();
    if (!ctx) return;
    const w = W > 0 ? W : viewW > 0 ? viewW : cssSizeOf(ctx.canvas, 'clientWidth');
    const h = H > 0 ? H : viewH > 0 ? viewH : cssSizeOf(ctx.canvas, 'clientHeight');
    call(current, 'draw', ctx, w, h);
    const my = tr;
    if (!my) return;
    const cover = coverOf(my);
    if (cover <= 0 || !(w > 0 && h > 0)) return;
    ctx.save();
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (ctx.canvas) {
        // Map css px onto the backing store (renderScale × dpr pre-scaling).
        ctx.scale(ctx.canvas.width / w, ctx.canvas.height / h);
      }
      ctx.globalCompositeOperation = 'source-over';
      if (my.type === 'iris') drawIris(ctx, w, h, cover, my.irisAt);
      else drawFade(ctx, w, h, cover);
    } catch (err) {
      report('draw.overlay', err);
    } finally {
      ctx.restore();
    }
  }

  /** A canvas's css size along one axis (0 when unknown, e.g. detached / offscreen canvases). */
  function cssSizeOf(canvas, prop) {
    const v = canvas ? canvas[prop] : 0;
    return typeof v === 'number' && v > 0 ? v : 0;
  }

  /** Full-screen black at `cover` alpha. */
  function drawFade(ctx, w, h, cover) {
    ctx.globalAlpha = cover;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * Black outside a circle whose outer radius shrinks to exactly zero at
   * cover = 1 (no pinhole at the swap frame), with a soft feathered rim.
   * All coordinates are css px (the caller has mapped css → backing store).
   */
  function drawIris(ctx, w, h, cover, at) {
    const cx = at ? at.x : w * 0.5;
    const cy = at ? at.y : h * 0.5;
    const dx = Math.max(cx, w - cx);
    const dy = Math.max(cy, h - cy);
    const rMax = Math.sqrt(dx * dx + dy * dy) + IRIS_FEATHER_PX;
    const outer = rMax * (1 - cover);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    if (!Number.isFinite(outer) || outer <= 0.5) {
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const inner = Math.max(0, outer - IRIS_FEATHER_PX);
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.arc(cx, cy, outer, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * Current scene's postParams() merged with transition effects (exposure dip,
   * extra vignette, slight aberration while covered). Returns a reused,
   * fixed-shape object whose absent fields are undefined.
   * @returns {object} partial postfx params
   */
  function postParams() {
    for (const k in mergedParams) mergedParams[k] = undefined;
    const p = call(current, 'postParams');
    if (p && typeof p === 'object') {
      for (const k in p) mergedParams[k] = p[k];
    }
    if (tr) {
      const cover = coverOf(tr);
      if (cover > 0) {
        const exposure = typeof mergedParams.exposure === 'number' ? mergedParams.exposure : 1;
        const vignette = typeof mergedParams.vignette === 'number' ? mergedParams.vignette : 0.45;
        const aberration = typeof mergedParams.aberration === 'number' ? mergedParams.aberration : 0.4;
        mergedParams.exposure = exposure * (1 - 0.35 * cover);
        mergedParams.vignette = Math.min(1, vignette + 0.3 * cover);
        mergedParams.aberration = aberration + 0.5 * cover;
      }
    }
    return mergedParams;
  }

  /**
   * Forwards an input event to the live scene's handler when it is present and
   * no transition is running. Gesture-ending events ('up', 'dragend', 'cancel')
   * are delivered even while busy, but only to the scene the gesture started on,
   * so no scene ever receives an 'up' without its 'down' or keeps a stuck pointer.
   * @param {string} eventName input event name ('tap', 'drag', …) or handler name ('onTap')
   * @param {*} e event payload
   * @returns {boolean} true when a handler ran
   */
  function dispatch(eventName, e) {
    if (!current) return false;
    const method = handlerFor(eventName);
    if (!method) return false;
    if (!routeGesture(method)) return false;
    if (typeof current[method] !== 'function') return false;
    call(current, method, e);
    return true;
  }

  /** Tracks gesture ownership for `method`; returns whether the live scene may receive it now. */
  function routeGesture(method) {
    const idle = tr === null;
    switch (method) {
      case 'onDown':
        contactLive = true;
        gestureOwner = idle ? current : null;
        return idle;
      case 'onDragStart':
        // A drag inside a live contact keeps the contact's owner; without one
        // (drag-only wiring) the drag is the gesture and claims ownership itself.
        if (!contactLive) {
          dragLive = true;
          gestureOwner = idle ? current : null;
        }
        return idle;
      case 'onDragEnd': {
        const allowed = terminalAllowed(idle);
        if (!contactLive) releaseGesture();
        return allowed;
      }
      case 'onUp':
      case 'onCancel': {
        const allowed = terminalAllowed(idle);
        releaseGesture();
        return allowed;
      }
      default:
        return idle;
    }
  }

  /** A gesture-ending event goes to its owner; with no tracked gesture it follows the idle rule. */
  function terminalAllowed(idle) {
    return contactLive || dragLive ? gestureOwner === current : idle;
  }

  /** Forgets the tracked gesture (pointer lifted, cancelled, or drag-only gesture ended). */
  function releaseGesture() {
    contactLive = false;
    dragLive = false;
    gestureOwner = null;
  }

  /**
   * Records the viewport (css px) and notifies the live scene of the change.
   * Call it on 'stage:resize'; draw(ctx) without W/H uses the recorded size.
   * @param {number} W
   * @param {number} H
   */
  function resize(W, H) {
    if (W > 0 && H > 0) {
      viewW = W;
      viewH = H;
    }
    call(current, 'onResize', W, H);
  }

  return {
    register,
    unregister,
    has: (name) => registry.has(name),
    get: (name) => registry.get(name) || null,
    names: () => Array.from(registry.keys()),
    go,
    update,
    tick,
    draw,
    postParams,
    dispatch,
    resize,
    get current() {
      return current;
    },
    get currentName() {
      return currentName;
    },
    get busy() {
      return tr !== null;
    },
    /** Snapshot of the live transition for tests/HUD (reused object; null when idle). */
    get transition() {
      if (!tr) return null;
      trInfo.type = tr.type;
      trInfo.progress = Math.min(1, tr.t / tr.dur);
      trInfo.cover = coverOf(tr);
      trInfo.switched = tr.switched;
      return trInfo;
    },
    /** Name of the queued go() target, or null. */
    get queuedName() {
      return queued ? queued.name : null;
    },
    /** When true, iris wipes become fades and transitions are capped at 250 ms. */
    get reducedMotion() {
      return reducedMotion;
    },
    set reducedMotion(v) {
      reducedMotion = !!v;
    },
  };
}
