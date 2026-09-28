# HOLDOUT — Technical Architecture & Module Contracts

This document is the binding contract for every module. Implementers MUST expose exactly the APIs listed here
(you may add extra exports, never rename/remove listed ones). Read `docs/GDD.md` for game rules and numbers.

## 0. Golden rules

1. **Vanilla ES2020 modules.** No frameworks, no runtime dependencies, no network, no image/font files. Everything is generated in code.
2. `src/package.json` sets `"type":"module"` so node can `import()` any src module directly for tests. **One entry:** `src/main.js`. esbuild bundles to a single IIFE inlined into `dist/index.html` (`node build.js`). CSS lives in `src/ui/styles.css` (inlined).
3. **Targets:** iOS Safari 15+, Android Chrome 90+. Portrait phones 320–480 css-px wide (also fine on tablets). 60 fps on a mid-range 2021 phone. Never allocate in hot loops; pool objects; cache every generated sprite.
4. **No audio.** Feedback = haptics (`core/haptics.js`) + visuals.
5. **Deterministic procedural generation:** everything random derives from `makeRng(seed)`. `Math.random()` is forbidden in `src/game/**` and `src/art/**` (use the rng passed in). Cosmetic-only randomness in render/particles may use a module-level rng.
6. **State is plain data.** `G` (game state) is a JSON-serializable object; no class instances, no functions, no canvases inside it. Runtime caches (sprites, entities) live in scene/module locals keyed by ids.
7. **Events over imports** for cross-cutting reactions: modules emit on `bus` (`core/events.js`); UI listens. Game logic never touches the DOM. Art never touches game state.
8. **Errors must not kill the loop.** Wrap scene update/draw in try/catch at the loop level; log once per unique message.
9. **Mobile hygiene:** `touch-action: none` on canvases; prevent double-tap zoom; handle `visualViewport` resize; respect `env(safe-area-inset-*)`; pause sim when `document.hidden`; save on `visibilitychange`/`pagehide`.
10. Every module file starts with a 3–10 line header comment describing responsibility and its public API.

## 1. Directory layout

```
src/main.js                   boot + wiring (owned by integrator)
src/core/   rng.js events.js loop.js input.js haptics.js save.js util.js tween.js
src/render/ stage.js camera.js lights.js particles.js postfx.js draw.js
src/art/    palette.js noise.js sprite.js characters.js zombies.js rooms.js props.js backgrounds.js effects.js icons.js cards.js
src/game/   state.js content.js survivors.js rooms.js resources.js events.js siege.js scav.js crafting.js meta.js offline.js tutorial.js director.js balance.js
src/scenes/ manager.js boot.js title.js hold.js siege.js scav.js summary.js
src/ui/     dom.js styles.css (base layout) theme.css (design system) components.css hud.js share.js panels/*.js  — all *.css in src/ui are inlined (styles.css first)
pwa/        manifest.webmanifest sw.js icon-192.png icon-512.png
tools/      build/test helpers   tests/  playwright-core scripts
```

## 2. Coordinate system, layers, resolution

- **Stage** (`render/stage.js`) owns two canvases: `#scene` (2D context, where the whole frame is drawn) and `#output` (WebGL2, post-processed final image). If WebGL2 is unavailable, `#scene` is shown directly and `#output` hidden.
- `stage.W`, `stage.H` = css px of the viewport (visualViewport). `stage.dpr` = min(devicePixelRatio, 2). The scene canvas backing store is `W*rs × H*rs` where `rs = stage.renderScale` (1.0 default, 0.75 on "low" quality). The context is pre-scaled by `rs` so all drawing code works in **css px**.
- `stage.px` = pixel-art scale (integer: 2 if W < 600 else 3). Sprites are authored at "unit" resolution and drawn scaled by `px`. `ctx.imageSmoothingEnabled = false` for sprites; lighting/blur layers use smoothing.
- World coordinates are css px; `Camera` translates/zooms. Depth sorting by `y` (feet) within the world layer.
- Frame composition order (all into scene canvas):
  1. background (sky gradient, celestial, parallax cityscape/zone backdrop)
  2. world (rooms/props/entities sorted)
  3. FX (particles, effects) — some particles are emissive and also drawn to the emissive layer
  4. lighting: `lights.render()` multiplies a low-res light map (¼ res, smoothed) then adds the emissive layer with `lighter`
  5. in-scene labels (damage numbers, name tags)
  6. `postfx.render(sceneCanvas, params)` → output canvas (bloom, tilt-shift DOF, filmic grade, vignette, grain, aberration, flash)
