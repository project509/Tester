/**
 * render/postfx.js — WebGL2 post-processing: bloom, tilt-shift DOF, filmic grade.
 *
 * Takes the finished 2D scene canvas, uploads it once per frame (texSubImage2D
 * into a texture allocated once per size) and runs a small chain of passes:
 * bright-pass (soft threshold) → separable Gaussian blur at ¼ res → (high) a
 * second level at ⅛ res, plus a blurred copy of the whole scene (½ res on high,
 * ¼ on medium) for tilt-shift depth of field. The composite pass then applies
 * exposure, an ACES-fit filmic tonemap, contrast, saturation, warm/cool split
 * toning, tint, vignette, animated luminance-weighted grain, radial chromatic
 * aberration and a flash overlay, writing the final sRGB image to #output.
 * Everything is uniform-driven; no allocations happen per frame. Context loss
 * marks fx.available=false (the stage falls back to the raw scene canvas) and
 * the pipeline rebuilds itself on webglcontextrestored.
 *
 * Public API:
 *   createPostFX(outputCanvas) → fx | null   (null: no WebGL2 / shader failure)
 *   fx.resize(w, h, dpr) · fx.render(sceneCanvas, params) → boolean · fx.setQuality('high'|'medium'|'low')
 *   fx.available (bool) · fx.quality · fx.drawCalls (last frame) · fx.destroy()
 *   DEFAULT_POST — neutral parameter set (see ARCHITECTURE.md §4)
 */

/** Neutral post-processing parameters; every field may be overridden per frame. */
export const DEFAULT_POST = Object.freeze({
  exposure: 1,
  contrast: 1,
  saturation: 1,
  warmth: 0,
  tint: Object.freeze([1, 1, 1]),
  bloom: 0.6,
  bloomThreshold: 0.6,
  focusY: 0.5,
  dof: 0.5,
  vignette: 0.45,
  grain: 0.06,
  aberration: 0.4,
  flash: Object.freeze([0, 0, 0, 0]),
  time: 0,
  quality: 'high',
});

const QUALITIES = { high: 2, medium: 1, low: 0 };
const BLOOM_KNEE = 0.25;
const MAX_DIM = 4096;

// ── shaders ──────────────────────────────────────────────────────────────────

const VERT = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/** 4-tap box downsample (bilinear taps at ±1 source texel cover a 4×4 block). */
const FRAG_DOWN = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  o = vec4(c * 0.25, 1.0);
}`;

/** Box downsample + soft-knee bright pass: gamma-space threshold, linear-energy output. */
const FRAG_BRIGHT = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
uniform float uKnee;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv + uTexel * vec2(-1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0, -1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2(-1.0,  1.0)).rgb
         + texture(uTex, vUv + uTexel * vec2( 1.0,  1.0)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  soft = soft * soft / (4.0 * uKnee + 1e-4);
  float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
  o = vec4(c * c * contrib, 1.0);
}`;

/** 13-tap Gaussian as 7 bilinear taps; uDir = direction / destination size. */
const FRAG_BLUR = `#version 300 es
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uDir;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 o1 = uDir * 1.4117647;
  vec2 o2 = uDir * 3.2941176;
  vec2 o3 = uDir * 5.1764706;
  vec3 c = texture(uTex, vUv).rgb * 0.1964825;
  c += (texture(uTex, vUv + o1).rgb + texture(uTex, vUv - o1).rgb) * 0.2969069;
  c += (texture(uTex, vUv + o2).rgb + texture(uTex, vUv - o2).rgb) * 0.0944703;
  c += (texture(uTex, vUv + o3).rgb + texture(uTex, vUv - o3).rgb) * 0.0103813;
  o = vec4(c, 1.0);
}`;

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform sampler2D uBloom2;
uniform sampler2D uDofTex;
uniform vec2 uAspect;     // vignette ellipse correction
uniform vec2 uPxUv;       // one css px in uv units
uniform vec2 uGrainRes;   // grain cells across the frame
uniform float uExposure, uContrast, uSaturation, uWarmth, uBloomStr, uBloom2On;
uniform float uFocusY, uDof, uVignette, uGrain, uAberration, uTime;
uniform vec3 uTint;
uniform vec4 uFlash;
in vec2 vUv;
out vec4 o;

const vec3 LUMA = vec3(0.299, 0.587, 0.114);
const vec3 COOL = vec3(-0.055, 0.002, 0.128);   // #1e2a44 minus its luma, normalised (luma-neutral)
const vec3 WARM = vec3(0.100, -0.024, -0.140);  // #ffb36b minus its luma, normalised

