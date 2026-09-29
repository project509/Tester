/**
 * art/font.js — The in-scene 5×7 pixel bitmap font (96 glyphs, no font file).
 *
 * A condensed bold face: 2px left stems, 1px right stems and bars, true
 * lowercase with a 5-row x-height and 2-row descenders (g j p q y , ;).
 * Glyphs are proportional (2–5 px wide) and every draw is a crisp integer
 * `fillRect` run, so text stays chunky under nearest-neighbour upscaling and
 * looks identical on every device. Cap height is 7 units; a line advances 10.
 *
 * Public API:
 *   GLYPHS                         { char: { w, h, desc, rows:[string], runs:[[y,x,len]] } } (96)
 *   FONT                           { cap: 7, desc: 2, line: 10, space: 3 }
 *   drawText(ctx, text, x, y, { scale=1, color, align='left'|'center'|'right', spacing=1, shadow, outline }?)
 *   measureText(text, scale=1, spacing=1) → { w, h, lines }
 *   makeTextSprite(text, opts?) → spr     (cached; same opts as drawText, anchor top-left)
 */

import { PAL } from './palette.js';
import { makeSprite, cached } from './sprite.js';

/** Font metrics in units. */
export const FONT = Object.freeze({ cap: 7, desc: 2, line: 10, space: 3 });