- DOM `#ui` sits on top (`pointer-events:none` container; interactive children `pointer-events:auto`).

## 3. Core contracts (`src/core`)

### rng.js
```js
export function hashStr(str) → uint32
export function makeRng(seed /* number|string */) → rng
rng.seed            // number
rng.next()          // float [0,1)
rng.float(a=0,b=1)  // float [a,b)
rng.int(a,b)        // integer [a,b] inclusive
rng.chance(p)       // boolean
rng.pick(arr)       // element
rng.weighted(items /* [{w, ...}] or [[item,w],...] */) → item
rng.shuffle(arr)    // in-place Fisher-Yates, returns arr
rng.fork(label)     // new independent rng derived from (seed,label)
rng.gauss(mean=0, sd=1)
```
mulberry32; `makeRng('abc')` hashes the string.

### events.js
```js
export const bus = { on(name, fn) → off, once(name, fn) → off, off(name, fn), emit(name, payload) }
```
Listeners are called synchronously; exceptions are caught and logged (never break emit). Event catalogue in §8.

### loop.js
```js
export function createLoop({ update(dtSec), render(dtSec) , step = 1/30, maxSubSteps = 5 }) → loop
loop.start(); loop.stop(); loop.paused (bool); loop.fps (smoothed); loop.time (sec since start); loop.setTimeScale(x)
```
Fixed-step `update` with accumulator; `render` once per rAF. Auto-pauses on `document.hidden`, resumes on visible (emits `app:hidden` / `app:visible`). Clamp frame dt to 100 ms.

### input.js
```js
export function createInput(element, { camera? }) → input
input.on/off  (same signature as bus, local)  events:
  'down'  {x,y,id,t}         'up' {x,y,id,t,dur}
  'tap'   {x,y}              'doubletap' {x,y}      'longpress' {x,y}   (500 ms, cancel on move > 8px)
  'dragstart' {x,y}  'drag' {x,y,dx,dy,vx,vy}  'dragend' {x,y,vx,vy}  (starts after 8 px)
  'swipe'  {dir:'left'|'right'|'up'|'down', vx, vy}
  'pinch'  {scale, cx, cy}   (two-finger)
  'hold'   {x,y,dt}          (fires every frame while a pointer is held past 160 ms; for "hold to fire")
input.pointers  // live map id→{x,y,x0,y0,t0}
input.setEnabled(bool); input.destroy()
```
Coordinates in css px relative to the element. Uses Pointer Events with `touch-action:none`, `setPointerCapture`, and blocks context menu / double-tap zoom / gesture events. Multi-touch safe.

### haptics.js
```js
export const haptics = {
  supported: bool, enabled: bool, intensity: 0..1,
  setEnabled(bool), setIntensity(x),
  play(name, strength = 1),    // named pattern from the vocabulary (GDD §12), strength scales durations (0.3–1.5) and may drop pulses
  pulse(ms), pattern(msArray), stop(),
  vocabulary: { [name]: number[] }  // exported for UI/tests
}
```
Throttle: never more than one call per 30 ms, drop lower-priority ones (priority table inside). iOS fallback: when `navigator.vibrate` is missing, use the `<input type="checkbox" switch>` toggle trick inside the same user gesture where possible; otherwise no-op silently. Must never throw.

### save.js
```js
export const save = {
  KEY: 'holdout.v1', META_KEY: 'holdout.meta.v1',
  load() → G|null, store(G), clear(),
  loadMeta() → meta|null, storeMeta(meta),
  exportCode(G) → string (base64 JSON), importCode(str) → G|null,
  migrate(obj) → obj   // by obj.v
}
```
Never throws (localStorage quota / private mode → warns and returns false). Writes are debounced 500 ms via `save.storeSoon(G)`.

