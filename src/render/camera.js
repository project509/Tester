/**
 * render/camera.js — 2D world camera with inertial panning, rubber-band
 * bounds, pinch zoom around a point, trauma-based shake, recoil kicks, target
 * following and tweened moves.
 *
 * (x, y) is the world point shown at the screen centre; `bounds` is the world
 * rectangle the VIEW must stay inside (when the world is smaller than the
 * view on an axis the camera centres it). Dragging past a bound is allowed up
 * to RUBBER_PX screen px with growing resistance and springs back once the
 * finger lifts. screenToWorld/worldToScreen are exact inverses of apply().
 *
 * Public API:
 *   createCamera(stage) → cam
 *   cam.x, cam.y, cam.zoom, cam.minZoom, cam.maxZoom, cam.bounds {x0,y0,x1,y1}|null, cam.vx, cam.vy, cam.trauma
 *   cam.apply(ctx) / cam.reset(ctx)
 *   cam.screenToWorld(sx, sy, out?) → {x,y}     cam.worldToScreen(wx, wy, out?) → {x,y}
 *   cam.panBy(dx, dy)  (screen px)   cam.fling(vx, vy)  (screen px/s)   cam.stop()
 *   cam.zoomAt(factor, sx, sy)   cam.zoomTo(zoom, sx, sy)   cam.setBounds(x0, y0, x1, y1)
 *   cam.moveTo(x, y, dur, ease) → handle|null   cam.follow(target|null, { lerp })   cam.snapTo(x, y)
 *   cam.shake(amp, dur)   cam.kick(dx, dy)   cam.offsetX / cam.offsetY / cam.roll (current shake+kick)
 *   cam.update(dt)   cam.isMoving   cam.viewWidth / cam.viewHeight (world units)
 */

import { tweens } from '../core/tween.js';
import { getEase } from '../core/util.js';

/** Max overshoot past a bound, in screen px. */
const RUBBER_PX = 60;
/** Exponential decay rate of fling velocity (1/s). */
const FLING_DECAY = 3.2;
/** Extra decay applied while flinging outside the bounds. */
const FLING_DECAY_OUTSIDE = 14;
/** Velocity below which a fling stops (world px/s). */
const FLING_STOP = 3;
/** Spring rate pulling the camera back inside the bounds (1/s). */
const SPRING_RATE = 14;
/** Seconds after the last panBy during which the spring stays disabled. */
const PIN_GRACE = 0.08;
/** Kick damping rate (1/s). */
const KICK_DECAY = 16;
/** Max shake roll in radians at full amplitude. */
const SHAKE_ROLL = 0.012;
/** Default follow lerp (fraction per 60 Hz frame). */
const FOLLOW_LERP = 0.12;

/**
 * Creates a camera bound to a stage (reads stage.W / stage.H live).
 * @param {{W: number, H: number}} stage
 * @returns {object} cam — see file header.
 */
