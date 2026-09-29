/**
 * render/stage.js — Owns the two full-viewport canvases: #scene (2D, where a
 * frame is drawn in css px) and #output (WebGL2 post-processed image via
 * render/postfx.js). Tracks viewport size (visualViewport), dpr (≤ 2),
 * render scale per quality, pixel-art scale `px` and safe-area insets, and
 * falls back to showing #scene directly whenever postfx is unavailable
 * (no WebGL2, context lost, or a render throwing).
 *
 * Scene backing store = round(W·rs) × round(H·rs) css px; the 2D context is
 * pre-scaled by rs in begin() so all drawing code works in css px. Postfx
 * upsamples to W·dpr × H·dpr on the output canvas.
 *
 * Public API:
 *   createStage({ sceneCanvas, outputCanvas }) → stage
 *   stage.W, stage.H, stage.dpr, stage.px, stage.renderScale, stage.quality, stage.safe {top,bottom,left,right}
 *   stage.ctx, stage.sceneCanvas, stage.outputCanvas, stage.fx (postfx or null), stage.usingPostFX, stage.frame
 *   stage.setQuality('high'|'medium'|'low')     stage.resize()   (emits bus 'stage:resize' {W,H,px,dpr,safe})
 *   stage.begin()  → ctx (clears + sets the frame transform)     stage.end(postParams)
 *   stage.setClearColor(css)     stage.destroy()
 */

import { bus } from '../core/events.js';
import { createPostFX } from './postfx.js';
import { setPx } from './draw.js';

/** Render scale per quality level. */
const RENDER_SCALE = { high: 1, medium: 0.85, low: 0.7 };
/** Resize debounce (ms); orientation changes get a second pass because iOS reports stale sizes. */
const RESIZE_DEBOUNCE_MS = 80;
const ORIENTATION_RECHECK_MS = 350;
/** Widths at or above this use the larger pixel-art scale. */
const PX_BREAKPOINT = 600;
const MAX_DPR = 2;
const MIN_SIZE = 64;

const CANVAS_STYLE =
  'position:fixed;left:0;top:0;display:block;margin:0;padding:0;border:0;' +
  'touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;' +
  'image-rendering:pixelated;image-rendering:crisp-edges;';

/** Resolves a canvas from an element, an id, or a fallback id (creating one if needed). */
function resolveCanvas(el, fallbackId) {
  if (el && typeof el.getContext === 'function') return el;
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc) return null;
  const id = typeof el === 'string' ? el : fallbackId;
  let c = doc.getElementById(id);
  if (!c) {
    c = doc.createElement('canvas');
    c.id = id;
    (doc.getElementById('app') || doc.body).appendChild(c);
  }
  return c;
}

/** Creates the hidden probe element used to read env(safe-area-inset-*). */
function makeSafeProbe() {
  const doc = typeof document !== 'undefined' ? document : null;
  if (!doc || !doc.body) return null;
  const p = doc.createElement('div');
  p.setAttribute('aria-hidden', 'true');
  p.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);padding-right:env(safe-area-inset-right,0px);' +
    'padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);';
  doc.body.appendChild(p);
  return p;
}

/**
 * Creates the stage. Canvases may be elements or ids; missing ones are created.
 * @param {{ sceneCanvas?: HTMLCanvasElement|string, outputCanvas?: HTMLCanvasElement|string, quality?: string }} [opts]
 * @returns {object} stage — see file header.
 */
