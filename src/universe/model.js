// The procedural universe: every star system, world and moon is a pure function of its seed.
// Physically flavoured: main-sequence mass–luminosity–temperature relations, Kepler periods, equilibrium
// temperatures and a habitable zone decide what kind of world forms where.

import { RNG, clamp } from '../core/rng.js';
import { blackbody } from '../core/color.js';

const A = ['Au', 'Ca', 'El', 'Ha', 'Io', 'Ky', 'Lu', 'Me', 'No', 'Or', 'Pa', 'Sa', 'Te', 'Va', 'Ze', 'Ny', 'Tha', 'Ri', 'Ve', 'Mi'];
const B = ['ri', 'la', 'no', 'the', 'ra', 'li', 'mo', 'san', 'de', 'vi', 'ku', 'ne', 'tra', 'sol', 'phi', 'ru'];
const C = ['a', 'on', 'is', 'us', 'e', 'ar', 'el', 'ia', 'os', 'um', 'eth', 'ine'];
export function makeName(rng, syll = 2) { let s = rng.pick(A); for (let i = 1; i < syll; i++) s += rng.pick(B); return s + rng.pick(C); }

// spectral classes: [class, mass (M☉), probability weight among systems worth visiting]
const CLASSES = [['M', 0.35, 30], ['K', 0.72, 26], ['G', 1.0, 22], ['F', 1.3, 12], ['A', 2.0, 6], ['B', 5.0, 2], ['giant', 1.6, 2]];

/** Surface look of a world, consumed by the orbit + surface realms. Colours are linear RGB. */
export const KINDS = {
  garden: { sea: 0.02, ocean: [[0.004, 0.022, 0.075], [0.02, 0.16, 0.24]], land: [[0.05, 0.13, 0.03], [0.24, 0.2, 0.09], [0.32, 0.27, 0.2]], snow: 0.72, cloud: 0.52, atmo: [0.25, 0.5, 1.0], atmoDensity: 1.0, lights: 1.0, lava: 0 },
  ocean: { sea: 0.32, ocean: [[0.002, 0.02, 0.09], [0.01, 0.2, 0.26]], land: [[0.09, 0.2, 0.06], [0.4, 0.36, 0.2], [0.5, 0.48, 0.4]], snow: 0.8, cloud: 0.62, atmo: [0.2, 0.55, 1.0], atmoDensity: 1.1, lights: 0.25, lava: 0 },
  desert: { sea: -0.6, ocean: [[0.1, 0.05, 0.02], [0.2, 0.1, 0.04]], land: [[0.36, 0.17, 0.07], [0.55, 0.3, 0.13], [0.7, 0.5, 0.3]], snow: 0.93, cloud: 0.1, atmo: [0.9, 0.55, 0.3], atmoDensity: 0.55, lights: 0.15, lava: 0 },
  ice: { sea: -0.25, ocean: [[0.2, 0.32, 0.42], [0.45, 0.6, 0.7]], land: [[0.55, 0.66, 0.75], [0.78, 0.85, 0.9], [0.92, 0.95, 1.0]], snow: 0.3, cloud: 0.22, atmo: [0.55, 0.75, 1.0], atmoDensity: 0.5, lights: 0, lava: 0 },
  lava: { sea: -0.7, ocean: [[0.02, 0.01, 0.01], [0.05, 0.02, 0.01]], land: [[0.035, 0.03, 0.03], [0.09, 0.07, 0.065], [0.18, 0.14, 0.12]], snow: 2, cloud: 0.12, atmo: [1.0, 0.35, 0.12], atmoDensity: 0.45, lights: 0, lava: 1 },
  rock: { sea: -0.8, ocean: [[0.05, 0.05, 0.05], [0.1, 0.1, 0.1]], land: [[0.1, 0.095, 0.09], [0.2, 0.19, 0.18], [0.34, 0.33, 0.31]], snow: 2, cloud: 0, atmo: [0.6, 0.6, 0.65], atmoDensity: 0.06, lights: 0, lava: 0 },
  gas: { gas: 1, bands: [[0.55, 0.38, 0.22], [0.85, 0.7, 0.5], [0.42, 0.26, 0.16]], atmo: [1.0, 0.8, 0.6], atmoDensity: 0.8, cloud: 0, lights: 0 },
  icegiant: { gas: 1, bands: [[0.16, 0.42, 0.62], [0.42, 0.7, 0.8], [0.1, 0.3, 0.55]], atmo: [0.4, 0.75, 1.0], atmoDensity: 0.9, cloud: 0, lights: 0 },
};
const KIND_LABEL = { garden: 'living world', ocean: 'ocean world', desert: 'desert world', ice: 'ice world', lava: 'molten world', rock: 'barren world', gas: 'gas giant', icegiant: 'ice giant' };
/** Which of my favourite makers a living world is dreamed after (drives the surface realm's art direction). */
export const MOODS = ['pastoral', 'dunes', 'neon', 'monolith', 'floating', 'starry', 'wave', 'ruins'];

