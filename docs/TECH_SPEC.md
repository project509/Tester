# HOLDOUT — Technical Specification (binding)

Companion to `ARCHITECTURE.md` (engine contracts) and `GDD.md` (rules + numbers). Where this document and the GDD differ on
*engine* matters (resolution, fonts, rendering), this document wins; on *game rules and numbers*, the GDD wins and `balance.js` mirrors it.

## 1. Deviations from the GDD (engine decisions)

1. **Resolution**: no fixed 240-px buffer. Units × `stage.px` (2 on phones, 3 ≥ 600 css px wide). Floor = 176×56 units, survivor 20×32, zombie 20×32 (bloater 24×32, brute 28×40), portrait 32×32. See `ARCHITECTURE.md §2`.
2. **Text**: DOM UI uses the system font stack (theme.css). The 5×7 bitmap font (`art/font.js`) is used for in-scene labels, the siege/scav in-canvas HUD accents and share cards (so cards are identical everywhere).
3. **Chromatic aberration** exists in postfx but defaults to 0 in all grades; it is pulsed briefly (0.6) only on BREACH and on the survivor-death grey-out.
4. **Time**: turn-based per the GDD (timers advance 12 h at each Dawn and Dusk boundary). There is no offline simulation (`game/offline.js` is dropped). A cosmetic clock drives the sky: during the Day phase the visual hour eases from 06:00 to 17:30 over the first 4 real minutes of the phase, Dusk Prep sits at 18:30, Siege runs 21:00→05:00 over its duration, Dawn Report shows 06:00.
5. **Live segments are not persisted** (overrides GDD §2 "snapshots every 1 s"): if the app is killed mid-Siege or mid-Scav, the segment restarts from its beginning on resume with the same seed (same horde / same zone layout, so a force-quit is not a reroll of the layout). `G.siege`/`G.scav` hold only the *plan* needed to restart. On `app:hidden` the loop pauses and a RESUME overlay counts down 1 s on return. Storage is localStorage (no IndexedDB).
6. **Settings** live in `meta` (persist across runs), not in `G`.
7. **Haptics**: game code uses the GDD §12 names (`UI_TICK`, `BREACH`, …). `core/haptics.js` `VOCABULARY` must contain every GDD name (add them as aliases/patterns; keep the existing lowercase set). Owner: the `game-director` implementer adds them.
8. **Share cards** are 1080×1350 (4:5, the group-chat thumbnail sweet spot) instead of 1080×1920; obituary/run/daily kinds per GDD §9. The last 20 cards' data is kept in `meta.cards`.
9. **Everything in the GDD ships** — including the Scope Guard's optional items (Second Runner, Night Sortie, zone modifiers, the Named Brute, act cards, the extraction dodge tap, tilt-shift, the Wall render). Nothing is cut.

## 2. Game flow (state machine)

```
BOOT → TITLE → (NEW RUN: seed/mutators/roster draft) → HOLD[day=1, phase='day']
HOLD/day:   free actions (build, upgrade, demolish, assign, craft, repair, survivor actions, broadcast, trader)
            context button: 'SEND' (opens Zone Select; "Stay home" link) → SCAV (live) → Scav Result sheet → back to HOLD (dayFlags.ranScav=true)
            context button: 'NIGHT' → Dusk Prep sheet → 'HOLD THE GATE' → director.resolveDusk() → SIEGE (live)
SIEGE end → director.resolveDawn(siegeResult) → HOLD[phase='dawn'] with Dawn Report sheet (cards, then event choice) → 'START DAY N+1' → phase='day'
GAME OVER (roster 0 or evacuation) → SUMMARY scene (run summary + card) → TITLE
```
`G.phase ∈ 'day' | 'dusk' | 'night' | 'dawn'`. `director.contextButton(G)` returns `{ label, action, enabled, hint }`:
- phase 'day' & !ranScav & !stayedHome → `SEND`; phase 'day' otherwise → `NIGHT`; phase 'dusk' (Dusk Prep open) → `HOLD THE GATE`; phase 'dawn' → `START DAY N+1`; game over → `SUMMARY`.

Boundaries (all in `director.js`, each step appends report lines):
- **resolveDusk(plan)**: store plan (`G.siege = { plan }`), phase='dusk'→'night'; `+12 h` to all timers (`survivors.advanceHours(G, 12)` — may trigger TURN at this boundary), Infirmary heals, natural regen, production (`rooms.production(G)` with power budget), consumption (`resources.consume(G)`), morale deltas, fracture timers, dayNoise additions (generator, traits), storm handling (no siege → skip to dawn), beacon power check.
- **resolveDawn(siegeResult)**: apply siege deaths/bites/breach/barricade, kills/morale; `+12 h`; turns; hidden-bite notices (Nerve ≥ 6 roommate) and 24 h confessions; walkouts (Morale < 10) and refusals (< 30); heat = min(20, round(0.6 × (heat + dayNoise))) (Loud World 0.8; Blood Moon nights 21/27 keep 100 %); dayNoise = 0; day++; zone unlocks; Familiar Face queue; recruit knock (Broadcast); beacon countdown; win/loss; event roll → `G.events.pending`; build `G.dawnReport`; streak update in meta; autosave.

## 3. State schema (`game/state.js`) — exact

