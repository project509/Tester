/**
 * render/draw.js — Allocation-free 2D drawing primitives for the scene canvas.
 *
 * Sprites are unit-resolution canvases ({canvas,w,h,ox,oy}) and are drawn
 * scaled by the pixel-art scale `px` (set by the stage), with positions snapped
 * to the px grid when unrotated so every sprite stays pixel-perfect. Labels use
 * a bold system font with a round-joined stroke for a chunky, readable look;
 * bars are crisp px-aligned rectangles. Nothing here allocates per call except
 * the optional label background (which needs measureText).
 *
 * Public API:
 *   setPx(px) / getPx()
 *   drawSprite(ctx, spr, x, y, { flip, scale, alpha, rot, anchor:'bottom'|'center'|'topleft' })
 *   drawFrame(ctx, anim, t, x, y, opts)         anim = { frames:[spr], fps, loop }
 *   frameIndex(anim, t) → number
 *   drawLabel(ctx, text, x, y, { size, color, stroke, align, font, alpha, weight, baseline, bg, pad, lineWidth })
 *   drawBar(ctx, x, y, w, h, t, { fg, bg, border, radius, shine })
 *   snap(v) → number   (rounds to the px grid)
 */

const DEFAULT_FAMILY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const DEFAULT_FPS = 8;
const MAX_CACHED_SIZE = 96;

/** Current pixel-art scale (integer, set by the stage). */
let px = 2;

/** Font strings cached per (weight, size) for the default family. */
const fontCache = { bold: new Array(MAX_CACHED_SIZE + 1), normal: new Array(MAX_CACHED_SIZE + 1) };

/**
 * Sets the pixel-art scale used by every sprite draw.
 * @param {number} value integer ≥ 1
 */
export function setPx(value) {
  const v = Math.round(value);
  px = v >= 1 && Number.isFinite(v) ? v : 1;
}

/** @returns {number} the current pixel-art scale. */
export function getPx() {
  return px;
}

/**
 * Rounds a scene coordinate onto the px grid.
 * @param {number} v
 */
export function snap(v) {
  return Math.round(v / px) * px;
}

/**
 * Resolves the anchor offset (in unit px) of a sprite for the given anchor mode.
 * Returns via two module-level numbers to stay allocation-free.
 */
let anchorX = 0;
let anchorY = 0;
function resolveAnchor(spr, anchor) {
  if (anchor === 'center') {
    anchorX = spr.w * 0.5;
    anchorY = spr.h * 0.5;
  } else if (anchor === 'topleft') {
    anchorX = 0;
    anchorY = 0;
  } else {
    // 'bottom' (default): the sprite's own anchor, falling back to bottom-centre.
    anchorX = typeof spr.ox === 'number' ? spr.ox : spr.w * 0.5;
    anchorY = typeof spr.oy === 'number' ? spr.oy : spr.h;
  }
}

/**
 * Draws a unit-resolution sprite at scene position (x, y).
 * @param {CanvasRenderingContext2D} ctx
 * @param {{canvas: HTMLCanvasElement, w: number, h: number, ox?: number, oy?: number}} spr
 * @param {number} x
 * @param {number} y
 * @param {{ flip?: boolean, scale?: number, alpha?: number, rot?: number, anchor?: 'bottom'|'center'|'topleft' }} [o]
 */
export function drawSprite(ctx, spr, x, y, o) {
  if (!spr || !spr.canvas || !(spr.w > 0) || !(spr.h > 0)) return;
  const flip = o ? !!o.flip : false;
  const scale = o && o.scale > 0 ? o.scale : 1;
  const alpha = o && typeof o.alpha === 'number' ? o.alpha : 1;
  const rot = o && o.rot ? o.rot : 0;
  if (alpha <= 0) return;
  resolveAnchor(spr, o ? o.anchor : undefined);

  const s = px * scale;
  const dw = spr.w * s;
  const dh = spr.h * s;
  if (ctx.imageSmoothingEnabled) ctx.imageSmoothingEnabled = false;
  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;

  if (rot === 0) {
    // Pixel-perfect path: snap the top-left corner to the px grid.
    const left = snap(x - anchorX * s);
    const top = snap(y - anchorY * s);
    if (!flip) {
      ctx.drawImage(spr.canvas, left, top, dw, dh);
    } else {
      // Mirror about the sprite's own vertical axis without save/restore.
      ctx.scale(-1, 1);
      ctx.drawImage(spr.canvas, -left - dw, top, dw, dh);
      ctx.scale(-1, 1);
    }
  } else {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    if (flip) ctx.scale(-1, 1);
    ctx.drawImage(spr.canvas, -anchorX * s, -anchorY * s, dw, dh);
    ctx.restore();
  }
  if (alpha < 1) ctx.globalAlpha = prevAlpha;
}

/**
 * Picks the frame index of an animation at time t (seconds).
 * Loops by default; clamps to the last frame when anim.loop === false.
 * @param {{frames: object[], fps?: number, loop?: boolean}} anim
 * @param {number} t
 * @returns {number} index into anim.frames (−1 when there are no frames)
 */
export function frameIndex(anim, t) {
  if (!anim || !anim.frames) return -1;
  const n = anim.frames.length;
  if (n === 0) return -1;
  const fps = anim.fps > 0 ? anim.fps : DEFAULT_FPS;
  let i = Math.floor((Number.isFinite(t) ? t : 0) * fps);
  if (anim.loop === false) {
    i = i < 0 ? 0 : i >= n ? n - 1 : i;
  } else {
    i %= n;
    if (i < 0) i += n;
  }
  return i;
}

/**
 * Draws the frame of an animation for time t.
 * @param {CanvasRenderingContext2D} ctx
 * @param {{frames: object[], fps?: number, loop?: boolean}} anim
 * @param {number} t seconds
 * @param {number} x
 * @param {number} y
 * @param {object} [opts] same as drawSprite
 */