function planet(rng, i, aAU, star, forced = {}) {
  const teq = 278 * Math.pow(star.lum, 0.25) / Math.sqrt(aAU);         // equilibrium temperature, K
  let kind;
  const big = aAU > star.snow * 0.9 ? rng.chance(0.75) : rng.chance(0.08);
  if (big) kind = teq < 95 || rng.chance(0.35) ? 'icegiant' : 'gas';
  else if (teq > 700) kind = 'lava';
  else if (teq > 330) kind = rng.chance(0.7) ? 'desert' : 'rock';
  else if (teq > 235) kind = rng.weighted(['garden', 'ocean', 'desert'], [5, 3, 2]);
  else kind = rng.chance(0.75) ? 'ice' : 'rock';
  kind = forced.kind || kind;
  const giant = kind === 'gas' || kind === 'icegiant';
  const radius = forced.radius ?? (giant ? rng.float(3.6, 11) : rng.float(0.35, 1.9));    // Earth radii
  const life = kind === 'garden' ? rng.float(0.6, 1) : kind === 'ocean' ? rng.float(0.3, 0.8) : kind === 'desert' ? rng.float(0, 0.4) : 0;
  const civ = forced.civ ?? (life > 0.55 ? rng.weighted(['none', 'villages', 'cities', 'spacefaring', 'ruins'], [2, 3, 4, 2, 2]) : life > 0.2 && rng.chance(0.3) ? 'ruins' : 'none');
  const moons = [];
  const nm = forced.moons ?? (giant ? rng.int(1, 4) : rng.weighted([0, 1, 2], [5, 4, 1]));
  for (let m = 0; m < nm; m++) moons.push({ name: makeName(rng, 1), radius: rng.float(0.12, 0.3) * (giant ? 1.4 : 1), dist: 2.6 + m * 1.5 + rng.float(0, 0.7), phase: rng.float(0, 6.28), speed: rng.float(0.05, 0.14) / (1 + m * 0.6), tone: rng.float(0.35, 0.8) });
  return {
    index: i, seed: rng.seed, name: forced.name || makeName(rng, rng.chance(0.5) ? 2 : 1), kind, label: KIND_LABEL[kind], look: KINDS[kind],
    radius, a: aAU, period: Math.sqrt(aAU ** 3 / star.mass), phase: rng.float(0, Math.PI * 2), tilt: forced.tilt ?? rng.gauss(0, 0.3), day: rng.float(0.3, 2.5),
    teq, life, civ, mood: forced.mood || rng.pick(MOODS), rings: forced.rings ?? (giant ? rng.chance(0.5) : rng.chance(0.03)), moons,
    hue: rng.float(-1, 1), terrainSeed: rng.int(1, 1e9),
  };
}

export function systemFromSeed(seed) {
  if (seed === 'home') return homeSystem();
  const rng = new RNG(seed);
  const [cls, m0] = rng.weighted(CLASSES, CLASSES.map((c) => c[2]));
  const mass = m0 * rng.float(0.8, 1.25);
  const lum = cls === 'giant' ? rng.float(60, 400) : Math.pow(mass, 3.6);
  const tempK = cls === 'giant' ? rng.float(3400, 4600) : clamp(5778 * Math.pow(mass, 0.54), 2600, 28000);
  const radius = cls === 'giant' ? rng.float(18, 45) : Math.pow(mass, 0.8);
  const star = { name: makeName(rng, 2), cls, mass, lum, tempK, radius, color: blackbody(tempK), snow: 2.7 * Math.sqrt(lum), hz: [0.95 * Math.sqrt(lum), 1.67 * Math.sqrt(lum)] };
  const planets = []; const n = rng.int(3, 8);
  let a = rng.float(0.25, 0.5) * Math.sqrt(lum) * (cls === 'giant' ? 0.3 : 1);
  for (let i = 0; i < n; i++) { planets.push(planet(rng.fork(i), i, a, star)); a *= rng.float(1.45, 2.05); }
  return { seed, star, planets, belt: rng.chance(0.6) ? { a: planets[Math.min(n - 1, 2 + rng.int(0, 1))].a * 1.35 } : null };
}

function homeSystem() {
  const rng = new RNG('home');
  const star = { name: 'Aubade', cls: 'G', mass: 1, lum: 1, tempK: 5800, radius: 1, color: blackbody(5800), snow: 2.7, hz: [0.95, 1.67] };
  const P = (i, a, f) => planet(rng.fork(i), i, a, star, f);
  const planets = [
    P(0, 0.38, { name: 'Cinder', kind: 'lava', radius: 0.5, moons: 0, rings: false }),
    P(1, 1.0, { name: 'Selah', kind: 'garden', radius: 1.0, civ: 'cities', mood: 'pastoral', moons: 1, tilt: 0.38, rings: false }),
    P(2, 1.62, { name: 'Ochre', kind: 'desert', radius: 0.62, civ: 'ruins', mood: 'dunes', moons: 2, rings: false }),
    P(3, 5.1, { name: 'Cantor', kind: 'gas', radius: 10.4, moons: 4, rings: true }),
    P(4, 9.8, { name: 'Hymnal', kind: 'icegiant', radius: 4.2, moons: 2, rings: true }),
    P(5, 19, { name: 'Rest', kind: 'ice', radius: 0.4, moons: 1, rings: false }),
  ];
  planets[1].moons[0].name = 'Refrain'; planets[1].life = 1;
  return { seed: 'home', home: true, star, planets, belt: { a: 2.9 } };
}

export const STAR_LABEL = { M: 'red dwarf', K: 'orange dwarf', G: 'yellow dwarf', F: 'white star', A: 'blue-white star', B: 'blue giant', giant: 'red giant' };
