/**
 * render/lights.js — Dynamic 2D lighting: ¼-resolution light map + emissive layer.
 *
 * The light map (ceil(W/4) × ceil(H/4)) is filled with the ambient colour, every
 * light is stamped on it as a cached radial-gradient sprite with 'lighter', and
 * the result is multiplied over the scene at full size with smoothing (soft,
 * cheap). A full-resolution emissive canvas collects queued world-space draws
 * (glowing sprites, additive particles, light-source glows) and is composited
 * with 'lighter' so postfx bloom picks it up. Light positions are world coords;
 * render() must be called in screen space (after cam.reset).
 *
 * Public API:
 *   createLighting(stage) → lights
 *   lights.ambient ('#hex' | [r,g,b]) · lights.ambientIntensity (0..1) · lights.enabled (bool)
 *   lights.add({ x, y, r, color, intensity, flicker, type:'point'|'cone', angle, spread, emissive }) → light
 *   lights.remove(light) · lights.clear() · lights.flash(x, y, r, color, dur) → light
 *   lights.update(dt) · lights.render(ctx, cam) · lights.drawEmissive(fn)
 *   lights.count · lights.time · lights.lightmap / lights.emissiveCanvas (debug) · lights.destroy()
 */

import { bus } from '../core/events.js';
import { makeRng } from '../core/rng.js';
import { hexToRgb } from '../core/util.js';

/** Light map is 1/LM_DIV of the viewport in each axis. */
const LM_DIV = 4;
/** Gradient sprite diameters are power-of-two buckets within this range. */
const SPRITE_MIN = 8;
const SPRITE_MAX = 256;
/** Sprite cache is flushed when it grows past this many entries. */
const SPRITE_CACHE_LIMIT = 128;
/** Default duration of a flash() light, seconds. */
const FLASH_DUR = 0.12;
/** Radius of the glow a light paints on the emissive layer, relative to its r. */
const EMISSIVE_R = 0.3;
/** Flicker noise target changes per second (smoothly interpolated in between). */
const FLICKER_NOISE_RATE_MIN = 6;
const FLICKER_NOISE_RATE_MAX = 11;
/** Cone-sprite spread is quantised to this many radians for cache keys. */
const SPREAD_STEP = 0.1;
const TAU = Math.PI * 2;
const MAX_LOGGED_ERRORS = 32;

/** Cosmetic randomness only (flicker phases); never affects game state. */
const rng = makeRng('lights');

const HAS_DOM = typeof document !== 'undefined' && !!document.createElement;

/**
 * Creates an offscreen canvas of the given backing size.
 * @param {number} w
 * @param {number} h
 * @returns {HTMLCanvasElement|null}
 */
function createCanvas(w, h) {
  if (!HAS_DOM) return null;
  const c = document.createElement('canvas');
  c.width = Math.max(1, w | 0);
  c.height = Math.max(1, h | 0);
  return c;
}

/**
 * Resolves a colour value ('#hex' or [r,g,b]) to a cache key string.
 * @param {string|number[]} color
 * @returns {string}
 */
function colorKey(color) {
  if (typeof color === 'string') return color;
  if (Array.isArray(color) && color.length >= 3) return color[0] + ',' + color[1] + ',' + color[2];
  return '#ffffff';
}

/**
 * Resolves a colour value to packed 0xRRGGBB.
 * @param {string|number[]} color
 * @returns {number}
 */
function colorRgb(color) {
  if (Array.isArray(color) && color.length >= 3) {
    return ((color[0] & 255) << 16) | ((color[1] & 255) << 8) | (color[2] & 255);
  }
  const c = hexToRgb(color);
  return (c.r << 16) | (c.g << 8) | c.b;
}

/** rgba() css string from packed rgb + alpha. */
function rgbaStr(rgb, a) {
  return 'rgba(' + ((rgb >> 16) & 255) + ',' + ((rgb >> 8) & 255) + ',' + (rgb & 255) + ',' + a + ')';
}

