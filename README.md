# HOLDOUT — Thirty Nights

**Fallout Shelter meets DayZ, in your pocket.** A portrait-mode zombie fortress-survival roguelike: run the Hold, a barricaded
tower seen in cross-section; build rooms; staff them with procedurally generated survivors who eat, bleed, hide bites, turn and die
for good; send one of them on a side-scrolling scavenging run where every container is a bet against the dark; then hold the gate
through a real-time night siege. One system ties it together: **Noise → Heat**. The louder you live, the more of the dead arrive.

Everything you see is generated in code at load time — there are no image, font or audio files. The whole game is one
self-contained HTML file with an installable PWA wrapper. Feedback is haptic (gameplay-reactive vibration patterns) and visual;
there is no audio by design.

## Play it

- **Open `dist/index.html`** in any modern phone browser (iOS Safari 15+, Android Chrome 90+). It works from a file, a USB stick,
  a chat attachment, or any static host — no build step, no server, no network.
- **Install it** as an app: host the `dist/` folder over HTTPS (any static host: GitHub Pages, Netlify, an S3 bucket…), open it on
  your phone and use *Add to Home Screen* (iOS) or the install prompt (Android). The service worker precaches the bundle so it
  boots offline; the manifest locks portrait orientation and standalone display.
- **Try it on a desktop** with a phone-sized window (Chrome DevTools device mode, 390×844 works well).

## Features

- **The Hold** — eight floors, ten room types over three tiers, a power budget that darkens the tower from the roof down,
  adjacency synergies, a repairable barricade drawn as five planks, and the Wall: a memorial that gains a portrait per death.
- **Survivors** — four stats, two traits each (every trait has a cost), procedural portraits, backstories and wants; wounds,
  bleeding, fractures and a 48-hour infection clock with hidden bites, cures, confessions, turns, Put Down and Exile.
  Permadeath is total; every death mints a shareable obituary card.
- **Night Siege** — a real-time gate defence with four verbs (Focus Fire, Brace, Throw, Cease Fire), five zombie types plus
  Familiar Faces wearing dead survivors' portraits, a Noise meter that summons mini-waves, and a survivable Breach.
- **Scav Runs** — push-your-luck side-scrolling expeditions across five procedurally generated zones with modifiers,
  non-decaying Attention that spawns waves *behind* you, stealth kills, hazards, rescues, and a run-home extraction with a dodge tap.
- **Eighteen dawn events**, act cards, seeded Blood Moons led by a Named Brute, and a three-night Beacon finale.
- **Replayability** — six-character seeds reproduce whole runs; a Daily Challenge with weekday mutators; four stackable mutators;
  ten Legacy unlocks that each change a system; a Dawn Streak that multiplies Marks.
- **HD-2D rendering** — chunky procedural pixel art under a smooth 2D light map, WebGL post-processing (bloom, tilt-shift depth of
  field, filmic grade lerped by the clock, vignette, film grain), camera moves instead of cuts, hit-stop and screen shake.
- **Haptic vocabulary** — fifty named vibration patterns with priorities and throttling, replacing audio; intensity 0–1.5; a
  screen-shake fallback where the platform has no vibration API.

## Build from source

```bash
npm install          # esbuild + playwright-core (dev only)
npm run build        # → dist/index.html (single file) + PWA companions copied from pwa/
npm run build:dev    # unminified, inline sourcemap
npm run serve        # static server for dist/ on http://localhost:8080 (needed to test the service worker)
npm test             # headless-Chromium smoke + flow tests on an emulated phone
npm run shot         # one screenshot of the running game on an emulated iPhone
npm run icons        # regenerate the procedural app icons
```

`src/` is plain ES2020 modules with no runtime dependencies. `docs/ARCHITECTURE.md` (engine contracts), `docs/TECH_SPEC.md`
(state schema, module APIs, world layouts) and `docs/GDD.md` (rules and numbers) describe the whole game.

## Wrapping as a store app (optional)

The `dist/` folder is a complete web app. To ship it through an app store, wrap it with Capacitor:

```bash
npm i -D @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
npx cap init HOLDOUT com.example.holdout --web-dir dist
npx cap add android && npx cap add ios
npx cap sync && npx cap open android   # or ios
```

Set the project to portrait-only in the native config; no plugins are required (haptics use the web Vibration API where
available, and the game degrades gracefully where it is not).

## Save data

One run slot and one Legacy record live in `localStorage` under `holdout.v1` / `holdout.meta.v1`, with a schema version and
migrations. Settings offer export/import as a text code, and a double-confirmed reset.