### util.js
```js
export const clamp, lerp, invLerp, remap, smoothstep, easeInOut, easeOut, easeIn, easeOutBack, easeOutElastic, damp(a,b,lambda,dt)
export function uid(prefix='') → string        // counter-based, deterministic per run: uses G.nextId when given (see state.js) — util.uid is for runtime only
export function fmt(n) → '1.2k'   fmtTime(minutes) → '06:40'   fmtDur(sec)
export function hexToRgb, rgbToHex, lerpColor(hexA, hexB, t) → hex, shade(hex, amt) → hex, hsl(h,s,l) → hex, rgba(hex, a) → 'rgba()'
export function deepClone(o), debounce(fn, ms), throttle(fn, ms), once(fn)
export const isIOS, isAndroid, isStandalone
```

### tween.js
```js
export const tweens = { to(obj, props, dur, { ease, delay, onUpdate, onDone }) → handle, cancel(handle), update(dt), clear() }
```

## 4. Render contracts (`src/render`)

### stage.js
```js
export function createStage({ sceneCanvas, outputCanvas }) → stage
stage.W, stage.H, stage.dpr, stage.px, stage.renderScale, stage.ctx, stage.sceneCanvas, stage.outputCanvas
stage.setQuality('high'|'medium'|'low')   // renderScale 1 / 0.85 / 0.7 and postfx feature flags
stage.resize()  (auto on resize/visualViewport; emits 'stage:resize' {W,H})
stage.begin()   // clears + sets transforms for the frame
stage.end(postParams)  // runs postfx (or no-op fallback)
stage.safe = { top, bottom, left, right }   // safe-area insets in css px (read from CSS env via a probe element)
```

### camera.js
```js
export function createCamera(stage) → cam
cam.x, cam.y (world coords at screen centre), cam.zoom, cam.minZoom, cam.maxZoom, cam.bounds {x0,y0,x1,y1}|null
cam.apply(ctx) / cam.reset(ctx)
cam.screenToWorld(sx, sy) → {x,y}; cam.worldToScreen(wx, wy)
cam.panBy(dx, dy) (screen px); cam.fling(vx, vy); cam.zoomAt(factor, sx, sy)
cam.moveTo(x, y, dur, ease) ; cam.follow(target|null, {lerp})
cam.shake(amp, dur) ; cam.kick(dx, dy)   // recoil-style offset that decays
cam.update(dt)   // inertia, bounds clamp with rubber-band, shake decay
```

### lights.js
```js
export function createLighting(stage) → lights
lights.ambient = '#hex' | [r,g,b] (0-255)    lights.ambientIntensity = 0..1
lights.add({ x, y, r, color:'#hex', intensity:1, flicker:0..1, type:'point'|'cone', angle, spread, emissive:0..1 }) → light  (mutable, .alive=false removes)
lights.remove(light); lights.clear()
lights.flash(x, y, r, color, dur)  // transient light (muzzle, explosion)
lights.update(dt)
lights.render(ctx, cam)   // ¼-res light map (radial gradients, 'lighter'), composited 'multiply' at full size with smoothing; then emissive layer 'lighter'
lights.drawEmissive(fn)   // queue a draw call (ctx)=>{} into the emissive layer for this frame (glowing sprites/particles)
```
Light positions are in world coords; render uses `cam`. Must handle 0–64 lights at 60 fps on mobile (batch gradients, cache gradient sprites per (r,color)).

### particles.js
```js
export function createParticles() → ps
ps.emit(type, x, y, opts = {}) // types: 'smoke','spark','ember','blood','dust','debris','muzzle','rain','snowash','glow','shell','flash','text'(floating number)
ps.burst(type, x, y, n, opts)
ps.update(dt); ps.draw(ctx, cam); ps.drawEmissive(ctx, cam); ps.clear(); ps.count
```
Pooled (max 1500). Each type has default physics (gravity, drag, life, size, color ramp, additive flag).