export function createStage(opts = {}) {
  const sceneCanvas = resolveCanvas(opts.sceneCanvas, 'scene');
  const outputCanvas = resolveCanvas(opts.outputCanvas, 'output');
  const ctx = sceneCanvas.getContext('2d', { alpha: false });
  const win = typeof window !== 'undefined' ? window : null;
  const vv = win && win.visualViewport ? win.visualViewport : null;
  const probe = makeSafeProbe();

  const stage = {
    W: 1,
    H: 1,
    dpr: 1,
    px: 2,
    renderScale: 1,
    quality: RENDER_SCALE[opts.quality] ? opts.quality : 'high',
    safe: { top: 0, bottom: 0, left: 0, right: 0 },
    ctx,
    sceneCanvas,
    outputCanvas,
    fx: null,
    usingPostFX: false,
    frame: 0,
    setQuality,
    resize,
    begin,
    end,
    setClearColor,
    destroy,
  };

  let clearColor = '#000';
  let resizeTimer = 0;
  let recheckTimer = 0;
  let destroyed = false;
  let loggedFxError = false;

  sceneCanvas.style.cssText += CANVAS_STYLE;
  outputCanvas.style.cssText += CANVAS_STYLE;

  // ── postfx ──
  try {
    stage.fx = createPostFX(outputCanvas) || null;
  } catch (err) {
    stage.fx = null;
    warnOnce('postfx init failed', err);
  }

  function warnOnce(msg, err) {
    if (loggedFxError) return;
    loggedFxError = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('[stage] ' + msg, err);
  }

  /** Switches between the post-processed output and the raw scene canvas. */
  function setUsingPostFX(on) {
    const use = !!on && !!stage.fx;
    stage.usingPostFX = use;
    sceneCanvas.style.visibility = use ? 'hidden' : 'visible';
    outputCanvas.style.display = use ? 'block' : 'none';
  }

  /** Drops postfx for good after a failure and shows the scene canvas. */
  function disablePostFX(reason, err) {
    warnOnce('postfx disabled: ' + reason, err);
    setUsingPostFX(false);
  }

  function onContextLost(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    setUsingPostFX(false);
  }

  function onContextRestored() {
    if (!stage.fx || stage.fx.available === false) {
      try {
        stage.fx = createPostFX(outputCanvas) || null;
      } catch (err) {
        stage.fx = null;
      }
    }
    if (!stage.fx) return;
    try {
      stage.fx.setQuality(stage.quality);
      stage.fx.resize(stage.W, stage.H, stage.dpr);
      setUsingPostFX(true);
    } catch (err) {
      disablePostFX('resize after restore threw', err);
    }
  }

  // ── sizing ──

  /** Reads the safe-area insets from the probe element. */
  function readSafeArea() {
    if (!probe || !win) return;
    try {
      const cs = win.getComputedStyle(probe);
      stage.safe.top = parseFloat(cs.paddingTop) || 0;
      stage.safe.right = parseFloat(cs.paddingRight) || 0;
      stage.safe.bottom = parseFloat(cs.paddingBottom) || 0;
      stage.safe.left = parseFloat(cs.paddingLeft) || 0;
    } catch (err) {
      /* computed style unavailable (detached document): keep previous insets */
    }
  }

  /** Current viewport size in css px (visualViewport first, window fallback). */
  function viewportW() {
    const w = vv && vv.width > 0 ? vv.width : win ? win.innerWidth : 0;
    return Math.max(MIN_SIZE, Math.round(w || 0));
  }
  function viewportH() {
    const h = vv && vv.height > 0 ? vv.height : win ? win.innerHeight : 0;
    return Math.max(MIN_SIZE, Math.round(h || 0));
  }

  /**
   * Re-measures the viewport, resizes both canvases and postfx buffers and
   * emits 'stage:resize'. Safe to call at any time.
   */
  function resize() {
    if (destroyed) return;
    const W = viewportW();
    const H = viewportH();
    const rawDpr = win && win.devicePixelRatio > 0 ? win.devicePixelRatio : 1;
    stage.W = W;
    stage.H = H;
    stage.dpr = Math.min(MAX_DPR, rawDpr);
    stage.px = W < PX_BREAKPOINT ? 2 : 3;
    stage.renderScale = RENDER_SCALE[stage.quality] || 1;
    setPx(stage.px);
    readSafeArea();

    const rs = stage.renderScale;
    const bw = Math.max(1, Math.round(W * rs));
    const bh = Math.max(1, Math.round(H * rs));
    if (sceneCanvas.width !== bw) sceneCanvas.width = bw;
    if (sceneCanvas.height !== bh) sceneCanvas.height = bh;
    sceneCanvas.style.width = W + 'px';
    sceneCanvas.style.height = H + 'px';
    outputCanvas.style.width = W + 'px';
    outputCanvas.style.height = H + 'px';

    if (stage.fx) {
      const ow = Math.round(W * stage.dpr);
      const oh = Math.round(H * stage.dpr);
      if (outputCanvas.width !== ow) outputCanvas.width = ow;
      if (outputCanvas.height !== oh) outputCanvas.height = oh;
      try {
        stage.fx.resize(W, H, stage.dpr);
        setUsingPostFX(stage.fx.available !== false);
      } catch (err) {
        disablePostFX('resize threw', err);
      }
    } else {
      setUsingPostFX(false);
    }
    bus.emit('stage:resize', { W, H, px: stage.px, dpr: stage.dpr, safe: stage.safe });
  }

  function scheduleResize() {
    if (destroyed || !win) return;
    if (resizeTimer) win.clearTimeout(resizeTimer);
    resizeTimer = win.setTimeout(() => {
      resizeTimer = 0;
      resize();
    }, RESIZE_DEBOUNCE_MS);
  }

  function onOrientation() {
    scheduleResize();
    if (!win) return;
    if (recheckTimer) win.clearTimeout(recheckTimer);
    recheckTimer = win.setTimeout(() => {
      recheckTimer = 0;
      resize();
    }, ORIENTATION_RECHECK_MS);
  }

  /**
   * Sets the quality level: render scale (high 1 / medium 0.85 / low 0.7)
   * and the postfx feature set.
   * @param {'high'|'medium'|'low'} q
   */
  function setQuality(q) {
    const level = RENDER_SCALE[q] ? q : 'high';
    if (stage.fx) {
      try {
        stage.fx.setQuality(level);
      } catch (err) {
        disablePostFX('setQuality threw', err);
      }
    }
    if (level === stage.quality && stage.renderScale === RENDER_SCALE[level]) return;
    stage.quality = level;
    resize();
  }

  /** Sets the colour the scene is cleared to each frame (default black). */
  function setClearColor(css) {
    clearColor = typeof css === 'string' && css ? css : '#000';
  }

  // ── frame ──

  /**
   * Starts a frame: resets context state, applies the render-scale transform
   * and clears the scene. Returns the 2D context.
   */
  function begin() {
    const rs = stage.renderScale;
    ctx.setTransform(rs, 0, 0, rs, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = clearColor;
    ctx.fillRect(0, 0, stage.W, stage.H);
    return ctx;
  }

  /**
   * Ends a frame: runs postfx into #output when available; otherwise the
   * scene canvas is already visible and nothing else is needed.
   * @param {object} [params] postfx params (see postfx.js)
   */
  function end(params) {
    stage.frame++;
    if (!stage.usingPostFX) return;
    const fx = stage.fx;
    if (!fx || fx.available === false) {
      setUsingPostFX(false);
      return;
    }
    try {
      if (fx.render(sceneCanvas, params || null) === false) setUsingPostFX(false);
    } catch (err) {
      disablePostFX('render threw', err);
    }
  }

  /** Removes listeners and the safe-area probe (canvases are left in place). */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (win) {
      win.removeEventListener('resize', scheduleResize);
      win.removeEventListener('orientationchange', onOrientation);
      if (vv) vv.removeEventListener('resize', scheduleResize);
      if (resizeTimer) win.clearTimeout(resizeTimer);
      if (recheckTimer) win.clearTimeout(recheckTimer);
    }
    outputCanvas.removeEventListener('webglcontextlost', onContextLost);
    outputCanvas.removeEventListener('webglcontextrestored', onContextRestored);
    if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
  }

  if (win) {
    win.addEventListener('resize', scheduleResize);
    win.addEventListener('orientationchange', onOrientation);
    if (vv) vv.addEventListener('resize', scheduleResize);
  }
  outputCanvas.addEventListener('webglcontextlost', onContextLost);
  outputCanvas.addEventListener('webglcontextrestored', onContextRestored);

  resize();
  return stage;
}
