/**
 * game/balance.js — Every tunable number in HOLDOUT, mirroring docs/GDD.md (§3 rooms, §4 survivors,
 * §5 siege, §6 scav, §8 progression, §11 balance). Pure data plus tiny pure helpers. No game logic here.
 *
 * Public API: B (frozen object), B.roomOutput(tierBase, stat), B.horde(day, heat, mods), B.siegeDuration(day),
 *   B.searchTime(hands), B.accuracy(aim, bonus), B.hpMax(grit), B.heatNext(heat, dayNoise, keep), B.marks(...)
 */

const ROOMS = {
  //           cost per tier (build=T1, →T2, →T3)   power draw   stat      outputs per worker per day by tier
  gate:       { name: 'Gate',        cost: [0, 40, 90],   draw: 0, stat: 'grit',  fixedFloor: 0, workers: 0, hpMax: [100, 180, 300], defenderSlots: 2 },
  bunks:      { name: 'Bunks',       cost: [20, 35, 60],  draw: 0, stat: null,    workers: 0, morale: [3, 5, 8], rosterCap: [8, 10, 12] },
  kitchen:    { name: 'Kitchen',     cost: [25, 45, 80],  draw: 1, stat: 'hands', workers: 2, out: { key: 'food', base: [3, 5, 8] } },
  cistern:    { name: 'Cistern',     cost: [25, 45, 80],  draw: 1, stat: 'hands', workers: 2, out: { key: 'water', base: [3, 5, 8] } },
  generator:  { name: 'Generator',   cost: [35, 60, 100], draw: 0, stat: 'hands', workers: 2, out: { key: 'power', base: [6, 10, 16] }, noise: [2, 3, 4] },
  workshop:   { name: 'Workshop',    cost: [30, 50, 90],  draw: 2, stat: 'hands', workers: 2, out: { key: 'scrap', base: [4, 6, 9] } },
  infirmary:  { name: 'Infirmary',   cost: [30, 55, 95],  draw: 2, stat: 'hands', workers: 2, heal: [15, 25, 40], patientSlots: [1, 2, 3], cureTier: 2, craftMedTier: 3 },
  armory:     { name: 'Armory',      cost: [30, 55, 95],  draw: 1, stat: 'aim',   workers: 2, out: { key: 'ammo', base: [5, 8, 12] }, dmgBonus: [0.10, 0.20, 0.35] },
  watchtower: { name: 'Watchtower',  cost: [25, 50, 85],  draw: 1, stat: 'aim',   workers: 0, accBonus: [0.15, 0.25, 0.40], defenderSlots: 1, previewTier: 2 },
  radio:      { name: 'Radio',       cost: [40, 80, 150], draw: 3, stat: 'nerve', fixedFloor: 7, workers: 0, broadcastNoise: 4, broadcastChance: 0.6, rerollTier: 2, beaconTier: 3, beaconDay: 20 },
};