```js
G = {
  v: 1, seed: 'K7R2QX', seedNum: uint32, mode: 'season'|'daily', dailyDate: null|'YYYY-MM-DD', mutators: [] /* 'dry'|'fast'|'loud'|'short' */,
  createdAt: ms, updatedAt: ms, day: 1, phase: 'day',
  dayFlags: { ranScav:false, stayedHome:false, broadcast:false, rerolled:false, traderUsed:false, quietNight:false, storm:false },
  res: { food:16, water:16, scrap:50, meds:2, ammo:30 },
  morale: 60, heat: 0, dayNoise: 0, peakSiegeNoise: 0,
  hold: { floors: [ { idx:0..7, room: Room|null } ] },   // floors[0].room = {type:'gate',tier:1}, floors[7].room = {type:'radio',tier:0}
  gate: { hp:60, hpMax:100, breached:false },
  survivors: [Survivor], graveyard: [Survivor & { death: { day, cause, where, night:bool } }],
  inventory: { throwables: { molotov:1, pipebomb:0, flare:0 }, gear: { pistol:2, shotgun:0, rifle:0, bat:2, machete:0, vest:0 }, kits:0 },
  zones: { unlocked: ['suburbs'], visits: { suburbs:0, mall:0, hospital:0, forest:0, depot:0 } },
  siege: null | { plan: SiegePlan, night: day },  scav: null | { survivorId, zoneId, seedLabel },
  events: { pending: null|EventInstance, trader: null|{ offeredDay }, fireTomorrow:false, history: [id], lastWantDay: 0 },
  dawnReport: null | { day, cards: [ReportCard] },   // ReportCard = { kind:'deaths'|'bites'|'siege'|'economy'|'heat'|'question', title, lines:[{icon,text,kind}], data }
  beacon: { lit:false, nightsLeft:0, litDay:0 },
  familiar: [ { snapshot: SurvivorSnapshot, night: day, reason:'exile'|'zone' } ],
  log: [ { day, text, kind } ] /* cap 300 */, stats: { kills:0, shots:0, breaches:0, runs:0, deaths:0, loot:0, nights:0, focusKills:0, maxHeat:0, heatHistory:[] },
  tutorial: { step: 0, done: false, seen: {} }, nextId: 1,
  result: null | { won:bool, day, nights, cause, moment:string, marks:number }
}
Room = { id, type:'gate'|'bunks'|'kitchen'|'cistern'|'generator'|'workshop'|'infirmary'|'armory'|'watchtower'|'radio', tier:0..3, workers:[survivorId] /* max 2 */, patients:[survivorId] /* infirmary only */, powered:true, seed:uint32 }
Survivor = { id, name:'Dana Okafor', first, last, appearance /* art/characters makeAppearance data */, portraitSeed:uint32,
  stats:{ grit, aim, hands, nerve } /* effective 1..10 incl. trait deltas */, traits:[traitId, traitId], backstory, want:'food'|'water'|'scrap'|'meds'|'ammo'|'gear',
  hp, hpMax /* 20+grit*8 */, wounds:[ { type:'bleed'|'fracture', hours:0 } ] /* max 3 */,
  bite: null | { hours:0, hidden:bool, known:bool, confessed:bool, maxHours:48|72|96 },
  weapon:null|'pistol'|'shotgun'|'rifle'|'bat'|'machete', armor:null|'vest', roomId:null|number, patientOf:null|number,
  role: null|'gate'|'tower'|'bracer' /* dusk plan */, refusing:false, suspect:false /* hypochondriac ring */,
  kills:0, nights:0, runs:0, joinedDay:1, rival:null|id, legacy:false /* from The Wall Remembers */, log:[ { day, text } ] /* cap 40 */ }
SurvivorSnapshot = { id, name, appearance, portraitSeed, traits, stats, kills, nights, joinedDay, log }
SiegePlan = { gate:[id|null,id|null], tower:id|null, bracer:id|null, throwables:['molotov'|'pipebomb'|'flare'|null ×3], lightBeacon:bool }
EventInstance = { id, day, params:{ survivorId?, rivalId?, zoneId?, roomId? }, rerolled:false }
meta = { v:1, marks:0, spent:0, unlocks:[], streak:{ count:0, last:'' }, runs:[RunSummary] /* cap 30 */, fallen:[SurvivorSnapshot] /* cap 40 */,
         daily:{ 'YYYY-MM-DD': { night, alive, won } }, totals:{ runs, wins, nights, kills, deaths, obitsShared }, settings:{ haptics:true, hapticIntensity:1, quality:'high', reducedMotion:false, showSeed:true }, seenTitle:false }
```
Ids are integers from `nextId(G)`. `state.newGame({ seed, mode, mutators, meta, roster })` builds `G` with the 4 drafted survivors (roster comes from `survivors.draft`). `state.snapshot(s)`; `state.validate(G)` returns a repaired copy (used after `save.load`).

## 4. Module APIs (`src/game`) — every function takes `G` first unless noted; mutators return `{ ok, reason?, ...data }` and emit bus events