### postfx.js
```js
export function createPostFX(outputCanvas) → fx | null (null if WebGL2 unavailable)
fx.resize(w, h, dpr)
fx.render(sceneCanvas, params)
params = { exposure:1, contrast:1, saturation:1, warmth:0 (-1 cool … +1 warm split-tone), tint:[r,g,b] (0-1, multiply), bloom:0.6, bloomThreshold:0.6,
           focusY:0.5, dof:0.5, vignette:0.45, grain:0.06, aberration:0.4, flash:[r,g,b,a], time:sec, quality:'high'|'medium'|'low' }
fx.setQuality(q)
```
Pipeline: bright-pass → 2×(down+blur) at ¼ → composite shader with filmic (ACES-fit) tonemap, split toning, tilt-shift using the blurred chain, vignette, animated hash grain, edge chromatic aberration. Must re-upload the scene canvas via `texSubImage2D` each frame (allocate once; re-allocate on resize). Handle context loss (`webglcontextlost` → mark unavailable, stage falls back).

### draw.js
```js
export function drawSprite(ctx, spr, x, y, { flip=false, scale=1, alpha=1, rot=0, anchor='bottom' } = {})   // spr = {canvas,w,h,ox,oy} at unit res; multiplies by stage.px
export function drawFrame(ctx, anim, t, x, y, opts)   // anim = {frames:[spr], fps, loop}
export function drawLabel(ctx, text, x, y, { size=11, color='#fff', stroke='#000', align='center', font, alpha, weight })
export function drawBar(ctx, x, y, w, h, t, { fg, bg, border })
export function setPx(px)  // called by stage
```

## 5. Art contracts (`src/art`)

All generators are pure functions of (params, seed) and cache results in an internal `Map` keyed by a stable string. They return **unit-resolution** `{ canvas, w, h, ox, oy }` sprites (ox/oy = anchor offset, default bottom-centre) or `{frames:[...], fps}` animations. Generation must be fast: total boot generation (all base sets) < 1.5 s on a mid phone; generate lazily per need where possible and report progress via `bus.emit('boot:progress', {t, label})`.

### palette.js
`export const PAL = { skin:[...], hair:[...], cloth:[...], zombie:[...], metal, wood, concrete, blood, ui: {...} }`, `export function ramp(hex, n)` (shadow→light), `export function pick(rng, list)`.

### noise.js
`export function makeNoise(seed) → { v2(x,y), fbm(x,y,oct), worley(x,y) }` value-noise, [0,1).

### sprite.js  (the procedural pixel toolkit)
```js
export function makeSprite(w, h, draw /* (p) => void */, { ox, oy } = {}) → spr
// p = pixel painter: p.set(x,y,hex,a?) p.rect(x,y,w,h,hex) p.line(x0,y0,x1,y1,hex) p.ellipse(cx,cy,rx,ry,hex) p.fillCircle
//     p.outline(hex) p.shadeVertical(rampArr) p.dither(x,y,w,h,hexA,hexB) p.noise(rng,x,y,w,h,hex,density) p.get(x,y) p.hflip() p.ctx (raw 2D ctx)
export function cached(key, factory) → any
export function compose(w, h, layers /* [{spr, x, y, flip}] */) → spr
export function tint(spr, hex, amount) → spr
export function outline(spr, hex) → spr
export function anim(frames, fps, loop=true) → {frames, fps, loop}
export function toDataURL(spr, scale)   // for CSS/DOM icons
```

### characters.js
```js
export function makeAppearance(rng, { role? }) → appearance   // plain data: {skin,hair,hairStyle,beard,eyes,build,outfit,hat,accessory,scar}
export function makeSurvivorAnims(appearance, gear = {}) → { idle, walk, work, shoot, melee, hurt, dead, carry }  // each anim {frames, fps}
export function makePortrait(appearance, size = 48, { mood = 'neutral', dead=false } = {}) → spr  // detailed bust for UI, deterministic
```
Body ≈ 16×32 units, 4–6 frames per anim; gear (weapon/armor) drawn as overlays.

