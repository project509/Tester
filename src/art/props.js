/**
 * art/props.js — Procedural pixel props: containers, street kit, camp gear and Hold furniture.
 *
 * Every prop is painted at unit resolution from a definition (size, painter
 * routine, optional animation frames and glow layer), wrapped in a 1px ink
 * outline, hue-shifted ramps (cool shadows, warm lights) and cached. A glow
 * variant (`name + '_glow'`) holds only the emissive pixels of lamps, flames,
 * screens and LEDs at the same size and anchor as its base prop, so it overlays
 * exactly in the emissive layer. Electric glows go dark with `{ on: false }`;
 * flames never do. Proportions are relative to a 20×32 survivor.
 *
 * Public API:
 *   PROPS                                  every prop name (incl. *_glow variants)
 *   ANIMATED                               names that makePropAnim animates
 *   ZONE_KITS                              { suburbs, mall, hospital, forest, depot } → six kit names each
 *   makeProp(name, seed, { on = true, frame = 0 }?) → spr   bottom-centre anchor; unknown → 'crate'
 *   makePropAnim(name, seed, { on }?) → { frames, fps, loop }
 *   hasGlow(name) → boolean                glowKind(name) → 'electric' | 'flame' | null
 *   propSize(name) → { w, h }              outer size incl. the outline
 */

import { PAL, ramp } from './palette.js';
import { makeNoise } from './noise.js';
import { makeSprite, cached, anim } from './sprite.js';
import { makeRng } from '../core/rng.js';

const INK = PAL.ink;
const R5 = (hex) => ramp(hex, 5);

/** Material ramps (shadow → light, 5 steps): index 2 is the body colour, 4 the single highlight. */
const M = Object.freeze({
  wood: PAL.wood, woodP: PAL.woodPale, metal: PAL.metal, metalD: PAL.metalDark, conc: PAL.concrete,
  rust: PAL.rust, blood: PAL.blood, bloodD: PAL.bloodDry, glass: PAL.glass, veg: PAL.vegetation,
  moss: PAL.moss, fire: PAL.fire, bone: PAL.bone, sand: PAL.sand, smoke: PAL.smoke, brick: PAL.brick,
  olive: R5('#5f6b4c'), white: R5('#cfd3d0'), red: R5('#a83232'), canvas: R5('#8a7a62'),
  navy: R5('#3e4a5c'), yellow: R5('#c9a63a'), teal: R5('#2f7f7a'), cloth: R5('#4a3b3d'),
  plastic: R5('#6b7f8e'), bark: R5('#5c4a3e'), pine: R5('#3f5f3f'), leaf: R5('#4f7a3f'),
  tarp: R5('#3b6b6b'), paper: R5(PAL.paper), amber: R5(PAL.base.amber), ivory: R5('#e8e2cf'),
  fur: R5('#6b5a48'), tyre: R5('#2e2d33'), asphalt: R5('#4a4a50'), water: R5('#3f7fb0'),
});

/** Emissive colours. */
const GLOW = Object.freeze({
  bulb: '#fff1c4', bulbRim: '#ffb347', sodium: '#ffc46b', neon: '#ff6a8a', neonPink: '#ff9ac0',
  screen: '#9ad8ff', screenDim: '#5f9fc8', ledR: '#ff3b2e', ledG: '#6fbf73', ledA: '#ffd84f',
  tube: '#dfffee', tubeDim: '#9fd8bb', ember: PAL.fire[2], flame: PAL.fire[3], flameHi: PAL.fire[5],
  coal: '#ff8a2a', moon: '#8fd3e8',
});

/** "Off" colours for dark bulbs, screens and LEDs. */
const OFF = Object.freeze({ bulb: '#8a8378', glass: '#3a3f4a', led: '#4a2a2a', tube: '#7a8a80' });

/** Car body colours picked per seed. */
const CAR_PAINT = Object.freeze(['#7a3b2e', '#3e4a5c', '#8c8378', '#5a6d6b', '#b8965a', '#2a2d33', '#6b4a4e', '#9a9382'].map(R5));

/** 3×5 glyphs for stencils and signs. */
const FONT = Object.freeze({
  A: ['.#.', '#.#', '###', '#.#', '#.#'], C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'], G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'], I: ['###', '.#.', '.#.', '.#.', '###'], L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'], O: ['###', '#.#', '#.#', '#.#', '###'],
  P: ['##.', '#.#', '##.', '#..', '#..'], R: ['##.', '#.#', '##.', '#.#', '#.#'], S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'], U: ['#.#', '#.#', '#.#', '#.#', '###'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'], '2': ['##.', '..#', '.#.', '#..', '###'], '7': ['###', '..#', '.#.', '.#.', '.#.'],
});

// ───────────────────────────── painter helpers ─────────────────────────────

/**
 * A painter view translated by (dx, dy) so prop routines draw in content coordinates.
 * @param {object} p painter from makeSprite
 * @param {number} dx @param {number} dy @param {number} w @param {number} h
 */
function shifted(p, dx, dy, w, h) {
  return {
    w, h,
    set: (x, y, c, a) => p.set(x + dx, y + dy, c, a),
    get: (x, y) => p.get(x + dx, y + dy),
    rect: (x, y, rw, rh, c, a) => p.rect(x + dx, y + dy, rw, rh, c, a),
    frame: (x, y, rw, rh, c) => p.frame(x + dx, y + dy, rw, rh, c),
    line: (x0, y0, x1, y1, c) => p.line(x0 + dx, y0 + dy, x1 + dx, y1 + dy, c),
    ellipse: (cx, cy, rx, ry, c) => p.ellipse(cx + dx, cy + dy, rx, ry, c),
    fillCircle: (cx, cy, r, c) => p.fillCircle(cx + dx, cy + dy, r, c),
    ring: (cx, cy, r, c) => p.ring(cx + dx, cy + dy, r, c),
    dither: (x, y, rw, rh, a, b, t) => p.dither(x + dx, y + dy, rw, rh, a, b, t),
    noise: (rng, x, y, rw, rh, c, d, a) => p.noise(rng, x + dx, y + dy, rw, rh, c, d, a),
    shade: (x, y, rw, rh, amt) => p.shade(x + dx, y + dy, rw, rh, amt),
    blit: (spr, x, y, o) => p.blit(spr, x + dx, y + dy, o),
    erase: (x, y, rw, rh) => {
      for (let yy = 0; yy < rh; yy++) for (let xx = 0; xx < rw; xx++) {
        const px = x + dx + xx;
        const py = y + dy + yy;
        if (px >= 0 && py >= 0 && px < p.w && py < p.h) p.data[(py * p.w + px) * 4 + 3] = 0;
      }
    },
  };
}

/** Bevelled box: body, light top/left, shadow bottom/right, one highlight pixel. */
function box(q, x, y, w, h, R) {
  q.rect(x, y, w, h, R[2]);
  q.rect(x, y, w, 1, R[3]);
  q.rect(x, y, 1, h, R[3]);
  q.rect(x, y + h - 1, w, 1, R[1]);
  q.rect(x + w - 1, y, 1, h, R[1]);
  q.set(x, y, R[4]);
}

/** Inset panel (reverse bevel) for doors, drawers and recesses. */
function inset(q, x, y, w, h, R) {
  q.rect(x, y, w, h, R[1]);
  q.rect(x, y, w, 1, R[0]);
  q.rect(x, y, 1, h, R[0]);
  q.rect(x, y + h - 1, w, 1, R[3]);
  q.rect(x + w - 1, y, 1, h, R[3]);
}

/** Vertical cylinder: light band left of centre, shadow on the right. */
function cyl(q, x, y, w, h, R, hi) {
  for (let i = 0; i < w; i++) {
    const t = (i + 0.5) / w;
    const k = t < 0.1 ? 1 : t < 0.42 ? 3 : t < 0.7 ? 2 : t < 0.88 ? 1 : 0;
    q.rect(x + i, y, 1, h, R[k]);
  }
  if (hi) q.rect(x + Math.max(1, Math.round(w * 0.22)), y, 1, h, R[4]);
}

/** Horizontal cylinder (pipe, log): light band near the top, shadow at the bottom. */
function hcyl(q, x, y, w, h, R) {
  for (let j = 0; j < h; j++) {
    const t = (j + 0.5) / h;
    const k = t < 0.12 ? 1 : t < 0.4 ? 3 : t < 0.68 ? 2 : t < 0.88 ? 1 : 0;
    q.rect(x, y + j, w, 1, R[k]);
  }
}

/** n horizontal planks with dark seams and a light top edge each. */
function planks(q, x, y, w, h, R, n) {
  const ph = h / n;
  for (let i = 0; i < n; i++) {
    const y0 = Math.round(y + i * ph);
    const y1 = Math.round(y + (i + 1) * ph);
    q.rect(x, y0, w, y1 - y0, R[2]);
    q.rect(x, y0, w, 1, R[3]);
    q.rect(x, y1 - 1, w, 1, R[0]);
  }
}

/** Rounded bag/cushion with a highlight on top. */
function bag(q, x, y, w, h, R) {
  q.rect(x + 1, y, w - 2, h, R[2]);
  q.rect(x, y + 1, w, h - 2, R[2]);
  q.rect(x + 1, y, w - 2, 1, R[3]);
  q.rect(x + 1, y + h - 1, w - 2, 1, R[1]);
  q.rect(x + w - 1, y + 1, 1, h - 2, R[1]);
  q.set(x + 2, y + 1, R[4]);
}

/** Stencil text in the 3×5 font (unknown glyphs are skipped, spaces advance). */
function text(q, str, x, y, c, s) {
  const k = s || 1;
  let cx = x;
  for (let i = 0; i < str.length; i++) {
    const g = FONT[str[i]];
    if (g) {
      for (let r = 0; r < 5; r++) for (let cc = 0; cc < 3; cc++) if (g[r][cc] === '#') q.rect(cx + cc * k, y + r * k, k, k, c);
    }
    cx += 4 * k;
  }
}

/** Width of stencil text. */
function textW(str, s) {
  return str.length * 4 * (s || 1) - (s || 1);
}

/** Paints a lit surface: full colour when on, dark when off; only when on in the glow pass. */
function lit(q, o, x, y, w, h, onC, offC) {
  if (o.glow) {
    if (o.on) q.rect(x, y, w, h, onC);
    return;
  }
  q.rect(x, y, w, h, o.on ? onC : offC);
}

/** Single lit pixel (LED). */
function led(q, o, x, y, onC) {
  lit(q, o, x, y, 1, 1, onC, OFF.led);
}

/**
 * Tapered flame tongue: base width `w` at (x, y+h-1) narrowing to a 1px tip, ember
 * edges around a pale core, with a per-frame wobble. Works for body and glow passes.
 */
function flame(q, x, y, h, f, w) {
  const F = M.fire;
  for (let j = 0; j < h; j++) {
    const t = j / h;
    const ww = Math.max(1, Math.round(w * Math.pow(1 - t, 0.8)));
    const wob = t > 0.45 ? (((j + f) & 1) ? 1 : 0) - (f & 1) : 0;
    const left = x + wob - (ww >> 1);
    const yy = y + h - 1 - j;
    q.rect(left, yy, ww, 1, t < 0.3 ? F[4] : t < 0.62 ? F[3] : F[2]);
    if (ww >= 3) q.rect(left + 1, yy, ww - 2, 1, t < 0.35 ? F[5] : t < 0.7 ? F[4] : F[3]);
  }
}