/** Glyph sources: rows separated by '|', '#' = ink. Rows 8–9 are descender rows. */
const SRC = {
  ' ': '...|...|...|...|...|...|...',
  '!': '##|##|##|##|##|..|##',
  '"': '#.#|#.#|...|...|...|...|...',
  '#': '.#.#.|#####|.#.#.|.#.#.|#####|.#.#.|.....',
  $: '..#..|.####|##...|.###.|...##|####.|..#..',
  '%': '##..#|##.#.|...#.|..#..|.#...|.#.##|#..##',
  '&': '.##..|##.#.|.##..|###..|##.##|##.#.|.##.#',
  "'": '##|##|..|..|..|..|..',
  '(': '.##|##.|##.|##.|##.|##.|.##',
  ')': '##.|.##|.##|.##|.##|.##|##.',
  '*': '.....|#.#.#|.###.|#####|.###.|#.#.#|.....',
  '+': '.....|..#..|..#..|#####|..#..|..#..|.....',
  ',': '..|..|..|..|..|##|##|.#|#.',
  '-': '....|....|....|####|....|....|....',
  '.': '..|..|..|..|..|##|##',
  '/': '....#|...##|..##.|.##..|##...|#....|.....',
  0: '.###.|##..#|##..#|##.##|##..#|##..#|.###.',
  1: '.##.|###.|.##.|.##.|.##.|.##.|####',
  2: '.###.|##..#|...##|..##.|.##..|##...|#####',
  3: '####.|...##|...##|.###.|...##|...##|####.',
  4: '...##|..###|.#.##|##.##|#####|...##|...##',
  5: '#####|##...|##...|####.|...##|...##|####.',
  6: '.###.|##...|##...|####.|##..#|##..#|.###.',
  7: '#####|...##|...#.|..##.|..#..|.##..|.##..',
  8: '.###.|##..#|##..#|.###.|##..#|##..#|.###.',
  9: '.###.|##..#|##..#|.####|...##|...##|.###.',
  ':': '..|..|##|##|..|##|##',
  ';': '..|..|##|##|..|##|##|.#|#.',
  '<': '...#|..##|.##.|##..|.##.|..##|...#',
  '=': '....|....|####|....|####|....|....',
  '>': '#...|##..|.##.|..##|.##.|##..|#...',
  '?': '.###.|##..#|...##|..##.|..#..|.....|..#..',
  '@': '.###.|#...#|#.###|#.#.#|#.###|#....|.####',
  A: '.###.|##..#|##..#|#####|##..#|##..#|##..#',
  B: '####.|##..#|##..#|####.|##..#|##..#|####.',
  C: '.####|##..#|##...|##...|##...|##..#|.####',
  D: '####.|##..#|##..#|##..#|##..#|##..#|####.',
  E: '#####|##...|##...|####.|##...|##...|#####',
  F: '#####|##...|##...|####.|##...|##...|##...',
  G: '.####|##..#|##...|##.##|##..#|##..#|.####',
  H: '##..#|##..#|##..#|#####|##..#|##..#|##..#',
  I: '####|.##.|.##.|.##.|.##.|.##.|####',
  J: '.####|...##|...##|...##|...##|#..##|.###.',
  K: '##..#|##.#.|###..|###..|##.#.|##..#|##..#',
  L: '##...|##...|##...|##...|##...|##...|#####',
  M: '#...#|##.##|#####|##.##|##..#|##..#|##..#',
  N: '##..#|###.#|###.#|##.##|##.##|##..#|##..#',
  O: '.###.|##..#|##..#|##..#|##..#|##..#|.###.',
  P: '####.|##..#|##..#|####.|##...|##...|##...',
  Q: '.###.|##..#|##..#|##..#|##.##|##.#.|.##.#',
  R: '####.|##..#|##..#|####.|###..|##.#.|##..#',
  S: '.####|##...|##...|.###.|...##|...##|####.',
  T: '####|.##.|.##.|.##.|.##.|.##.|.##.',
  U: '##..#|##..#|##..#|##..#|##..#|##..#|.###.',
  V: '##..#|##..#|##..#|##..#|.#.#.|.###.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|#####|.#.#.',
  X: '##..#|##..#|.###.|..#..|.###.|##..#|##..#',
  Y: '##..#|##..#|##..#|.###.|..#..|..#..|..#..',
  Z: '#####|....#|...##|..##.|.##..|##...|#####',
  '[': '###|##.|##.|##.|##.|##.|###',
  '\\': '#....|##...|.##..|..##.|...##|....#|.....',
  ']': '###|.##|.##|.##|.##|.##|###',
  '^': '..#..|.###.|##.##|.....|.....|.....|.....',
  _: '.....|.....|.....|.....|.....|.....|#####',
  '`': '##.|.##|...|...|...|...|...',
  a: '.....|.....|.###.|...##|.####|##..#|.####',
  b: '##...|##...|####.|##..#|##..#|##..#|####.',
  c: '.....|.....|.####|##...|##...|##..#|.####',
  d: '...##|...##|.####|##..#|##..#|##..#|.####',
  e: '.....|.....|.###.|##..#|#####|##...|.####',
  f: '..##|.##.|####|.##.|.##.|.##.|.##.',
  g: '.....|.....|.####|##..#|##..#|##..#|.####|...##|.###.',
  h: '##...|##...|####.|##..#|##..#|##..#|##..#',
  i: '##|..|##|##|##|##|##',
  j: '.##|...|.##|.##|.##|.##|.##|.##|##.',
  k: '##...|##...|##.#.|###..|###..|##.#.|##..#',
  l: '##.|##.|##.|##.|##.|##.|.##',
  m: '.....|.....|##.#.|#####|#.#.#|#.#.#|#.#.#',
  n: '.....|.....|####.|##..#|##..#|##..#|##..#',
  o: '.....|.....|.###.|##..#|##..#|##..#|.###.',
  p: '.....|.....|####.|##..#|##..#|##..#|####.|##...|##...',
  q: '.....|.....|.####|##..#|##..#|##..#|.####|...##|...##',
  r: '....|....|##.#|###.|##..|##..|##..',
  s: '.....|.....|.####|##...|.###.|...##|####.',
  t: '.##.|.##.|####|.##.|.##.|.##.|..##',
  u: '.....|.....|##..#|##..#|##..#|##..#|.####',
  v: '.....|.....|##..#|##..#|##..#|.###.|..#..',
  w: '.....|.....|#...#|#.#.#|#.#.#|#####|.#.#.',
  x: '.....|.....|##..#|.###.|..#..|.###.|##..#',
  y: '.....|.....|##..#|##..#|##..#|##..#|.####|...##|.###.',
  z: '.....|.....|#####|...#.|..#..|.#...|#####',
  '{': '..##|.##.|.##.|##..|.##.|.##.|..##',
  '|': '##|##|##|##|##|##|##',
  '}': '##..|.##.|.##.|..##|.##.|.##.|##..',
  '~': '.....|.....|.##.#|#.##.|.....|.....|.....',
  '\x7f': '#####|#...#|#.#.#|#...#|#.#.#|#...#|#####',
};