### balance.js — `export const B = {...}` mirroring GDD §3, §4, §5, §6, §8, §11 exactly (rooms table, output formula factors, traits, wounds/infection hours, siege timings, zombie table, zone table, containers/loot, attention, extraction, horde formula, heat, legacy costs, mutators, weapons, crafting, start kit). Pure data + tiny helpers: `B.horde(day, heat, mods)`, `B.roomOutput(tierBase, stat)`, `B.siegeDuration(day)`, `B.searchTime(hands)`, `B.accuracy(aim, bonus)`.
### content.js — name pools (≥ 80 first, ≥ 80 last, gender-neutral mix), 40 backstory templates with slot lists (jobs, towns, quirks), `TRAITS` (id → { name, blurb, benefit, cost }), `WANTS`, zone copy (`ZONES[id] = { name, blurb, unlockDay }`), event copy, dawn/tutorial copy, `obituarySentence(snapshot, death)`, `definingMoment(G)`, `sysLine(kind, ...)`. Exports `makeName(rng)`, `makeBackstory(rng)`.
### survivors.js — `draft(rng, meta, n=4)` (16–22 points, one stat ≥ 6 each in different stats, 2 traits w/ costs applied, Old Hand/Wall-Remembers from meta), `generate(rng, G, opts)` (recruits), `advanceHours(G, hours, rng)` → lines (bleed, fracture, infection → `turn`), `damage(G, s, amount, { cause, biteChance, source, rng })` → { died, bitten }, `bite(G, s, rng, { forceHidden })`, `cure(G, s)` (Meds tiers by hours), `check(G, s)`, `putDown(G, s)`, `exile(G, s)`, `kill(G, s, cause, where)`, `heal(G, s, n)`, `canScav(s)`, `canDefend(s)`, `refuses(s, role)`, `stat(G, s, key)` (effective incl. shortages), `hpMax(s)`, `noticeHiddenBites(G, rng)` → lines, `walkouts(G, rng)` → lines, `refusals(G, rng)`, `turn(G, s, rng)` → lines (roommate 30 HP + 50 % bite, highest-Aim puts down, 1 ammo, −15 morale), `obituary(snap)`.
### rooms.js — `defs()` (from B), `canBuild(G, floorIdx, type)`, `build(G, floorIdx, type)`, `upgrade(G, roomId)`, `demolish(G, roomId)`, `assign(G, survivorId, roomId|null)`, `admit(G, survivorId, roomId)` (infirmary patient), `discharge`, `byId(G, id)`, `floorIdx(G, roomId)`, `workersOf`, `outputOf(G, room)` → { key, amount, perWorker }, `powerBudget(G)` → { produced, draw, deficit, unpowered:[roomId] } (unpowered from roof down), `production(G)` → { food, water, scrap, ammo, meds } (+lines), `adjacencyBonus(G, room)`, `rosterCap(G)`, `craftTier(G)` (best workshop), `armoryBonus(G)`, `towerBonus(G)`, `repairGate(G, hpWanted)` (1 scrap / 5 HP, day only), `gateMaxHp(tier)`, `radioTier(G)`, `hordePreviewAvailable(G)`.
### resources.js — `canAfford(G, cost)`, `spend(G, cost)`, `add(G, key, n)`, `consume(G)` → lines (food/water per survivor, shortage effects), `daysOfSupply(G, key)`, `deltaPreview(G)` → per-key expected daily delta (for HUD arrows), `moraleDelta(G, n, why)`.
### events.js — `EVENTS` (18 from GDD §7; each `{ id, title, weight(G), cond(G), pick(G, rng) → params, text(G, params) → { lines:[string], portrait: survivorId|icon }, choices:[{ id, label, sub, cost?, risk?:bool, enabled(G), apply(G, rng, params) → { lines, haptic } }] }`), `roll(G, rng)` → EventInstance|null, `resolve(G, instance, choiceId, rng)` → { lines }, `reroll(G, rng)` (Radio T2 once/day), `traderOffer(G)`.
### siege.js — `hordeComposition(G, rng)` → [{type, count}], `createSiege(G, rng)` → S, `step(S, G, dt, input)`, `finish(S, G)` → SiegeResult.
```js
S = { t:0, T /*s*/, hardDawn: T+45, waves:[{at, spawned:false, count}], zombies:[Z], defenders:[D], bracer:{ id, x, hp? (uses survivor hp), bracing:false, knockback:0 }, barricade:{ hp, hpMax, planks }, noise:0, noiseThresholds:{25:false,...}, fires:[{x0,x1,t}], clouds:[{x,t}], flare:null|{x,t}, throwables:[type|null×3], cooldownThrow:0, focus:{ zid, until }, ceaseFire:{ [defenderId]:bool }, breached:false, breachT:0, kills:0, shots:0, log:[], events:[] /* drained by scene each frame: {kind:'shot'|'kill'|'hit'|'spawn'|'throw'|'breach'|'roar'|'scream'|'pop'|'bite'|'death', ...} */, result:null, ended:false, rng }
Z = { id, type, x /* 1 = spawn edge, 0 = barricade */, hp, hpMax, speed, state:'walk'|'attack'|'roar'|'scream'|'dying'|'dead'|'stunned', t, target:'wall'|'bracer'|'flare'|'inside', variant:uint32, familiar:null|SurvivorSnapshot, lane:0..2 /* draw row */, burning:0 }
D = { survivorId, slot:'gate'|'gate2'|'tower', weapon, cooldown, ceaseFire:false, targetId:null, x }
input = { focus:null|zid, brace:bool, throwAt:null|{ slot, x }, toggleCease:null|defenderId }
SiegeResult = { won, kills, shots, barricadeHp, breached, deaths:[{id,cause}], bites:[id], damaged:[{id,hp}], peakNoise, familiarRest:[snapshot], survived:true, hardDawn:bool, byType:{} }
```
Rules per GDD §5 + §11 (fire every 1.0 s; accuracy 0.45+0.05×aim+tower bonus cap 0.95; melee at 0 ammo; Focus 3 s +50 % 1 s cd; Brace 4 HP/s; throwables; Screamer/Brute/Bloater/Runner behaviours; noise decay 3/s and mini-waves; breach rules; Familiar Face). `S.events` is the visual/haptic feed; the scene drains it.
### scav.js — `zones(G)` (unlocked list with info), `createRun(G, survivorId, zoneId, rng)` → R, `step(R, G, dt, input)`, `finish(R, G)` → ScavResult, `applyResult(G, R, result)` (adds loot to res/inventory, wounds, bites, rescue, dayNoise += floor(attention/25), survivor log, stats).
```js
R = { zoneId, survivorId, seed, W /* units */, screens:[Screen], screenIdx:0, x /* survivor world x in units */, y, facing:1|-1, crouch:false, state:'idle'|'walk'|'search'|'attack'|'hurt'|'sprint'|'extract'|'dead'|'home', target:null|{x}|{containerId}|{zombieId}, searchT:0, attention:0, attentionThresholds:{33:false,66:false,100:false}, pack:[ { item, n } ] /* 8 slots */, hp (mirror), t:0, extractT:0, extractScreen:0, encounters:[], kills:0, bitten:false, wounds:[], rescued:null, events:[] /* drained: 'step','search','loot','wake','alert','hit','bite','kill','wave','hazard','extract','home','death','scream' */, result:null, ended:false, log:[], rng }
Screen = { idx, x0, containers:[{ id, kind, x, state:'closed'|'open', loot:[{item,n}] /* pre-rolled */, notDead:bool }], zombies:[{ id, type, x, asleep, hp, hpMax, state, t, variant, facing }], hazard:null|{ kind:'alarm'|'dog'|'floor', x, seen:bool }, rescue:null|Survivor, props:[{ name, x, layer:0|1 }] }
input = { tapWorld:null|{x,y}, tapContainer:null|id, tapZombie:null|id, longPress:bool, swipe:null|'left'|'right' }
ScavResult = { extracted, died, pack, loot:{ food, water, scrap, meds, ammo, kits, throwables:{}, gear:{} }, attention, screensReached, kills, bitten, wounds, hpLeft, rescued, encounters, log }
```
Rules per GDD §6 (search time, crouch, attack, sprint +2/s attention, extraction timing and encounters, waves behind at 33/66/100, hazards, sleepers wake radius, container tables, pack stacking, corpse not dead 15 %).
### crafting.js — `RECIPES` (ammo8/5, molotov/6 T2, machete/20 T2, pipebomb/12 T3, flare/8 T3, shotgun/30 armoryT2, vest/25 armoryT2, rifle/60 armoryT3, med/4 infirmaryT3), `available(G)` → [{recipe, canAfford, unlocked}], `craft(G, id)`, `equip(G, survivorId, slot:'weapon'|'armor', item|null)` (swaps into inventory), `weaponStats(item)`.
### meta.js — `load()`, `store(meta)`, `UNLOCKS` (8, GDD §8), `MUTATORS` (4), `marksFor(G)`, `awardRun(meta, G)` → { marks, streakMult }, `unlock(meta, id)`, `touchStreak(meta, todayStr)`, `dailySeed(dateStr)`, `dailyMutator(dateStr)`, `todayStr()`, `rememberFallen(meta, snapshot)`, `applyUnlocksToNewGame(meta, G)`.
### tutorial.js — steps for the first 90 s (GDD §10): `STEPS` [{ id, when(G) → bool, text, target:'repair'|'survivor:first'|'room:1'|'build:bunks'|'send'|'container'|'zombie:wall'|'startDay', haptic }], `current(G)`, `complete(G, id)`, `skip(G)`. UI renders a pointing hand + text pill at the target (targets resolved by the scene/UI via `bus.emit('tutorial:target', {...})`).
### director.js — `createDirector({ G, meta, bus, scenes, ui, rng })` → `{ contextButton(), doContext(), startNewGame(opts), continueGame(), abandonRun(), openZoneSelect(), sendRunner(id, zoneId), stayHome(), beginDusk(), holdTheGate(plan), onSiegeEnd(result), onScavEnd(result), startNextDay(), resolveEvent(choiceId), rerollEvent(), broadcast(), repair(hp), checkEnd(), setG(G), update(dt) /* cosmetic hour, autosave debounce */, visualHour() }`. Owns the rng streams (`rng.fork('day'+day)`), autosaves (`save.storeSoon`) after every mutation, and is the only module that calls `scenes.go`. Emits `time:phase`, `state:changed`, `game:over`.