/** Clumpy rust: a few blobs with drips, instead of speckle noise. */
function rustPatch(q, rng, x, y, w, h, n) {
  for (let i = 0; i < n; i++) {
    const cx = x + rng.int(1, Math.max(1, w - 2));
    const cy = y + rng.int(1, Math.max(1, h - 2));
    const rx = rng.int(1, 3);
    const ry = rng.int(1, 2);
    q.ellipse(cx, cy, rx + 1, ry + 1, M.rust[1]);
    q.ellipse(cx, cy, rx, ry, M.rust[2]);
    q.set(cx, cy - 1, M.rust[3]);
    const drip = rng.int(0, 4);
    if (drip) q.rect(cx + rng.int(-1, 1), cy + ry, 1, drip, M.rust[1]);
  }
}

/** Foliage canopy: noise-clumped leaf colours, shadowed underside, sparse gaps. */
function canopy(q, rng, cx, cy, rx, ry, L) {
  const nz = makeNoise(rng.int(0, 1e9));
  for (let yy = Math.floor(cy - ry); yy <= Math.ceil(cy + ry); yy++) {
    for (let xx = Math.floor(cx - rx); xx <= Math.ceil(cx + rx); xx++) {
      const dx = (xx + 0.5 - cx) / rx;
      const dy = (yy + 0.5 - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d > 1) continue;
      const edge = nz.fbm(xx * 0.35, yy * 0.35, 2);
      if (d > 0.72 && edge < 0.42) continue;
      const v = nz.fbm(xx * 0.22 + 3.1, yy * 0.22, 3) + (0.5 - dy) * 0.28 - dx * 0.08;
      q.set(xx, yy, v < 0.36 ? L[0] : v < 0.5 ? L[1] : v < 0.66 ? L[2] : v < 0.8 ? L[3] : L[4]);
    }
  }
}

/** Shared wheel: tyre ring, rim, hub. */
function wheel(q, cx, cy, r, R) {
  q.fillCircle(cx, cy, r, M.tyre[2]);
  q.ring(cx, cy, r, M.tyre[0]);
  q.fillCircle(cx, cy, r - 2, R ? R[2] : M.metal[2]);
  q.ring(cx, cy, r - 2, R ? R[1] : M.metal[1]);
  q.set(cx - 1, cy - 1, R ? R[4] : M.metal[4]);
  q.set(cx, cy, M.tyre[0]);
}

/** Broken glass: dark pane with a few bright shards. */
function shatter(q, rng, x, y, w, h) {
  q.rect(x, y, w, h, '#1e2028');
  const n = Math.max(2, (w * h) >> 4);
  for (let i = 0; i < n; i++) q.set(x + rng.int(0, w - 1), y + rng.int(0, h - 1), M.glass[3]);
  q.line(x, y + h - 1, x + (w >> 1), y, M.glass[4]);
}

/** A rifle lying along +x. */
function rifle(q, x, y, len, dir) {
  const d = dir < 0 ? -1 : 1;
  q.rect(dir < 0 ? x - len : x, y, len, 1, M.metalD[1]);
  q.rect(dir < 0 ? x - len : x, y + 1, len, 1, M.wood[1]);
  q.rect(x + d * (len >> 2), y - 1, 3, 1, M.metalD[2]);
  q.rect(x + (d < 0 ? -3 : 0), y + 2, 4, 2, M.wood[2]);
}

/** Generic corpse body; searched = jacket open, pockets out, wider pool. */
function corpseBody(q, rng, searched) {
  const skin = PAL.skin[rng.int(0, PAL.skin.length - 1)];
  const cloth = PAL.clothMuted[rng.int(0, PAL.clothMuted.length - 1)];
  const pants = PAL.clothMuted[rng.int(0, PAL.clothMuted.length - 1)];
  const hair = PAL.hair[rng.int(0, PAL.hair.length - 1)];
  const pw = searched ? 14 : 10;
  q.ellipse(14, 12, pw, 2.2, M.blood[1]);
  q.ellipse(15, 12, pw - 4, 1.6, M.blood[2]);
  // legs (left), torso, head (right)
  q.rect(0, 7, 10, 4, pants[1]);
  q.rect(0, 6, 10, 1, pants[2]);
  q.rect(0, 9, 3, 3, M.cloth[1]);
  q.rect(9, 4, 12, 8, cloth[1]);
  q.rect(9, 4, 12, 2, cloth[2]);
  if (searched) {
    q.rect(13, 5, 5, 6, cloth[0]);
    q.rect(14, 6, 2, 3, M.ivory[2]);
    q.rect(12, 11, 2, 2, M.paper[2]);
    q.rect(4, 11, 3, 1, M.paper[1]);
  }
  q.rect(20, 6, 3, 5, cloth[1]);
  q.rect(searched ? 24 : 21, searched ? 10 : 9, searched ? 5 : 3, 2, skin[1]);
  q.rect(23, 3, 7, 7, skin[1]);
  q.rect(23, 3, 7, 2, skin[2]);
  q.rect(24, 2, 6, 2, hair[1]);
  q.rect(29, 3, 2, 4, hair[0]);
  q.set(25, 6, INK);
  q.set(27, 6, INK);
  q.rect(9, 12, 12, 1, cloth[0]);
}

// ───────────────────────────── definitions ─────────────────────────────

/**
 * Prop definitions: { w, h, draw(q, rng, o), frames?, fps?, glow?: 'electric'|'flame' }.
 * `o` = { f: frame index, on: powered, glow: painting the emissive layer }. Routines must
 * consume the rng identically for every frame (frame-only noise uses rng.fork).
 */