export function drawFrame(ctx, anim, t, x, y, opts) {
  const i = frameIndex(anim, t);
  if (i < 0) return;
  drawSprite(ctx, anim.frames[i], x, y, opts);
}

/** Returns a cached CSS font string for the default family. */
function fontFor(size, weight, family) {
  const w = weight === 'normal' || weight === 400 || weight === '400' ? 'normal' : 'bold';
  if (family) return w + ' ' + size + 'px ' + family;
  const sz = Math.round(size);
  if (sz >= 1 && sz <= MAX_CACHED_SIZE) {
    const cache = fontCache[w];
    let f = cache[sz];
    if (!f) {
      f = w + ' ' + sz + 'px ' + DEFAULT_FAMILY;
      cache[sz] = f;
    }
    return f;
  }
  return w + ' ' + size + 'px ' + DEFAULT_FAMILY;
}

/** Fills a rounded rectangle path (r clamped to half the size). */
function roundRectPath(ctx, x, y, w, h, r) {
  const rr = r > w * 0.5 ? w * 0.5 : r > h * 0.5 ? h * 0.5 : r;
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/**
 * Draws a stroked text label (pixel-ish bold system font, round joins).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {{ size?: number, color?: string, stroke?: string|null, align?: CanvasTextAlign, font?: string,
 *           alpha?: number, weight?: string|number, baseline?: CanvasTextBaseline, bg?: string|null,
 *           pad?: number, lineWidth?: number }} [o]
 */
export function drawLabel(ctx, text, x, y, o) {
  if (text === undefined || text === null) return;
  const size = o && o.size > 0 ? o.size : 11;
  const color = (o && o.color) || '#fff';
  const stroke = o ? (o.stroke === undefined ? '#000' : o.stroke) : '#000';
  const align = (o && o.align) || 'center';
  const alpha = o && typeof o.alpha === 'number' ? o.alpha : 1;
  const baseline = (o && o.baseline) || 'middle';
  const bg = o ? o.bg : null;
  if (alpha <= 0) return;
  const str = typeof text === 'string' ? text : String(text);
  const sx = Math.round(x);
  const sy = Math.round(y);

  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
  ctx.font = fontFor(size, o && o.weight, o && o.font);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;

  if (bg) {
    // Background pill (the only allocating path: measureText).
    const pad = o && o.pad >= 0 ? o.pad : Math.round(size * 0.45);
    const tw = ctx.measureText(str).width;
    const bw = Math.round(tw + pad * 2);
    const bh = Math.round(size + pad * 1.2);
    const bx = align === 'left' || align === 'start' ? sx - pad : align === 'right' || align === 'end' ? sx - bw + pad : sx - bw * 0.5;
    const by = baseline === 'top' ? sy - pad * 0.6 : baseline === 'bottom' || baseline === 'alphabetic' ? sy - bh + pad * 0.6 : sy - bh * 0.5;
    ctx.fillStyle = bg;
    roundRectPath(ctx, Math.round(bx), Math.round(by), bw, bh, bh * 0.5);
    ctx.fill();
  }
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = o && o.lineWidth > 0 ? o.lineWidth : size < 14 ? 3 : Math.round(size * 0.22);
    ctx.strokeStyle = stroke;
    ctx.strokeText(str, sx, sy);
  }
  ctx.fillStyle = color;
  ctx.fillText(str, sx, sy);
  if (alpha < 1) ctx.globalAlpha = prevAlpha;
}

/**
 * Draws a horizontal progress bar filled to t (0..1).
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x left
 * @param {number} y top
 * @param {number} w
 * @param {number} h
 * @param {number} t fill fraction 0..1
 * @param {{ fg?: string, bg?: string, border?: string|null, radius?: number, shine?: boolean, alpha?: number }} [o]
 */
export function drawBar(ctx, x, y, w, h, t, o) {
  if (!(w > 0) || !(h > 0)) return;
  const fg = (o && o.fg) || '#6ee07a';
  const bg = (o && o.bg) || 'rgba(0,0,0,0.6)';
  const border = o ? (o.border === undefined ? '#000' : o.border) : '#000';
  const radius = o && o.radius > 0 ? o.radius : 0;
  const shine = o ? o.shine !== false : true;
  const alpha = o && typeof o.alpha === 'number' ? o.alpha : 1;
  if (alpha <= 0) return;
  const f = !(t > 0) ? 0 : t > 1 ? 1 : t;
  const bx = Math.round(x);
  const by = Math.round(y);
  const bw = Math.round(w);
  const bh = Math.round(h);
  const fw = Math.round(bw * f);

  const prevAlpha = ctx.globalAlpha;
  if (alpha < 1) ctx.globalAlpha = prevAlpha * alpha;
  if (radius > 0) {
    ctx.fillStyle = bg;
    roundRectPath(ctx, bx, by, bw, bh, radius);
    ctx.fill();
    if (fw > 0) {
      ctx.fillStyle = fg;
      roundRectPath(ctx, bx, by, fw, bh, radius);
      ctx.fill();
    }
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      roundRectPath(ctx, bx + 0.5, by + 0.5, bw - 1, bh - 1, radius);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = bg;
    ctx.fillRect(bx, by, bw, bh);
    if (fw > 0) {
      ctx.fillStyle = fg;
      ctx.fillRect(bx, by, fw, bh);
      if (shine && bh >= 4) {
        // One-px highlight along the top of the fill and a darker base line.
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fillRect(bx, by, fw, 1);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(bx, by + bh - 1, fw, 1);
      }
    }
    if (border) {
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
    }
  }
  if (alpha < 1) ctx.globalAlpha = prevAlpha;
}