/** Smallest power of two ≥ x, clamped to the sprite bucket range. */
function spriteBucket(diameter) {
  let s = SPRITE_MIN;
  while (s < diameter && s < SPRITE_MAX) s *= 2;
  return s;
}

/**
 * Paints the standard light falloff as a radial gradient centred in a square canvas.
 * @param {CanvasRenderingContext2D} g
 * @param {number} size canvas size
 * @param {number} rgb packed colour
 * @param {number} alpha peak alpha
 */
function fillFalloff(g, size, rgb, alpha) {
  const c = size / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, rgbaStr(rgb, alpha));
  grad.addColorStop(0.22, rgbaStr(rgb, alpha * 0.78));
  grad.addColorStop(0.5, rgbaStr(rgb, alpha * 0.42));
  grad.addColorStop(0.8, rgbaStr(rgb, alpha * 0.11));
  grad.addColorStop(1, rgbaStr(rgb, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
}

/**
 * Builds a point-light sprite: soft radial falloff.
 * @returns {HTMLCanvasElement|null}
 */
function makePointSprite(size, rgb) {
  const cv = createCanvas(size, size);
  if (!cv) return null;
  fillFalloff(cv.getContext('2d'), size, rgb, 1);
  return cv;
}

/**
 * Builds a cone-light sprite pointing along +x: a soft-edged wedge of the
 * radial falloff (two nested wedges) plus a small glow at the origin.
 * @returns {HTMLCanvasElement|null}
 */
function makeConeSprite(size, rgb, spread) {
  const cv = createCanvas(size, size);
  if (!cv) return null;
  const g = cv.getContext('2d');
  const c = size / 2;
  const halves = [spread * 0.5, spread * 0.36];
  const alphas = [0.55, 0.6];
  for (let i = 0; i < halves.length; i++) {
    g.save();
    g.beginPath();
    g.moveTo(c, c);
    g.arc(c, c, c, -halves[i], halves[i]);
    g.closePath();
    g.clip();
    fillFalloff(g, size, rgb, alphas[i]);
    g.restore();
  }
  // Source glow: the lamp housing itself lights its immediate surroundings.
  const gr = size * 0.12;
  const grad = g.createRadialGradient(c, c, 0, c, c, gr);
  grad.addColorStop(0, rgbaStr(rgb, 0.7));
  grad.addColorStop(1, rgbaStr(rgb, 0));
  g.fillStyle = grad;
  g.fillRect(c - gr, c - gr, gr * 2, gr * 2);
  return cv;
}

/**
 * Creates the lighting system for a stage.
 * @param {{ W:number, H:number, renderScale?:number }} stage
 * @returns {object} lights (see file header)
 */
export function createLighting(stage) {
  /** @type {object[]} live lights (order irrelevant: 'lighter' is commutative) */
  const lights = [];
  /** @type {object[]} recycled light objects */
  const pool = [];
  /** @type {Function[]} emissive draw callbacks queued for this frame */
  const queue = [];
  /** @type {Map<string, HTMLCanvasElement>} gradient sprites keyed by colour|kind|size[|spread] */
  const sprites = new Map();
  const logged = new Set();

  let lmCanvas = null;
  let lm = null;
  let lmW = 0;
  let lmH = 0;
  let emCanvas = null;
  let em = null;
  let sizedW = -1;
  let sizedH = -1;
  let sizedRs = -1;
  let dirty = true;
  let time = 0;

  // Ambient cache (rebuilt only when ambient/intensity change).
  let ambientRef = null;
  let ambientIntensityRef = -1;
  let ambientStyle = '#ffffff';
  let ambientIsWhite = true;

  // World → screen affine map for the current frame (css px).
  let ma = 1, mb = 0, mc = 0, md = 1, me = 0, mf = 0;
  let camZoom = 1;
  let camRot = 0;

  /** Logs an error once per unique message (never throws). */
  function report(where, err) {
    const msg = where + ': ' + (err && err.message ? err.message : String(err));
    if (logged.has(msg)) return;
    if (logged.size < MAX_LOGGED_ERRORS) logged.add(msg);
    if (typeof console !== 'undefined' && console.error) console.error('[lights] ' + msg, err);
  }

  /** Reads stage dimensions, defaulting sanely when a field is missing. */
  function stageW() { return stage && stage.W > 0 ? stage.W : 1; }
  function stageH() { return stage && stage.H > 0 ? stage.H : 1; }
  function stageRs() { return stage && stage.renderScale > 0 ? stage.renderScale : 1; }

  /** (Re)creates the light map and emissive canvases when the viewport changes. */
  function ensureSize() {
    const W = stageW();
    const H = stageH();
    const rs = stageRs();
    if (!dirty && W === sizedW && H === sizedH && rs === sizedRs) return;
    dirty = false;
    sizedW = W;
    sizedH = H;
    sizedRs = rs;
    lmW = Math.ceil(W / LM_DIV);
    lmH = Math.ceil(H / LM_DIV);
    if (!lmCanvas) {
      lmCanvas = createCanvas(lmW, lmH);
      lm = lmCanvas ? lmCanvas.getContext('2d') : null;
    } else {
      lmCanvas.width = lmW;
      lmCanvas.height = lmH;
    }
    const ew = Math.ceil(W * rs);
    const eh = Math.ceil(H * rs);
    if (!emCanvas) {
      emCanvas = createCanvas(ew, eh);
      em = emCanvas ? emCanvas.getContext('2d') : null;
    } else {
      emCanvas.width = ew;
      emCanvas.height = eh;
    }
  }

  const offResize = bus.on('stage:resize', () => { dirty = true; });

  /**
   * Returns the cached gradient sprite for a light drawn at radius rr (in the
   * target canvas's px); `cone` selects the wedge sprite instead of the point one.
   */
  function getSprite(l, rr, cone) {
    if (l.color !== l._colorRef) {
      l._colorRef = l.color;
      l._ck = colorKey(l.color);
      l._rgb = colorRgb(l.color);
    }
    const size = spriteBucket(rr * 2);
    let key;
    let spread = 0;
    if (cone) {
      spread = Math.round((l.spread > 0 ? l.spread : Math.PI / 3) / SPREAD_STEP) * SPREAD_STEP;
      if (spread > TAU) spread = TAU;
      key = l._ck + '|c|' + size + '|' + spread.toFixed(1);
    } else {
      key = l._ck + '|p|' + size;
    }
    let spr = sprites.get(key);
    if (spr === undefined) {
      if (sprites.size >= SPRITE_CACHE_LIMIT) sprites.clear();
      spr = cone ? makeConeSprite(size, l._rgb, spread) : makePointSprite(size, l._rgb);
      sprites.set(key, spr);
    }
    return spr;
  }

  /** Rebuilds the ambient fill style when ambient colour or intensity changed. */
  function refreshAmbient() {
    const col = api.ambient;
    const k = api.ambientIntensity;
    if (col === ambientRef && k === ambientIntensityRef) return;
    ambientRef = col;
    ambientIntensityRef = k;
    const rgb = colorRgb(col);
    const f = k < 0 ? 0 : k > 1 ? 1 : k;
    const r = Math.round(((rgb >> 16) & 255) * f);
    const g = Math.round(((rgb >> 8) & 255) * f);
    const b = Math.round((rgb & 255) * f);
    ambientStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    ambientIsWhite = r === 255 && g === 255 && b === 255;
  }

  /**
   * Captures the world→screen affine map for this frame. Prefers the camera's
   * own worldToScreen (exact, including shake) with three probe points; falls
   * back to the x/y/zoom formula, then identity.
   */
  function readCamera(cam) {
    ma = 1; mb = 0; mc = 0; md = 1; me = 0; mf = 0;
    if (cam && typeof cam.worldToScreen === 'function') {
      const o = cam.worldToScreen(0, 0);
      const px = cam.worldToScreen(1, 0);
      const py = cam.worldToScreen(0, 1);
      if (o && px && py) {
        ma = px.x - o.x; mb = px.y - o.y; mc = py.x - o.x; md = py.y - o.y; me = o.x; mf = o.y;
      }
    } else if (cam && typeof cam.zoom === 'number') {
      const z = cam.zoom > 0 ? cam.zoom : 1;
      ma = z; md = z;
      me = stageW() * 0.5 - (cam.x || 0) * z;
      mf = stageH() * 0.5 - (cam.y || 0) * z;
    }
    if (!(isFinite(ma) && isFinite(mb) && isFinite(mc) && isFinite(md) && isFinite(me) && isFinite(mf))) {
      ma = 1; mb = 0; mc = 0; md = 1; me = 0; mf = 0;
    }
    camZoom = Math.sqrt(ma * ma + mb * mb) || 1;
    camRot = mb === 0 && ma > 0 ? 0 : Math.atan2(mb, ma);
  }

  /** Effective brightness of a light this frame (intensity × flicker × flash decay). */
  function brightness(l) {
    let a = l.intensity * l._flickerVal;
    if (l._dur > 0) {
      const k = l._life / l._dur;
      a *= k * k;
    }
    return a;
  }

  /** Stamps one light onto the light map (light-map pixel space). */
  function drawLight(l) {
    const a = brightness(l);
    if (a <= 0.003 || !(l.r > 0)) return;
    const sx = (ma * l.x + mc * l.y + me) / LM_DIV;
    const sy = (mb * l.x + md * l.y + mf) / LM_DIV;
    const rr = (l.r * camZoom) / LM_DIV;
    if (rr < 0.5 || sx + rr < 0 || sy + rr < 0 || sx - rr > lmW || sy - rr > lmH) return;
    const spr = getSprite(l, rr, l.type === 'cone');
    if (!spr) return;
    const d = rr * 2;
    if (l.type === 'cone') {
      const ang = l.angle + camRot;
      const cs = Math.cos(ang);
      const sn = Math.sin(ang);
      lm.setTransform(cs, sn, -sn, cs, sx, sy);
      lm.globalAlpha = a > 1 ? 1 : a;
      lm.drawImage(spr, -rr, -rr, d, d);
      if (a > 1) {
        lm.globalAlpha = a - 1 > 1 ? 1 : a - 1;
        lm.drawImage(spr, -rr, -rr, d, d);
      }
      lm.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      lm.globalAlpha = a > 1 ? 1 : a;
      lm.drawImage(spr, sx - rr, sy - rr, d, d);
      if (a > 1) {
        lm.globalAlpha = a - 1 > 1 ? 1 : a - 1;
        lm.drawImage(spr, sx - rr, sy - rr, d, d);
      }
    }
  }

  /** Paints the glow of an emissive light onto the emissive layer (world space). */
  function drawLightGlow(l) {
    const a = brightness(l) * l.emissive;
    if (a <= 0.003 || !(l.r > 0)) return;
    const r2 = l.r * EMISSIVE_R;
    const spr = getSprite(l, r2 * camZoom * stageRs(), false);
    if (!spr) return;
    em.globalAlpha = a > 1 ? 1 : a;
    em.drawImage(spr, l.x - r2, l.y - r2, r2 * 2, r2 * 2);
  }

  /** Renders the light map: ambient fill + every light with 'lighter'. */
  function renderLightMap() {
    refreshAmbient();
    lm.setTransform(1, 0, 0, 1, 0, 0);
    lm.globalCompositeOperation = 'source-over';
    lm.globalAlpha = 1;
    lm.fillStyle = ambientStyle;
    lm.fillRect(0, 0, lmW, lmH);
    lm.globalCompositeOperation = 'lighter';
    lm.imageSmoothingEnabled = true;
    for (let i = 0; i < lights.length; i++) drawLight(lights[i]);
    lm.globalAlpha = 1;
    lm.globalCompositeOperation = 'source-over';
  }

  /** Runs queued emissive callbacks and light glows into the emissive layer. */
  function renderEmissive(cam, hasGlow) {
    const rs = stageRs();
    em.setTransform(rs, 0, 0, rs, 0, 0);
    em.globalCompositeOperation = 'source-over';
    em.globalAlpha = 1;
    em.clearRect(0, 0, sizedW, sizedH);
    em.save();
    const hasCam = cam && typeof cam.apply === 'function';
    if (hasCam) cam.apply(em);
    em.imageSmoothingEnabled = false;
    for (let i = 0; i < queue.length; i++) {
      try {
        queue[i](em);
      } catch (err) {
        report('drawEmissive callback', err);
      }
      em.globalAlpha = 1;
      em.globalCompositeOperation = 'source-over';
    }
    if (hasGlow) {
      em.imageSmoothingEnabled = true;
      for (let i = 0; i < lights.length; i++) {
        if (lights[i].emissive > 0) drawLightGlow(lights[i]);
      }
    }
    if (hasCam && typeof cam.reset === 'function') cam.reset(em);
    em.restore();
  }

  /** Advances one light's flicker/flash state. Returns false when it died. */
  function stepLight(l, dt) {
    if (l.alive === false) return false;
    if (l._dur > 0) {
      l._life -= dt;
      if (l._life <= 0) {
        l.alive = false;
        return false;
      }
    }
    if (l.flicker > 0) {
      l._nT += dt * l._nRate;
      while (l._nT >= 1) {
        l._nT -= 1;
        l._nA = l._nB;
        l._nB = rng.next();
      }
      const s = l._nT * l._nT * (3 - 2 * l._nT);
      const noise = l._nA + (l._nB - l._nA) * s;
      const w1 = 0.5 + 0.5 * Math.sin(time * l._freq + l._phase);
      const w2 = 0.5 + 0.5 * Math.sin(time * l._freq * 2.63 + l._phase * 1.7);
      const wave = w1 * 0.65 + w2 * 0.35;
      const dip = 0.55 * (1 - wave) + 0.45 * (1 - noise);
      l._flickerVal = 1 - l.flicker * dip;
    } else {
      l._flickerVal = 1;
    }
    return true;
  }

  /** Takes a light object from the pool (or creates one) and initialises it. */
  function acquire(o) {
    const l = pool.length ? pool.pop() : {
      x: 0, y: 0, r: 0, color: '#ffffff', intensity: 1, flicker: 0, type: 'point',
      angle: 0, spread: 0, emissive: 0, alive: true,
      _phase: 0, _freq: 0, _nA: 0, _nB: 0, _nT: 0, _nRate: 0, _flickerVal: 1,
      _life: 0, _dur: 0, _colorRef: null, _ck: '', _rgb: 0,
    };
    l.x = +o.x || 0;
    l.y = +o.y || 0;
    l.r = o.r > 0 ? +o.r : 64;
    l.color = o.color !== undefined && o.color !== null ? o.color : '#ffd9a0';
    l.intensity = o.intensity !== undefined ? +o.intensity || 0 : 1;
    l.flicker = o.flicker > 0 ? (o.flicker > 1 ? 1 : +o.flicker) : 0;
    l.type = o.type === 'cone' ? 'cone' : 'point';
    l.angle = typeof o.angle === 'number' ? o.angle : -Math.PI / 2;
    l.spread = o.spread > 0 ? +o.spread : Math.PI / 3;
    l.emissive = o.emissive > 0 ? (o.emissive > 1 ? 1 : +o.emissive) : 0;
    l.alive = true;
    l._phase = rng.float(0, TAU);
    l._freq = rng.float(7, 13);
    l._nA = rng.next();
    l._nB = rng.next();
    l._nT = 0;
    l._nRate = rng.float(FLICKER_NOISE_RATE_MIN, FLICKER_NOISE_RATE_MAX);
    l._flickerVal = 1;
    l._life = 0;
    l._dur = 0;
    l._colorRef = null;
    lights.push(l);
    return l;
  }

  const api = {
    ambient: '#ffffff',
    ambientIntensity: 1,
    enabled: true,

    /**
     * Adds a persistent light (world coords). The returned object is mutable;
     * set `.alive = false` (or call remove) to drop it.
     * @param {{x:number,y:number,r?:number,color?:string|number[],intensity?:number,flicker?:number,type?:'point'|'cone',angle?:number,spread?:number,emissive?:number}} o
     * @returns {object} light
     */
    add(o) {
      return acquire(o || {});
    },

    /**
     * Removes a light immediately.
     * @param {object} light
     */
    remove(light) {
      if (!light) return;
      light.alive = false;
      const i = lights.indexOf(light);
      if (i >= 0) {
        lights[i] = lights[lights.length - 1];
        lights.pop();
        pool.push(light);
      }
    },

    /** Removes every light and pending emissive draw. */
    clear() {
      for (let i = 0; i < lights.length; i++) pool.push(lights[i]);
      lights.length = 0;
      queue.length = 0;
    },

    /**
     * Adds a transient light that decays quadratically and removes itself.
     * @param {number} x
     * @param {number} y
     * @param {number} r
     * @param {string|number[]} [color]
     * @param {number} [dur] seconds
     * @returns {object} light
     */
    flash(x, y, r, color, dur) {
      const l = acquire({ x, y, r, color: color || '#fff2c8', intensity: 1.4, emissive: 0.8 });
      l._dur = dur > 0 ? +dur : FLASH_DUR;
      l._life = l._dur;
      return l;
    },

    /**
     * Advances flicker and flash timers; prunes dead lights.
     * @param {number} dt seconds
     */
    update(dt) {
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      time += dt;
      for (let i = lights.length - 1; i >= 0; i--) {
        const l = lights[i];
        if (!stepLight(l, dt)) {
          lights[i] = lights[lights.length - 1];
          lights.pop();
          pool.push(l);
        }
      }
    },

    /**
     * Queues a draw call into this frame's emissive layer. The callback receives
     * the emissive context in world space (camera applied, smoothing off).
     * @param {(ctx: CanvasRenderingContext2D) => void} fn
     */
    drawEmissive(fn) {
      if (typeof fn === 'function') queue.push(fn);
    },

    /**
     * Composites the light map ('multiply') and the emissive layer ('lighter')
     * over the scene. Call in screen space after cam.reset(ctx).
     * @param {CanvasRenderingContext2D} ctx scene context (css px, pre-scaled by renderScale)
     * @param {object} cam camera
     */
    render(ctx, cam) {
      try {
        ensureSize();
        if (!ctx || !lm || !em) {
          queue.length = 0;
          return;
        }
        readCamera(cam);
        refreshAmbient();
        const W = sizedW;
        const H = sizedH;
        if (api.enabled && !(ambientIsWhite && lights.length === 0)) {
          renderLightMap();
          ctx.save();
          ctx.imageSmoothingEnabled = true;
          ctx.globalCompositeOperation = 'multiply';
          ctx.globalAlpha = 1;
          ctx.drawImage(lmCanvas, 0, 0, W, H);
          ctx.restore();
        }
        let hasGlow = false;
        for (let i = 0; i < lights.length && !hasGlow; i++) hasGlow = lights[i].emissive > 0;
        if (queue.length > 0 || hasGlow) {
          renderEmissive(cam, hasGlow);
          ctx.save();
          ctx.imageSmoothingEnabled = false;
          ctx.globalCompositeOperation = 'lighter';
          ctx.globalAlpha = 1;
          ctx.drawImage(emCanvas, 0, 0, W, H);
          ctx.restore();
        }
      } catch (err) {
        report('render', err);
      }
      queue.length = 0;
    },

    /** Number of live lights. */
    get count() { return lights.length; },
    /** Seconds accumulated through update(). */
    get time() { return time; },
    /** The ¼-resolution light map canvas (debug/inspection). */
    get lightmap() { return lmCanvas; },
    /** The full-resolution emissive canvas (debug/inspection). */
    get emissiveCanvas() { return emCanvas; },

    /** Unsubscribes from the bus and drops all lights and caches. */
    destroy() {
      offResize();
      api.clear();
      pool.length = 0;
      sprites.clear();
    },
  };

  return api;
}