const DEFS = {
  // ── containers ──
  cupboard: { w: 20, h: 28, draw(q, rng) {
    box(q, 0, 2, 20, 26, M.wood);
    q.rect(0, 0, 20, 3, M.woodP[2]);
    q.rect(0, 0, 20, 1, M.woodP[3]);
    q.rect(0, 25, 20, 3, M.wood[0]);
    inset(q, 2, 5, 8, 19, M.wood);
    inset(q, 10, 5, 8, 19, M.wood);
    q.rect(9, 5, 2, 19, M.wood[0]);
    q.rect(4, 7, 4, 15, M.wood[2]);
    q.rect(12, 7, 4, 15, M.wood[2]);
    q.rect(4, 7, 4, 1, M.wood[3]);
    q.rect(12, 7, 4, 1, M.wood[3]);
    q.rect(7, 13, 1, 4, M.metal[4]);
    q.rect(12, 13, 1, 4, M.metal[4]);
    q.noise(rng, 0, 3, 20, 22, M.wood[1], 0.06);
  } },
  cupboard_open: { w: 20, h: 28, draw(q, rng) {
    box(q, 0, 2, 20, 26, M.wood);
    q.rect(0, 0, 20, 3, M.woodP[2]);
    q.rect(0, 0, 20, 1, M.woodP[3]);
    q.rect(0, 25, 20, 3, M.wood[0]);
    q.rect(2, 5, 16, 18, '#221c22');
    q.rect(2, 13, 16, 1, M.wood[1]);
    q.rect(4, 10, 3, 3, M.red[2]);
    q.rect(9, 9, 2, 4, M.metal[2]);
    q.rect(5, 19, 4, 4, M.paper[1]);
    q.rect(1, 4, 3, 20, M.wood[2]);
    q.rect(1, 4, 1, 20, M.wood[3]);
    q.rect(3, 4, 1, 20, M.wood[0]);
    q.rect(17, 4, 3, 20, M.wood[1]);
    q.rect(19, 4, 1, 20, M.wood[0]);
    q.noise(rng, 0, 3, 20, 22, M.wood[1], 0.05);
  } },
  locker: { w: 14, h: 36, draw(q, rng) {
    box(q, 0, 0, 14, 36, M.metalD);
    inset(q, 2, 2, 10, 32, M.metalD);
    for (let i = 0; i < 3; i++) q.rect(4, 5 + i * 2, 6, 1, M.metalD[0]);
    q.rect(4, 16, 6, 3, M.metal[1]);
    q.rect(9, 22, 2, 4, M.metal[3]);
    q.set(9, 22, M.metal[4]);
    rustPatch(q, rng, 2, 22, 10, 10, 2);
    q.rect(0, 34, 14, 2, M.metalD[0]);
  } },
  locker_open: { w: 22, h: 36, draw(q, rng) {
    box(q, 8, 0, 14, 36, M.metalD);
    q.rect(10, 2, 10, 32, '#1b1a22');
    q.rect(10, 6, 10, 1, M.metalD[2]);
    q.rect(15, 7, 1, 2, M.metal[2]);
    q.rect(13, 8, 5, 12, M.olive[1]);
    q.rect(13, 8, 5, 1, M.olive[2]);
    q.rect(12, 28, 6, 5, M.canvas[1]);
    q.rect(0, 1, 7, 34, M.metalD[2]);
    q.rect(0, 1, 1, 34, M.metalD[3]);
    q.rect(6, 1, 1, 34, M.metalD[0]);
    for (let i = 0; i < 3; i++) q.rect(2, 5 + i * 2, 3, 1, M.metalD[0]);
    q.rect(4, 16, 2, 3, M.metal[1]);
    rustPatch(q, rng, 1, 22, 5, 10, 1);
    q.rect(8, 34, 14, 2, M.metalD[0]);
  } },
  crate: { w: 22, h: 18, draw(q, rng) {
    planks(q, 0, 0, 22, 18, M.wood, 3);
    q.rect(0, 0, 3, 18, M.wood[1]);
    q.rect(19, 0, 3, 18, M.wood[1]);
    q.rect(0, 0, 1, 18, M.wood[3]);
    q.rect(21, 0, 1, 18, M.wood[0]);
    q.set(1, 2, M.metal[3]); q.set(20, 2, M.metal[3]); q.set(1, 15, M.metal[3]); q.set(20, 15, M.metal[3]);
    q.rect(7, 7, 8, 4, M.bone[2]);
    q.rect(8, 8, 6, 1, M.wood[0]);
    q.rect(8, 10, 4, 1, M.wood[0]);
    q.noise(rng, 3, 0, 16, 18, M.wood[1], 0.08);
  } },
  crate_open: { w: 24, h: 22, draw(q, rng) {
    q.rect(2, 4, 22, 18, M.wood[2]);
    q.rect(2, 4, 22, 1, M.wood[3]);
    q.rect(2, 21, 22, 1, M.wood[0]);
    q.rect(2, 12, 22, 1, M.wood[0]);
    q.rect(2, 4, 3, 18, M.wood[1]);
    q.rect(21, 4, 3, 18, M.wood[1]);
    q.rect(4, 5, 16, 5, '#221c22');
    q.dither(5, 7, 14, 3, M.sand[2], M.sand[1], 0.5);
    q.rect(9, 6, 4, 3, M.metal[2]);
    q.noise(rng, 5, 4, 14, 18, M.wood[1], 0.08);
    // lid leaning against the left side
    for (let i = 0; i < 8; i++) q.rect(i, 8 - i, 2, 1, i & 1 ? M.wood[3] : M.wood[2]);
    q.rect(0, 8, 1, 14, M.wood[2]);
    q.rect(1, 9, 1, 12, M.wood[1]);
  } },
  cabinet: { w: 18, h: 30, draw(q, rng) {
    box(q, 0, 0, 18, 30, M.white);
    q.rect(0, 0, 18, 3, M.white[1]);
    q.rect(7, 1, 4, 1, M.red[2]); q.rect(8, 0, 2, 3, M.red[2]);
    inset(q, 2, 5, 14, 22, M.white);
    q.rect(3, 6, 12, 20, M.glass[1]);
    q.rect(3, 12, 12, 1, M.white[1]);
    q.rect(3, 19, 12, 1, M.white[1]);
    q.rect(5, 8, 2, 4, M.teal[2]); q.rect(9, 9, 2, 3, M.red[2]); q.rect(12, 8, 2, 4, M.ivory[2]);
    q.rect(5, 15, 3, 4, M.paper[2]); q.rect(10, 16, 2, 3, M.teal[3]);
    q.rect(4, 21, 8, 4, M.ivory[1]);
    q.line(3, 25, 14, 7, M.glass[4]);
    q.rect(14, 15, 1, 3, M.metal[3]);
    rustPatch(q, rng, 2, 25, 14, 3, 1);
    q.rect(0, 28, 18, 2, M.white[1]);
  } },
  cabinet_open: { w: 22, h: 30, draw(q, rng) {
    box(q, 4, 0, 18, 30, M.white);
    q.rect(4, 0, 18, 3, M.white[1]);
    q.rect(11, 1, 4, 1, M.red[2]); q.rect(12, 0, 2, 3, M.red[2]);
    q.rect(6, 5, 14, 22, '#2a2e33');
    q.rect(6, 12, 14, 1, M.white[1]);
    q.rect(6, 19, 14, 1, M.white[1]);
    q.rect(9, 9, 2, 3, M.red[2]); q.rect(15, 16, 3, 3, M.paper[1]);
    q.rect(7, 24, 5, 3, M.ivory[1]);
    q.rect(0, 4, 5, 24, M.white[2]);
    q.rect(0, 4, 1, 24, M.white[3]);
    q.rect(4, 4, 1, 24, M.white[0]);
    q.rect(1, 6, 3, 20, M.glass[1]);
    q.line(1, 24, 3, 8, M.glass[4]);
    rustPatch(q, rng, 6, 25, 14, 3, 1);
    q.rect(4, 28, 18, 2, M.white[1]);
  } },
  corpse: { w: 32, h: 14, draw(q, rng) { corpseBody(q, rng, false); } },
  corpse_searched: { w: 32, h: 14, draw(q, rng) { corpseBody(q, rng, true); } },

  // ── street / zone kit ──
  car: { w: 64, h: 26, draw(q, rng) {
    const P = CAR_PAINT[rng.int(0, CAR_PAINT.length - 1)];
    q.rect(2, 12, 60, 9, P[2]);
    q.rect(2, 12, 60, 1, P[3]);
    q.rect(2, 19, 60, 2, P[1]);
    q.rect(4, 20, 56, 1, P[0]);
    for (let i = 0; i < 6; i++) q.rect(6 + i * 2, 12 - i, 2, i + 1, P[2]);
    q.rect(10, 6, 2, 6, P[3]);
    q.rect(18, 4, 28, 8, P[2]);
    q.rect(18, 4, 28, 1, P[3]);
    for (let i = 0; i < 5; i++) q.rect(46 + i * 2, 4 + i, 2, 8 - i, P[2]);
    q.rect(20, 5, 10, 6, M.glass[2]);
    q.rect(31, 5, 12, 6, M.glass[2]);
    q.rect(46, 6, 5, 5, M.glass[1]);
    q.line(20, 10, 25, 5, M.glass[4]);
    q.line(31, 10, 36, 5, M.glass[4]);
    q.rect(30, 5, 1, 7, P[0]);
    q.rect(34, 12, 1, 8, P[0]);
    q.rect(36, 14, 4, 1, M.metal[3]);
    q.rect(3, 13, 2, 3, M.amber[3]);
    q.rect(60, 13, 2, 3, M.red[2]);
    q.rect(0, 17, 4, 3, M.metal[1]);
    q.rect(60, 17, 4, 3, M.metal[1]);
    wheel(q, 14, 20, 5, M.metal);
    wheel(q, 50, 20, 5, M.metal);
    q.noise(rng, 2, 16, 60, 5, P[1], 0.2);
  } },
  car_wreck: { w: 64, h: 26, draw(q, rng) {
    const P = M.rust;
    const S = M.smoke;
    q.rect(2, 13, 60, 8, S[1]);
    q.rect(2, 13, 60, 1, S[2]);
    q.rect(2, 20, 60, 1, S[0]);
    q.dither(2, 14, 60, 6, S[1], P[1], 0.45);
    for (let i = 0; i < 6; i++) q.rect(6 + i * 2, 13 - i, 2, i + 1, S[1]);
    q.rect(18, 6, 28, 7, S[1]);
    q.rect(18, 6, 28, 1, S[2]);
    for (let i = 0; i < 5; i++) q.rect(46 + i * 2, 6 + i, 2, 7 - i, S[1]);
    shatter(q, rng, 20, 7, 10, 5);
    shatter(q, rng, 31, 7, 12, 5);
    // popped bonnet
    for (let i = 0; i < 9; i++) q.rect(2 + i, 10 - i, 2, 1, i & 1 ? P[2] : S[2]);
    q.rect(3, 11, 12, 2, '#1b1a22');
    q.rect(30, 7, 1, 6, S[0]);
    q.rect(34, 13, 1, 8, S[0]);
    q.rect(0, 18, 4, 3, S[0]);
    q.rect(60, 18, 4, 3, P[1]);
    q.ellipse(14, 22, 6, 3, M.tyre[2]);
    q.rect(9, 20, 10, 1, M.tyre[3]);
    q.ellipse(50, 22, 6, 3, M.tyre[2]);
    q.rect(45, 20, 10, 1, M.tyre[3]);
    q.fillCircle(14, 20, 2, M.metal[1]);
    q.fillCircle(50, 20, 2, M.metal[1]);
    q.dither(18, 6, 28, 3, S[0], S[1], 0.5);
    rustPatch(q, rng, 36, 13, 24, 6, 3);
    rustPatch(q, rng, 4, 14, 12, 5, 1);
    q.rect(3, 14, 2, 3, '#1b1a22');
    q.noise(rng, 2, 6, 60, 15, S[0], 0.05);
  } },
  truck: { w: 64, h: 40, draw(q, rng) {
    const P = M.ivory;
    box(q, 0, 2, 44, 30, P);
    q.rect(0, 2, 44, 2, P[1]);
    q.rect(2, 14, 40, 3, M.teal[2]);
    q.rect(2, 14, 40, 1, M.teal[3]);
    q.rect(3, 6, 1, 26, P[1]);
    for (let i = 1; i < 4; i++) q.rect(i * 11, 4, 1, 28, P[1]);
    q.rect(42, 4, 2, 28, P[1]);
    rustPatch(q, rng, 2, 20, 40, 10, 3);
    q.rect(0, 30, 44, 2, P[0]);
    const C = M.navy;
    q.rect(44, 14, 20, 18, C[2]);
    q.rect(44, 14, 20, 1, C[3]);
    for (let i = 0; i < 4; i++) q.rect(56 + i * 2, 20 + i, 2, 12 - i, C[2]);
    q.rect(46, 16, 10, 8, M.glass[2]);
    q.line(46, 23, 52, 16, M.glass[4]);
    q.rect(57, 20, 6, 1, C[3]);
    q.rect(58, 24, 3, 3, M.amber[3]);
    q.rect(44, 30, 20, 2, C[0]);
    q.rect(0, 32, 64, 2, M.metalD[1]);
    q.rect(60, 29, 4, 4, M.metal[1]);
    wheel(q, 11, 34, 6, M.metalD);
    wheel(q, 25, 34, 6, M.metalD);
    wheel(q, 53, 34, 6, M.metalD);
    q.rect(62, 22, 2, 5, M.metal[2]);
  } },
  barrel: { w: 14, h: 20, draw(q, rng) {
    cyl(q, 0, 0, 14, 20, M.metalD, true);
    q.rect(0, 0, 14, 2, M.metalD[3]);
    q.rect(1, 0, 12, 1, M.metalD[4]);
    q.rect(0, 6, 14, 1, M.metalD[0]);
    q.rect(0, 13, 14, 1, M.metalD[0]);
    q.rect(0, 19, 14, 1, M.metalD[0]);
    rustPatch(q, rng, 1, 3, 12, 15, 2);
    q.noise(rng, 0, 14, 14, 6, M.rust[1], 0.1);
  } },
  barrel_fire: { w: 16, h: 28, frames: 2, fps: 6, glow: 'flame', draw(q, rng, o) {
    const f = o.f;
    if (!o.glow) {
      cyl(q, 1, 8, 14, 20, M.metalD, true);
      q.rect(1, 8, 14, 2, M.metalD[3]);
      q.rect(1, 14, 14, 1, M.metalD[0]);
      q.rect(1, 21, 14, 1, M.metalD[0]);
      q.rect(1, 27, 14, 1, M.metalD[0]);
      rustPatch(q, rng, 2, 11, 12, 14, 2);
      q.rect(2, 9, 12, 1, '#2a1208');
    }
    lit(q, o, 4, 16, 2, 2, GLOW.coal, INK);
    lit(q, o, 10, 18, 2, 2, GLOW.coal, INK);
    lit(q, o, 7, 23, 2, 1, GLOW.ember, INK);
    lit(q, o, 3, 9, 10, 1, M.fire[3], M.fire[1]);
    flame(q, 8, 0 + (f & 1), 10 - (f & 1), f, 8);
    flame(q, 5, 4, 6 + (f & 1), f + 1, 4);
    flame(q, 11, 3 - (f & 1), 6 + (f & 1), f, 4);
  } },
  tire: { w: 12, h: 12, draw(q) {
    q.fillCircle(6, 6, 6, M.tyre[2]);
    q.ring(6, 6, 5, M.tyre[3]);
    q.fillCircle(6, 6, 3, M.tyre[1]);
    q.fillCircle(6, 6, 2, '#1b1a22');
    q.set(4, 3, M.tyre[4]);
    q.rect(0, 11, 12, 1, M.tyre[0]);
  } },
  sandbags: { w: 28, h: 12, draw(q, rng) {
    const R = M.canvas;
    bag(q, 0, 6, 10, 6, R); bag(q, 9, 6, 10, 6, R); bag(q, 18, 6, 10, 6, R);
    bag(q, 4, 1, 10, 6, R); bag(q, 14, 1, 10, 6, R);
    q.noise(rng, 0, 0, 28, 12, R[1], 0.12);
    q.rect(9, 8, 1, 3, R[0]); q.rect(18, 8, 1, 3, R[0]); q.rect(14, 3, 1, 3, R[0]);
  } },
  sandbag_wall: { w: 32, h: 20, draw(q, rng) {
    const R = M.canvas;
    for (let row = 0; row < 4; row++) {
      const y = 15 - row * 5;
      const off = row & 1 ? 5 : 0;
      for (let x = off - 5; x < 32; x += 10) {
        const x0 = Math.max(0, x);
        const w = Math.min(32, x + 10) - x0;
        if (w > 2) bag(q, x0, y, w, 6, R);
      }
    }
    q.noise(rng, 0, 0, 32, 20, R[1], 0.14);
    q.noise(rng, 0, 12, 32, 8, R[0], 0.08);
  } },
  fence: { w: 32, h: 22, draw(q, rng) {
    q.rect(0, 1, 32, 1, M.metal[2]);
    for (let y = 2; y < 20; y++) for (let x = 2; x < 30; x++) if (((x + y) % 4 === 0) || ((x - y + 40) % 4 === 0)) q.set(x, y, M.metal[1]);
    q.rect(0, 0, 2, 22, M.metalD[2]); q.rect(0, 0, 1, 22, M.metalD[3]);
    q.rect(30, 0, 2, 22, M.metalD[2]); q.rect(30, 0, 1, 22, M.metalD[3]);
    q.rect(0, 20, 32, 1, M.metal[1]);
    q.rect(0, 21, 32, 1, M.metalD[0]);
    q.rect(3, 19, 5, 2, M.veg[1]); q.rect(20, 18, 7, 3, M.veg[1]); q.set(22, 17, M.veg[2]);
    q.noise(rng, 2, 2, 28, 18, M.rust[2], 0.04);
  } },
  fence_broken: { w: 32, h: 22, draw(q, rng) {
    q.rect(0, 1, 18, 1, M.metal[2]);
    for (let y = 2; y < 20; y++) for (let x = 2; x < 30; x++) {
      const inHole = x > 12 && x < 26 && y > 6 && y < 18;
      if (inHole) continue;
      if (((x + y) % 4 === 0) || ((x - y + 40) % 4 === 0)) q.set(x, y, M.metal[1]);
    }
    q.line(12, 7, 16, 13, M.metal[2]); q.line(25, 8, 22, 15, M.metal[2]); q.line(14, 17, 19, 14, M.metal[3]);
    q.rect(0, 0, 2, 22, M.metalD[2]); q.rect(0, 0, 1, 22, M.metalD[3]);
    for (let i = 0; i < 12; i++) q.rect(30 - i, 12 + i * 0.75, 2, 1, M.metalD[2]);
    q.rect(30, 12, 2, 10, M.metalD[2]);
    q.rect(0, 20, 32, 1, M.metal[1]);
    q.rect(0, 21, 32, 1, M.metalD[0]);
    q.rect(3, 19, 5, 2, M.veg[1]);
    q.noise(rng, 2, 2, 28, 18, M.rust[2], 0.08);
  } },
  hydrant: { w: 10, h: 16, draw(q) {
    const R = M.red;
    cyl(q, 2, 4, 6, 11, R, true);
    q.fillCircle(5, 3, 3, R[3]);
    q.rect(3, 1, 4, 1, R[4]);
    q.rect(2, 6, 6, 1, R[1]);
    q.rect(0, 8, 2, 3, R[2]); q.rect(8, 8, 2, 3, R[2]);
    q.set(0, 8, R[3]); q.set(8, 8, R[3]);
    q.rect(1, 14, 8, 2, R[1]);
    q.rect(1, 14, 8, 1, R[2]);
  } },
  streetlamp: { w: 18, h: 52, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(2, 4, 3, 46, M.metalD[2]);
      q.rect(2, 4, 1, 46, M.metalD[3]);
      q.rect(4, 4, 1, 46, M.metalD[0]);
      q.rect(0, 49, 7, 3, M.metalD[1]);
      q.rect(0, 49, 7, 1, M.metalD[3]);
      q.rect(2, 1, 12, 3, M.metalD[2]);
      q.rect(2, 1, 12, 1, M.metalD[3]);
      q.rect(8, 0, 10, 5, M.metalD[1]);
      q.rect(8, 0, 10, 1, M.metalD[3]);
      rustPatch(q, rng, 2, 30, 3, 16, 1);
    }
    lit(q, o, 9, 5, 8, 2, GLOW.sodium, OFF.glass);
    if (o.glow && o.on) q.rect(10, 7, 6, 1, GLOW.sodium, 0.5);
  } },
  sign: { w: 16, h: 30, draw(q, rng) {
    q.rect(7, 8, 2, 22, M.metalD[2]);
    q.rect(7, 8, 1, 22, M.metalD[3]);
    q.rect(0, 0, 16, 8, M.olive[2]);
    q.rect(0, 0, 16, 1, M.olive[3]);
    q.rect(0, 7, 16, 1, M.olive[0]);
    q.rect(0, 0, 1, 8, M.olive[3]);
    const words = ['ELM', 'ASH', 'RUE', 'MAIN', 'MILL', 'HILL'];
    const w = words[rng.int(0, words.length - 1)];
    text(q, w, Math.max(1, (16 - textW(w)) >> 1), 2, M.ivory[3]);
    q.rect(5, 12, 6, 5, M.red[2]);
    q.rect(5, 12, 6, 1, M.red[3]);
    q.noise(rng, 0, 0, 16, 8, M.olive[1], 0.1);
  } },
  sign_hospital: { w: 44, h: 16, draw(q, rng) {
    box(q, 0, 0, 44, 14, M.ivory);
    q.rect(2, 2, 10, 10, M.red[2]);
    q.rect(2, 2, 10, 1, M.red[3]);
    q.rect(6, 4, 2, 6, M.ivory[3]); q.rect(4, 6, 6, 2, M.ivory[3]);
    text(q, 'HOSPITAL', 13, 3, M.navy[1]);
    q.rect(13, 9, 30, 1, M.navy[1]);
    q.rect(0, 14, 44, 2, M.metalD[1]);
    rustPatch(q, rng, 14, 10, 28, 3, 1);
  } },
  sign_mall: { w: 48, h: 18, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      box(q, 0, 0, 48, 16, M.metalD);
      q.rect(2, 2, 44, 12, '#1b1a22');
      q.rect(0, 16, 48, 2, M.metalD[0]);
      rustPatch(q, rng, 2, 12, 44, 3, 2);
    }
    const letters = 'MALL';
    for (let i = 0; i < letters.length; i++) {
      const dead = i === 2;
      if (o.glow) { if (o.on && !dead) text(q, letters[i], 5 + i * 8, 3, GLOW.neon, 2); }
      else text(q, letters[i], 5 + i * 8, 3, o.on && !dead ? GLOW.neonPink : OFF.led, 2);
    }
    lit(q, o, 38, 5, 6, 2, GLOW.neon, OFF.led);
    lit(q, o, 40, 7, 4, 2, GLOW.neon, OFF.led);
    lit(q, o, 42, 9, 2, 2, GLOW.neon, OFF.led);
  } },
  bench: { w: 28, h: 14, draw(q, rng) {
    q.rect(2, 0, 24, 2, M.woodP[2]); q.rect(2, 0, 24, 1, M.woodP[3]);
    q.rect(2, 3, 24, 2, M.woodP[2]); q.rect(2, 3, 24, 1, M.woodP[3]);
    q.rect(0, 7, 28, 2, M.woodP[2]); q.rect(0, 7, 28, 1, M.woodP[3]);
    q.rect(0, 9, 28, 1, M.woodP[1]);
    q.rect(3, 0, 2, 9, M.metalD[1]); q.rect(23, 0, 2, 9, M.metalD[1]);
    q.rect(3, 9, 2, 5, M.metalD[2]); q.rect(23, 9, 2, 5, M.metalD[2]);
    q.rect(1, 12, 5, 1, M.metalD[1]); q.rect(22, 12, 5, 1, M.metalD[1]);
    q.noise(rng, 0, 0, 28, 9, M.woodP[1], 0.12);
  } },
  dumpster: { w: 36, h: 24, draw(q, rng) {
    const R = M.teal;
    box(q, 0, 6, 36, 15, R);
    q.rect(0, 6, 36, 2, R[1]);
    q.rect(2, 10, 32, 1, R[1]); q.rect(2, 16, 32, 1, R[1]);
    for (let i = 0; i < 4; i++) q.rect(4 + i * 8, 9, 1, 11, R[1]);
    q.rect(0, 20, 36, 1, R[0]);
    q.rect(2, 3, 30, 3, R[3]);
    q.rect(2, 3, 30, 1, R[4]);
    q.rect(2, 5, 30, 1, R[1]);
    q.rect(8, 1, 10, 2, M.tyre[2]); q.rect(20, 0, 6, 3, M.paper[1]); q.rect(16, 2, 3, 1, M.paper[2]);
    q.rect(4, 21, 3, 3, M.tyre[2]); q.rect(29, 21, 3, 3, M.tyre[2]);
    q.rect(0, 12, 2, 5, M.metalD[2]); q.rect(34, 12, 2, 5, M.metalD[2]);
    q.noise(rng, 0, 8, 36, 12, R[1], 0.12);
    rustPatch(q, rng, 2, 15, 32, 5, 3);
  } },
  shopping_cart: { w: 22, h: 20, draw(q) {
    const R = M.metal;
    for (let y = 4; y < 15; y++) for (let x = 3; x < 20; x++) if ((x & 1) === 0 || (y & 1) === 0) q.set(x, y, (x & 1) === 0 && (y & 1) === 0 ? R[3] : R[1]);
    q.rect(3, 4, 17, 1, R[3]);
    q.rect(3, 14, 17, 1, R[2]);
    q.rect(3, 4, 1, 11, R[2]);
    q.rect(19, 4, 1, 11, R[2]);
    q.rect(0, 1, 2, 2, M.red[2]);
    q.line(2, 2, 4, 4, R[2]);
    q.rect(5, 15, 1, 3, R[1]); q.rect(17, 15, 1, 3, R[1]);
    q.rect(3, 17, 3, 1, R[1]); q.rect(16, 17, 4, 1, R[1]);
    q.rect(4, 18, 2, 2, M.tyre[2]); q.rect(17, 18, 2, 2, M.tyre[2]);
    q.rect(7, 9, 5, 5, M.paper[1]); q.rect(13, 10, 4, 4, M.olive[2]);
  } },
  gurney: { w: 34, h: 24, draw(q, rng) {
    q.rect(2, 6, 30, 5, M.ivory[2]);
    q.rect(2, 6, 30, 1, M.ivory[3]);
    q.rect(2, 10, 30, 1, M.ivory[1]);
    q.rect(24, 4, 7, 3, M.ivory[3]);
    q.rect(24, 4, 7, 1, M.ivory[4]);
    q.rect(6, 7, 14, 3, M.teal[2]);
    q.rect(2, 11, 30, 2, M.metal[2]);
    q.rect(2, 11, 30, 1, M.metal[3]);
    q.rect(0, 3, 2, 10, M.metal[2]); q.rect(32, 3, 2, 10, M.metal[2]);
    q.rect(0, 3, 34, 1, M.metal[3]);
    q.rect(6, 13, 2, 8, M.metal[1]); q.rect(26, 13, 2, 8, M.metal[1]);
    q.rect(7, 16, 20, 1, M.metal[1]);
    q.rect(5, 21, 4, 3, M.tyre[2]); q.rect(25, 21, 4, 3, M.tyre[2]);
    q.noise(rng, 6, 7, 20, 3, M.bloodD[1], 0.1);
  } },
  ivbag: { w: 12, h: 36, frames: 2, fps: 3, draw(q, rng, o) {
    q.rect(5, 2, 2, 30, M.metal[2]);
    q.rect(5, 2, 1, 30, M.metal[3]);
    q.rect(2, 0, 8, 2, M.metal[2]);
    q.rect(0, 32, 12, 2, M.metal[1]);
    q.rect(0, 33, 3, 3, M.tyre[2]); q.rect(9, 33, 3, 3, M.tyre[2]);
    q.rect(1, 3, 6, 11, M.glass[2]);
    q.rect(1, 3, 6, 1, M.glass[3]);
    q.rect(1, 8, 6, 6, M.water[3]);
    q.rect(1, 8, 6, 1, M.water[4]);
    q.set(2, 4, M.glass[4]);
    q.rect(3, 14, 2, 2, M.plastic[2]);
    q.line(4, 16, 9, 30, M.glass[3]);
    q.set(4, 17 + (o.f & 1) * 5, M.water[4]);
  } },
  vending: { w: 22, h: 34, frames: 2, fps: 4, glow: 'electric', draw(q, rng, o) {
    const dim = (o.f & 1) === 1;
    if (!o.glow) {
      box(q, 0, 0, 22, 34, M.red);
      q.rect(0, 30, 22, 4, M.metalD[1]);
      q.rect(0, 30, 22, 1, M.metalD[3]);
      inset(q, 2, 6, 12, 20, M.red);
      q.rect(14, 8, 6, 3, M.metalD[1]);
      q.rect(15, 14, 4, 1, M.metalD[0]);
      q.rect(14, 22, 6, 4, '#1b1a22');
      rustPatch(q, rng, 1, 26, 20, 4, 2);
    }
    lit(q, o, 2, 1, 18, 4, dim ? GLOW.screenDim : GLOW.screen, OFF.glass);
    lit(q, o, 3, 7, 10, 18, dim ? GLOW.screenDim : '#7fc0e8', OFF.glass);
    if (!o.glow || o.on) {
      const cans = [M.red[3], M.teal[3], M.yellow[3], M.navy[3]];
      for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) q.rect(4 + c * 3, 8 + r * 4, 2, 3, cans[(r + c) & 3]);
      for (let r = 0; r < 4; r++) q.rect(3, 11 + r * 4, 10, 1, dim ? M.metalD[1] : M.metal[2]);
    }
    if (!o.glow) { text(q, 'ICE', 5, 1, o.on ? '#183040' : OFF.led); }
    led(q, o, 16, 9, GLOW.ledG);
  } },
  tree: { w: 40, h: 48, draw(q, rng) {
    const B = M.bark;
    const L = M.leaf;
    q.rect(17, 22, 6, 26, B[2]);
    q.rect(17, 22, 2, 26, B[3]);
    q.rect(21, 22, 2, 26, B[1]);
    q.rect(14, 44, 12, 4, B[1]);
    q.line(19, 24, 8, 12, B[2]); q.line(21, 22, 32, 10, B[2]); q.line(20, 20, 20, 8, B[1]); q.line(19, 26, 12, 30, B[1]);
    canopy(q, rng, 13, 13, 10, 8, L);
    canopy(q, rng, 27, 11, 11, 9, L);
    canopy(q, rng, 20, 7, 11, 7, L);
    canopy(q, rng, 17, 19, 8, 5, L);
    q.noise(rng, 17, 22, 6, 26, B[0], 0.12);
  } },
  pine: { w: 28, h: 48, draw(q, rng) {
    const P = M.pine;
    q.rect(12, 40, 4, 8, M.bark[1]);
    q.rect(12, 40, 1, 8, M.bark[2]);
    const tiers = [[24, 14, 30], [20, 12, 20], [15, 9, 10], [9, 6, 2]];
    for (let i = 0; i < tiers.length; i++) {
      const [hw, th, y] = tiers[i];
      for (let j = 0; j < th; j++) {
        const w = Math.max(2, Math.round((hw * (j + 1)) / th));
        q.rect(14 - (w >> 1), y + j, w, 1, j === th - 1 ? P[0] : P[2]);
        q.rect(14 - (w >> 1), y + j, Math.max(1, w >> 2), 1, P[3]);
      }
    }
    q.noise(rng, 2, 2, 24, 40, P[1], 0.12);
    q.noise(rng, 2, 2, 24, 40, P[4], 0.03);
  } },
  bush: { w: 20, h: 12, draw(q, rng) {
    const L = M.veg;
    canopy(q, rng, 10, 7, 10, 5, L);
    canopy(q, rng, 7, 5, 6, 4, L);
    canopy(q, rng, 14, 6, 5, 4, L);
    q.rect(0, 11, 20, 1, L[0]);
  } },
  log: { w: 26, h: 10, draw(q, rng) {
    hcyl(q, 3, 1, 23, 8, M.bark);
    q.ellipse(3, 5, 3, 4, M.woodP[2]);
    q.ring(3, 5, 2, M.woodP[1]);
    q.set(3, 5, M.woodP[0]);
    q.rect(10, 0, 2, 2, M.bark[1]);
    q.noise(rng, 6, 1, 20, 8, M.bark[1], 0.15);
    q.rect(0, 9, 26, 1, M.bark[0]);
  } },
  tent: { w: 40, h: 24, draw(q, rng) {
    const T = M.tarp;
    for (let j = 0; j < 22; j++) {
      const w = 2 + Math.round((36 * j) / 21);
      q.rect(20 - (w >> 1), j, w, 1, T[2]);
      q.rect(20 - (w >> 1), j, Math.max(1, w >> 3), 1, T[3]);
      q.rect(20 + (w >> 1) - Math.max(1, w >> 3), j, Math.max(1, w >> 3), 1, T[1]);
    }
    q.rect(19, 0, 2, 22, T[3]);
    for (let j = 8; j < 22; j++) { const w = Math.round(((j - 8) * 10) / 14); q.rect(20 - (w >> 1), j, w, 1, '#1b1a22'); }
    q.rect(15, 21, 10, 1, '#1b1a22');
    q.line(38, 2, 39, 22, M.canvas[3]);
    q.line(2, 2, 1, 22, M.canvas[3]);
    q.rect(0, 22, 40, 2, M.moss[1]);
    q.noise(rng, 2, 2, 36, 20, T[1], 0.1);
  } },
  campfire: { w: 20, h: 14, frames: 2, fps: 6, glow: 'flame', draw(q, rng, o) {
    const f = o.f;
    if (!o.glow) {
      for (let i = 0; i < 6; i++) q.rect(i * 3 + (i & 1), 11 + (i & 1), 4, 2, i & 1 ? M.conc[2] : M.conc[3]);
      q.rect(2, 12, 16, 1, M.conc[1]);
      q.line(3, 10, 16, 8, M.bark[2]); q.line(4, 8, 16, 10, M.bark[1]);
    }
    lit(q, o, 7, 9, 6, 2, GLOW.coal, M.bark[0]);
    lit(q, o, 9, 9, 2, 1, GLOW.ember, M.bark[0]);
    flame(q, 10, 1 + (f & 1), 9 - (f & 1), f, 8);
    flame(q, 13, 4, 6 + (f & 1), f + 1, 4);
    flame(q, 6, 5 - (f & 1), 5 + (f & 1), f, 4);
  } },
  ammo_box: { w: 14, h: 10, draw(q) {
    box(q, 0, 2, 14, 8, M.olive);
    q.rect(0, 4, 14, 1, M.olive[1]);
    q.rect(5, 0, 4, 2, M.olive[1]);
    q.rect(5, 0, 4, 1, M.olive[3]);
    q.rect(2, 6, 4, 1, M.ivory[3]);
    q.rect(8, 6, 3, 1, M.ivory[3]);
  } },
  crates_military: { w: 32, h: 22, draw(q, rng) {
    box(q, 0, 12, 16, 10, M.olive);
    box(q, 16, 12, 16, 10, M.olive);
    box(q, 6, 2, 18, 10, M.olive);
    q.rect(0, 16, 16, 1, M.olive[1]); q.rect(16, 16, 16, 1, M.olive[1]); q.rect(6, 6, 18, 1, M.olive[1]);
    text(q, '7', 3, 14, M.ivory[3]); text(q, '2', 19, 14, M.ivory[3]);
    q.rect(9, 8, 6, 1, M.ivory[3]); q.rect(17, 8, 4, 1, M.ivory[3]);
    q.rect(2, 18, 3, 2, M.metalD[1]); q.rect(18, 18, 3, 2, M.metalD[1]);
    q.noise(rng, 0, 2, 32, 20, M.olive[1], 0.08);
  } },
  barrier_concrete: { w: 30, h: 18, draw(q, rng) {
    const C = M.conc;
    for (let j = 0; j < 18; j++) {
      const w = j < 6 ? 18 : j < 12 ? 18 + (j - 6) * 2 : 30;
      q.rect(15 - (w >> 1), j, w, 1, C[2]);
      q.rect(15 - (w >> 1), j, 1, 1, C[3]);
      q.rect(15 + (w >> 1) - 1, j, 1, 1, C[1]);
    }
    q.rect(6, 0, 18, 1, C[4]);
    q.rect(7, 1, 16, 5, C[3]);
    q.rect(0, 17, 30, 1, C[0]);
    for (let x = 3; x < 27; x += 6) { q.rect(x, 13, 3, 3, M.yellow[2]); q.rect(x + 3, 13, 3, 3, INK); }
    q.rect(0, 12, 30, 1, C[1]);
    q.noise(rng, 0, 0, 30, 18, C[1], 0.15);
    q.line(8, 2, 10, 9, C[0]);
  } },
  antenna: { w: 16, h: 48, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      const R = M.metal;
      q.rect(6, 4, 1, 42, R[3]); q.rect(9, 4, 1, 42, R[1]);
      for (let y = 6; y < 44; y += 4) { q.line(6, y, 9, y + 3, R[2]); }
      for (let y = 8; y < 44; y += 8) q.rect(6, y, 4, 1, R[2]);
      q.rect(3, 46, 10, 2, R[1]); q.rect(3, 46, 10, 1, R[3]);
      q.line(6, 10, 0, 46, R[1]); q.line(9, 10, 15, 46, R[1]);
      q.rect(7, 0, 2, 4, R[2]);
      q.rect(2, 12, 12, 1, R[3]);
      q.rect(1, 13, 1, 2, R[2]); q.rect(14, 13, 1, 2, R[2]);
    }
    lit(q, o, 7, 0, 2, 1, GLOW.ledR, OFF.led);
    if (o.glow && o.on) q.rect(6, 1, 4, 1, GLOW.ledR, 0.4);
  } },
  radio_set: { w: 24, h: 16, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      box(q, 0, 4, 24, 12, M.metalD);
      q.rect(2, 6, 8, 5, M.metalD[0]);
      q.fillCircle(15, 9, 2, M.metalD[3]); q.fillCircle(20, 9, 2, M.metalD[3]);
      q.set(15, 8, M.metalD[4]); q.set(20, 8, M.metalD[4]);
      q.rect(2, 13, 20, 1, M.metalD[0]);
      q.rect(21, 0, 1, 4, M.metal[2]);
      q.line(0, 12, 0, 16, M.tyre[2]);
      q.rect(0, 10, 3, 2, M.tyre[2]);
    }
    lit(q, o, 3, 7, 6, 3, '#2f7f7a', OFF.glass);
    if (o.on) { q.set(4, 8, GLOW.ledG); q.rect(5, 8, 3, 1, GLOW.tube); }
    led(q, o, 12, 7, GLOW.ledR);
    led(q, o, 12, 10, GLOW.ledG);
  } },
  generator_unit: { w: 30, h: 22, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(1, 2, 28, 1, M.metalD[3]); q.rect(1, 2, 1, 17, M.metalD[2]); q.rect(28, 2, 1, 17, M.metalD[2]);
      q.rect(1, 18, 28, 1, M.metalD[1]);
      box(q, 3, 7, 12, 11, M.metalD);
      for (let i = 0; i < 4; i++) q.rect(5, 9 + i * 2, 8, 1, M.metalD[0]);
      box(q, 15, 4, 12, 14, M.yellow);
      q.rect(17, 6, 8, 3, M.yellow[1]);
      q.rect(16, 12, 10, 1, M.yellow[1]);
      q.fillCircle(21, 15, 2, M.metalD[2]);
      q.rect(4, 3, 10, 4, M.metalD[2]); q.rect(4, 3, 10, 1, M.metalD[3]);
      q.rect(25, 0, 3, 5, M.metalD[1]); q.rect(25, 0, 3, 1, M.metalD[2]);
      q.rect(0, 19, 30, 1, M.metalD[0]);
      q.fillCircle(6, 19, 2, M.tyre[2]); q.fillCircle(24, 19, 2, M.tyre[2]);
      rustPatch(q, rng, 4, 9, 10, 8, 1);
    }
    led(q, o, 17, 7, GLOW.ledG);
    lit(q, o, 19, 7, 4, 1, GLOW.ledA, OFF.led);
  } },
  workbench: { w: 36, h: 24, draw(q, rng) {
    planks(q, 0, 6, 36, 4, M.woodP, 1);
    q.rect(0, 6, 36, 1, M.woodP[4]);
    q.rect(2, 10, 3, 14, M.metalD[2]); q.rect(31, 10, 3, 14, M.metalD[2]);
    q.rect(2, 10, 1, 14, M.metalD[3]); q.rect(31, 10, 1, 14, M.metalD[3]);
    inset(q, 6, 11, 24, 6, M.wood);
    q.rect(16, 13, 4, 1, M.metal[3]);
    q.rect(0, 2, 6, 4, M.metalD[2]); q.rect(0, 2, 6, 1, M.metalD[3]); q.rect(6, 3, 3, 2, M.metalD[1]);
    q.rect(7, 4, 1, 1, M.metalD[3]);
    q.rect(12, 4, 6, 1, M.metal[2]); q.rect(11, 3, 2, 3, M.metalD[1]);
    q.rect(22, 3, 1, 3, M.wood[1]); q.rect(20, 2, 5, 2, M.metalD[2]);
    q.rect(27, 2, 5, 4, M.red[2]); q.rect(27, 2, 5, 1, M.red[3]);
    q.rect(20, 18, 12, 6, M.metal[1]); q.rect(21, 17, 3, 2, M.metalD[2]); q.rect(26, 16, 4, 3, M.rust[2]);
    q.noise(rng, 0, 6, 36, 4, M.woodP[1], 0.14);
  } },
  bed: { w: 32, h: 16, draw(q, rng) {
    const S = PAL.clothMuted[rng.int(0, PAL.clothMuted.length - 1)];
    q.rect(1, 6, 30, 5, M.canvas[2]);
    q.rect(1, 6, 30, 1, M.canvas[3]);
    q.rect(1, 10, 30, 1, M.canvas[1]);
    q.rect(2, 4, 8, 3, M.ivory[2]); q.rect(2, 4, 8, 1, M.ivory[3]);
    q.rect(12, 5, 19, 5, S[1]); q.rect(12, 5, 19, 1, S[2]); q.rect(12, 8, 19, 1, S[0]);
    q.rect(0, 11, 32, 1, M.metalD[2]);
    q.rect(0, 11, 32, 1, M.metalD[3]);
    q.rect(2, 12, 2, 4, M.metalD[1]); q.rect(28, 12, 2, 4, M.metalD[1]);
    q.line(4, 12, 8, 16, M.metalD[1]); q.line(27, 12, 23, 16, M.metalD[1]);
  } },
  bunkbed: { w: 32, h: 34, draw(q, rng) {
    const A = PAL.clothMuted[rng.int(0, PAL.clothMuted.length - 1)];
    const B = PAL.clothMuted[rng.int(0, PAL.clothMuted.length - 1)];
    const F = M.metalD;
    q.rect(1, 0, 2, 34, F[2]); q.rect(1, 0, 1, 34, F[3]);
    q.rect(29, 0, 2, 34, F[2]); q.rect(29, 0, 1, 34, F[3]);
    q.rect(1, 0, 30, 1, F[3]);
    for (const y of [10, 26]) {
      q.rect(1, y, 30, 2, F[2]); q.rect(1, y, 30, 1, F[3]);
      q.rect(3, y - 5, 26, 5, M.canvas[2]); q.rect(3, y - 5, 26, 1, M.canvas[3]);
      const S = y === 10 ? A : B;
      q.rect(12, y - 5, 17, 4, S[1]); q.rect(12, y - 5, 17, 1, S[2]); q.rect(12, y - 2, 17, 1, S[0]);
      q.rect(4, y - 6, 7, 3, M.ivory[2]); q.rect(4, y - 6, 7, 1, M.ivory[3]);
    }
    q.rect(26, 12, 1, 14, F[3]);
    for (let y = 14; y < 26; y += 3) q.rect(26, y, 3, 1, F[2]);
    q.rect(1, 32, 2, 2, F[1]); q.rect(29, 32, 2, 2, F[1]);
    q.noise(rng, 3, 5, 26, 6, M.canvas[1], 0.08);
  } },
  table: { w: 28, h: 16, draw(q, rng) {
    q.rect(0, 4, 28, 3, M.wood[2]); q.rect(0, 4, 28, 1, M.wood[3]); q.rect(0, 6, 28, 1, M.wood[0]);
    q.rect(2, 7, 2, 9, M.wood[1]); q.rect(24, 7, 2, 9, M.wood[1]);
    q.rect(2, 7, 1, 9, M.wood[2]); q.rect(24, 7, 1, 9, M.wood[2]);
    q.rect(4, 11, 20, 1, M.wood[0]);
    q.rect(6, 1, 4, 3, M.ivory[2]); q.rect(6, 1, 4, 1, M.ivory[3]); q.set(10, 2, M.ivory[1]);
    q.rect(14, 2, 8, 2, M.paper[2]); q.rect(15, 3, 5, 1, M.paper[0]);
    q.noise(rng, 0, 4, 28, 3, M.wood[1], 0.12);
  } },
  chair: { w: 12, h: 18, draw(q) {
    q.rect(1, 0, 2, 10, M.wood[2]); q.rect(1, 0, 1, 10, M.wood[3]);
    q.rect(3, 2, 6, 1, M.wood[1]); q.rect(3, 5, 6, 1, M.wood[1]);
    q.rect(1, 9, 10, 2, M.wood[2]); q.rect(1, 9, 10, 1, M.wood[3]);
    q.rect(1, 11, 2, 7, M.wood[1]); q.rect(9, 11, 2, 7, M.wood[1]);
    q.rect(3, 14, 6, 1, M.wood[0]);
  } },
  stove: { w: 22, h: 24, glow: 'flame', draw(q, rng, o) {
    if (!o.glow) {
      const F = M.metalD;
      q.rect(16, 0, 3, 8, F[2]); q.rect(16, 0, 1, 8, F[3]);
      q.rect(15, 0, 5, 1, F[1]);
      box(q, 1, 8, 20, 12, F);
      q.rect(0, 7, 22, 2, F[3]); q.rect(0, 7, 22, 1, F[4]);
      inset(q, 4, 11, 12, 7, F);
      q.rect(17, 13, 2, 3, M.metal[3]);
      q.rect(2, 20, 3, 4, F[1]); q.rect(17, 20, 3, 4, F[1]);
      q.rect(3, 3, 8, 4, M.metal[1]); q.rect(3, 3, 8, 1, M.metal[3]); q.rect(2, 2, 10, 1, M.metal[2]);
      q.rect(6, 1, 2, 1, M.smoke[2]);
    }
    lit(q, o, 6, 13, 8, 3, GLOW.coal, '#2a1208');
    lit(q, o, 8, 14, 3, 1, GLOW.flame, '#2a1208');
    if (!o.glow) for (let i = 0; i < 3; i++) q.rect(6, 12 + i * 2, 8, 1, M.metalD[0]);
  } },
  sink: { w: 20, h: 22, draw(q, rng) {
    box(q, 0, 8, 20, 14, M.white);
    inset(q, 3, 12, 6, 8, M.white); inset(q, 11, 12, 6, 8, M.white);
    q.rect(0, 6, 20, 3, M.metal[2]); q.rect(0, 6, 20, 1, M.metal[3]);
    q.rect(3, 7, 14, 2, M.metal[1]);
    q.set(10, 8, M.metalD[0]);
    q.rect(15, 1, 2, 5, M.metal[2]); q.rect(13, 1, 4, 1, M.metal[3]); q.set(13, 2, M.metal[2]);
    q.set(13, 3, M.water[3]);
    rustPatch(q, rng, 2, 18, 16, 3, 1);
  } },
  water_tank: { w: 32, h: 36, draw(q, rng) {
    const R = M.plastic;
    cyl(q, 3, 3, 26, 26, R, true);
    q.ellipse(16, 3, 13, 2, R[3]);
    q.rect(3, 2, 26, 1, R[4]);
    q.rect(3, 9, 26, 1, R[1]); q.rect(3, 18, 26, 1, R[1]); q.rect(3, 27, 26, 1, R[1]);
    q.rect(24, 6, 3, 20, M.glass[1]);
    q.rect(24, 14, 3, 12, M.water[2]); q.rect(24, 14, 3, 1, M.water[4]);
    q.rect(12, 0, 8, 3, R[1]); q.rect(12, 0, 8, 1, R[3]);
    q.rect(0, 29, 32, 2, M.metalD[2]); q.rect(0, 29, 32, 1, M.metalD[3]);
    q.rect(2, 31, 3, 5, M.metalD[1]); q.rect(27, 31, 3, 5, M.metalD[1]); q.rect(14, 31, 3, 5, M.metalD[1]);
    q.rect(6, 25, 5, 2, M.metal[2]); q.rect(4, 24, 3, 4, M.red[2]); q.set(4, 24, M.red[3]);
    q.noise(rng, 3, 4, 26, 24, R[1], 0.08);
  } },
  pipes: { w: 40, h: 10, draw(q, rng) {
    hcyl(q, 0, 3, 40, 4, M.metal);
    q.rect(6, 2, 2, 6, M.metalD[2]); q.rect(30, 2, 2, 6, M.metalD[2]);
    q.rect(6, 2, 1, 6, M.metalD[3]); q.rect(30, 2, 1, 6, M.metalD[3]);
    q.fillCircle(18, 2, 2, M.red[2]); q.ring(18, 2, 2, M.red[1]); q.set(18, 2, M.red[3]);
    q.rect(17, 3, 3, 1, M.metalD[1]);
    q.set(12, 7, M.water[3]); q.set(12, 8, M.water[4]);
    rustPatch(q, rng, 2, 3, 36, 3, 3);
  } },
  medical_bed: { w: 34, h: 22, draw(q, rng) {
    const F = M.white;
    q.rect(2, 8, 30, 5, F[2]); q.rect(2, 8, 30, 1, F[3]); q.rect(2, 12, 30, 1, F[1]);
    for (let i = 0; i < 5; i++) q.rect(24 + i, 8 - i, 8 - i, 1, F[2]);
    q.rect(24, 3, 8, 1, F[3]);
    q.rect(4, 9, 16, 3, M.teal[2]); q.rect(4, 9, 16, 1, M.teal[3]);
    q.rect(24, 6, 6, 2, M.ivory[3]);
    q.rect(0, 13, 34, 2, M.metal[2]); q.rect(0, 13, 34, 1, M.metal[3]);
    q.rect(0, 3, 2, 12, M.metal[2]); q.rect(32, 1, 2, 14, M.metal[2]);
    q.rect(0, 3, 1, 12, M.metal[3]); q.rect(32, 1, 1, 14, M.metal[3]);
    q.rect(4, 15, 2, 5, M.metal[1]); q.rect(28, 15, 2, 5, M.metal[1]);
    q.rect(5, 18, 24, 1, M.metal[1]);
    q.rect(3, 20, 4, 2, M.tyre[2]); q.rect(27, 20, 4, 2, M.tyre[2]);
    q.noise(rng, 4, 9, 16, 3, M.teal[1], 0.1);
  } },
  cabinet_med: { w: 18, h: 28, draw(q, rng) {
    box(q, 0, 0, 18, 28, M.white);
    q.rect(6, 2, 6, 1, M.red[2]); q.rect(8, 1, 2, 3, M.red[2]);
    inset(q, 2, 6, 14, 9, M.white); inset(q, 2, 16, 14, 9, M.white);
    q.rect(3, 7, 12, 7, M.glass[1]); q.line(3, 13, 9, 7, M.glass[4]);
    q.rect(5, 9, 2, 4, M.red[2]); q.rect(9, 10, 2, 3, M.teal[3]); q.rect(12, 9, 2, 4, M.ivory[3]);
    q.rect(8, 19, 2, 3, M.metal[3]);
    q.rect(0, 26, 18, 2, M.white[1]);
    rustPatch(q, rng, 2, 24, 14, 2, 1);
  } },
  gun_rack: { w: 24, h: 28, draw(q, rng) {
    box(q, 0, 0, 24, 28, M.wood);
    q.rect(2, 2, 20, 22, M.wood[1]);
    q.rect(2, 12, 20, 1, M.wood[3]);
    for (let i = 0; i < 3; i++) {
      const x = 5 + i * 6;
      q.rect(x, 3, 2, 20, M.metal[2]); q.rect(x, 3, 1, 20, M.metal[3]);
      q.rect(x - 1, 15, 4, 7, M.woodP[2]); q.rect(x - 1, 15, 1, 7, M.woodP[3]); q.rect(x, 4, 1, 3, M.metal[4]);
      q.rect(x - 1, 9, 4, 2, M.metalD[0]); q.rect(x + 1, 12, 2, 2, M.metalD[0]);
    }
    q.rect(2, 24, 20, 2, M.wood[3]);
    q.rect(4, 22, 6, 4, M.olive[2]); q.rect(4, 22, 6, 1, M.olive[3]);
    q.noise(rng, 0, 0, 24, 28, M.wood[0], 0.06);
  } },
  spotlight: { w: 16, h: 22, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(7, 8, 2, 8, M.metalD[2]);
      q.line(7, 15, 2, 21, M.metalD[2]); q.line(8, 15, 13, 21, M.metalD[2]); q.rect(7, 16, 2, 6, M.metalD[1]);
      q.rect(2, 2, 10, 7, M.metalD[2]); q.rect(2, 2, 10, 1, M.metalD[3]); q.rect(2, 8, 10, 1, M.metalD[0]);
      q.rect(12, 3, 2, 5, M.metalD[1]);
      q.rect(0, 3, 2, 5, M.metal[2]);
      q.line(9, 9, 14, 21, M.tyre[2]);
    }
    lit(q, o, 0, 4, 1, 3, GLOW.bulb, OFF.glass);
    lit(q, o, 1, 3, 1, 5, GLOW.bulb, OFF.glass);
    if (!o.glow) q.set(1, 3, M.metal[3]);
  } },
  lamp_hanging: { w: 12, h: 16, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(5, 0, 1, 6, M.tyre[3]);
      for (let j = 0; j < 6; j++) { const w = 4 + j * 1.5; q.rect(6 - Math.round(w / 2), 6 + j, Math.round(w), 1, j === 5 ? M.metalD[1] : M.metalD[2]); }
      q.rect(4, 6, 1, 5, M.metalD[3]);
      q.rect(1, 11, 10, 1, M.metalD[0]);
    }
    lit(q, o, 4, 12, 4, 3, GLOW.bulb, OFF.bulb);
    lit(q, o, 5, 15, 2, 1, GLOW.bulbRim, OFF.bulb);
    if (o.glow && o.on) { q.rect(3, 12, 1, 3, GLOW.bulbRim, 0.6); q.rect(8, 12, 1, 3, GLOW.bulbRim, 0.6); }
  } },
  lamp_desk: { w: 14, h: 14, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(6, 11, 8, 3, M.metalD[2]); q.rect(6, 11, 8, 1, M.metalD[3]);
      q.line(10, 11, 8, 4, M.metalD[3]);
      q.rect(0, 2, 8, 4, M.red[2]); q.rect(0, 2, 8, 1, M.red[3]); q.rect(8, 3, 1, 3, M.red[1]);
      q.rect(0, 5, 8, 1, M.red[1]);
    }
    lit(q, o, 1, 6, 6, 1, GLOW.bulb, OFF.bulb);
    lit(q, o, 2, 7, 4, 1, GLOW.bulbRim, OFF.bulb);
  } },
  candles: { w: 12, h: 10, frames: 2, fps: 5, glow: 'flame', draw(q, rng, o) {
    const f = o.f;
    if (!o.glow) {
      q.rect(0, 8, 12, 2, M.metal[2]); q.rect(0, 8, 12, 1, M.metal[3]);
      q.rect(1, 4, 2, 4, M.ivory[2]); q.rect(5, 2, 2, 6, M.ivory[3]); q.rect(9, 5, 2, 3, M.ivory[2]);
      q.set(1, 4, M.ivory[4]); q.set(5, 2, M.ivory[4]);
      q.rect(2, 5, 1, 2, M.ivory[1]);
    }
    lit(q, o, 1 + (f & 1), 2, 1, 2, GLOW.flame, INK);
    lit(q, o, 5 + ((f + 1) & 1), 0, 1, 2, GLOW.flameHi, INK);
    lit(q, o, 9 + (f & 1), 3, 1, 2, GLOW.flame, INK);
  } },
  poster: { w: 12, h: 16, draw(q, rng) {
    const P = M.paper;
    q.rect(0, 0, 12, 16, P[1]);
    q.rect(0, 0, 12, 1, P[3]);
    q.rect(0, 0, 1, 16, P[2]);
    const v = rng.int(0, 2);
    if (v === 0) { q.rect(2, 2, 8, 6, M.red[2]); q.rect(3, 3, 6, 4, M.ivory[3]); q.rect(2, 10, 8, 1, INK); q.rect(2, 12, 6, 1, INK); }
    else if (v === 1) { q.rect(2, 2, 8, 8, M.navy[2]); q.fillCircle(6, 6, 2, M.ivory[3]); q.rect(3, 12, 6, 1, INK); q.rect(2, 14, 8, 1, M.red[2]); }
    else { q.rect(2, 3, 8, 1, INK); q.rect(2, 5, 8, 1, INK); q.rect(2, 7, 5, 1, INK); q.rect(2, 10, 8, 4, M.olive[2]); }
    q.erase(9, 13, 3, 3);
    q.erase(10, 12, 2, 1);
    q.set(1, 1, M.red[3]); q.set(10, 1, M.red[3]);
    q.noise(rng, 0, 0, 12, 16, P[0], 0.06);
  } },
  wire: { w: 18, h: 20, draw(q) {
    q.rect(8, 0, 2, 1, M.metalD[2]);
    q.line(8, 1, 6, 8, M.tyre[3]); q.line(6, 8, 10, 12, M.tyre[3]); q.line(10, 12, 12, 17, M.tyre[3]);
    q.rect(11, 17, 3, 3, M.metalD[2]); q.rect(11, 17, 3, 1, M.metalD[3]);
    q.set(12, 19, M.metal[3]);
    q.line(9, 1, 14, 6, M.tyre[2]); q.line(14, 6, 16, 4, M.tyre[2]);
    q.set(16, 3, M.rust[3]);
  } },
  rubble: { w: 32, h: 12, draw(q, rng) {
    const C = M.conc;
    q.ellipse(16, 10, 16, 3, C[1]);
    const chunks = [[2, 6, 8, 5], [9, 4, 7, 6], [15, 7, 9, 4], [23, 5, 7, 5], [6, 9, 5, 3], [28, 8, 4, 3]];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      q.rect(c[0], c[1], c[2], c[3], C[2]);
      q.rect(c[0], c[1], c[2], 1, C[3]);
      q.rect(c[0], c[1] + c[3] - 1, c[2], 1, C[0]);
      q.rect(c[0] + c[2] - 1, c[1], 1, c[3], C[1]);
    }
    q.line(4, 5, 12, 1, M.rust[2]); q.line(20, 6, 26, 2, M.rust[1]);
    q.rect(12, 8, 3, 2, M.brick[2]); q.rect(25, 9, 3, 2, M.brick[2]);
    q.noise(rng, 0, 4, 32, 8, C[1], 0.16);
    q.noise(rng, 0, 4, 32, 8, M.smoke[0], 0.06);
  } },
  skeleton: { w: 28, h: 12, draw(q, rng) {
    const B = M.bone;
    q.rect(0, 8, 12, 2, B[2]); q.rect(0, 8, 12, 1, B[3]);
    q.rect(3, 10, 6, 1, B[1]);
    q.rect(12, 6, 8, 5, B[1]);
    for (let i = 0; i < 4; i++) q.rect(12 + i * 2, 5, 1, 6, B[3]);
    q.rect(12, 5, 8, 1, B[2]);
    q.line(8, 3, 14, 6, B[2]);
    q.fillCircle(23, 6, 4, B[2]); q.ring(23, 6, 4, B[1]);
    q.rect(20, 5, 7, 1, B[3]);
    q.set(22, 6, INK); q.set(25, 6, INK); q.rect(22, 9, 4, 1, INK);
    q.rect(9, 3, 3, 7, M.cloth[1]); q.rect(13, 3, 6, 2, M.cloth[1]);
    q.noise(rng, 0, 3, 28, 9, B[0], 0.1);
  } },
  trash: { w: 20, h: 12, draw(q, rng) {
    const T = M.tyre;
    q.ellipse(7, 8, 7, 4, T[2]); q.ellipse(6, 6, 5, 3, T[3]); q.set(4, 5, T[4]);
    q.ellipse(14, 9, 6, 3, T[1]); q.ellipse(13, 7, 4, 2, T[2]);
    q.rect(7, 2, 2, 3, T[3]);
    q.rect(15, 1, 2, 7, M.glass[2]); q.set(15, 2, M.glass[4]); q.rect(15, 0, 2, 1, M.olive[1]);
    q.rect(1, 9, 5, 2, M.paper[1]); q.rect(17, 9, 3, 3, M.paper[2]);
    q.rect(9, 10, 4, 2, M.red[2]);
    q.noise(rng, 0, 0, 20, 12, T[0], 0.06);
  } },
  weak_floor: { w: 32, h: 8, draw(q, rng) {
    planks(q, 0, 0, 32, 8, M.wood, 2);
    for (let x = 6; x < 32; x += 8) q.rect(x, 0, 1, 8, M.wood[0]);
    q.rect(10, 1, 12, 6, '#0e0d14');
    q.line(8, 1, 12, 5, M.wood[3]); q.line(24, 1, 20, 6, M.wood[3]);
    q.rect(9, 6, 3, 1, M.wood[1]); q.rect(21, 1, 3, 1, M.wood[1]);
    q.noise(rng, 0, 0, 32, 8, M.wood[0], 0.12);
    q.set(14, 3, M.wood[1]); q.set(18, 5, M.wood[1]);
  } },
  dog: { w: 28, h: 18, frames: 2, fps: 6, draw(q, rng, o) {
    const F = M.fur;
    const f = o.f & 1;
    q.rect(7, 6, 15, 6, F[2]); q.rect(7, 6, 15, 1, F[3]);
    q.rect(7, 11, 15, 1, F[1]);
    for (let i = 0; i < 4; i++) q.rect(10 + i * 3, 8, 1, 3, F[1]);
    q.line(7, 7, 1, 3, F[2]); q.line(6, 7, 1, 4, F[1]);
    q.rect(19, 2, 8, 6, F[2]); q.rect(19, 2, 8, 1, F[3]);
    q.rect(25, 5, 3, 3, F[1]);
    q.set(27, 7, INK);
    q.rect(20, 1, 2, 2, F[1]); q.rect(23, 1, 2, 1, F[1]);
    q.set(23, 4, '#ffd84f'); q.set(24, 4, '#ffd84f');
    q.rect(24, 7, 3, 1, M.blood[3]);
    const legs = f ? [[8, 12, 2, 6], [11, 12, 2, 5], [18, 12, 2, 5], [21, 12, 2, 6]] : [[9, 12, 2, 5], [11, 12, 2, 6], [17, 12, 2, 6], [20, 12, 2, 5]];
    for (let i = 0; i < legs.length; i++) { const l = legs[i]; q.rect(l[0], l[1], l[2], l[3], F[1]); q.rect(l[0], l[1] + l[3] - 1, l[2], 1, F[0]); }
    q.noise(rng, 7, 6, 15, 6, F[0], 0.1);
  } },

  // ── extra Hold fittings used by rooms.js ──
  shelf: { w: 28, h: 10, draw(q, rng) {
    q.rect(0, 8, 28, 2, M.wood[2]); q.rect(0, 8, 28, 1, M.wood[3]);
    const cans = [M.red, M.olive, M.yellow, M.ivory, M.teal];
    let x = 1;
    while (x < 26) {
      const R = cans[rng.int(0, cans.length - 1)];
      const w = rng.int(2, 4);
      const h = rng.int(3, 6);
      if (rng.chance(0.85)) { q.rect(x, 8 - h, w, h, R[2]); q.rect(x, 8 - h, w, 1, R[3]); q.rect(x, 8 - h, 1, h, R[3]); }
      x += w + 1;
    }
  } },
  tool_board: { w: 30, h: 18, draw(q, rng) {
    q.rect(0, 0, 30, 18, M.woodP[1]);
    for (let y = 2; y < 18; y += 3) for (let x = 2; x < 30; x += 3) q.set(x, y, M.woodP[0]);
    q.rect(3, 2, 1, 7, M.wood[2]); q.rect(2, 1, 3, 2, M.metalD[2]);
    q.rect(8, 2, 1, 8, M.wood[2]); q.rect(7, 8, 3, 3, M.metalD[2]);
    q.rect(13, 2, 2, 9, M.metal[2]); q.rect(12, 2, 4, 2, M.metal[3]);
    q.rect(19, 3, 1, 6, M.metal[2]); q.rect(18, 8, 3, 2, M.red[2]);
    q.rect(24, 2, 3, 9, M.metalD[1]); q.rect(24, 2, 3, 1, M.metalD[3]);
    q.rect(3, 13, 24, 1, M.wood[2]);
    q.rect(5, 12, 3, 1, M.metal[3]); q.rect(12, 12, 4, 1, M.red[2]); q.rect(20, 12, 3, 1, M.metal[3]);
    q.noise(rng, 0, 0, 30, 18, M.woodP[0], 0.05);
  } },
  monitor: { w: 14, h: 12, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) { box(q, 0, 0, 14, 10, M.metalD); q.rect(4, 10, 6, 2, M.metalD[1]); q.rect(3, 11, 8, 1, M.metalD[2]); }
    lit(q, o, 2, 2, 10, 6, GLOW.screen, OFF.glass);
    if (o.on) { q.rect(3, 3, 5, 1, '#e8f8ff'); q.rect(3, 5, 7, 1, GLOW.screenDim); q.rect(3, 7, 3, 1, GLOW.screenDim); }
  } },
  fuel_can: { w: 8, h: 10, draw(q) {
    box(q, 0, 2, 8, 8, M.red);
    q.rect(2, 0, 3, 2, M.red[1]); q.rect(6, 1, 2, 2, M.metalD[2]);
    q.rect(1, 5, 6, 1, M.red[1]);
    q.rect(2, 4, 4, 3, M.ivory[3]); q.rect(3, 5, 2, 1, INK);
  } },
  lantern: { w: 8, h: 12, glow: 'flame', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(3, 0, 2, 2, M.metalD[3]); q.rect(1, 2, 6, 1, M.metalD[2]);
      q.rect(1, 3, 1, 6, M.metalD[2]); q.rect(6, 3, 1, 6, M.metalD[2]);
      q.rect(0, 9, 8, 3, M.metalD[2]); q.rect(0, 9, 8, 1, M.metalD[3]);
    }
    lit(q, o, 2, 3, 4, 6, GLOW.bulbRim, OFF.glass);
    lit(q, o, 3, 5, 2, 3, GLOW.bulb, OFF.glass);
  } },
  fluorescent: { w: 28, h: 5, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) { q.rect(0, 0, 28, 2, M.metalD[2]); q.rect(0, 0, 28, 1, M.metalD[3]); q.rect(1, 2, 26, 1, M.metalD[0]); }
    lit(q, o, 2, 3, 24, 2, GLOW.tube, OFF.tube);
    if (o.glow && o.on) { q.rect(1, 3, 1, 2, GLOW.tubeDim, 0.5); q.rect(26, 3, 1, 2, GLOW.tubeDim, 0.5); }
  } },
  cage_lamp: { w: 10, h: 9, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      q.rect(3, 0, 4, 2, M.metalD[2]); q.rect(3, 0, 4, 1, M.metalD[3]);
      q.rect(1, 2, 8, 1, M.metalD[3]);
      q.rect(1, 3, 1, 5, M.metalD[2]); q.rect(8, 3, 1, 5, M.metalD[2]); q.rect(4, 3, 1, 5, M.metalD[1]);
      q.rect(1, 8, 8, 1, M.metalD[2]);
    }
    lit(q, o, 2, 3, 2, 5, GLOW.bulb, OFF.bulb);
    lit(q, o, 5, 3, 3, 5, GLOW.bulb, OFF.bulb);
    if (o.glow && o.on) q.rect(3, 8, 4, 1, GLOW.bulbRim, 0.5);
  } },
  control_panel: { w: 24, h: 30, glow: 'electric', draw(q, rng, o) {
    if (!o.glow) {
      box(q, 0, 0, 24, 30, M.metalD);
      inset(q, 2, 2, 20, 10, M.metalD);
      inset(q, 2, 14, 20, 14, M.metalD);
      q.rect(4, 17, 4, 2, M.red[2]); q.rect(4, 22, 4, 2, M.metal[2]);
      q.fillCircle(16, 21, 3, M.metalD[3]); q.set(16, 19, M.metalD[4]);
      q.rect(10, 17, 3, 8, M.metalD[0]);
      q.rect(11, 20, 1, 2, M.metal[3]);
    }
    for (let i = 0; i < 6; i++) led(q, o, 4 + i * 3, 4, i % 3 === 2 ? GLOW.ledR : GLOW.ledG);
    lit(q, o, 4, 7, 16, 3, '#2f7f7a', OFF.glass);
    if (o.on) { q.rect(5, 8, 3, 1, GLOW.ledG); q.rect(9, 8, 6, 1, GLOW.ledA); }
    led(q, o, 6, 26, GLOW.ledA);
  } },
};