vec3 aces(vec3 x) { return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); }

// ACES fit with pre-exposure 0.8 and white point 1.1, blended with identity so
// mids stay put and only highlights/bloom get the filmic shoulder.
vec3 tonemap(vec3 x) {
  vec3 f = aces(x * 0.8) * 1.2898;
  float w = 0.4 + 0.6 * clamp((dot(x, LUMA) - 0.6) * 2.0, 0.0, 1.0);
  return mix(x, f, w);
}

float hash(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);   // image space, y down (matches the 2D canvas)
  vec2 d = uv - 0.5;

  vec3 scene;
  if (uAberration > 0.0) {
    vec2 ab = d * (uAberration * 3.0) * uPxUv;
    scene = vec3(texture(uScene, uv + ab).r, texture(uScene, uv).g, texture(uScene, uv - ab).b);
  } else {
    scene = texture(uScene, uv).rgb;
  }
  if (uDof > 0.0) {
    float band = smoothstep(0.0, 1.0, (abs(uv.y - uFocusY) - 0.12) / 0.38) * uDof;
    scene = mix(scene, texture(uDofTex, uv).rgb, band);
  }

  vec3 bloom = texture(uBloom, uv).rgb;
  if (uBloom2On > 0.5) bloom += texture(uBloom2, uv).rgb * 0.8;

  vec3 lin = (scene * scene + bloom * uBloomStr * 1.5) * uExposure;
  vec3 c = sqrt(clamp(tonemap(lin), 0.0, 1.0));

  c = (c - 0.5) * uContrast + 0.5;
  float l = dot(c, LUMA);
  c = mix(vec3(l), c, uSaturation);

  float a = abs(uWarmth) * 0.9;
  vec3 shadowTone = uWarmth >= 0.0 ? COOL : WARM;
  vec3 highTone = uWarmth >= 0.0 ? WARM : COOL;
  c += (shadowTone * (1.0 - l) + highTone * l) * a;
  c *= uTint;

  float r = length(d * uAspect);
  c *= 1.0 - uVignette * smoothstep(0.25, 1.15, r);

  vec2 cell = floor(uv * uGrainRes);
  float n = hash(cell + vec2(fract(uTime * 7.31) * 97.0, fract(uTime * 3.17) * 61.0));
  float gw = mix(0.3, 1.0, 4.0 * l * (1.0 - l));
  c += (n - 0.5) * uGrain * gw;

  c = mix(c, uFlash.rgb, uFlash.a);
  o = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

const COMPOSITE_UNIFORMS = [
  'uScene', 'uBloom', 'uBloom2', 'uDofTex', 'uAspect', 'uPxUv', 'uGrainRes',
  'uExposure', 'uContrast', 'uSaturation', 'uWarmth', 'uBloomStr', 'uBloom2On',
  'uFocusY', 'uDof', 'uVignette', 'uGrain', 'uAberration', 'uTime', 'uTint', 'uFlash',
];

// ── helpers ──────────────────────────────────────────────────────────────────

let warned = false;
function warnOnce(msg, detail) {
  if (warned) return;
  warned = true;
  if (typeof console !== 'undefined' && console.warn) console.warn('[postfx] ' + msg, detail || '');
}