export function createCamera(stage) {
  const cam = {
    x: 0,
    y: 0,
    zoom: 1,
    minZoom: 0.5,
    maxZoom: 3,
    /** @type {{x0:number,y0:number,x1:number,y1:number}|null} */
    bounds: null,
    vx: 0,
    vy: 0,
    trauma: 0,
    offsetX: 0,
    offsetY: 0,
    roll: 0,
    isMoving: false,
    get viewWidth() {
      return stage.W / cam.zoom;
    },
    get viewHeight() {
      return stage.H / cam.zoom;
    },
    apply,
    reset,
    screenToWorld,
    worldToScreen,
    panBy,
    fling,
    stop,
    zoomAt,
    zoomTo,
    setBounds,
    moveTo,
    snapTo,
    follow,
    shake,
    kick,
    update,
  };

  // ── internal state ──
  let pinTimer = 0;
  let shakeAmp = 0;
  let shakeDur = 1;
  let shakeT = 0;
  let kickX = 0;
  let kickY = 0;
  let followTarget = null;
  let followLerp = FOLLOW_LERP;
  let moveHandle = null;
  /** Scratch results of limits(): centre limits on each axis. */
  const lim = { x0: 0, x1: 0, y0: 0, y1: 0 };
  /** Cached cos/sin of the current roll. */
  let cosR = 1;
  let sinR = 0;

  /** Clamps a zoom value into [minZoom, maxZoom]. */
  function clampZoom(z) {
    if (!(z > 0) || !Number.isFinite(z)) return cam.zoom;
    return z < cam.minZoom ? cam.minZoom : z > cam.maxZoom ? cam.maxZoom : z;
  }

  /** Computes the allowed range of the camera centre for the current zoom into `lim`. */
  function limits() {
    const b = cam.bounds;
    const hw = stage.W * 0.5 / cam.zoom;
    const hh = stage.H * 0.5 / cam.zoom;
    if (b.x1 - b.x0 <= hw * 2) lim.x0 = lim.x1 = (b.x0 + b.x1) * 0.5;
    else {
      lim.x0 = b.x0 + hw;
      lim.x1 = b.x1 - hw;
    }
    if (b.y1 - b.y0 <= hh * 2) lim.y0 = lim.y1 = (b.y0 + b.y1) * 0.5;
    else {
      lim.y0 = b.y0 + hh;
      lim.y1 = b.y1 - hh;
    }
  }

  /**
   * Moves one axis by delta with rubber-band resistance past [lo, hi]:
   * movement back toward the range is free, outward movement is scaled by
   * 0.5·(1 − over/maxOver) and the overshoot is capped at maxOver.
   */
  function rubberAxis(v, delta, lo, hi, maxOver) {
    const next = v + delta;
    if (next >= lo && next <= hi) return next;
    if (next < lo) {
      if (delta >= 0) return next;
      const prevOver = v < lo ? lo - v : 0;
      const spentInside = v < lo ? 0 : v - lo;
      const k = 0.5 * (1 - Math.min(prevOver / maxOver, 1));
      const newOver = Math.min(maxOver, prevOver + (-delta - spentInside) * k);
      return lo - newOver;
    }
    if (delta <= 0) return next;
    const prevOver = v > hi ? v - hi : 0;
    const spentInside = v > hi ? 0 : hi - v;
    const k = 0.5 * (1 - Math.min(prevOver / maxOver, 1));
    const newOver = Math.min(maxOver, prevOver + (delta - spentInside) * k);
    return hi + newOver;
  }

  /** Hard-clamps (x, y) into the centre limits (no rubber). */
  function clampHard() {
    if (!cam.bounds) return;
    limits();
    if (cam.x < lim.x0) cam.x = lim.x0;
    else if (cam.x > lim.x1) cam.x = lim.x1;
    if (cam.y < lim.y0) cam.y = lim.y0;
    else if (cam.y > lim.y1) cam.y = lim.y1;
  }

  /** Recomputes shake/kick offsets for the current frame. */
  function updateOffsets(dt) {
    kickX -= kickX * Math.min(1, KICK_DECAY * dt);
    kickY -= kickY * Math.min(1, KICK_DECAY * dt);
    if (Math.abs(kickX) < 0.01) kickX = 0;
    if (Math.abs(kickY) < 0.01) kickY = 0;

    let sx = 0;
    let sy = 0;
    let roll = 0;
    if (cam.trauma > 0) {
      shakeT += dt;
      cam.trauma -= dt / shakeDur;
      if (cam.trauma <= 0) {
        cam.trauma = 0;
      } else {
        const a = shakeAmp * cam.trauma * cam.trauma;
        const t = shakeT;
        // Two incommensurate sines per axis ≈ cheap 1D noise.
        sx = a * (Math.sin(t * 41.3) * 0.62 + Math.sin(t * 67.9 + 1.7) * 0.38);
        sy = a * (Math.sin(t * 38.7 + 0.9) * 0.58 + Math.sin(t * 73.1 + 2.3) * 0.42);
        roll = SHAKE_ROLL * cam.trauma * cam.trauma * Math.sin(t * 29.3 + 0.4);
      }
    }
    cam.offsetX = kickX + sx;
    cam.offsetY = kickY + sy;
    cam.roll = roll;
    if (roll === 0) {
      cosR = 1;
      sinR = 0;
    } else {
      cosR = Math.cos(roll);
      sinR = Math.sin(roll);
    }
  }

  /**
   * Applies the camera transform: centre + offsets, roll, zoom, -position.
   * Pair with reset(ctx).
   * @param {CanvasRenderingContext2D} ctx
   */
  function apply(ctx) {
    ctx.save();
    ctx.translate(stage.W * 0.5 + cam.offsetX, stage.H * 0.5 + cam.offsetY);
    if (cam.roll !== 0) ctx.rotate(cam.roll);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.translate(-cam.x, -cam.y);
  }

  /** Restores the context state saved by apply(). */
  function reset(ctx) {
    ctx.restore();
  }

  /**
   * Converts screen (css px) to world coordinates.
   * @param {number} sx
   * @param {number} sy
   * @param {{x:number,y:number}} [out] reused result object (avoids allocation)
   */
  function screenToWorld(sx, sy, out) {
    const dx = sx - stage.W * 0.5 - cam.offsetX;
    const dy = sy - stage.H * 0.5 - cam.offsetY;
    // Inverse roll, then inverse zoom.
    const rx = dx * cosR + dy * sinR;
    const ry = -dx * sinR + dy * cosR;
    const o = out || { x: 0, y: 0 };
    o.x = rx / cam.zoom + cam.x;
    o.y = ry / cam.zoom + cam.y;
    return o;
  }

  /**
   * Converts world coordinates to screen (css px).
   * @param {number} wx
   * @param {number} wy
   * @param {{x:number,y:number}} [out] reused result object (avoids allocation)
   */
  function worldToScreen(wx, wy, out) {
    const zx = (wx - cam.x) * cam.zoom;
    const zy = (wy - cam.y) * cam.zoom;
    const o = out || { x: 0, y: 0 };
    o.x = zx * cosR - zy * sinR + stage.W * 0.5 + cam.offsetX;
    o.y = zx * sinR + zy * cosR + stage.H * 0.5 + cam.offsetY;
    return o;
  }

  /**
   * Pans by a finger delta in screen px (the world follows the finger).
   * Past the bounds the movement is resisted and capped at RUBBER_PX.
   */
  function panBy(dx, dy) {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    cancelMove();
    cam.vx = 0;
    cam.vy = 0;
    pinTimer = PIN_GRACE;
    const wdx = -dx / cam.zoom;
    const wdy = -dy / cam.zoom;
    if (!cam.bounds) {
      cam.x += wdx;
      cam.y += wdy;
      return;
    }
    limits();
    const maxOver = RUBBER_PX / cam.zoom;
    cam.x = rubberAxis(cam.x, wdx, lim.x0, lim.x1, maxOver);
    cam.y = rubberAxis(cam.y, wdy, lim.y0, lim.y1, maxOver);
  }

  /**
   * Starts an inertial glide from a finger velocity in screen px/s.
   */
  function fling(vx, vy) {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
    cancelMove();
    pinTimer = 0;
    cam.vx = -vx / cam.zoom;
    cam.vy = -vy / cam.zoom;
  }

  /** Stops any inertia, tweened move and following. */
  function stop() {
    cam.vx = 0;
    cam.vy = 0;
    pinTimer = 0;
    cancelMove();
  }

  /**
   * Multiplies the zoom by factor keeping the world point under (sx, sy) fixed.
   */
  function zoomAt(factor, sx, sy) {
    if (!(factor > 0) || !Number.isFinite(factor)) return;
    zoomTo(cam.zoom * factor, sx, sy);
  }

  /**
   * Sets an absolute zoom keeping the world point under (sx, sy) fixed
   * (defaults to the screen centre).
   */
  function zoomTo(zoom, sx, sy) {
    const z = clampZoom(zoom);
    if (z === cam.zoom) return;
    const px = Number.isFinite(sx) ? sx : stage.W * 0.5;
    const py = Number.isFinite(sy) ? sy : stage.H * 0.5;
    // World point under the finger before the zoom (ignoring roll/kick, which are transient).
    const wx = (px - stage.W * 0.5) / cam.zoom + cam.x;
    const wy = (py - stage.H * 0.5) / cam.zoom + cam.y;
    cam.zoom = z;
    cam.x = wx - (px - stage.W * 0.5) / z;
    cam.y = wy - (py - stage.H * 0.5) / z;
    cam.vx = 0;
    cam.vy = 0;
    pinTimer = PIN_GRACE;
  }

  /**
   * Sets (or clears, with no args) the world rectangle the view must stay in.
   */
  function setBounds(x0, y0, x1, y1) {
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
      cam.bounds = null;
      return;
    }
    cam.bounds = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  }

  function cancelMove() {
    if (moveHandle) {
      tweens.cancel(moveHandle);
      moveHandle = null;
    }
    cam.isMoving = false;
  }

  /** Immediately centres the camera on (x, y) (hard-clamped to the bounds). */
  function snapTo(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    stop();
    cam.x = x;
    cam.y = y;
    clampHard();
  }

  /**
   * Tweens the centre to (x, y) over dur seconds. Following is suspended
   * while the move runs. dur ≤ 0 snaps.
   * @returns {object|null} tween handle
   */
  function moveTo(x, y, dur, ease) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    stop();
    if (!(dur > 0)) {
      cam.x = x;
      cam.y = y;
      clampHard();
      return null;
    }
    // Clamp the destination so the tween never fights the spring.
    const save0 = cam.x;
    const save1 = cam.y;
    cam.x = x;
    cam.y = y;
    clampHard();
    const tx = cam.x;
    const ty = cam.y;
    cam.x = save0;
    cam.y = save1;
    cam.isMoving = true;
    moveHandle = tweens.to(cam, { x: tx, y: ty }, dur, {
      ease: getEase(ease || 'inOut'),
      onDone: () => {
        moveHandle = null;
        cam.isMoving = false;
      },
    });
    return moveHandle;
  }

  /**
   * Follows a target ({x, y}) with exponential smoothing; null stops following.
   * @param {{x:number,y:number}|null} target
   * @param {{lerp?: number}} [opts] fraction per 60 Hz frame (0..1)
   */
  function follow(target, opts) {
    followTarget = target && Number.isFinite(target.x) && Number.isFinite(target.y) ? target : null;
    const l = opts && opts.lerp;
    followLerp = l > 0 && l <= 1 ? l : FOLLOW_LERP;
  }

  /**
   * Adds shake trauma. amp = max offset in screen px; dur = seconds to fully decay.
   */
  function shake(amp, dur) {
    if (!(amp > 0)) return;
    const d = dur > 0 ? dur : 0.4;
    // Stacked hits keep the stronger amplitude and the longer tail so they feel bigger, not shorter.
    if (cam.trauma > 0) {
      shakeAmp = Math.max(shakeAmp, amp);
      shakeDur = Math.max(shakeDur, d);
    } else {
      shakeAmp = amp;
      shakeDur = d;
      shakeT = 0;
    }
    cam.trauma = Math.min(1, cam.trauma + 0.6);
  }

  /** Adds a recoil-style offset (screen px) that damps back to zero. */
  function kick(dx, dy) {
    if (Number.isFinite(dx)) kickX += dx;
    if (Number.isFinite(dy)) kickY += dy;
  }

  /** Steps inertia, following, spring-back and shake by dt seconds. */
  function update(dt) {
    if (!(dt > 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    if (pinTimer > 0) pinTimer -= dt;

    const hasBounds = !!cam.bounds;
    let outside = false;
    if (hasBounds) {
      limits();
      outside = cam.x < lim.x0 || cam.x > lim.x1 || cam.y < lim.y0 || cam.y > lim.y1;
    }

    if (!cam.isMoving && followTarget) {
      const k = 1 - Math.pow(1 - followLerp, dt * 60);
      cam.x += (followTarget.x - cam.x) * k;
      cam.y += (followTarget.y - cam.y) * k;
      if (hasBounds) clampHard();
    } else if (cam.vx !== 0 || cam.vy !== 0) {
      cam.x += cam.vx * dt;
      cam.y += cam.vy * dt;
      const decay = Math.exp(-(outside ? FLING_DECAY_OUTSIDE : FLING_DECAY) * dt);
      cam.vx *= decay;
      cam.vy *= decay;
      if (Math.abs(cam.vx) < FLING_STOP) cam.vx = 0;
      if (Math.abs(cam.vy) < FLING_STOP) cam.vy = 0;
      if (hasBounds) {
        // Never glide further than the rubber limit.
        const maxOver = RUBBER_PX / cam.zoom;
        if (cam.x < lim.x0 - maxOver) cam.x = lim.x0 - maxOver;
        else if (cam.x > lim.x1 + maxOver) cam.x = lim.x1 + maxOver;
        if (cam.y < lim.y0 - maxOver) cam.y = lim.y0 - maxOver;
        else if (cam.y > lim.y1 + maxOver) cam.y = lim.y1 + maxOver;
      }
    }

    if (hasBounds && !cam.isMoving && pinTimer <= 0) {
      // Spring back toward the nearest legal centre.
      const k = 1 - Math.exp(-SPRING_RATE * dt);
      if (cam.x < lim.x0) cam.x += (lim.x0 - cam.x) * k;
      else if (cam.x > lim.x1) cam.x += (lim.x1 - cam.x) * k;
      if (cam.y < lim.y0) cam.y += (lim.y0 - cam.y) * k;
      else if (cam.y > lim.y1) cam.y += (lim.y1 - cam.y) * k;
      if (Math.abs(cam.x - lim.x0) < 0.05) cam.x = lim.x0;
      else if (Math.abs(cam.x - lim.x1) < 0.05) cam.x = lim.x1;
      if (Math.abs(cam.y - lim.y0) < 0.05) cam.y = lim.y0;
      else if (Math.abs(cam.y - lim.y1) < 0.05) cam.y = lim.y1;
    }

    updateOffsets(dt);
  }

  return cam;
}