/**
 * Compiles a row-string source into a glyph with horizontal ink runs.
 * @param {string} src
 * @returns {{ w:number, h:number, desc:number, rows:string[], runs:number[][] }}
 */
function compileGlyph(src) {
  const rows = src.split('|');
  const w = rows[0].length;
  const runs = [];
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    let x = 0;
    while (x < w) {
      if (r[x] !== '#') { x++; continue; }
      const start = x;
      while (x < w && r[x] === '#') x++;
      runs.push([y, start, x - start]);
    }
  }
  const h = rows.length;
  return Object.freeze({ w, h, desc: h > FONT.cap ? h - FONT.cap : 0, rows: Object.freeze(rows), runs: Object.freeze(runs) });
}

/** All 96 glyphs (printable ASCII 32–126 plus 127 as the missing-glyph box). */
export const GLYPHS = Object.freeze(Object.keys(SRC).reduce((acc, ch) => {
  acc[ch] = compileGlyph(SRC[ch]);
  return acc;
}, {}));

const MISSING = GLYPHS['\x7f'];

/** Glyph for a character (unknown characters render as the box). */
function glyphOf(ch) {
  const g = GLYPHS[ch];
  return g === undefined ? MISSING : g;
}

/** Width in units of one line of text at scale 1. */
function lineWidth(line, spacing) {
  let w = 0;
  for (let i = 0; i < line.length; i++) w += glyphOf(line[i]).w + spacing;
  return w > 0 ? w - spacing : 0;
}

/** True when any character of the line has a descender. */
function lineHasDesc(line) {
  for (let i = 0; i < line.length; i++) if (glyphOf(line[i]).desc > 0) return true;
  return false;
}

/**
 * Measures text (supports '\n'). `h` covers the cap height of every line plus
 * the descender of the last line when it has one; lines advance FONT.line.
 * @param {string} text @param {number} [scale] @param {number} [spacing] units between glyphs
 * @returns {{ w:number, h:number, lines:number }}
 */
export function measureText(text, scale, spacing) {
  const s = scale >= 1 ? Math.floor(scale) : 1;
  const sp = spacing === undefined ? 1 : spacing | 0;
  const lines = String(text === undefined || text === null ? '' : text).split('\n');
  let w = 0;
  for (let i = 0; i < lines.length; i++) w = Math.max(w, lineWidth(lines[i], sp));
  const last = lines[lines.length - 1];
  const h = (lines.length - 1) * FONT.line + FONT.cap + (lineHasDesc(last) ? FONT.desc : 0);
  return { w: w * s, h: h * s, lines: lines.length };
}

/**
 * Paints every glyph run of `text` through `rect(x, y, w, h)` (already scaled).
 * @param {(x:number,y:number,w:number,h:number)=>void} rect
 */
function layout(text, x, y, s, sp, align, rect) {
  const lines = String(text).split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const lw = lineWidth(line, sp) * s;
    let cx = align === 'center' ? x - (lw >> 1) : align === 'right' ? x - lw : x;
    cx = Math.round(cx);
    const cy = Math.round(y) + li * FONT.line * s;
    for (let i = 0; i < line.length; i++) {
      const g = glyphOf(line[i]);
      const runs = g.runs;
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        rect(cx + run[1] * s, cy + run[0] * s, run[2] * s, s);
      }
      cx += (g.w + sp) * s;
    }
  }
}

/** Resolves an optional colour flag (true → ink, string → that colour). */
function flagColor(v) {
  if (!v) return null;
  return typeof v === 'string' ? v : PAL.ink;
}