export const B = Object.freeze({
  VERSION: 1,
  FLOORS: 8,
  ROOMS,
  ROOM_TYPES_BUILDABLE: ['bunks', 'kitchen', 'cistern', 'generator', 'workshop', 'infirmary', 'armory', 'watchtower'],
  ROSTER_CAP_NO_BUNKS: 6,
  DEMOLISH_REFUND: 0.5,
  OUTPUT: { base: 0.7, perStat: 0.06, adjacency: 1.10, unpowered: 0.5, lowMorale: 0.8, lowMoraleAt: 30, highMorale: 1.1, highMoraleAt: 70 },
  GATE: { repairScrapPer5Hp: 1, startHp: 60 },

  START: { food: 16, water: 16, scrap: 50, meds: 2, ammo: 30, morale: 60, heat: 0, survivors: 4,
           gear: { pistol: 2, bat: 2, shotgun: 0, rifle: 0, machete: 0, vest: 0 }, throwables: { molotov: 1, pipebomb: 0, flare: 0 }, kits: 0 },

  SURVIVOR: {
    statMin: 1, statMax: 10, draftTotalMin: 16, draftTotalMax: 22, draftHighStat: 6,
    hpBase: 20, hpPerGrit: 8, regenPerDay: 5, maxWounds: 3, traitsEach: 2,
    foodPerDay: 1, waterPerDay: 1,
    bleedPerBoundary: 6, bandageMeds: 1,
    fractureStatPenalty: 2, fractureDaysPatient: 3, fractureDaysIdle: 6,
    infectionHours: 48, infectionHoursLongFuse: 72, infectionHoursImmune: 96,
    cureEarlyHours: 24, cureEarlyMeds: 3, cureLateMeds: 6, cureLateChance: 0.5, checkMeds: 1,
    hiddenBiteChance: 0.15, noticeNerve: 6, confessHours: 24, immuneVisibleAt: 48,
    turnRoommateDamage: 30, turnRoommateBite: 0.5, turnAmmo: 1,
    hypochondriacChance: 0.2, medicFieldMeds: 3,
  },

  MORALE: { start: 60, min: 0, max: 100,
    fedAll: 2, siegeNoBreach: 5, want: 10, familiarRest: 6, wake: 8, ghost: 5,
    death: -10, turn: -15, breach: -15, exile: -8, putDown: -10, mercy: -10, familiarAlive: -6,
    foodShort: -10, waterShort: -15, waterSecondDryDamage: 20,
    refuseBelow: 30, walkoutBelow: 10, walkoutFood: 5, faithfulFloor: 20,
    hoarderScrapReturn: 3, hoarderUpgrade: -3, lightSleeperDaily: -2, grudgeDaily: -2, grudgeRivalDies: 5 },

  TRAITS: {
    steady:      { name: 'Steady Hands',  searchTime: 0.75, refusesDefense: true },
    scrounger:   { name: 'Scrounger',     extraLootRoll: 1, refusesDefense: true },
    heavyfoot:   { name: 'Heavy Foot',    packSlots: 2, screenAttention: 6 },
    medic:       { name: 'Medic',         infirmaryMult: 1.5, curesAtT1: true, fieldCure: true, grit: -1 },
    lightsleeper:{ name: 'Light Sleeper', waveWarnSec: 3, nightAim: 1, dailyMorale: -2 },
    irongut:     { name: 'Iron Gut',      immuneBadWater: true, immuneRats: true, nerve: -1 },
    coward:      { name: 'Coward',        detectRadius: 0.75, abandonsBelow: 0.25 },
    loud:        { name: 'Loud',          grit: 2, dayNoise: 1 },
    quiet:       { name: 'Quiet',         dayNoise: -1, grit: -1 },
    proud:       { name: 'Proud',         grit: 1, alwaysHidesBite: true },
    hypochondriac:{ name: 'Hypochondriac', nerve: 1, falseBite: 0.2 },
    hoarder:     { name: 'Hoarder',       scrapReturnMorale: 3, upgradeMorale: -3 },
    faithful:    { name: 'Faithful',      moraleFloor: 20, shootKnockMorale: -5, exileMorale: -5 },
    grudge:      { name: 'Grudge',        rivalDiesMorale: 5, dailyMorale: -2 },
    immune:      { name: 'Immune',        infectionHours: 96, ringHiddenUntil: 48 },
    oldhand:     { name: 'Old Hand',      allStats: 1, foodPerDay: 2, legacyOnly: true },
  },

  SIEGE: {
    fireInterval: 1.0, accBase: 0.45, accPerAim: 0.05, accCap: 0.95,
    meleeBase: 6, meleeInterval: 1.2, meleeBite: 0.10,
    durationBase: 60, durationPerDay: 2, durationMax: 120, hardDawnGrace: 45,
    waves: [0, 1 / 3, 2 / 3], waveShare: [0.30, 0.30, 0.40],
    focusDur: 3, focusMult: 1.5, focusCooldown: 1.0,
    braceHpPerSec: 4, runnerBracerDamage: 8, runnerBracerBite: 0.15, bruteBracerDamage: 10,
    throwSlots: 3, throwCooldown: 4,
    throwables: { molotov: { dur: 6, dps: 8, noise: 10, laneWidth: 0.12 }, pipebomb: { dmg: 40, radius: 0.10, noise: 25 }, flare: { dur: 5, noise: 0 } },
    noise: { shot: 1, shotgun: 2, molotov: 10, pipebomb: 25, scream: 15, bloaterPop: 6, decayPerSec: 3, thresholds: [25, 50, 75, 100], miniWaveBase: 3, miniWavePerDays: 5 },
    breach: { insideDamage: 15, insideBite: 0.20, insideInterval: 4, morale: -15 },
    bruteRoarAt: 0.40, bruteRoarDur: 3, bruteRoarDamageMult: 2.0, screamerStopAt: 0.5, screamInterval: 6, bloaterCloudDur: 3, bloaterCloudBite: 0.30,
    familiarHp: 25, familiarExileNights: 3, familiarZoneChance: 0.4, familiarZoneNightsMin: 2, familiarZoneNightsMax: 5,
    hitStopMs: 60, bruteDeathShakePx: 6,
  },

  ZOMBIES: {
    //                   hp  street/s   wall dmg  every s   unlock
    shambler: { hp: 15, speed: 1 / 12, dmg: 2,  hitEvery: 1.5, day: 1 },
    runner:   { hp: 10, speed: 1 / 5,  dmg: 2,  hitEvery: 1.0, day: 12, heat: 3 },
    screamer: { hp: 12, speed: 1 / 10, dmg: 0,  hitEvery: 0,   day: 4 },
    brute:    { hp: 60, speed: 1 / 20, dmg: 10, hitEvery: 2.0, day: 6 },
    bloater:  { hp: 30, speed: 1 / 17, dmg: 4,  hitEvery: 1.0, day: 9 },
    familiar: { hp: 25, speed: 1 / 12, dmg: 2,  hitEvery: 1.5, day: 1 },
  },
  ZOMBIE_ORDER: ['shambler', 'screamer', 'brute', 'bloater', 'runner'],

  HORDE: { base: 5, perDay: 1.5, perDay2: 0.02, bloodMoonNights: [21, 27], bloodMoonMult: 1.5, beaconMult: 1.5, pastDay: 30, pastPerNight: 4,
           twoBrutesFrom: 16, screamerPairsFrom: 25, runnersEveryNightFrom: 12 },

  HEAT: { keep: 0.6, keepLoudWorld: 0.8, max: 20, attentionPerHeat: 4, attentionStartCap: 40, noiseFromAttentionDiv: 25, noiseFromSiegeDiv: 25 },

  WEAPONS: {
    pistol:  { dmg: 8,  ammo: 1, ranged: true,  noise: 1, targets: 1 },
    shotgun: { dmg: 20, ammo: 2, ranged: true,  noise: 2, targets: 2 },
    rifle:   { dmg: 30, ammo: 1, ranged: true,  noise: 1, targets: 1 },
    bat:     { dmg: 12, ammo: 0, ranged: false, noise: 0, targets: 1 },
    machete: { dmg: 18, ammo: 0, ranged: false, noise: 0, targets: 1 },
  },
  ARMOR: { vest: { biteMult: 0.7 } },

  CRAFT: {
    ammo8:   { name: '8 Ammo',     room: 'workshop',  tier: 1, scrap: 5,  gives: { res: { ammo: 8 } } },
    molotov: { name: 'Molotov',    room: 'workshop',  tier: 2, scrap: 6,  gives: { throwables: { molotov: 1 } } },
    machete: { name: 'Machete',    room: 'workshop',  tier: 2, scrap: 20, gives: { gear: { machete: 1 } } },
    pipebomb:{ name: 'Pipe Bomb',  room: 'workshop',  tier: 3, scrap: 12, gives: { throwables: { pipebomb: 1 } } },
    flare:   { name: 'Flare',      room: 'workshop',  tier: 3, scrap: 8,  gives: { throwables: { flare: 1 } } },
    shotgun: { name: 'Shotgun',    room: 'armory',    tier: 2, scrap: 30, gives: { gear: { shotgun: 1 } } },
    vest:    { name: 'Vest',       room: 'armory',    tier: 2, scrap: 25, gives: { gear: { vest: 1 } } },
    rifle:   { name: 'Rifle',      room: 'armory',    tier: 3, scrap: 60, gives: { gear: { rifle: 1 } } },
    med:     { name: 'Med',        room: 'infirmary', tier: 3, scrap: 4,  gives: { res: { meds: 1 } } },
  },

  ZONES: {
    suburbs:  { name: 'Suburbs',        day: 1,  screens: 6, containers: { cupboard: 0.60, crate: 0.25, corpse: 0.15 }, zombies: ['shambler'], focus: ['food', 'water', 'scrap'] },
    mall:     { name: 'Strip Mall',     day: 3,  screens: 7, containers: { locker: 0.40, crate: 0.40, cupboard: 0.20 }, zombies: ['shambler', 'runner'], focus: ['scrap', 'ammo', 'gear'] },
    hospital: { name: 'Hospital',       day: 6,  screens: 8, containers: { cabinet: 0.55, cupboard: 0.25, corpse: 0.20 }, zombies: ['shambler', 'bloater'], focus: ['meds'] },
    forest:   { name: 'Forest Camp',    day: 10, screens: 8, containers: { cupboard: 0.50, crate: 0.30, corpse: 0.20 }, zombies: ['runner', 'screamer'], focus: ['food', 'water', 'survivor'] },
    depot:    { name: 'Military Depot', day: 15, screens: 9, containers: { locker: 0.50, crate: 0.40, corpse: 0.10 }, zombies: ['shambler', 'brute'], focus: ['ammo', 'pipebomb', 'rifle'], sleepingBrute: true },
  },
  ZONE_RARE: { suburbs: 'vest', mall: 'shotgun', hospital: 'kit', forest: 'vest', depot: 'rifle' },

  SCAV: {
    containersMin: 1, containersMax: 3, zombiesMin: 0, zombiesMax: 2, asleepChance: 0.5, hazardChance: 0.2, hazardAttention: 12, hazardSeeNerve: 6,
    rescueChance: 0.14, rescueFromScreen: 2, rescuePackSlots: 2,
    searchBase: 3.0, searchPerHands: 0.15, searchMin: 1.5, crouchSpeed: 0.5, crouchDetect: 0.5,
    meleeInterval: 0.6, gunAttention: 10, sprintAttentionPerSec: 2,
    wakeRadius: 1.5, wakeRadiusCrouch: 0.75, wakeNervePer: 0.05, tileUnits: 32,
    zombieStrikeInterval: 1.2, zombieHitBase: 0.45, zombieHitPerGrit: 0.04, zombieDmgMin: 8, zombieDmgMax: 14,
    biteChance: { shambler: 0.10, runner: 0.15, brute: 0.10, screamer: 0.10, bloater: 0.10, familiar: 0.10 }, bruteFracture: 0.30, bloaterCloudBite: 0.30, screamAttention: 15,
    packSlots: 8, stack: { food: 5, water: 5, scrap: 5, meds: 3, ammo: 10, throwable: 2, gear: 1, kit: 1 }, kitMeds: 3,
    attention: { container: 6, screen: 3, gunshot: 10, hazard: 12, thresholds: [33, 66, 100], waves: [2, 4, 6], ringEvery: 10 },
    rareWeightFromScreen: 4, rareWeightMult: 2,
    extract: { perScreen: 2.5, packPenaltyPer: 0.1, packPenaltyFrom: 5, hitBase: 0.5, hitPerGrit: 0.04, dmg: 12, bite: 0.15 },
    corpseNotDead: 0.15, corpseBite: 0.20,
    speedUnitsPerSec: 48, sprintUnitsPerSec: 96,
  },

  LOOT: {
    cupboard: [ ['food', 3, 0.45], ['water', 3, 0.30], ['scrap', 3, 0.15], ['meds', 1, 0.10] ],
    locker:   [ ['ammo', 8, 0.45], ['scrap', 4, 0.25], ['gear', 1, 0.20], ['throwable', 1, 0.10] ],
    crate:    [ ['scrap', 5, 0.50], ['throwable', 1, 0.25], ['gear', 1, 0.15], ['rare', 1, 0.10] ],
    cabinet:  [ ['meds', 1, 0.50], ['meds', 2, 0.25], ['kit', 1, 0.15], ['nothing', 0, 0.10] ],
    corpse:   [ ['gear', 1, 0.35], ['ammo', 6, 0.30], ['scrap', 3, 0.15], ['nothing', 0, 0.20] ],
    gearPool: ['bat', 'pistol', 'machete', 'vest', 'shotgun'],
    gearWeights: [0.30, 0.30, 0.15, 0.15, 0.10],
    throwablePool: ['molotov', 'flare', 'pipebomb'],
    throwableWeights: [0.6, 0.25, 0.15],
  },

  EVENTS: { storm: { weight: 0.08, minDay: 4, barricadeDamage: 40 }, traderMinDay: 5, traderDays: 2, traderAmmoPerMed: 5, traderMaxMeds: 4, traderSurvivorScrap: 60,
            knockBiteChance: 0.2, knockMinDay: 2, generatorCoughFire: 0.3, badWaterHp: 10, badWaterChance: 0.5, ratsFood: 6, ratsTrapScrap: 3, ratsCatChance: 0.6,
            coughBite: 0.15, feverAim: 3, feverFail: 0.4, fuelScrap: 30, fuelPower: 10, wakeFood: 3, quietMult: 0.5, quietOutput: 1.25 },

  LEGACY: {
    winMarks: 10, sharedMax: 5, streakPer: 0.1, streakMax: 5, mutatorBonus: 0.10,
    unlocks: [
      { id: 'wall',    name: 'The Wall Remembers', cost: 10, blurb: 'One fallen survivor from a past run appears in the Roster Draft with their old traits.' },
      { id: 'oldhand', name: 'Old Hand',           cost: 15, blurb: 'One starting survivor gets the Old Hand trait (+1 all stats, eats 2 Food).' },
      { id: 'kit',     name: 'Field Kit',          cost: 20, blurb: 'Start with one Antibiotic kit.' },
      { id: 'tinker',  name: 'Tinker',             cost: 25, blurb: 'Workshop T1 pre-built on Floor 1.' },
      { id: 'quietgen',name: 'Quiet Generator',    cost: 30, blurb: 'Generator dayNoise −1.' },
      { id: 'fuse',    name: 'Long Fuse',          cost: 40, blurb: 'Infection clock 72 h (cure tiers at 36 h).' },
      { id: 'carto',   name: 'Cartographer',       cost: 50, blurb: 'Zone Select shows screen and container counts.' },
      { id: 'radio2',  name: 'Second Broadcast',   cost: 60, blurb: 'Broadcast recruits at 80 %.' },
    ],
    mutators: [
      { id: 'dry',   name: 'Dry Season', blurb: 'Cistern output ×0.5.' },
      { id: 'fast',  name: 'Fast Ones',  blurb: 'Runners from Night 1.' },
      { id: 'loud',  name: 'Loud World', blurb: 'Heat keeps 80 % instead of 60 %.' },
      { id: 'short', name: 'Short Season', blurb: 'Radio T3 from Day 10; the curve compresses ×2.' },
    ],
    dailyMutatorByWeekday: ['loud', 'dry', 'fast', 'short', 'dry', 'fast', 'loud'],
  },

  TUTORIAL: { suburbsDay1Screens: 4, siegeDay1Count: 7 },

  /** GDD §3 output formula (per worker, before adjacency/power/morale multipliers). */
  roomOutput(tierBase, stat) { return tierBase * (0.7 + 0.06 * stat); },
  /** GDD §8 horde total for a night. mods = { bloodMoon, beacon, short } */
  horde(day, heat, mods = {}) {
    const d = mods.short ? day * 2 : day;
    let base = Math.round(5 + 1.5 * d + 0.02 * d * d);
    if (d > 30) base += 4 * (d - 30);
    let total = base + heat;
    if (mods.bloodMoon || mods.beacon) total = Math.round(total * 1.5);
    return { base, total };
  },
  siegeDuration(day) { return Math.min(120, 60 + 2 * day); },
  searchTime(hands, mult = 1) { return Math.max(1.5, 3.0 - 0.15 * hands) * mult; },
  accuracy(aim, bonus = 0) { return Math.min(0.95, 0.45 + 0.05 * aim + bonus); },
  hpMax(grit) { return 20 + grit * 8; },
  heatNext(heat, dayNoise, keep = 0.6) { return Math.min(20, Math.round(keep * (heat + dayNoise))); },
  marks(nights, won, shared, streak, mutators = 0) {
    const streakMult = 1 + 0.1 * Math.min(5, streak);
    return Math.round((nights + (won ? 10 : 0) + Math.min(5, shared)) * streakMult * (1 + 0.1 * mutators));
  },
});
export default B;