### zombies.js
```js
export const ZOMBIE_TYPES = [...]   // ids from GDD §5
export function makeZombieAnims(type, seed) → { walk, attack, die, idle, hit }
```

### rooms.js
```js
export function makeRoomArt(type, tier, cells /* width in cells */, seed) → { spr /* whole room interior incl. walls */, lights:[{x,y,r,color,flicker}], workSpots:[{x,y,anim:'work'|'idle'}], propsBBox }
export const ROOM_CELL = { w: 64, h: 48 }   // unit px of one cell (scene px = ×stage.px)
export function makeExteriorArt(floors, width, seed) → { spr: facade/ruins around the tower }
export function makeGateArt(barricadeTier, damage01) → spr
```

### props.js
`export function makeProp(name, seed) → spr` (crates, sandbags, barrels, cars, corpses, signs, lamp, generator, bed, table, plants, tv, fridge…).

### backgrounds.js
```js
export function drawSky(ctx, W, H, { hour, weather, seed })  // gradient + sun/moon + stars + clouds; cheap per frame (cache gradient per hour bucket)
export function makeCityscape(seed, layerIdx, W) → spr   // parallax layer (tileable horizontally)
export function makeZoneBackdrop(zoneType, seed, W, H) → { layers:[{spr, parallax, y}], groundY, lights:[...] }
export function drawWeather(ctx, W, H, weather, t)      // rain streaks / ash / fog overlay (calls particles where appropriate)
```

### effects.js
`makeMuzzleFlash(seed)`, `makeBloodSplat(seed)`, `makeExplosionAnim()`, `makeSmokePuff()`, `makeImpact()`, `makeBiteFx()`.

### icons.js
`export function icon(name, size=16) → dataURL` for resources/stats/rooms/items; `export const ICONS = [...names]`. Deterministic, cached.

### cards.js
`export function renderCard(kind /* 'obituary'|'run'|'fortress'|'daily' */, data, G) → HTMLCanvasElement (1080×1350)`; `export async function shareCard(canvas, text)` (Web Share files → fallback download).

## 6. Game contracts (`src/game`)

### state.js
```js
export const SAVE_VERSION = 1
export function newGame({ seed, mode = 'season', mutators = [], legacy }) → G
export function nextId(G) → number   // G.nextId++
G = {
  v, seed, mode, mutators, createdAt, day, minute /*0..1439*/, phase: 'day'|'dusk'|'night'|'dawn', speed: 1|2|3,
  res: { food, water, power, scrap, meds, ammo }, caps: {...}, morale, noise, threat,
  hold: { floors: [ { y, rooms: [ { id, type, tier, x, cells, assigned:[survivorIds], hp, state } ] } ], gate: { tier, hp, hpMax, traps:[] } },
  survivors: [ { id, name, appearance, stats:{...}, lvl, xp, hp, hpMax, hunger, thirst, fatigue, morale, infection: null|{t, stage}, injuries:[], traits:[], gear:{weapon,armor}, job: {roomId}|null, status:'idle'|'working'|'resting'|'scav'|'defending'|'sick'|'dead', log:[] } ],
  graveyard: [ ... ],  inventory: { items: { [itemId]: count } },
  siege: null | { ... live siege data ... },   scav: null | { ... live run data ... },
  eventLog: [ {day, text, kind} ], pendingEvent: null | { id, ... }, flags: {}, stats: {...counters...}, tutorial: { step, done }, nextId,
  settings: { haptics: true, hapticIntensity: 1, quality: 'high', reducedMotion: false }
}
```
The exact fields for rooms, survivors, items, siege, scav are defined by the GDD + `TECH_SPEC.md` (§9 below). All numbers must live in `balance.js`.

### director.js (the game flow brain)
```js
export function createDirector({ G, bus, scenes }) → director
director.update(dtSec)     // advances G.minute by speed × rate, runs resources/survivor ticks at fixed cadence, triggers phases: dusk warning → night siege scene → dawn summary
director.startSiege(); director.endSiege(result); director.startScav(survivorId, zoneId); director.endScav(result)
director.pause()/resume()/isPaused
director.checkEnd()        // win/loss detection → 'game:over'
```