## 5. Scenes (`src/scenes`) — world layouts in units (× stage.px for css px)

- **boot.js**: shows a procedural loading screen (tower silhouette, progress bar) while `art` pre-generates base sets in chunks (≤ 16 ms per rAF slice) → `scenes.go('title')`.
- **title.js**: background = the Hold renderer in "attract" mode (a seeded demo tower at dusk with lamps flicking on, slow camera drift, embers); DOM menu via `ui/panels/title.js`.
- **hold.js**: world origin at the gate floor's bottom-left; tower x ∈ [0,176], floor i spans y ∈ [−(i+1)·56, −i·56] (floor 0 at the bottom, roof at top); ground/street strip below y=0; exterior strips left/right; parallax cityscape behind; sky by `director.visualHour()`. Camera: vertical pan only (x locked to tower centre), bounds with rubber-band, fling, RATCHET haptic per floor crossed. Hit-testing: tap on floor i → room sheet / build menu (empty) / gate sheet (floor 0) / radio sheet (floor 7); tap on a survivor sprite (within its bbox, sprites sorted by y) → survivor sheet; long-press on survivor → drag portrait (DOM ghost) with room glow by stat fit; drop → assign (ASSIGN_SNAP) or DENY. Renders: rooms (`makeRoomArt(type, tier, seed, {powered})`), survivors at `workSpots` with anims by status (working: 'work' anim; resting in bunks: 'rest'; idle wander on their floor: 'walk'/'idle' with simple pacing AI; sick: 'rest' in infirmary; infected ring drawn as an arc over the head when known), the Wall portraits on floor 0, gate planks by hp, unpowered floors darkened (lights off), lights from room specs + moon/sun ambient from `skyPalette(hour)`, weather, dusk lamp flicker-on sequence (UI_TICK per room), DOF focus band at the touched floor (`focusY` follows last tap), grade preset by phase (Dawn/Day/Dusk/Night per GDD §13). Exposes `hold.focusFloor(i)`, `hold.revealTower()` (intro bottom-up reveal), `hold.attractMode(bool)`.
- **siege.js**: street world: gate at x ∈ [0, 88] (the tower's floor 0 seen from the street side: barricade doorway at x≈80), street from x=88 to x=88+2.2·W; ground line y=0; zombies walk from x_spawn = 88+1.1·W toward the barricade (S.x 1→0 maps linearly); lanes offset y by 0/6/12 units for depth; defenders drawn in the doorway (gate slots) and on the watchtower ledge above (tower slot); bracer at the barricade. Camera: fixed on the gate third with a slow drift toward the action's centroid (max 0.3·W), shake on hits, kick on shots. Input mapping (from `input` gestures): tap on zombie → `input.focus`; hold within the barricade zone → `brace`; swipe up from the tray → `throwAt`; double-tap on defender → `toggleCease`. Drains `S.events` → particles (muzzle, blood, shells, sparks, smoke, fire), lights.flash, haptics (SHOT/SHOTGUN/FOCUS_LOCK/BARRICADE_HIT/BRUTE_SLAM/ROAR/SCREAM/BLOATER_POP/BREACH/BITE/DEATH/HORDE_INCOMING/SIEGE_WON), hit-stop (60 ms) on focus kills, 200 ms + 6 px shake on Brute death, 0.5° roll while a Screamer lives, vignette tightening with barricade HP, breach grade (desaturate, keep red). In-canvas HUD (bitmap font): timer, wave pips; DOM overlay (`ui/panels/siegeHud.js`): barricade bar with 5 plank pips, noise meter, throwable tray (3 slots with counts), defender chips (ammo, cease-fire state), Cease-fire indicator. On `S.ended` → `director.onSiegeEnd(finish(S,G))` after a 1.2 s beat.
- **scav.js**: side-scroller: screen k spans x ∈ [k·W, (k+1)·W] units (W = stage.W/stage.px); ground y=0 at 300 units from the top (backdrop.ground.y); backdrop parallax layers from `makeZoneBackdrop`; survivor drawn with `makeSurvivorAnims(appearance, gear)`; containers/props/zombies from `R.screens`; camera follows the survivor with 24-unit lookahead, clamped to the current screen ± 30 units (screens are discrete rooms; a sprint scrolls to the next). Input: tap ground → walk; tap container → search (progress ring, SEARCH_LOOP); tap zombie → attack; long-press → crouch toggle; swipe right → sprint next screen; swipe left → extract (confirm not needed; a 300 ms hold-arrow to prevent accidents: the arrow fills then extracts). Extraction plays the run-home montage: camera pans left across visited screens quickly, CHASE_STEP haptics, encounter flashes; home → EXTRACT_HOME, iris out. Death: camera locks, grade drains to grey over 3 s with aberration 0.6, DEATH haptic, then result. DOM overlay (`ui/panels/scavHud.js`): portrait + wound icons top-left, pack grid top-right (8 slots), Attention bar with 33/66/100 ticks, extract arrow at left edge, crouch state chip, zone name + screen index.
- **summary.js**: run summary (tower snapshot drawn once, roster portraits) + DOM (`ui/panels/summary.js`) with Marks earned, streak, Defining Moment, share card button, "Back to Title".

## 6. UI panels (`src/ui/panels`) — DOM, built with `ui/dom.js`, refreshed via `ui.bind`

| File | Contents |
|---|---|
| hud.js (src/ui/) | Top bar: 5 resource pills (icon, value, delta arrow from `resources.deltaPreview`, red when `daysOfSupply < 1`), Power pill (produced/draw), Morale face (5 states), Heat ring (0–20, red), Day counter + phase label + cosmetic clock. Bottom: the **context button** (label from `director.contextButton()`, pulse animation when the tutorial points to it) + a small secondary row (Roster, Build, Log) icons. Hidden during Siege/Scav. |
| title.js | Title card (logo text with bitmap-font sprite or styled DOM), Continue (if save: shows day/roster), New Run, Daily Challenge (today's seed + mutator, one attempt), Legacy, Settings; streak flame with count; version + seed chip. |
| newRun.js | Seed field (6 chars, random + "paste" button), mutator chips with descriptions and +10 % Marks each, Roster Draft: 4 survivor cards (portrait, name, stats bars, traits with benefit/cost, backstory) + one Reroll (per draft), START. |
| roomSheet.js | Room name/tier/icon, output line (per worker, adjacency), worker slots (portrait chips; tap → pick survivor from a list sorted by stat fit), Upgrade (cost, next tier effect), Demolish (50 % refund, confirm), room-specific: Gate (repair slider 1 Scrap/5 HP with RATCHET detents, barricade tier upgrade, defender note), Infirmary (patients, Cure/Check actions with costs), Workshop/Armory/Infirmary crafting list (`crafting.available`), Radio (Broadcast once/day, Reroll event at T2, Beacon status/T3 build ≥ day 20), Bunks (roster cap), Watchtower (tonight's composition at T2+ when dusk). Empty floor → Build menu (room cards with cost/output/stat/power draw, affordable state). |
| survivorSheet.js | Portrait (mood by state, infection ring/`?` ring), name, backstory, want, traits (benefit/cost), 4 stat bars, HP bar, wounds with hour timers, bite panel (hours/known/hidden note, Cure cost + chance, Check 1 Med), gear (weapon/armor selectors from inventory), assignment (room chip → tap to change), actions: Put Down / Exile (confirm, morale costs), log (last 6 lines). Dead survivors show the obituary + Share button. |
| zoneSelect.js | Zone cards (name, blurb, unlock day, screens/containers if Cartographer, loot focus icons, threat icons, starting Attention from Heat), runner picker (eligible survivors: not fractured/defender-locked, shows pack traits), Start Run; "Stay home" text link. |
| scavResult.js | Loot list with counts (LOOT haptics as lines reveal), wounds/bites, rescued survivor card, attention → dayNoise added, survivor log line; Continue. |
| duskPrep.js | Defender slots: Gate ×2, Watchtower ×1 (if built) — tap slot → pick survivor (accuracy preview), Bracer picker (default highest Hands), 3 throwable slots from inventory, horde preview (Watchtower T2+: counts by type; otherwise "?" with total estimate range), Light the Beacon toggle (Radio T3, day ≥ 20), warnings (no ammo, no defenders, barricade < 25 %), HOLD THE GATE button. |
| dawnReport.js | Cards revealed one at a time (tap/auto 1.2 s; RESOURCE_TICK per line): Deaths (obituary stubs with Share) → Bites/turns/notices → Siege (kills, shots, barricade, breach) → Economy (production/consumption with deltas) → Heat (ring fills to today's value; dayNoise breakdown) → Question (event card / knock / zone unlocked). Event card: portrait, 2 lines, 2–3 choice buttons with cost/risk chips; Radio T2 reroll button. Then START DAY N+1. |
| obituary.js | Full-screen obituary card preview (rendered by `art/cards.js`), Share (Web Share files → download fallback), SHUTTER haptic + flash; Marks note (max 5 shared per run). |
| summary.js | Run summary: EVACUATED / FELL stamp, night reached, roster (dead greyed), Heat sparkline (canvas), Defining Moment, Marks breakdown (nights + win + shared × streak), unlock hints, Share card, Back to Title. |
| legacy.js | Marks balance, 8 unlock cards (cost, effect, owned), streak flame, past runs list, the Fallen list (portraits, run, cause). |
| settings.js | Haptics on/off + intensity slider (test button), Quality (auto/high/medium/low), Reduce motion, Show seed, Export/Import save code, Reset data (confirm twice), Credits/how-to-play (short). |
| siegeHud.js / scavHud.js | See §5. |
| tutorialLayer.js | Pointing hand + pill text anchored to a target rect (from `bus 'tutorial:target'`), Skip link. |

## 7. Share cards (`art/cards.js`)
`renderCard(kind, data, G, meta)` → 1080×1350 canvas: dark paper texture (noise), grain, vignette, the bitmap font at ×6/×8, portrait at ×12 nearest-neighbour, seed chip bottom-right, "HOLDOUT" wordmark. Kinds: `obituary` { snapshot, death }, `run` { G }, `daily` { G }. `shareCard(canvas, text)` → tries `navigator.share({ files })`, else download link `holdout-<kind>-<seed>.png`; returns 'shared'|'downloaded'|'failed'.

## 8. main.js (integrator) responsibilities
Create stage/camera/lights/particles/input/tweens; register scenes; load meta + save; apply settings; wire input → `scenes.dispatch`; loop: update (tweens, camera, lights, particles, director, scenes) / render (stage.begin, scenes.draw, stage.end(postParams)); register the service worker (`navigator.serviceWorker.register('sw.js')` guarded, only on http(s)); expose `window.HOLDOUT`; global error guard (log once, `ui.toast` in dev); handle `app:hidden` → autosave.

## 9. Addendum — final GDD reconciliation (binding; supersedes §2–§6 where they differ)

The GDD was revised after §2–§6 were written. These rules are final. `balance.js` already carries the numbers (`B.START.prebuilt`, `B.HORDE.composition`, `B.ZONE_MODS`, `B.SIEGE.*`, `B.SCAV.extract.*`, `B.LEGACY.unlocks` (10), `B.DRAMA`, `B.RNG_STREAMS`, …).

### 9.1 Flow & boundaries
- **Start of run:** Kitchen T1 pre-built on floor 1 (Tinker: Workshop T1 on floor 2), Scrap 40, Radio slot empty (`floors[7].room = { type:'radio', tier:0 }`, buildable any time). Roster Draft shows **6** survivors, the player picks **4**, one REROLL of all six (`rng.fork('rosterReroll')`). Owned unlocks are toggle chips (`G.unlocksOn: [ids]`, default all owned; the Daily runs with none).
- **Build rule:** the Build Menu opens only from the **lowest empty floor** (floors 1–6); Radio is independent.
- **Dusk order** (director.resolveDusk): 1 +12 h · 2 infection (pending cure rolls, clock ticks, turns) · 3 power budget from staffing (draw-0 rooms never cut) · 4 production (with yesterday's shortage stat penalties; runner's room ×0.5; Quiet Night ×1.25; Storm → Kitchen 0) · 5 consumption + shortage flags · 6 Bleed · 7 Infirmary healing (needs ≥ 1 worker; `tierBase × (0.7 + 0.06 × best worker Hands)`, Medic ×1.5, unpowered ×0.5) · 8 Morale (Bunks, +2 fed, −3 drift while > 50, trait dailies, −2/day over cap) · 9 Beacon power check · 10 autosave → Dusk Prep. Storm Night: the context button reads SLEEP, no siege, barricade −40, dayNoise 0, the night counts as played.
- **Dawn order** (director.resolveDawn): 1 +12 h · 2 siege results (deaths → Wall, obituaries queued, `floor(peakNoise/25)` + 1 per surviving Brute/Bloater into dayNoise, `round(0.25 × leftovers)` carried into tomorrow's base as Shamblers) · 3 infection (ticks, turns, Hypochondriac 20 %, notices 60 % at Nerve ≥ 6 / 100 % at ≥ 8, confessions at ≥ 50 % of the clock) · 4 Bleed, then +5 regen · 5 Morale (+5 clean night: no breach/death/known bite; −5 survived badly; Familiar ±6; −10 per death; over-cap −2) · 6 refusal (< 30) and walk-out (< 10) rolls · 7 `heat = min(20, round(0.6 × (heat + dayNoise)))` (Loud World 0.8; a Blood Moon dawn keeps 100 %), then dayNoise = 0 · 8 roster-cap check, zone unlock · 9 event: chained Fire pre-empts; else weighted roll with 3-day cooldowns (`rng.fork('event:'+day)`); else *Quiet Morning* filler · 10 autosave → Dawn Report. Act cards at Dawn 10 (**PRESSURE**: reveals both Blood Moon nights and names the Brute) and Dawn 20 (**BEACON**).
- **End of run:** roster 0 → 2 s hold → Run Summary directly (no Dawn Report). Evacuation dawn → Run Summary. Marks credited, `meta.runs` appended, run save deleted at the moment the Summary shows. NEW RUN over a live save asks once and records FELL.
- **Blood Moons** are seeded per run (`rng.fork('bloodMoon')`): first on Night 18–24, second 5–7 nights later → `G.bloodMoons: [n1, n2]`. The first is led by the **Named Brute** (120 HP, `G.namedBrute: { name, alive:true, night }`; +10 Morale and a drama-8 log line for the killer; if alive at dawn it leads the second).
- **RNG streams** (GDD §8): `roster`, `rosterReroll`, `zoneMods`, `bloodMoon`, per day `zone:{day}`, `containers:{day}:{screen}`, `event:{day}`, `eventReroll:{day}`, `horde:{day}`, `siege:{day}`, `scav:{day}` (`scav:{day}:2` for the Second Runner). `makeRng(G.seedNum).fork(label)`.

### 9.2 State additions
```js
G.unlocksOn: [id], G.bloodMoons: [n1, n2], G.namedBrute: null|{ name, alive, night }, G.carryOver: 0 /* shamblers added to tomorrow's base */,
G.zoneMods: { suburbs:'evacuated', mall:'burned', ... } /* one per zone per run */, G.acts: { pressure:false, beacon:false },
G.dayFlags += { runnerIds:[], secondRun:false, absent:[], quarantine:null|id, wantZone:null|zoneId, storm:false, quietNight:false, broadcastDone:false, rerollDone:false, traderOffer:null|{day} },
G.obituaryQueue: [ { snapshot, death } ]  /* shown one at a time before the Dawn Report / Summary */,
Survivor += { role:'worker'|'patient'|'idle', treatment: null|{ startedHours, medsPaid, tier:'early'|'late' } /* pending cure roll */, baseGrit }
Room.spent: number  /* total scrap ever spent, for the 50 % demolish refund */
meta += { cards: [ { kind, data, date } ] /* last 20 */, tutorialDone:false, lastSeenStreak:0 }, meta.fallen cap 50
```
`inventory` is the **Stash** (unbounded: unequipped weapons, armor, throwables, kits).

### 9.3 Survivors
- `hpMax = 20 + baseGrit × 8` (base, before trait/shortage deltas). Trait pairs exclude Loud/Quiet, Proud/Hypochondriac, Coward/Faithful, Steady Hands/Scrounger. Grudge picks a rival at generation (`rival` id; trait rerolled if no other survivor).
- Infection clock: 48 h; Long Fuse 72; Immune 96; both 144 (`bite.maxHours`). CURE (sheet; Infirmary T2, or T1 with a Medic worker; powered): survivor becomes a patient, Meds paid now: ≤ 50 % of clock → 3 Meds, always works; > 50 % → 6 Meds at 50 % (`treatment` pending; resolves in the infection step of the next boundary, before the turn check; Fever Dream ×0.6). Turn: roommate 30 HP + 50 % bite (same room; idle survivors share the Gate yard); highest-Aim puts them down with 1 Ammo, or bare-handed at Ammo 0 with a 10 % bite on the putter. Immune bites are hidden for the first 48 h. BITE haptic only when a bite becomes *known*; a hidden bite fires SURVIVOR_HIT.
- Bleed is inflicted by any hit ≥ 10 HP at 25 %, a Brute swing on the Bracer 40 %, a Breach attack 20 %, an extraction strike 25 %. BANDAGE (1 Med, sheet, instant).
- Patient = assignment (`role:'patient'`, `roomId` = Infirmary). MAKE PATIENT / CURE on the sheet; dragging a patient out ends patient status (DENY while a cure is pending).
- Recruits: 20 % hidden bite. Rescue chance per zone (`B.ZONES[z].rescue`, Hunting Season 0.4). Over cap: no recruiting (DENY "no bunk"), −2 Morale/day.

### 9.4 Siege
- Ranges: Pistol 0.5, Shotgun 0.3 (2 targets within 0.10), Rifle 1.0; Watchtower slot +0.20 (powered). `accuracy = clamp(0.45 + 0.05×aim + towerBonus, 0.55, 0.95)`; Armory damage bonus only while powered.
- Melee at Ammo 0: `4 + grit/2` per 1.5 s at the gate line (MELEE_HIT); the engaged zombie strikes the defender instead of the wall every 1.5 s: 6 HP, 5 % bite (SURVIVOR_HIT). AMMO_OUT when Ammo hits 0; the HUD count reddens ≤ 10.
- Composition per `B.HORDE.composition` band (round(share × base), minimums, remainder Shamblers); heat zombies 50 % newest type / 50 % Shamblers (Runners for the heat half at Heat ≥ 3 before Night 12). Placement: Screamers wave 1; Brutes/Bloaters split across waves 2–3; Familiar Faces in wave 1 (FAMILIAR_FACE). Spawn stagger 0.4 s (0.25 s Blood Moon). Carry-over Shamblers from `G.carryOver`.
- Brace: 4 HP/s, capped at 40 % of max HP per night (`S.braceBudget`), BRACE_LOOP; a Runner at the wall strikes a *held* Bracer every 1.0 s (8 HP, 15 % bite) else the barricade; a Brute swing on a held Bracer: 10 HP, Bleed 40 %, cancels the hold, locks Brace 2 s (BRUTE_SLAM).
- Screamer stops at 0.55 (only Rifle range or Watchtower Pistol reaches it). Bloater cloud is 0.08 of the street wide at its contact point. Molotov lane 0.15 wide. Pipe Bomb radius 0.12 (inside a Breach also 20 HP to survivors in radius). Molotov inside a Breach is refused (DENY).
- Hard dawn: leftovers drift off; SIEGE_WON still fires if anyone lives; result carries `leftovers` and `bigLeftovers` for the dawn step.
- **Night Sortie** (unlock): `plan.sortie: id|null` — a melee survivor standing at x = 0.08 who engages zombies (the exchange above) before they reach the wall; tapping them pulls them inside (`input.recallSortie`).
- Named Brute: `Z.named = true`, hp 120, leads wave 1 on its Blood Moon.

### 9.5 Scav
- Runner carries: equipped weapon/armor, **10 Ammo from stock** (unused returns; `R.ammo`), up to 2 throwables from the Stash (`plan.throwables`), a Medic 3 Meds (one field cure). Second Runner: `director.sendRunners([{id, zoneId}, {id, zoneId}])` plays the runs back to back.
- Zone modifier: one per zone per run from `G.zoneMods` (`B.ZONE_MODS`), printed on the zone card and applied in `createRun`.
- New verbs: **stealth kill** (crouched melee tap on a sleeper: instant, silent, LOOT_RARE); **swipe up → throw** a carried throwable (siege rules; Molotov Attention +10, Pipe Bomb +25, Flare pulls the screen's zombies). Hazards: crouching over a weak floor avoids it and halves an alarm/dog. HAZARD haptic on a sleeper waking.
- Pack full: the item sits in a 3 s "drop to swap" tray (`R.swapTray`), tap a pack slot to swap, else discarded (DENY).
- Extraction: FOOTSTEPS_BEHIND 0.5 s before each roll; a tap within `250 + 20×nerve` ms of the strike dodges it (KILL_STOP; `input.dodgeTap`), a mistimed tap +1 Attention; a landed strike: hit `0.5 − 0.04×grit`, 12 HP, 15 % bite, 25 % Bleed. Death: dayNoise +2 flat.
- Loot rolls: Locker Ammo ×12; gear weights Bat 30 / Pistol 30 / Vest 25 / Machete 10 / Shotgun 5 (Mall 15) / Rifle 0 (Depot 15); throwables Molotov 60 / Flare 25 / Pipe Bomb 15 (Depot 40).

### 9.6 Events & narrative
- Weights: default 10; Knock 15, Want 6, Storm 8, Ghost 4; 3-day cooldown per event; Quiet Morning filler. Event 6 is **Voice on the Air**. Old Grudge *Separate* −6. Rationing *Strip the garden* destroys a T1 Kitchen. Mercy triggers past 75 % of the clock; *Wait* −3 (+5 instead if a Faithful lives). Fever Dream: cure roll ×0.6. Trader lives as a TRADE button on the Radio sheet for 2 days.
- Drama weights (`B.DRAMA`) tag every log line (`{ day, text, drama }`); obituary cards show the top 3 by drama then recency; the Defining Moment is the run's highest-drama line.

### 9.7 Progression & UI
- Unlocks 9 **Second Runner** (70) and 10 **Night Sortie** (80). Daily: seed from the UTC date, unlocks off, weekday mutators per `B.LEGACY.dailyMutatorsByWeekday`, no ×10 win bonus, counts for the streak. Streak: local calendar days with a 6 h grace past midnight; UNLOCK haptic per new flame; Title shows the flame going out when a streak was lost.
- Dusk Prep is **auto-filled** (two highest-Aim → Gate, third → Watchtower, highest-Hands non-defender → Bracer, three throwables from the Stash); drag/tap to change. Context button variants: SLEEP (storm), HOLD (3)/HOLD (2)/LAST NIGHT (beacon), HOLD THE DOOR (breached start).
- Obituary cards queue (`G.obituaryQueue`), NEXT advances, the last NEXT continues to the Dawn Report or the Summary. Legacy shows the ten-unlock grid, last 20 cards (re-render + share), the Wall of past dead (50).
- Settings: haptic intensity 0–1.5 (0 = shake-only), reduce motion, seed display, replay tutorial (clears `meta.tutorialDone`), delete run save, reset Legacy (double confirm), export/import save code.
- Onboarding (first run only, gated by `meta.tutorialDone`): repair slider stops at 80/100 (4 Scrap) → drag first survivor to the Kitchen → tap Floor 2, build Bunks → SEND (Suburbs Near, 4 screens) → first container → "swipe left to run home" when the first wave spawns → HOLD THE GATE (7 Shamblers) → "tap the one at the wall" → Dawn Report: the Knock.
