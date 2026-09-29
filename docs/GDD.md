# HOLDOUT — Final Game Design Document

## 1. Title & Pitch

**HOLDOUT** stays. It is one word, a verb and a noun, reads at icon size, and names both the fortress and the act. Store subtitle: *HOLDOUT — Thirty Nights*.

HOLDOUT is a portrait-mode fortress-survival roguelike. You run the Hold, a barricaded tower seen in cross-section, staffed by procedurally generated survivors who eat, bleed, hide bites, turn, and die for good. Days are for building rooms, assigning people and sending one of them on a side-scrolling scavenging run where every container is a bet against the dark. Nights are a real-time siege at the gate. One system ties it together: **Noise**. Generators, gunfire and a loud run raise the Hold's **Heat**, and Heat decides how many dead reach the gate tonight and how alert today's zone is. You are never safe; you are only quieter or louder.

**10-second pitch:** Fallout Shelter's cutaway tower, DayZ's dread, one thumb, five minutes a day. Build up, send someone out, hold the gate. Everyone can die, and when they do you get a card to share.

## 2. Core Loop

**Minute-to-minute (10–60 s):** one tap, one visible consequence, one haptic, within 100 ms. Assign a survivor and the room's lamp warms and its number ticks. Tap a Brute and the rifle kicks in your palm. There is no dead input.

**Session (= one in-game day, ~5 minutes):** Dawn Report (30 s) → Day in the Hold: build, assign, craft, repair (90–120 s) → optional Scav Run (60–90 s real time) → Dusk Prep (20 s) → Night Siege (60–120 s real time) → next Dawn Report. The day is the atomic session. Day 1 opens straight onto the tower; the first Dawn Report is the morning after Night 1.