Other game modules export pure-ish functions operating on `G` (e.g. `rooms.build(G, type, floorIdx, x)`, `survivors.tick(G, minutes)`, `resources.tick(G, minutes)`, `events.roll(G, rng)`, `siege.createSiege(G)`, `siege.step(S, dt, inputs)`, `scav.createRun(G, survivorId, zone)`, `scav.step(R, dt, inputs)`, `crafting.craft(G, recipeId)`, `meta.award(meta, G)`, `offline.apply(G, elapsedSec)`, `tutorial.step(G)`). They return `{ ok, reason }` for actions and emit bus events for UI.

## 7. Scenes & UI

### scenes/manager.js
```js
export function createScenes() → scenes
scenes.register(name, scene); scenes.go(name, data, { transition: 'fade'|'iris'|'cut', dur }); scenes.current; scenes.update(dt); scenes.draw(ctx); scenes.postParams()
scene = { enter(data), exit(), update(dt), draw(ctx), postParams() → partial postfx params, onTap(e), onDrag(e), onDragEnd(e), onPinch(e), onHold(e), onLongPress(e), onSwipe(e), onResize() }
```
Transitions are drawn by the manager (fade to black / iris) over the scene canvas.

### ui/dom.js
```js
export function h(tag, attrs, ...children) → el      // attrs: class, style(obj), on{Event}, dataset, html; children: string|Node|array|null
export const ui = { root, mount(el), toast(msg, {kind, icon, dur}), modal({title, body, actions:[{label, kind, onClick}], dismissable}) → handle,
                    sheet({ title, body, height:'half'|'full' }) → handle (bottom sheet with drag-to-dismiss), closeAll(), confirm(msg) → Promise<bool>,
                    banner(text, kind), flash(kind), setScreen(name) /* toggles body[data-screen] */ , bind(el, fn) /* re-render fn on 'state:changed' */ }
```
Panels are functions `openXPanel(ctx)` in `ui/panels/*.js` that build DOM with `h()` and subscribe to `bus` for refresh. Every button press calls `haptics.play('tap')` (UI helper `ui.btn(label, onClick, opts)` does this automatically).

## 8. Event catalogue (bus)

```
app:hidden / app:visible / stage:resize {W,H} / boot:progress {t,label} / boot:done
state:changed {what}          (throttled UI refresh trigger; emitted by director every sim tick and by every action)
time:phase {phase, day}        time:day {day}
res:changed {key, delta}       res:low {key}
room:built {room}  room:upgraded {room}  room:damaged {room}  room:assigned {room, survivorId}
survivor:joined / survivor:levelup / survivor:injured / survivor:infected / survivor:turned / survivor:died {survivor, cause} / survivor:returned
event:offer {event}  event:resolved {event, choice, outcome}
siege:start {S}  siege:wave {n}  siege:kill {z, by}  siege:breach  siege:end {result}
scav:start {R}  scav:loot {item}  scav:threat {level}  scav:extract {R}  scav:end {result}
craft:done {recipe}   meta:unlock {id}   game:over {win, summary}   tutorial:step {step}
haptic:played {name}  (for tests)
```

## 9. TECH_SPEC.md

After the GDD is final, `docs/TECH_SPEC.md` pins the exact data schemas (rooms, items, survivors, siege, scav), balance tables, and per-module function lists. Implementers read GDD + ARCHITECTURE + TECH_SPEC.

## 10. Debug/test hooks

`main.js` exposes `window.HOLDOUT = { G, bus, director, scenes, stage, haptics, save, version, debug: { skipTo(phase), giveRes(), spawnSiege(), newGame(opts), tick(minutes) } }`. Tests drive the game through this. Never gate gameplay on it.

## 11. Performance budget (per frame, mid phone)

update ≤ 2 ms · scene draw ≤ 6 ms · lights ≤ 2 ms · postfx ≤ 4 ms · DOM refresh ≤ 1 ms (batched, only on `state:changed`, max 10 Hz). Scene canvas texture upload ≤ 2 ms (keep `renderScale ≤ 1`, dpr ≤ 2).