function num(v, def) {
  return typeof v === 'number' && v === v ? v : def;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Numeric [r,g,b(,a)] with fallback for missing/short arrays. */
function vec(v, def, n) {
  if (!v || v.length < n) return def;
  for (let i = 0; i < n; i++) if (typeof v[i] !== 'number' || v[i] !== v[i]) return def;
  return v;
}

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    warnOnce('shader compile failed', gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

/** Links a program and caches the listed uniform locations on `.u`. */
function buildProgram(gl, fragSrc, uniformNames) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    warnOnce('program link failed', gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  const u = {};
  for (let i = 0; i < uniformNames.length; i++) u[uniformNames[i]] = gl.getUniformLocation(prog, uniformNames[i]);
  return { prog, u };
}

function makeTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Creates or resizes an RGBA8 render target {fbo, tex, w, h}. */
function makeTarget(gl, target, w, h) {
  const rt = target || { fbo: gl.createFramebuffer(), tex: makeTexture(gl), w: 0, h: 0 };
  if (rt.w === w && rt.h === h) return rt;
  gl.bindTexture(gl.TEXTURE_2D, rt.tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt.tex, 0);
  rt.w = w;
  rt.h = h;
  return rt;
}

function deleteTarget(gl, rt) {
  if (!rt) return;
  gl.deleteFramebuffer(rt.fbo);
  gl.deleteTexture(rt.tex);
}

// ── factory ──────────────────────────────────────────────────────────────────

/**
 * Creates the post-processing pipeline on `outputCanvas`.
 * @param {HTMLCanvasElement} outputCanvas canvas that receives the final image
 * @returns {object|null} fx, or null when WebGL2 is unavailable / shaders fail
 */
export function createPostFX(outputCanvas) {
  if (!outputCanvas || typeof outputCanvas.getContext !== 'function') return null;
  let gl = null;
  try {
    gl = outputCanvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
  } catch (err) {
    gl = null;
  }
  if (!gl) {
    warnOnce('WebGL2 unavailable; post-processing disabled');
    return null;
  }

  const fx = {
    available: true,
    quality: 'high',
    drawCalls: 0,
    resize,
    render,
    setQuality,
    destroy,
  };

  // GL resources (rebuilt on context restore)
  let progDown = null, progBright = null, progBlur = null, progComp = null;
  let vao = null, vbo = null;
  let sceneTex = null, sceneW = 0, sceneH = 0;
  // Render targets: q* = ¼ res, e* = ⅛ res, h* = ½ res
  let qA = null, qB = null, qC = null, eA = null, eB = null, hA = null, hB = null;
  let outW = 0, outH = 0, dpr = 1, cssW = 0, cssH = 0;
  let level = QUALITIES.high;
  let lost = false;
  let destroyed = false;
  let checkErrors = true; // getError() only after (re)allocation, never every frame

  /** Compiles programs and creates the fullscreen-triangle VAO. */
  function init() {
    gl.getError(); // clear any stale error flag so glOk('init') reports only ours
    progDown = buildProgram(gl, FRAG_DOWN, ['uTex', 'uTexel']);
    progBright = buildProgram(gl, FRAG_BRIGHT, ['uTex', 'uTexel', 'uThreshold', 'uKnee']);
    progBlur = buildProgram(gl, FRAG_BLUR, ['uTex', 'uDir']);
    progComp = buildProgram(gl, FRAG_COMPOSITE, COMPOSITE_UNIFORMS);
    if (!progDown || !progBright || !progBlur || !progComp) return false;

    vao = gl.createVertexArray();
    vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    sceneTex = makeTexture(gl);
    sceneW = sceneH = 0;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

    // Sampler units are fixed per program; bind once.
    gl.useProgram(progComp.prog);
    gl.uniform1i(progComp.u.uScene, 0);
    gl.uniform1i(progComp.u.uBloom, 1);
    gl.uniform1i(progComp.u.uBloom2, 2);
    gl.uniform1i(progComp.u.uDofTex, 3);
    gl.useProgram(progDown.prog);
    gl.uniform1i(progDown.u.uTex, 0);
    gl.useProgram(progBright.prog);
    gl.uniform1i(progBright.u.uTex, 0);
    gl.useProgram(progBlur.prog);
    gl.uniform1i(progBlur.u.uTex, 0);
    checkErrors = true;
    return glOk('init');
  }

  /** Forgets every GL object without deleting (after context loss they are invalid). */
  function dropRefs() {
    progDown = progBright = progBlur = progComp = null;
    vao = vbo = sceneTex = null;
    qA = qB = qC = eA = eB = hA = hB = null;
  }

  /** Frees every GL object (used on destroy and after an init failure). */
  function release() {
    if (!gl.isContextLost()) {
      for (const p of [progDown, progBright, progBlur, progComp]) if (p) gl.deleteProgram(p.prog);
      if (vao) gl.deleteVertexArray(vao);
      if (vbo) gl.deleteBuffer(vbo);
      if (sceneTex) gl.deleteTexture(sceneTex);
      for (const rt of [qA, qB, qC, eA, eB, hA, hB]) deleteTarget(gl, rt);
    }
    dropRefs();
  }

  /** Reads the GL error flag once; disables the pipeline on a real error. */
  function glOk(where) {
    if (!checkErrors) return true;
    checkErrors = false;
    const err = gl.getError();
    if (err === gl.NO_ERROR || err === gl.CONTEXT_LOST_WEBGL) return true;
    warnOnce('GL error 0x' + err.toString(16) + ' during ' + where);
    fx.available = false;
    return false;
  }

  /** (Re)allocates all offscreen targets for the current output size. */
  function allocTargets() {
    const q = (n, d) => Math.max(1, Math.ceil(n / d));
    qA = makeTarget(gl, qA, q(outW, 4), q(outH, 4));
    qB = makeTarget(gl, qB, q(outW, 4), q(outH, 4));
    qC = makeTarget(gl, qC, q(outW, 4), q(outH, 4));
    eA = makeTarget(gl, eA, q(outW, 8), q(outH, 8));
    eB = makeTarget(gl, eB, q(outW, 8), q(outH, 8));
    hA = makeTarget(gl, hA, q(outW, 2), q(outH, 2));
    hB = makeTarget(gl, hB, q(outW, 2), q(outH, 2));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    checkErrors = true;
  }

  /**
   * Sets the output backing store to round(w*dpr) × round(h*dpr) and resizes
   * the bloom / DOF targets to match.
   * @param {number} w css px width  @param {number} h css px height  @param {number} pixelRatio device pixel ratio (≤ 2 recommended)
   */
  function resize(w, h, pixelRatio) {
    if (destroyed) return;
    cssW = Math.max(1, num(w, 1));
    cssH = Math.max(1, num(h, 1));
    dpr = Math.max(0.5, num(pixelRatio, 1));
    outW = Math.min(MAX_DIM, Math.max(1, Math.round(cssW * dpr)));
    outH = Math.min(MAX_DIM, Math.max(1, Math.round(cssH * dpr)));
    if (outputCanvas.width !== outW) outputCanvas.width = outW;
    if (outputCanvas.height !== outH) outputCanvas.height = outH;
    if (lost || !fx.available) return;
    allocTargets();
  }

  /**
   * Selects the pipeline size: 'high' full chain, 'medium' no ⅛ level and ¼-res
   * DOF copy, 'low' single bloom level and no DOF / aberration (≤ 5 draws).
   * @param {'high'|'medium'|'low'} q
   */
  function setQuality(q) {
    const lv = QUALITIES[q];
    if (lv === undefined) return;
    level = lv;
    fx.quality = q;
  }

  /** Uploads the scene canvas into the scene texture (allocating on size change). */
  function uploadScene(sceneCanvas) {
    const w = sceneCanvas.width | 0;
    const h = sceneCanvas.height | 0;
    if (w < 1 || h < 1) return false;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    if (w !== sceneW || h !== sceneH) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      sceneW = w;
      sceneH = h;
      checkErrors = true;
    }
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, sceneCanvas);
    return true;
  }

  /** Binds `rt` (or the canvas when null) as the draw target and sets the viewport. */
  function bindTarget(rt) {
    if (rt) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, rt.fbo);
      gl.viewport(0, 0, rt.w, rt.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, outW, outH);
    }
  }

  function draw() {
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    fx.drawCalls++;
  }

  /** Box-downsamples `srcTex` (srcW×srcH) into `dst`. */
  function passDown(srcTex, srcW, srcH, dst) {
    gl.useProgram(progDown.prog);
    gl.uniform2f(progDown.u.uTexel, 1 / srcW, 1 / srcH);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    bindTarget(dst);
    draw();
  }

  function passBright(threshold, dst) {
    gl.useProgram(progBright.prog);
    gl.uniform2f(progBright.u.uTexel, 1 / sceneW, 1 / sceneH);
    gl.uniform1f(progBright.u.uThreshold, threshold);
    gl.uniform1f(progBright.u.uKnee, BLOOM_KNEE);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    bindTarget(dst);
    draw();
  }

  /** One blur direction from `src` into `dst` (kernel radius in dst texels). */
  function passBlur(src, dst, horizontal) {
    gl.useProgram(progBlur.prog);
    if (horizontal) gl.uniform2f(progBlur.u.uDir, 1 / dst.w, 0);
    else gl.uniform2f(progBlur.u.uDir, 0, 1 / dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    bindTarget(dst);
    draw();
  }

  /** Separable blur src → tmp → src (result stays in src). */
  function blurInPlace(src, tmp) {
    passBlur(src, tmp, true);
    passBlur(tmp, src, false);
  }

  function passComposite(p, bloomA, bloomB, dofRt, dofOn, aberrationOn) {
    const u = progComp.u;
    gl.useProgram(progComp.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, (bloomB || bloomA).tex);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, (dofRt || bloomA).tex);

    const tint = vec(p.tint, DEFAULT_POST.tint, 3);
    const flash = vec(p.flash, DEFAULT_POST.flash, 4);
    gl.uniform2f(u.uAspect, 1, Math.sqrt(outH / outW));
    gl.uniform2f(u.uPxUv, dpr / outW, dpr / outH);
    gl.uniform2f(u.uGrainRes, cssW, cssH);
    gl.uniform1f(u.uExposure, Math.max(0, num(p.exposure, 1)));
    gl.uniform1f(u.uContrast, Math.max(0, num(p.contrast, 1)));
    gl.uniform1f(u.uSaturation, Math.max(0, num(p.saturation, 1)));
    gl.uniform1f(u.uWarmth, Math.max(-1, Math.min(1, num(p.warmth, 0))));
    gl.uniform1f(u.uBloomStr, Math.max(0, num(p.bloom, DEFAULT_POST.bloom)));
    gl.uniform1f(u.uBloom2On, bloomB ? 1 : 0);
    gl.uniform1f(u.uFocusY, clamp01(num(p.focusY, 0.5)));
    gl.uniform1f(u.uDof, dofOn ? clamp01(num(p.dof, DEFAULT_POST.dof)) : 0);
    gl.uniform1f(u.uVignette, clamp01(num(p.vignette, DEFAULT_POST.vignette)));
    gl.uniform1f(u.uGrain, clamp01(num(p.grain, DEFAULT_POST.grain)));
    gl.uniform1f(u.uAberration, aberrationOn ? Math.max(0, num(p.aberration, DEFAULT_POST.aberration)) : 0);
    gl.uniform1f(u.uTime, num(p.time, 0) % 1000);
    gl.uniform3f(u.uTint, tint[0], tint[1], tint[2]);
    gl.uniform4f(u.uFlash, flash[0], flash[1], flash[2], clamp01(flash[3]));
    bindTarget(null);
    draw();
  }

  /**
   * Post-processes `sceneCanvas` into the output canvas.
   * @param {HTMLCanvasElement} sceneCanvas finished 2D frame
   * @param {object|null} params see DEFAULT_POST (missing fields use defaults)
   * @returns {boolean} false when the pipeline is unavailable (caller falls back)
   */
  function render(sceneCanvas, params) {
    if (destroyed || lost || !fx.available || !sceneCanvas) return false;
    if (gl.isContextLost()) {
      lost = true;
      fx.available = false;
      return false;
    }
    const p = params || DEFAULT_POST;
    if (typeof p.quality === 'string' && p.quality !== fx.quality) setQuality(p.quality);
    if (!qA) {
      // resize() not called yet: size the output to the scene canvas at dpr 1.
      if (outW < 1) resize(sceneCanvas.width | 0, sceneCanvas.height | 0, 1);
      else allocTargets();
      if (!qA) return false;
    }
    fx.drawCalls = 0;
    gl.bindVertexArray(vao);
    if (!uploadScene(sceneCanvas)) return false;

    const threshold = clamp01(num(p.bloomThreshold, DEFAULT_POST.bloomThreshold));
    passBright(threshold, qA);
    blurInPlace(qA, qB);

    if (level === QUALITIES.low) {
      passComposite(p, qA, null, null, false, false);
    } else if (level === QUALITIES.medium) {
      passDown(sceneTex, sceneW, sceneH, qC);
      blurInPlace(qC, qB);
      passComposite(p, qA, null, qC, true, true);
    } else {
      passBlur(qA, eA, true);
      passBlur(eA, eB, false);
      passDown(sceneTex, sceneW, sceneH, hA);
      blurInPlace(hA, hB);
      passComposite(p, qA, eB, hA, true, true);
    }
    gl.bindVertexArray(null);
    return glOk('render');
  }

  function onContextLost(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    lost = true;
    fx.available = false;
    dropRefs();
  }

  function onContextRestored() {
    if (destroyed) return;
    lost = false;
    fx.available = init();
    if (!fx.available) return;
    if (outW > 0) allocTargets();
    warned = false;
  }

  /** Removes listeners and frees GL resources; the fx is unusable afterwards. */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    fx.available = false;
    outputCanvas.removeEventListener('webglcontextlost', onContextLost);
    outputCanvas.removeEventListener('webglcontextrestored', onContextRestored);
    release();
  }

  if (!init()) {
    release();
    return null;
  }
  outputCanvas.addEventListener('webglcontextlost', onContextLost, false);
  outputCanvas.addEventListener('webglcontextrestored', onContextRestored, false);
  return fx;
}