/**
 * Draws crisp bitmap text with `fillRect` runs (no fillText). (x, y) is the
 * top-left of the cap box (or top-centre / top-right for other alignments).
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text supports '\n'
 * @param {number} x @param {number} y
 * @param {{ scale?:number, color?:string, align?:'left'|'center'|'right', spacing?:number,
 *           shadow?:boolean|string, outline?:boolean|string }} [opts]
 *        shadow: 1-unit drop shadow (true = ink, or a colour); outline: 1-unit ring (true = ink, or a colour)
 * @returns {{ w:number, h:number, lines:number }} the measured size
 */
export function drawText(ctx, text, x, y, opts) {
  const o = opts || {};
  const s = o.scale >= 1 ? Math.floor(o.scale) : 1;
  const sp = o.spacing === undefined ? 1 : o.spacing | 0;
  const align = o.align === 'center' || o.align === 'right' ? o.align : 'left';
  const str = String(text === undefined || text === null ? '' : text);
  const rect = (rx, ry, rw, rh) => ctx.fillRect(rx, ry, rw, rh);
  const outlineHex = flagColor(o.outline);
  const shadowHex = flagColor(o.shadow);
  if (outlineHex) {
    ctx.fillStyle = outlineHex;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        layout(str, x + dx * s, y + dy * s, s, sp, align, rect);
      }
    }
  }
  if (shadowHex) {
    ctx.fillStyle = shadowHex;
    layout(str, x + s, y + s, s, sp, align, rect);
    if (outlineHex) layout(str, x + 2 * s, y + 2 * s, s, sp, align, rect);
  }
  ctx.fillStyle = o.color || PAL.paper;
  layout(str, x, y, s, sp, align, rect);
  return measureText(str, s, sp);
}

/**
 * Renders text into a cached unit sprite (anchor top-left, 1-unit padding when
 * shadow/outline is set). Same options as drawText except `align`.
 * @param {string} text
 * @param {{ scale?:number, color?:string, spacing?:number, shadow?:boolean|string, outline?:boolean|string }} [opts]
 * @returns {object} spr
 */
export function makeTextSprite(text, opts) {
  const o = opts || {};
  const s = o.scale >= 1 ? Math.floor(o.scale) : 1;
  const sp = o.spacing === undefined ? 1 : o.spacing | 0;
  const str = String(text === undefined || text === null ? '' : text);
  const color = o.color || PAL.paper;
  const outlineHex = flagColor(o.outline);
  const shadowHex = flagColor(o.shadow);
  const key = 'text:' + s + '|' + sp + '|' + color + '|' + (outlineHex || '') + '|' + (shadowHex || '') + '|' + str;
  return cached(key, () => {
    const m = measureText(str, s, sp);
    const pad = (outlineHex ? 1 : 0) + (shadowHex ? 1 : 0);
    const w = m.w + pad * 2 * s;
    const h = m.h + pad * 2 * s;
    const x0 = (outlineHex ? s : 0);
    const y0 = (outlineHex ? s : 0);
    return makeSprite(Math.max(1, w), Math.max(1, h), (p) => {
      const rect = (rx, ry, rw, rh, hex) => p.rect(rx, ry, rw, rh, hex);
      if (outlineHex) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            layout(str, x0 + dx * s, y0 + dy * s, s, sp, 'left', (rx, ry, rw, rh) => rect(rx, ry, rw, rh, outlineHex));
          }
        }
      }
      if (shadowHex) {
        layout(str, x0 + s, y0 + s, s, sp, 'left', (rx, ry, rw, rh) => rect(rx, ry, rw, rh, shadowHex));
        if (outlineHex) layout(str, x0 + 2 * s, y0 + 2 * s, s, sp, 'left', (rx, ry, rw, rh) => rect(rx, ry, rw, rh, shadowHex));
      }
      layout(str, x0, y0, s, sp, 'left', (rx, ry, rw, rh) => rect(rx, ry, rw, rh, color));
    }, { ox: 0, oy: 0 });
  });
}