/** Names with glow layers, plus the anim list. */
const NAMES = Object.keys(DEFS);
const GLOW_NAMES = NAMES.filter((n) => DEFS[n].glow).map((n) => n + '_glow');

/** Every prop name, including glow variants. */
export const PROPS = Object.freeze(NAMES.concat(GLOW_NAMES));

/** Names with animation frames (their glow variants animate too). */
export const ANIMATED = Object.freeze(NAMES.filter((n) => DEFS[n].frames > 1));

/** Six-prop decoration kits per scav zone (GDD §6). */
export const ZONE_KITS = Object.freeze({
  suburbs: Object.freeze(['car', 'fence_broken', 'hydrant', 'tree', 'bush', 'trash']),
  mall: Object.freeze(['shopping_cart', 'vending', 'sign_mall', 'bench', 'dumpster', 'barrier_concrete']),
  hospital: Object.freeze(['gurney', 'ivbag', 'sign_hospital', 'medical_bed', 'skeleton', 'trash']),
  forest: Object.freeze(['pine', 'tree', 'log', 'tent', 'campfire', 'bush']),
  depot: Object.freeze(['truck', 'crates_military', 'barrier_concrete', 'sandbag_wall', 'ammo_box', 'spotlight']),
});

/** Splits a name into its base definition and whether it is the glow variant. */
function resolve(name) {
  const s = String(name || '');
  if (s.endsWith('_glow')) {
    const base = s.slice(0, -5);
    if (DEFS[base] && DEFS[base].glow) return { base, glow: true };
  }
  return { base: DEFS[s] ? s : 'crate', glow: false };
}