**Saving.** The game autosaves at every phase boundary and event choice, and during the two real-time phases it snapshots the whole sim every 1 s (zombie positions and HP, barricade, Noise or Attention, wave index, cooldowns, the phase's RNG cursor). Killing the app mid-siege resumes mid-siege on the same stream: there is no reroll by force-quit. On `visibilitychange` hidden the sim and haptics pause and a snapshot is written; on return a RESUME overlay counts down 1 s. One run slot plus one Legacy record, in IndexedDB (localStorage fallback) with a schema version and forward migrations. Nothing simulates while the app is closed: the Hold waits.

**Why the day hooks:** a slot machine with skill. Day is the stake, Siege is the pull, the Dawn Report is the reveal, in a fixed order that always ends on an open question — an event card, a hidden bite noticed, a stranger at the gate — under the largest button on the screen, **START DAY N+1**. The quit point is the curiosity point.

**Day (tactical question): "How loud can I afford to be?"** Run the Generator and the horde grows. Push the run one more screen for Meds and the runner may not come home. Every trade-off is legible and player-authored.

**Run (typically 12–30 nights, 1–2.5 hours across sessions):** three acts — Foundation (1–9), Pressure (10–19), Beacon (20+) — each announced by an act card in the Dawn Report. Win by lighting the evacuation beacon (Radio T3, Day 20+) and surviving its three-night countdown. Lose when the last survivor dies. Both endings go to the Run Summary (§8) and mint Legacy Marks; the **Dawn Streak** flame multiplies Marks for consecutive real days played and resets without touching unlocks.

## 3. The Hold

Eight floors, one room per floor. Floor 0 is always the **Gate**; Floor 7 is always the **Radio** slot. Floors 1–6 are built bottom-up (the lowest empty floor is the only build target) from eight room types; a new run starts with a Kitchen T1 on Floor 1. Duplicates are allowed (two Kitchens is a real strategy), so no two runs build the same tower. No rearranging. **Demolish** refunds 50 % of all Scrap ever spent on the room; the floor becomes empty and can take any type; floors above stay. A room pushed below T1 by an event is destroyed the same way, without refund. Adjacent floors whose rooms share a governing stat get **+10 % output**. Assignment is instant. Each room holds up to 2 workers unless noted.

| Room | Stat | Build / →T2 / →T3 (Scrap) | Power draw | Output per worker per day T1 / T2 / T3 | Special |
|---|---|---|---|---|---|
| Gate (F0, fixed) | Grit | — / 40 / 90 | 0 | Barricade max HP 100 / 180 / 300 | 2 defender slots; the yard where idle survivors stand |
| Bunks (no workers) | — | 20 / 35 / 60 | 0 | Morale +1 / +2 / +3 flat | Roster cap 8 / 10 / 12 (6 without Bunks; best Bunks counts) |
| Kitchen | Hands | 25 / 45 / 80 | 1 | Food 3 / 5 / 8 | — |
| Cistern | Hands | 25 / 45 / 80 | 1 | Water 3 / 5 / 8 | — |
| Generator | Hands | 35 / 60 / 100 | 0 | Power 6 / 10 / 16 | dayNoise +2 / +3 / +4 if staffed |
| Workshop | Hands | 30 / 50 / 90 | 2 | Scrap 4 / 6 / 9 | Crafting tier (see §11) |
| Infirmary | Hands | 30 / 55 / 95 | 2 | Heals 15 / 25 / 40 HP per patient at Dusk; patient slots 1 / 2 / 3 | Needs ≥ 1 worker to heal; T2 cures infection; T3 crafts 1 Med from 4 Scrap |
| Armory | Aim | 30 / 55 / 95 | 1 | Ammo 12 / 18 / 26 | Defender damage +10 / +20 / +35 % (powered); T2 crafts Shotgun and Vest; T3 crafts Rifle |
| Watchtower | Aim | 25 / 50 / 85 | 1 | none by day | 1 defender slot: accuracy +15 / +25 / +40 %, range +20 % (powered); T2+ shows tonight's horde at Dusk |
| Radio (F7 slot, starts empty) | Nerve | 40 / 80 / 150 | 3 | — | Buildable any time regardless of lower floors. T1: BROADCAST button, once per day, needs power (dayNoise +4, 60 % a stranger knocks at dawn). T2: REROLL the dawn event once per day. T3 (Day 20+): the Beacon |

**Output formula:** `output = tierBase × (0.7 + 0.06 × stat)` per worker (stat 5 = ×1.0, stat 10 = ×1.3), summed per room, × 1.1 adjacency, × 0.5 unpowered, × 0.5 if a worker is today's runner, × 0.8 if Morale < 30, × 1.1 if Morale ≥ 70, floored per room.

**Power** is a daily budget, never stored: `power = Σ Generator output − Σ draws`, fixed at the Dusk boundary from that day's staffing and holding through the night. On deficit, rooms are cut from the roof down — the Radio first, then Floor 6 — until it balances, and the tower visibly goes dark from the top; draw-0 rooms (Gate, Bunks, Generator) are never cut. Unpowered: production ×0.5; the Infirmary heals ×0.5 and cannot cure; the Armory and Watchtower lose their night bonuses; the Radio cannot Broadcast or reroll, and a Beacon countdown resets if the Radio is cut at any Dusk of it. Every room sheet shows projected output with the multiplier it will actually get from the current staffing. Day 1 has no Generator: the pre-built Kitchen runs at ×0.5 and its sheet says so.

**The Gate:** one barricade HP pool drawn as five planks; each 20 % lost removes a plank (PLANK_LOST) and lets cold street light spill in. Daytime repair costs 1 Scrap per 5 HP, also from 0 after a Breach. A night that starts below 20 HP starts breached and the button says HOLD THE DOOR. On the back wall of Floor 0 hangs **the Wall**, a memorial that gains one portrait per death.

**Boundary resolution.** Everything resolves at the two boundaries, in this order; each step reads the state the previous one left.
- **Dusk:** 1 clock +12 h · 2 infection: cure rolls, clock ticks, turns · 3 power budget from today's staffing · 4 production, with yesterday's shortage penalties on stats · 5 consumption; shortage flags set for tomorrow · 6 Bleed · 7 Infirmary healing · 8 Morale: Bunks, fed, drift, trait dailies · 9 Beacon power check · 10 autosave → Dusk Prep.
- **Dawn:** 1 clock +12 h · 2 siege results: deaths, the Wall, obituaries queued, siege noise and survivors into dayNoise, carry-over · 3 infection: clock ticks, turns, Hypochondriac, notices, confessions · 4 Bleed, then natural regen · 5 Morale: clean night or survived badly, Familiar Face, deaths, over-cap · 6 refusal and walk-out rolls · 7 dayNoise closes → Heat, then resets · 8 roster-cap check, zone unlock · 9 event: a chained Fire, else the weighted roll with cooldowns, else Quiet Morning · 10 autosave → Dawn Report.

## 4. Survivors

**Four stats, 1–10, shown as bars.** `grit` (HP = 20 + baseGrit×8; melee damage; resists hits), `aim` (ranged accuracy; Armory, Watchtower), `hands` (all production rooms; search speed; repair), `nerve` (sneak radius; spotting hidden bites; Radio; Morale on events). Generated from the `roster` stream with 16–22 total points, one stat ≥ 6. Effective stats after traits, shortages and Old Hand clamp to 1–10; max HP uses base Grit only. Record: `{id, name, portraitSeed, grit, aim, hands, nerve, traits[2], rivalId, backstory, want, hp, wounds[], bite, treatment, weapon, armor, roomId, role: worker|patient|idle, log[]}`. Portraits are 24×24 sprites from five part layers (skin 6, face 8, hair 12, eyes 8, accessory 6) plus clothing (10). Backstory is one line from 40 templates with slotted nouns ("Was a **dental hygienist** in **Reno**. Still flosses."). `want` is one loot type; bringing it home grants +10 Morale once.

**Traits (2 per survivor, every trait carries a cost; excluded pairs: Loud/Quiet, Proud/Hypochondriac, Coward/Faithful, Steady Hands/Scrounger):**

| Trait | Benefit | Cost |
|---|---|---|
| Steady Hands | Search time −25 % | Refuses Gate/Watchtower duty |
| Scrounger | +1 loot roll per container | Refuses Gate/Watchtower duty |
| Heavy Foot | +2 pack slots | Screen entry Attention +6 instead of +3 |
| Medic | As an Infirmary worker: heal ×1.5 and cures at T1; carries 3 Meds on a run for one field cure (a bite taken out there, cured on the spot) | −1 Grit |
| Light Sleeper | HORDE_INCOMING fires 3 s early; +1 Aim at night | −2 Morale per day |
| Iron Gut | Immune to Bad Water and Rats outcomes | −1 Nerve |
| Coward | Sneak detection radius −25 % | Abandons defender slot when barricade < 25 % |
| Loud | +2 Grit | dayNoise +1 per day |
| Quiet | dayNoise −1 per day | −1 Grit |
| Proud | +1 Grit | Always hides bites |
| Hypochondriac | +1 Nerve | 20 % each dawn: "insists they were bitten" (a ? ring until a 1-Med Check) |
| Hoarder | +3 Morale when a run returns Scrap | −3 Morale on every upgrade |
| Faithful | Morale floor 20 while alive (clamps the pool) | −5 Morale whenever you Shoot at the Knock or Exile anyone |
| Grudge | +5 Morale when the rival dies or is exiled | −2 Morale per day while the rival lives. Rival = a random other survivor at generation (trait rerolled if none); the rival's portrait shows on the sheet |
| Immune | Infection clock 96 h (cure tiers scale: 3 Meds through 48 h, 6 Meds at 50 % after); with Long Fuse ×1.5 → 144 h | The bite is hidden for its first 48 h; the player finds out the hard way |
| Old Hand (Legacy only) | +1 all stats | Eats 2 Food per day |

**Needs:** 1 Food + 1 Water per survivor at Dusk. Food short: −10 Morale, all stats −1 until fed. Water short: −15 Morale, all stats −2; a second dry day deals 20 HP each.

**Morale** is one Hold-wide pool 0–100 (start 60). Every Morale effect in this document is a delta to that pool: "both −3" is −6, "everyone else −3" is −3, Faithful's floor clamps it. At Dusk: +Bunks, +2 if everyone ate and drank, −3 drift while above 50, trait dailies. At Dawn: +5 for a clean night (no breach, death or known bite), −5 survived badly (breach or death), +10 want delivered, +6 Familiar Face put to rest and −6 if one lived to dawn, +8 Wake, −10 per death, −15 per turn inside the Hold, −15 Breach, −8 Exile, −10 Put Down, −2 per day over the roster cap. Production ×1.1 at ≥ 70, ×0.8 below 30. Below 30 one random survivor per day refuses assignment (a DENY line in the report); below 10 one walks out at dawn with 5 Food (obituary: "Walked out on Night N"). Morale is meant to sit high on clean runs and fall off a cliff on bad ones; the drift means it is never free, and T3 Bunks exactly pay for it.

**Injury:** up to three wound entries. **Bleed** (−6 HP at every boundary until bandaged: BANDAGE on the sheet, 1 Med, instant, no room needed) is inflicted by any hit of ≥ 10 HP at 25 %, a Brute swing on the Bracer at 40 %, a Breach attack at 20 % (WOUND haptic). **Fracture** (−2 Grit and Hands; cannot scav; clears after 3 days as a patient or 6 days otherwise). **Bite** starts infection. Natural regen +5 HP at Dawn. **Patient** is an assignment (roomId = Infirmary, role patient; MAKE PATIENT or CURE on the sheet): patients neither work nor defend and are skipped by Dusk Prep; each heals at Dusk `tierBase × (0.7 + 0.06 × best worker Hands)` if the room has ≥ 1 worker (Medic worker ×1.5, unpowered ×0.5), floored.

**Game clock:** time moves only at phase boundaries; Dawn→Dusk and Dusk→Dawn each add 12 hours, and every timer counts those hours.

**Infection:** a Bite sets `bite = {at, hidden, clock}` (clock 48 h; Long Fuse 72; Immune 96; both 144); the portrait shows a red ring filling over the clock. **Cure** (CURE on the sheet; Infirmary T2, or T1 with a Medic worker; powered): the survivor becomes a patient and the Meds are paid now, tiered by elapsed time — ≤ 50 % of the clock costs 3 Meds and always works; over 50 % costs 6 Meds at 50 %. The roll resolves in the infection step of the next boundary, before the turn check, so a failed roll at the last boundary is a turn on the table. At clock end the survivor **turns** at that boundary (Dusk step 2 or Dawn step 3 — never mid-phase, so a defender or runner is committed only after turns resolve): a roommate takes 30 HP and a 50 % bite roll (same room; idle survivors share the Gate yard; no roommate, no collateral), then the highest-Aim survivor puts them down with 1 Ammo, or bare-handed at Ammo 0 with a 10 % bite roll on the putter (−15 Morale, TURN then DEATH, obituary "turned in the Kitchen"). **Hidden bites:** Proud always, 15 % of everyone else, and Immune for its first 48 h (no ring, `hidden = true`; the hit fires SURVIVOR_HIT, never BITE). Each Dawn every roommate with Nerve ≥ 6 notices at 60 % (100 % at Nerve ≥ 8: "Dana noticed Marcus favoring his arm"); otherwise the survivor confesses at the first Dawn Report where elapsed ≥ 50 % of the clock — already in the 6-Med tier. BITE fires the moment a bite becomes known: visible ring, notice, confession or Check. A 1-Med **Check** at any Infirmary reveals any hidden bite. At any time the player may **Put Them Down** (−10 Morale, obituary) or **Exile** (−8 Morale, they walk out; three nights later they enter the horde as a Familiar Face wearing their own portrait).

**Permadeath** is total: obituary, Morale drop, portrait on the Wall, gear lost. **Recruiting:** Broadcast (60 % a stranger knocks at dawn), the Knock event, and a survivor found on a run (Forest Camp 25 %, other zones 10 %; occupies 2 pack slots; standard generator with a 20 % hidden bite; at roster cap they cannot be picked up — DENY, "no bunk"). Roster cap by Bunks; if Bunks are lost while over cap nobody is evicted, but recruiting is blocked and Morale −2 per day.

## 5. Night Siege

The camera drops to street level: the Gate on the left third, the street stretching right from the gate line (0 %) to the spawn edge (100 %), one flickering sodium lamp. Defenders are the survivors in the 2 Gate slots and the Watchtower slot (max 3); they auto-fire at the nearest zombie in range every 1.0 s, 1 Ammo per shot (2 for Shotgun). **Range:** Pistol 50 %, Shotgun 30 % (hits up to 2 targets within 10 % of each other), Rifle 100 %; the Watchtower slot adds +20 %. `accuracy = max(0.55, 0.45 + 0.05×aim + watchtowerBonus)`, cap 0.95; the Armory bonus multiplies damage while powered. At Ammo 0 (AMMO_OUT; the HUD count reddens at ≤ 10) defenders auto-melee zombies at the gate line: `4 + Grit/2` per 1.5 s, silent (MELEE_HIT). A zombie in melee with a defender strikes the defender instead of the barricade every 1.5 s: 6 HP, 5 % bite (SURVIVOR_HIT). Melee is a stopgap, deliberately worse than the cheapest gun (Grit 5: 4.3 DPS against a Pistol's 8.4). Outside a Breach and this exchange, non-Bracer defenders take no damage.

**Duration:** `T = min(120, 60 + 2×day)` seconds. The horde spawns in three waves at 0, T/3 and 2T/3 (30 / 30 / 40 % of the count), each zombie stepping onto the street 0.4 s after the last (0.25 s on a Blood Moon). The siege ends when every zombie is dead (SIEGE_WON) or at hard dawn `T + 45 s`: leftovers drift off (SIEGE_WON still fires if anyone lives), barricade damage stands, each surviving Brute or Bloater adds +1 dayNoise ("they know where you are"), and `round(0.25 × leftovers)` join tomorrow's base horde as Shamblers. A siege can be *survived badly* — barricade gone, two dead, one bitten — and those are the runs people talk about.

**Composition** (share of `base` by night band; counts are `round(share × base)` with minimums applied and the remainder Shamblers; drawn from the `horde:{day}` stream):

| Nights | Shambler | Runner | Screamer | Brute | Bloater |
|---|---|---|---|---|---|
| 1–2 | 100 % | — | — | — | — |
| 3–5 | 85 % | — | 15 % (min 1) | — | — |
| 6–8 | 75 % | — | 15 % | 10 % (min 1) | — |
| 9–11 | 65 % | — | 12 % | 12 % | 11 % (min 1) |
| 12–15 | 55 % | 20 % | 10 % | 10 % | 5 % |
| 16–19 | 48 % | 20 % | 10 % | 12 % (min 2) | 10 % |
| 20–24 | 42 % | 22 % | 12 % | 13 % (min 2) | 11 % |
| 25+ | 36 % | 24 % | 14 % (in pairs) | 14 % (min 2) | 12 % |

Heat zombies are 50 % the newest unlocked type and 50 % Shamblers, except that at Heat ≥ 3 before Night 12 the heat half is Runners: the loud Hold meets the fast ones early. Placement: Screamers in wave 1; Brutes and Bloaters split across waves 2 and 3; everything else fills in order.

**Player verbs (four):**
- **Tap a zombie — Focus Fire.** All defenders switch to it for 3 s at +50 % damage; FOCUS_LOCK; 1 s cooldown; a Focus kill fires KILL_STOP with a 60 ms hit-stop. The main verb: the game is choosing what dies first.
- **Hold on the barricade — Brace.** The Bracer (a non-defender chosen in Dusk Prep, default highest Hands) repairs 4 HP/s while held (BRACE_LOOP), free, capped at 40 % of max HP per night, but is exposed: a Runner that reaches the wall while Brace is held strikes the Bracer every 1.0 s (8 HP, 15 % bite) instead of the barricade and hits the barricade otherwise; a Brute swing on a held Bracer deals 10 HP (Bleed 40 %), cancels the hold and locks Brace for 2 s (BRUTE_SLAM).
- **Swipe up from the tray — Throw** the selected throwable to where the swipe ends (THROW). Molotov: a lane 15 % of the street wide for 6 s, 8 dmg/s, Noise +10 (MOLOTOV_IGNITE). Pipe Bomb: 40 dmg in a 12 % radius, Noise +25 (PIPE_BOMB). Flare: every zombie walks to the spot for 5 s, then resumes normal targeting, silent (FLARE). Three slots filled from the Stash, 4 s cooldown.
- **Double-tap a defender — Cease Fire** toggle (CONFIRM on, UI_TICK off): melee only, cooling the Noise meter.

**Zombie types (5):**

| Type | HP | Speed (street/s) | Barricade damage | Behavior | From |
|---|---|---|---|---|---|
| Shambler | 15 | 1/12 | 2 per 1.5 s | The mass | Night 1 |
| Runner | 10 | 1/5 | 2 per 1.0 s | Strikes a held Bracer instead of the wall | Heat ≥ 3 or Night 12+ |
| Screamer | 12 | 1/10 | 0 | Stops at 55 % street (only a Rifle or a Watchtower Pistol reaches it: a reason to build the tower); screams every 6 s: Noise +15 | Night 3 |
| Brute | 60 | 1/20 | 10 per 2 s | Stops at 40 % and roars 3 s: takes +100 % damage (ROAR); BRUTE_DOWN on death | Night 6 |
| Bloater | 30 | 1/17 | 4 per 1 s | On death, a 3 s cloud 8 % of the street wide at its contact point: a held Bracer rolls infection 30 % | Night 9 |

**Familiar Face:** a 25 HP Shambler wearing a dead survivor's portrait, walking in with wave 1 (FAMILIAR_FACE). Guaranteed three nights after an Exile; 40 % likely 2–5 nights after a runner dies in a zone. Killing it: +6 Morale and a log line ("Put to rest at the gate, Night 12"). Alive at dawn: −6 Morale.

**Siege Noise meter (0–100):** +1 per shot (+2 Shotgun), Molotov +10, Pipe Bomb +25, Screamer +15, Bloater pop +6; decays 3/s. Crossing 25 / 50 / 75 / 100 (once each per siege) sends a mini-wave of `3 + floor(day/5)` Shamblers from the right. The player owns this dial through trigger discipline.

**Breach:** barricade 0 → BREACH, grade drains to near-monochrome with red preserved. Every zombie at the wall enters at once; later arrivals enter on reaching the gate line. Each defender engages one zombie in the doorway (the melee exchange above, no Ammo); every unengaged zombie inside deals 15 HP with a 20 % bite and 20 % Bleed roll to a random survivor every 4 s. Focus works on anything; throws land in the doorway — Pipe Bombs and Flares are allowed (a Pipe Bomb also deals 20 HP to survivors in its radius), a Molotov inside is refused (DENY). At hard dawn the remaining dead drift off. Post-breach: −15 Morale; rebuilding is ordinary repair from 0.

**Loss:** roster 0, at any phase. That is the only loss rule. The camera holds 2 s on the death, then the phase ends straight into the Run Summary (no Dawn Report).

## 6. Scav Runs

One survivor, one zone, one thumb, 60–90 s. A zone is a linear side-scrolling strip of **screens** 1..N (home is screen 0), one viewport each. The Hold's Heat sets the starting Attention.

| Zone | Unlock | Screens | Containers | Zombies | Loot focus |
|---|---|---|---|---|---|
| Suburbs | Day 1 | 6 | Cupboard 60 %, Crate 25 %, Corpse 15 % | Shamblers | Food, Water, Scrap |
| Strip Mall | Day 3 | 7 | Locker 40 %, Crate 40 %, Cupboard 20 % | Shamblers, Runners | Scrap, Ammo, throwables, gear |
| Hospital | Day 6 | 8 | Cabinet 55 %, Cupboard 25 %, Corpse 20 % | Shamblers, Bloaters | Meds, Antibiotic kits |
| Forest Camp | Day 10 | 8 | Cupboard 50 %, Crate 30 %, Corpse 20 % | Runners, Screamers | Food, Water, survivors |
| Military Depot | Day 15 | 9 | Locker 50 %, Crate 40 %, Corpse 10 % | Shamblers, one sleeping Brute | Ammo, Pipe Bombs, Rifle |

**Suburbs (Near)** is a 4-screen cut of the Suburbs used only for the first run of a fresh install (`tutorialDone` false); every later run and every Daily uses the 6-screen zone. **Zone modifiers:** each run draws one per zone from the `zoneMods` stream and prints it on the zone card. Suburbs: *Evacuated* (Cupboard Food ×1.5, no Corpses) / *Picked Over* (one container fewer per screen, starting Attention −10). Strip Mall: *Burned* (no Runners, Crates ×0.5) / *Back Room* (Locker Ammo ×2, Attention +10). Hospital: *Flooded* (Attention +10, Cabinet Meds ×2) / *Quarantine Ward* (sleepers 80 %, Bloaters ×2). Forest Camp: *Hunting Season* (survivor 40 %, Screamers ×2) / *Fog* (detection radius ×0.75, hazards ×2). Depot: *Live Wire* (hazards on 40 % of screens, Rare ×2) / *Garrison* (two sleeping Brutes, Locker Ammo ×1.5).

Each screen has 1–3 containers, 0–2 zombies (50 % asleep), and 20 % hold a **hazard**: a one-tile trigger (car alarm, dog, weak floor) worth Attention +12 (HAZARD); Nerve ≥ 6 shows its warning ring; crouching over it avoids a weak floor and halves an alarm or dog. Each zone reuses one kit of six generated props. One screen past the second holds a survivor to rescue (Forest 25 %, else 10 %).

**Zone Select** shows the zone cards (modifier, unlock day; Cartographer adds screen and container counts), then a runner strip of eligible survivors with stat-fit glow: Fractured, refusing and patient survivors are excluded. The runner's room produces at ×0.5 today. They carry their equipped weapon and armor, 10 Ammo from stock and up to 2 throwables from the Stash (the unused come home), and a Medic carries 3 Meds. The pack starts empty.

**Verbs:** tap ground → walk. Tap a container → search: bar fills over `max(1.5, 3.0 − 0.15×hands)` s with SEARCH_LOOP; tap again cancels. Long-press → crouch toggle (half speed, half detection radius). Tap a zombie → attack with the equipped weapon: melee swings every 0.6 s (silent, Bat 12 / Machete 18, MELEE_HIT); a gun fires instantly at `0.45 + 0.05×aim`, 1 Ammo, Attention +10. A crouched melee tap on a sleeper is a **stealth kill**: instant, silent (LOOT_RARE) — the payoff that makes crouch and Nerve a build. Swipe up → throw a carried throwable where the swipe ends, with siege rules (Molotov Attention +10, Pipe Bomb +25, Flare pulls the screen's zombies to the spot). Swipe right → sprint to the next screen (Attention +2/s). **Swipe left → Extract** (EXTRACT_START).

**Zombies in the zone** use §5 stats. Sleepers wake within 1.5 tiles walking or 0.75 crouched, scaled by `(1 − 0.05×nerve)` (HAZARD on waking). An awake zombie closes and strikes every 1.2 s: hit chance `0.45 − 0.04×grit`, 8–14 HP (SURVIVOR_HIT; ≥ 10 HP rolls Bleed 25 %), bite roll Shambler 10 % / Runner 15 % / Brute 10 % (+ Fracture 30 %); a dying Bloater rolls 30 %. A scream adds +15 Attention. Vest: bite chance ×0.7.

**Containers and loot** (weighted rolls from `containers:{day}:{screen}`; Scrounger adds a second roll):

| Container | Loot roll |
|---|---|
| Cupboard | Food ×3 45 %, Water ×3 30 %, Scrap ×3 15 %, Med 10 % |
| Locker | Ammo ×12 45 %, Scrap ×4 25 %, Gear 20 %, Throwable 10 % |
| Crate | Scrap ×5 50 %, Throwable 25 %, Gear 15 %, Rare 10 % (Rifle in Depot, Shotgun in Mall, Antibiotic kit in Hospital, else Vest) |
| Cabinet | Med 50 %, Med ×2 25 %, Antibiotic kit 15 %, nothing 10 % |
| Corpse | Gear 35 %, Ammo ×6 30 %, Scrap ×3 15 %, nothing 20 %; independently 15 %: it is not dead (bite roll 20 %) |

**Gear roll:** Bat 30 / Pistol 30 / Vest 25 / Machete 10 / Shotgun 5 (Mall 15); the Depot adds Rifle 15. **Throwable roll:** Molotov 60 / Flare 25 / Pipe Bomb 15 (Depot 40). Containers on screen ≥ 4 roll the rare/gear outcomes at ×2 weight. **Pack:** 8 slots; stacks Food/Water/Scrap ×5, Meds ×3, Ammo ×10, Throwable ×2, Gear ×1. An Antibiotic kit is 3 Meds in one slot. **Pack full:** the search completes and the item sits in a "drop to swap" tray for 3 s (DENY); tap a pack slot to swap, or it is discarded.

**Attention (0–100):** starts at `min(40, heat×4)`. Container +6, screen entered +3, sprint +2/s, gunshot +10, hazard +12, melee 0. **It never decays.** Crossing 33 / 66 / 100 spawns a wave of 2 / 4 / 6 zone zombies on the screen behind the survivor, walking right — FOOTSTEPS_BEHIND is the only warning. The dead come from the way you came, which is the way home.

**Extraction:** swipe left at any time. The survivor sprints home; each screen takes `2.5 × (1 + 0.1 × max(0, filledSlots − 5))` s under CHASE_STEP and rolls one encounter at probability `attention/100`. FOOTSTEPS_BEHIND fires 0.5 s before the roll; a tap inside a `250 + 20×nerve` ms window around the strike dodges it (KILL_STOP), a mistimed tap adds +1 Attention. A landed strike: hit chance `0.5 − 0.04×grit`, 12 HP, bite 15 %, Bleed 25 %; the pursuer then falls behind. Screen 0 fires EXTRACT_HOME. The decision is exactly: "Attention 58, screen 6, six slots full — sixteen seconds, three coin-flips and three taps. Search the Cabinet or go?" Loot grows linearly; return risk grows with distance and Attention. The game never tells you to leave.

**Death in the zone:** HP 0 → the camera locks, the grade drains to grey over 3 s, survivor and pack are gone, obituary fires ("died on screen 7 of the Hospital carrying 4 Meds"), dayNoise +2 flat: the dead learned where they came from. Any return adds `floor(finalAttention / 25)` to dayNoise.

**On screen:** survivor centre-left, portrait and wound icons top-left, pack top-right, Attention bar across the top with 33/66/100 ticks, Noise ring while searching, the throwable tray bottom-right when carrying, a faint left-edge Extract arrow.

## 7. Events, Narrative & Emergent Stories

One event fires at every Dawn Report from the first one (the morning after Night 1), drawn from the `event:{day}` stream over a weighted pool filtered by run state (day range, resources, Morale, Heat, traits, deaths). Weight 10 unless noted; each event has a 3-day cooldown after firing; a chained Fire pre-empts the roll; if nothing is eligible a *Quiet Morning* flavour card with no choice fills the slot. Each is a portrait, two lines, and 2–3 choices with numbers shown; hidden outcomes are marked *(risk)*. Radio T2, powered, rerolls once per day from `eventReroll:{day}`. Every outcome writes a line to a named survivor's `log`; the obituary is that log rendered in order.

1. **The Knock** (Day 2+, roster < cap; weight 15) — *Open* (+1 survivor; risk 20 % they are hiding a bite) / *Ignore* (−5 Morale) / *Shoot* (Noise +1, 1 Ammo, Faithful −5).
2. **Rationing** (Food < roster) — *Half rations* (−8 Morale, Food lasts 2 days) / *Skip Water instead* (−15 Morale) / *Strip the garden* (Kitchen −1 tier, destroyed at T1; +12 Food).
3. **Generator Cough** (Generator built) — *Repair* (−15 Scrap) / *Run it anyway* (risk 30 %: Fire fires tomorrow; dayNoise +5).
4. **Fire** (chained, pre-empts the roll) — *Fight it* (two named survivors take 15 HP each, room saved) / *Let it burn* (room −2 tiers, destroyed below T1; dayNoise +3).
5. **Old Grudge** (a Grudge survivor and rival alive) — *Separate them* (−6 Morale; they cannot share a room) / *Let them settle it* (Grit contest: loser −20 HP, +5 Morale).
6. **Voice on the Air** (Radio T1+) — *Answer* (dayNoise +6, guaranteed recruit with one gear item) / *Listen only* (tonight's composition revealed).
7. **Bad Water** (Cistern built) — *Boil* (−4 Power tonight) / *Drink it* (risk 50 % each survivor −10 HP; Iron Gut immune) / *Dump it* (Water 0).
8. **The Want** (a survivor's want exists in an unlocked zone; weight 6) — the named zone gets +10 starting Attention today; delivering the item is +10 Morale.
9. **Trader** (Day 5+) — *5 Ammo per Med, up to 4* / *60 Scrap for a survivor* / *Decline*. The offer lives as a TRADE button on the Radio sheet for two days.
10. **Mercy** (a bitten survivor past 75 % of the clock) — *Do it* (−10 Morale, obituary "asked for it") / *Wait* (−3 Morale; +5 instead if a Faithful lives).
11. **Storm Night** (Day 4+, weight 8) — no siege tonight (the button reads SLEEP; the night still counts as played); Kitchen output 0; barricade −40 HP; dayNoise 0.
12. **Fever Dream** (an infected survivor is a patient) — *Let them fight tonight* (+3 Aim, they leave the Infirmary for a Gate slot; a cure resolving at the next boundary rolls at ×0.6) / *Refuse*.
13. **Rats** (Kitchen built) — *Lose 6 Food* / *Traps* (−3 Scrap; 60 %: "the cat" joins, Kitchen +1 Food/day).
14. **Quiet Night** (Heat ≤ 2) — *Trust it* (tonight's horde ×0.5, played with the Dusk Prep defaults; all rooms ×1.25 today) / *Stand watch* (normal).
15. **Fuel Truck** (Watchtower T2+) — send two named survivors: +30 Scrap, +10 Power today, both absent from tonight's siege.
16. **The Wake** (a death yesterday) — *Hold a wake* (−3 Food, +8 Morale, dayNoise +1) / *No time* (−6 Morale).
17. **The Cough** (Day 5+) — *Quarantine* (the named survivor sits out the day: no work, no run) / *Ignore* (risk 15 %: it was a bite, clock already at 24 h).
18. **Ghost on the Radio** (Radio T1+, a dead survivor; weight 4) — narrative: +5 Morale and a postscript on that obituary.

**System lines** also appear in the Dawn Report: hidden bite noticed, confession, turn resolved, exile spotted in tonight's horde (Watchtower T2+), refused assignment and walk-outs (DENY), zone unlocked and act cards (UNLOCK), Familiar Face put to rest.

**Drama weights** by log type: death 10, turn 9, breach 8, Named Brute killed 8, hidden bite caught 7, exile 7, put to rest 6, rescue 5, want delivered 4, cure 4, refusal 2, production 0. The obituary card shows a survivor's top three lines by weight, then recency; the Run Summary's Defining Moment is the run's single highest-weight line.

**How stories emerge:** the systems share nouns. A *Loud*, *Heavy Foot* runner pushes Attention faster, brings less, Morale dips, *Grudge* bites, you Exile them, and they walk in with the horde on Night 14 wearing their own face. Nothing scripts that. Every death builds an obituary sentence from cause + trait + last log line: "Marta Okafor, Proud, hid a bite for thirty hours, was caught by Dana, and turned in the Cistern on Night 14, the morning after we let the garden burn."

## 8. Progression & Replayability

**Heat, the carried consequence.** `dayNoise` accrues from one Heat calculation to the next (Dawn N to Dawn N+1, so it includes Night N's siege): Generator 2/3/4 by tier when staffed, Broadcast +4, event noise, `floor(finalAttention/25)` from a return and +2 from a runner's death, `floor(peakSiegeNoise/25)` and +1 per Brute or Bloater alive at dawn, Loud +1 and Quiet −1. At Dawn: `heat = min(20, round(0.6 × (heat + dayNoise)))`, or `min(20, heat + dayNoise)` on a Blood Moon dawn (no decay). Heat adds `heat` zombies to tonight's horde (§5 composition) and seeds today's Attention at `heat × 4`. A quiet Hold sits at Heat 2–3; a loud one at 10–14 faces nearly double the horde from the same seed.

**Horde size:** `base = round(5 + 1.5×day + 0.02×day²)` plus last night's carry-over; `total = base + heat`; ×1.5 on Blood Moon nights and on each night of the Beacon countdown. Blood Moons are seeded per run from the `bloodMoon` stream: the first on Night 18–24, the second 5–7 nights later, both revealed by the Night 10 act card. Past Night 30 base gains +4 per night until the run ends.

| Nights | Base horde | New threat | Zone unlocked |
|---|---|---|---|
| 1–2 | 7–8 | Shamblers only | Suburbs |
| 3–5 | 10–13 | Screamers (3) | Strip Mall (3) |
| 6–8 | 15–18 | Brutes (6) | Hospital (6) |
| 9–11 | 20–24 | Bloaters (9) | Forest Camp (10) |
| 12–15 | 26–32 | Runners every night | Military Depot (15) |
| 16–19 | 34–40 | Two Brutes minimum | — |
| 20–24 | 43–52 | Radio T3 unlocks (20); first Blood Moon, led by the Named Brute | — |
| 25–30 | 55–68 | Screamers in pairs; second Blood Moon | — |

**Act cards** replace the open question of Dawn 10 and Dawn 20 (UNLOCK). *PRESSURE* reveals both Blood Moon nights and names the Brute that leads the first — 120 HP, its name on the card, +10 Morale and a drama-8 log line for whoever kills it; alive at dawn, it leads the second too. *BEACON* announces Radio T3 and its price.

**Win — the Beacon Hum:** from Day 20 the Radio can reach T3 (150 Scrap). At any Dusk Prep thereafter the player may **LIGHT THE BEACON**: a three-night countdown begins, every horde in it is ×1.5, dayNoise +5 per day, and the Radio must be powered at each Dusk of it or the countdown resets. Surviving the third night is the evacuation dawn and the helicopter card. The player picks the night; that authored finale is the climax. Targets: new players end Nights 8–14; win rate 15 % at Legacy 0 rising to 40 % at full Legacy.

**End of run.** Roster 0 (2 s hold, no Dawn Report) or the evacuation dawn opens the **Run Summary**: the card, SHARE, "Marks earned: N (streak ×1.3)", CONTINUE → Legacy (spend) → Title. The moment the Summary shows, Marks are credited, the Legacy record (seed, night, outcome, mutators, unlocks on, the dead with cause) is appended and the run save is deleted, so Continue vanishes from the Title. The card's data (last 20) is kept and re-rendered from Legacy for sharing again. NEW RUN over a live save asks once ("Abandon Night N? It counts as FELL") and records FELL at the current night with its Marks.

**Legacy Marks:** `(nightsSurvived + 10×won + min(5, obituariesShared)) × streakMult`. **Dawn Streak:** consecutive local calendar days with at least one night played — a night counts when SIEGE_WON or a Storm dawn fires, in any mode including the Daily — with a 6 h grace past midnight; `streakMult = 1 + 0.1 × min(5, streak)`; each new flame fires UNLOCK. A missed day resets the flame, never the unlocks, and the next Title shows the flame going out over "Night N is waiting". Nothing simulates while the app is closed, and the only re-engagement lever is the PWA install prompt after the first Run Summary. **Unlocks (10, any order; each changes a system, not a number; toggle chips on New Run, default on, off for the Daily; active chips print on every card):**

| # | Unlock | Cost | Effect |
|---|---|---|---|
| 1 | The Wall Remembers | 10 | One dead survivor from a past run (persisted last 50: name, traits, seed, night, cause) appears in the Roster Draft with their old traits |
| 2 | Old Hand | 15 | One starting survivor gets the Old Hand trait |
| 3 | Field Kit | 20 | Start with one Antibiotic kit |
| 4 | Tinker | 25 | Workshop T1 pre-built on Floor 2 |
| 5 | Quiet Generator | 30 | Generator dayNoise −1 |
| 6 | Long Fuse | 40 | Infection clock 72 h (cure tiers scale with it) |
| 7 | Cartographer | 50 | Zone Select shows screen count and container count |
| 8 | Second Broadcast | 60 | Broadcast recruits at 80 % |
| 9 | Second Runner | 70 | Zone Select takes two runners for two zones; the second run plays after the first (10 Ammo each, `scav:{day}:2`) |
| 10 | Night Sortie | 80 | Dusk Prep gains a fourth slot outside the wall: a melee survivor at 8 % street who engages zombies before they reach the barricade (the §5 exchange); tap them to pull them back inside for the night |

**Seeds:** every run has a 6-character seed (`K7R2QX`) on the title card and every share card. All randomness forks from it by name (`rng.fork`): `roster`, `rosterReroll`, `zoneMods`, `bloodMoon`, and per day `zone:{day}`, `containers:{day}:{screen}`, `event:{day}`, `eventReroll:{day}`, `horde:{day}`, `siege:{day}`, `scav:{day}`, each forked fresh at its phase start — an extra search or shot changes later rolls inside that phase and nothing outside it. The same seed with the same mutator and unlock chips is the same run; the Daily runs unlocks-off so "Beat my Night 19" compares. **Daily Challenge:** seed from the UTC date, one attempt per date, its own card, Marks without the ×10 win bonus, counts for the streak. Weekday mutators: Mon Dry Season, Tue Fast Ones, Wed Loud World, Thu Short Season, Fri Dry + Fast, Sat Loud + Short, Sun none. **Mutators (4, stackable, +10 % Marks each):** *Dry Season* (Cistern ×0.5), *Fast Ones* (Runners from Night 1), *Loud World* (Heat keeps 80 % instead of 60 %), *Short Season* (Radio T3 from Day 10, curve compressed ×2).

## 9. Viral & Share Hooks

Every card is a 1080×1920 PNG rendered offscreen through the game's own sprite generator and post chain with heavier grain and a paper overlay, shared via `navigator.share` with a download fallback; SHUTTER haptic and a 300 ms flash. The seed, active mutators and unlocks sit in the corner of every card, so any screenshot is a playable invitation, and shared obituaries earn Legacy Marks (max 5 per run). The last 20 cards are kept as data in Legacy and re-rendered on tap.

- **Obituary card** (every death, one-tap share): portrait, name, traits, backstory, nights survived, kills, cause, the three highest-drama log lines, the seed. The primary viral object: deaths are frequent and personal.
- **Run Summary card**: the tower as it stood, roster portraits with the dead greyed, a Heat sparkline, EVACUATED / FELL stamp, night reached, seed, mutators and unlocks, the Defining Moment line.
- **Daily Challenge card**: date, night reached, survivors alive, the seed ("Beat my Night 19").

No leaderboards, no server; the share target is the group chat and the card reads at thumbnail size.

## 10. UI/UX Flow

**Screens (17):** 1 Title → 2 New Run → 3 **Hold** → 4 Room Sheet → 5 Survivor Sheet → 6 Build Menu → 7 Zone Select → 8 **Scav Run** → 9 Scav Result → 10 Dusk Prep → 11 **Siege** → 12 Dawn Report → 13 Event Modal → 14 Obituary Card → 15 Run Summary → 16 Legacy → 17 Settings.

- **1 Title:** CONTINUE (only with a live save), NEW RUN, DAILY, LEGACY, SETTINGS; the streak flame; the tower at dusk. A streak lost since the last visit plays the flame going out over "Night N is waiting".
- **2 New Run:** seed field (random; typing one reproduces the run), mutator chips, owned-unlock toggle chips (default on), and the **Roster Draft**: six survivors from the `roster` stream, pick four, one REROLL of all six from `rosterReroll`; START. With a live save it first asks to abandon (§8).
- **4 Room Sheet:** workers, tier, projected output with its real multiplier, UPGRADE, DEMOLISH (refund shown); the Radio sheet adds BROADCAST (once per day, disabled when the projected budget leaves it unpowered), REROLL at T2, TRADE while a Trader offer stands, and BUILD RADIO while the slot is empty.
- **5 Survivor Sheet:** stats, traits (Grudge shows the rival's portrait), wounds with timers, the infection ring or ? ring, two gear slots that open a **Stash** strip, and CHECK / CURE / BANDAGE / MAKE PATIENT / PUT DOWN / EXILE. The Stash is unbounded, holds every unequipped weapon, armor and throwable, is also the Dusk Prep throwable tray, and never appears in the HUD; equipping swaps the old item back.
- **6 Build Menu:** opens from the lowest empty floor only; one row per room type with cost, governing stat, projected T1 output for your best free survivor with tonight's power multiplier, and draw; unaffordable rows grey (DENY on tap); CONFIRM builds.
- **7 Zone Select:** zone cards and the runner strip (§6); "Stay home" is a text link under the cards.
- **9 Scav Result:** loot lines landing in the stock (RESOURCE_TICK each, LOOT_RARE for gear), the runner's HP change and new wounds (a hidden bite shows nothing), kills, Attention peak and the dayNoise it adds, a want-delivered line; then the Hold, day still open, button NIGHT.
- **10 Dusk Prep:** auto-filled every night — the two highest-Aim survivors into the Gate slots, the third into the Watchtower if built, the highest-Hands non-defender as Bracer, three throwables from the Stash; drag to change; LIGHT THE BEACON toggle at Radio T3; horde preview at Watchtower T2+; button HOLD THE GATE.
- **11 Siege HUD:** top bar = five planks, timer, Ammo (red and pulsing at ≤ 10); right edge = the Noise meter with 25/50/75/100 ticks; bottom = the throwable tray above the button, which shows WAVE 2/3 and is not tappable; the Focus target ringed; Cease-Fire defenders dimmed.
- **12 Dawn Report** slides in one card at a time (RESOURCE_TICK per line): 1 deaths → 2 bites, turns, notices, confessions → 3 siege (kills, shots, barricade, breach) → 4 production and consumption → 5 today's Heat ring filling → 6 the open question: event card, act card, knock, zone unlocked, refusals. Then the button.
- **14 Obituary:** the card, SHARE, NEXT; several deaths queue and NEXT advances; the last NEXT continues to the Dawn Report or the Run Summary.
- **15 Run Summary:** the card, SHARE, "Marks earned: N (streak ×1.3)", CONTINUE → Legacy.
- **16 Legacy:** Marks balance, the ten-unlock grid (UNLOCK on purchase), the streak flame and its count, the last 20 cards (tap to re-render and share), and the Wall of past dead (last 50).
- **17 Settings:** haptic intensity 0–1.5 (0 = shake only), reduce motion, seed display, replay tutorial (clears `tutorialDone`), delete run save, reset Legacy (double confirm).

**The context button.** One large bottom button whose label is the day phase; time advances only through it: **START DAY N** → **SEND** (Zone Select) → **NIGHT** (Dusk Prep) → **HOLD THE GATE** → **START DAY N+1**. Variants: Storm Night SLEEP; Beacon nights HOLD (3), HOLD (2), LAST NIGHT; a breached start HOLD THE DOOR. Build, assign, craft and repair are free actions on the tower by day. The button doubles as the tutorial.

**Hold gestures:** vertical drag scrolls the tower with a rubber-band at the roof (RATCHET); tap a room opens its sheet; tap a survivor opens theirs; long-press lifts a portrait, rooms glow by stat fit, drop assigns; dragging a patient out of the Infirmary ends patient status (DENY while a cure is pending). Sheets slide up in 220 ms and close on swipe-down. Two fingers are never required. **HUD:** one top bar with the six resources (delta arrow, red below one day of supply), Morale as a face, Heat as a red ring with its number, the Day counter; inset by the safe area.

**Transitions are camera moves, never cuts:** NIGHT triggers the 2-second warm→cold crossfade (DUSK_HINGE; the long form on Blood Moon and Beacon nights); Hold→Siege dollies down to the gate over 0.8 s; Hold→Scav pushes through the gate into the street (DOOR_SLAM); Siege→Dawn fades to bone-white and the report cards.

**Onboarding: first run only, 90 seconds, no tutorial screen.** A persisted `tutorialDone` flag, set at the first Dawn Report, gates it; New Run, the Daily and a loss never replay it, Settings can. Hints are a pointing hand and one line, dismissed by any tap, never blocking: every free action stays free, and the hand simply moves to whichever step is still undone. 0–10 s: the tower reveals bottom-up at dawn, four survivors, a Kitchen on Floor 1, a gate at 60 %, one glowing Repair slider. 10–20 s: "repair the gate" (the tutorial slider stops at 4 Scrap: 80/100). 20–30 s: "drag Dana to the Kitchen"; the lamp warms and the sheet shows Food at ×0.5, unpowered. 30–40 s: "tap Floor 2, build Bunks" (20 Scrap; 16 left). 40–70 s: SEND; Suburbs (Near), the first container highlighted; the moment the first wave spawns behind the runner the left-edge arrow pulses with "swipe left to run home". 70–90 s: Dusk Prep arrives pre-filled with one HOLD THE GATE pulse; seven Shamblers; "tap the one at the wall" with the hit-stop and FOCUS_LOCK. Dawn Report: nobody died, Heat 1, the Knock. START DAY 2 pulses.

## 11. Balance Numbers

**Start:** 4 survivors (stats 16–22 total, one 6+ each in a different stat), Food 16, Water 16, Scrap 40, Meds 2, Ammo 30, Power 0, Morale 60, Heat 0. Gate T1 at 60/100 HP. Kitchen T1 on Floor 1, nothing else; the Radio slot empty. Stash: 2 Pistols, 2 Bats, 1 Molotov. Roster cap 6 until Bunks.

**Consumption per day:** 1 Food and 1 Water per survivor; Ammo 1 per shot (45–65 shots per siege at Night 10); repair 1 Scrap per 5 HP; a run takes 10 Ammo out and brings the unused back.

**Stable Hold at Night 8 (roster 7, two workers at stat 5 in each core room, T2):** Food 10, Water 10, Scrap 12, Ammo 36, Power 20 vs draw 11. Three Food surplus per day is the intended margin: one bad run and you ration.

**Weapons:** Pistol 12 (1 Ammo, range 50 %). Shotgun 20 to up to 2 targets (2 Ammo, Noise +2, range 30 %; Armory T2 30 Scrap or Mall rare). Rifle 30 (range 100 %; Armory T3 60 Scrap or Depot rare). Bat 12 melee. Machete 18 melee (Workshop T2). Vest: bite ×0.7 (Armory T2 25 Scrap or rare). One weapon and one armor slot per survivor; the rest sits in the Stash.

**Crafting (instant, Scrap only):** Workshop T1: 5 Scrap → 15 Ammo. T2: Molotov 6, Machete 20. T3: Pipe Bomb 12, Flare 8. Infirmary T3: 4 Scrap → 1 Med.

**Siege sanity check, Night 10:** base 22 + Heat 8 = 30 zombies, ~17 HP average = 510 HP. Two Pistol defenders at Aim 5 (70 %, 8.4 per shot) deal 16.8 DPS, ~22 with steady Focus: a 25–30 s clear inside an 80 s siege plus 45 s grace, before mini-waves, on ~61 shots (~48 with Focus and a roaring Brute). **Ammo closes only if someone works the Armory:** T2 with two Hands-5 workers makes 36, a Mall run brings ~18 and a Workshop turns 5 Scrap into 15, so ~55–70 per day against 50–65 per night; the red count at ≤ 10 is the warning and the melee exchange is the punishment. Ten Shamblers stacked on a T2 gate deal 13 HP/s against 4 HP/s bracing, so they must not stack — throwables and Focus exist for this. One unanswered Brute kills a T2 gate in 36 s. Night 20: 53 zombies, ~1,170 HP; three Shotgun/Rifle defenders at Aim 7 with Armory T2 (~62 DPS focused) clear in 20 s of a 100 s siege on ~70 Ammo, against Armory T3 at Hands 7 making 58 and the Depot bringing 36 — the margin goes to Brutes and Bloaters.

**Loot per run (median, extract at Attention 60):** Suburbs Food 8, Water 5, Scrap 6. Mall Scrap 14, Ammo 18, a throwable. Hospital Meds 5, kit 40 %. Forest Food 10, Water 8, survivor 25 %. Depot Ammo 36, Pipe Bomb 2, Rifle 25 %.

**Infection:** clock 48 h (Long Fuse 72, Immune 96, both 144); 3 Meds through 50 % of it; 6 Meds at 50 % after; Bloater cloud 30 %; corpse 20 %; Runner hit 15 %; Shambler and Brute hit 10 %; Breach attack 20 %; melee exchange 5 %; Vest ×0.7.

**Line budget (~15,000):** boot/save/RNG/input 900 · procedural art and font 2,000 · renderer and post 1,600 · Hold and economy 2,000 · survivors and infection 950 · siege 1,850 · scav 1,800 · events and Dawn Report 1,200 · Legacy, seeds, streak, daily 550 · share cards 600 · haptics 300 · screens and transitions 1,250.

## 12. Haptic Vocabulary

All patterns are `navigator.vibrate` millisecond arrays `[on, off, on…]`, scaled by the Settings intensity 0–1.5 (0 = shake only; any scaled "on" segment floors at 8 ms). Classes: *tick* (≤ 20 ms), *thud* (40–90 ms), *tone* (≥ 150 ms). **iOS fallback:** vibrate is a no-op there, so every pattern also drives a screen shake: tick 2 px for one frame, thud 3 px for three, tone 4 px decaying over the pattern's length. **Queue rules:** one one-shot pattern at a time; never two starts within 60 ms; a lower-priority one-shot arriving during a higher one is *dropped, never delayed*; equal priority, newest wins; SHOT throttled to 8/s. **Loops** (marked L) are background: priority 0 while running, so any one-shot interrupts them and the loop resumes after; only one loop runs at a time and the newest replaces the previous (CHASE_STEP replaces HEARTBEAT during extraction; BRACE_LOOP replaces BARRICADE_CRITICAL while held), which resumes if its condition still holds; UI_TICK is suppressed while HEARTBEAT runs. Priority 5 is highest. No vibrate call before the first Title tap.

| Name | Array (ms) | Pri | Fires when |
|---|---|---|---|
| UI_TICK | [10] | 1 | Any button; each floor crossed while dragging; Cease-Fire off |
| ASSIGN_SNAP | [12, 30, 12] | 2 | Survivor dropped into a room |
| CONFIRM | [20, 40, 30] | 2 | Build, upgrade, craft, repair, cure ordered; Cease-Fire on |
| DENY | [60, 30, 60] | 2 | Cannot afford; invalid drop; no bunk; pack full; a refusal or walk-out line; Ammo hits 10 |
| RESOURCE_TICK | [6] | 1 | Each Dawn Report or Scav Result line reveals |
| RATCHET | [8, 40, 8, 40, 8] | 1 | Tower scroll rubber-band; slider detents |
| DUSK_HINGE | [30, 300, 60]; Blood Moon and Beacon nights [60, 300, 120] | 2 | The warm→cold crossfade at NIGHT |
| UNLOCK | [20, 60, 20, 60, 120] | 3 | Legacy purchase; streak flame +1; zone unlocked; act card |
| DOOR_SLAM | [70] | 3 | Entering a zone |
| SEARCH_LOOP | [10, 90] L | 0 | Container search bar filling |
| LOOT_COMMON | [15] | 2 | Item lands in the pack |
| LOOT_RARE | [15, 40, 15, 40, 90] | 3 | Gear, kit or rare lands; stealth kill |
| NOISE_RING | [25] | 2 | Attention crosses a multiple of 10 |
| HAZARD | [30, 60, 30, 60, 90] | 3 | Hazard triggered; a sleeper wakes |
| FOOTSTEPS_BEHIND | [30, 300, 30, 300, 30] | 4 | A wave spawns behind the survivor; 0.5 s before each extraction roll |
| EXTRACT_START | [15, 40, 15] | 3 | Swipe-left accepted |
| CHASE_STEP | [10] every 250 ms → 120 ms L | 0 | Extraction run; interval shortens with Attention |
| EXTRACT_HOME | [20, 100, 20, 100, 60, 100, 120] | 4 | Survivor reaches screen 0 |
| HEARTBEAT | [40, 400, 40, 400] → gap shrinks to 150 L | 0 | Attention ≥ 66 in the zone |
| HORDE_INCOMING | [40, 80, 40, 80, 120] | 4 | Each siege wave starts (3 s early for a Light Sleeper) |
| SHOT | [15] | 1 | Pistol or Rifle shot (max 8/s) |
| SHOTGUN | [40, 20, 20] | 2 | Shotgun blast |
| MELEE_HIT | [25] | 1 | Any melee swing connects, gate or zone |
| FOCUS_LOCK | [15, 25, 15] | 3 | Focus Fire target acquired |
| KILL_STOP | [8] | 2 | Focus kill (with the 60 ms hit-stop); a dodged strike |
| THROW | [12] | 1 | Throwable released |
| MOLOTOV_IGNITE | [40, 30, 40] | 3 | Molotov lane ignites |
| PIPE_BOMB | [120, 40, 60] | 4 | Pipe Bomb detonates |
| FLARE | [20, 60, 20] | 2 | Flare lands |
| BARRICADE_HIT | [40] → [70] below 30 % | 2 | Zombie hits the gate |
| PLANK_LOST | [60, 40, 30] | 3 | Each 20 % of barricade lost |
| BRACE_LOOP | [8, 180] L | 0 | Brace held (repair ticking) |
| BRUTE_SLAM | [80, 60, 80] | 4 | Brute hits the gate or the Bracer |
| ROAR | [250] | 4 | Brute roar window opens |
| BRUTE_DOWN | [90, 50, 150] | 4 | Brute dies (with the 200 ms hit-stop) |
| SCREAM | [200, 50, 200, 50, 400] | 4 | Screamer screams; infection ring crosses 12 h left |
| BLOATER_POP | [60, 20, 20, 20, 20, 20, 20] | 4 | Cloud released |
| FAMILIAR_FACE | [60, 200, 60, 200, 300] | 4 | A Familiar Face steps onto the street |
| SURVIVOR_HIT | [40] | 2 | A survivor takes damage (runner, Bracer, melee exchange, Breach); also a hidden or Immune bite |
| WOUND | [45, 40, 100] | 3 | Bleed inflicted |
| AMMO_OUT | [50, 50, 50, 50, 50] | 3 | Ammo reaches 0 in a siege |
| BARRICADE_CRITICAL | [20, 80, 20, 120, 20, 60] L | 0 | Barricade < 25 % |
| BREACH | [150, 80, 150, 80, 200] | 5 | Barricade reaches 0 |
| BITE | [90, 40, 200] | 5 | A bite becomes known: visible ring, notice, confession, Check |
| TURN | [300, 100, 300, 100, 600] | 5 | Infection clock hits 0 |
| DEATH | [500] then 2 s silence | 5 | Permadeath |
| KNOCK | [50, 100, 50, 100, 50] | 3 | Recruit or stranger at the gate at dawn |
| SIEGE_WON | [30, 200, 50, 200, 80] | 4 | Last zombie down or dawn with survivors |
| SHUTTER | [10, 30, 60] | 2 | Share card rendered |
| BEACON_LIT | [50, 100, 50, 100, 50, 100, 50, 100, 800]; half length at each countdown night's first wave | 5 | Beacon countdown starts |
| EVACUATION | [100, 200, 100, 200, 100, 200, 1000] | 5 | Win |

## 13. Visual Direction

**Look:** every sprite is generated at load from part libraries and drawn at 1× into a 240 × H buffer, `H = ceil(240 × screenAspect)` clamped to 426–540 (9:16 through 20:9; floors 240×64, tower and street backgrounds extend vertically to fill; survivors and zombies 16×24; portraits 24×24; props from rectangles, lines and dither), upscaled nearest-neighbour by the largest integer factor that fits the width in device pixels (`devicePixelRatio`), centred with 16 px gutters, then lit and post-processed at device resolution in one WebGL chain: (1) a 2D light map of additive radial lights — one per room tinted by function (Kitchen amber, Infirmary green-white, Generator strobing amber, Radio blinking red), two-frame muzzle flashes, animated Molotov pools, a one-pixel cyan moon rim on the horde; (2) bloom on emissives only (lamps, flashes, fire, the beacon); (3) tilt-shift blur growing with distance from the focal band (the touched floor, the gate, the survivor's row); (4) a filmic S-curve with blacks lifted to `#14121a`, lerped between four grade presets by the clock; (5) 3 % animated grain, 5 % at night; (6) a vignette that tightens as barricade HP drops. No normal maps, no chromatic aberration. Chunky pixels under smooth light is the HD-2D read. The HUD and the context button are DOM, inset by `env(safe-area-inset-*)`. All text uses a 5×7 bitmap font defined in code (96 glyphs), so no font file ships and cards look identical on every device. **Without WebGL2** the scene canvas is shown directly with the grade as a CSS filter: no bloom, tilt-shift or grain, same game.

**Palette (fixed, 16 colours for all sprites; lighting is continuous colour on top):** ink `#14121a`, slate `#2b2a33`, concrete `#5c5a57`, rust `#7a3b2e`, wood `#8a5a3c`, bone `#d9c9a3`, sand `#d9b27a`, amber `#ffb347`, ember `#ff6a1a`, blood `#8b1a1a`, rot `#6fbf73`, moss `#3b4a3a`, cold sky `#2e4a6b`, moon `#8fd3e8`, violet `#5a3e6e`, paper `#f2ead7`.

**Grades:** four clock presets, lerped so the whole tower changes mood without a sprite changing — *Dawn* (rose-grey key from the left, long blue shadows, the tower the only warm object), *Day* (amber through the tower's holes, cool shadow on the right wall, Kitchen and Cistern floors greener), *Dusk* (amber rim on the tower, violet shadows, street cold cyan; lamps flicker on room by room with a UI_TICK each; the 2-second warm→cold crossfade is the day's emotional hinge), *Siege* (one flickering sodium lamp, muzzle flashes as the main light, moon rim on the horde) — plus *Breach* as an override (near-monochrome with red preserved) and per-scene zone overrides (Hospital sick-green fluorescents, Forest dappled cyan, Depot red strobe, Mall neutral) over a three-layer parallax (fence, buildings, sky) and fog planes.

**State through light, not HUD:** Power deficit dims rooms from the roof down; lost planks let street light spill onto Floor 0; the infection ring glows rot-green with a dashed outline and the Heat ring carries its number, so neither depends on colour alone.

**Feel:** 60 ms hit-stop on any Focus-Fire kill; 200 ms and a 6 px shake on a Brute death; 2 px shake per Brute swing; a slow 0.5° roll while a Screamer lives. Smooth-damped portrait camera with 16 px gutters. **Reduce motion** disables shakes, the roll and tilt-shift and shortens every transition to a 120 ms cut; hit-stops stay.

**Platform:** an installable PWA — manifest with `display: standalone` and `orientation: portrait`, a service worker that precaches the single bundle so it boots offline; IndexedDB save (localStorage fallback) with a `SAVE_VERSION` and forward migrations; 60 fps with the full post chain at 3× integer scale on a 2020 mid-range Android; `visibilitychange` pauses the sim (§2); no vibrate call before the Title tap, because Android Chrome ignores it.

## 14. Scope Guard

**Non-negotiable:** the Hold with Gate, Radio and eight buildable rooms at three tiers; four stats, two traits, portraits and logs; dayNoise → Heat → horde size and zone Attention; the infection clock with hidden bites, Put Down and Exile; the siege with its four verbs, five zombie types, ranged weapons, composition table, Noise meter and survivable Breach; scav runs with non-decaying Attention, waves behind you and the swipe-left run home; permadeath and the obituary card; the Dawn Report order, the boundary order and the context button; autosave at every phase boundary and the 1 s mid-phase snapshot; the haptic table with its queue and iOS shake fallback; the WebGL post chain (without it the pitch is wrong); the dusk crossfade; the seed and its named streams on every card.

**Cut in this order if over budget:**
1. Night Sortie and Second Runner (unlocks 9–10).
2. Zone modifiers and the Named Brute (keep the act cards as text).
3. Mutators beyond *Dry Season* and *Fast Ones*.
4. Legacy unlocks 7–8.
5. Events 15, 17, 18 (keep 15 events).
6. Daily Challenge and its card.
7. Familiar Faces from scav deaths (keep the Exile return).
8. Hypochondriac and the Check action.
9. Military Depot (the Rifle becomes a Mall rare).
10. Watchtower horde preview and *Voice on the Air*'s *Listen only*.
11. Adjacent-room synergy.
12. Long-press drag (fall back to tap survivor, tap room).
13. The extraction dodge tap (keep the warning).
14. Tilt-shift pass (keep light map, bloom, grade, grain).
15. The Wall render (keep the death log).

**Never cut:** the haptic vocabulary (300 lines, and it is the audio), the Dawn Report order, the seed on every card, infection timers, permadeath, the obituary card. Ship fewer systems at 100 % rather than every system at 80 %.