/**
 * True when `name` (or its glow variant) has an emissive layer.
 * @param {string} name
 * @returns {boolean}
 */
export function hasGlow(name) {
  return !!DEFS[resolve(name).base].glow;
}

/**
 * The glow kind of a prop: 'electric' goes dark when unpowered, 'flame' never does.
 * @param {string} name
 * @returns {'electric'|'flame'|null}
 */
export function glowKind(name) {
  return DEFS[resolve(name).base].glow || null;
}

/**
 * Outer size of a prop sprite (content plus the 1px outline margin).
 * @param {string} name
 * @returns {{ w: number, h: number }}
 */
export function propSize(name) {
  const d = DEFS[resolve(name).base];
  return { w: d.w + 2, h: d.h + 2 };
}

/**
 * Builds (and caches) one prop sprite. The anchor is bottom-centre; the bottom
 * row is the outline's ground contact, so place it on the floor line.
 * @param {string} name prop name or `name_glow`
 * @param {number|string} seed
 * @param {{ on?: boolean, frame?: number }} [opts] on=false darkens electric glows; frame picks an animation frame
 * @returns {object} spr
 */
export function makeProp(name, seed, opts) {
  const r = resolve(name);
  const def = DEFS[r.base];
  const on = def.glow === 'flame' ? true : !(opts && opts.on === false);
  const frames = def.frames || 1;
  const f = opts && opts.frame > 0 ? Math.floor(opts.frame) % frames : 0;
  const key = 'prop|' + r.base + (r.glow ? '~' : '') + '|' + String(seed) + '|' + (on ? 1 : 0) + '|' + f;
  return cached(key, () => makeSprite(def.w + 2, def.h + 2, (p) => {
    const rng = makeRng('prop/' + r.base + '/' + String(seed));
    def.draw(shifted(p, 1, 1, def.w, def.h), rng, { f, on, glow: r.glow });
    if (!r.glow) p.outline(INK);
  }));
}

/**
 * Animation of a prop (a single frame for static props). Glow variants animate in step.
 * @param {string} name
 * @param {number|string} seed
 * @param {{ on?: boolean }} [opts]
 * @returns {{ frames: object[], fps: number, loop: boolean }}
 */
export function makePropAnim(name, seed, opts) {
  const r = resolve(name);
  const def = DEFS[r.base];
  const n = def.frames || 1;
  const frames = new Array(n);
  for (let i = 0; i < n; i++) frames[i] = makeProp(name, seed, { on: opts ? opts.on : undefined, frame: i });
  return anim(frames, def.fps || 6, true);
}
