// Selah — harmony engine. All material is ORIGINAL and written relative to a key centre (home = D), so the
// whole score can drift to related keys by pivot modulation while every scene keeps its own modal identity.
//
// Chord DSL (one string per bar, "a | b" = two chords in the bar):  "<semitones above tonic> <quality>[~mode][/bass]"
// The comments give the chord names in the home key of D.

import { makeChord, pcName } from './theory.js';

export const HOME_KEY = 2; // D

export const FORMS = {
  // before the first light: an open fifth, no third yet
  void: { sections: { A: ['0 5'] }, order: ['A'], home: true },
  // the universe opens in D lydian
  genesis: { sections: { A: ['0 maj9#11'] }, order: ['A'], home: true },
  // the cosmic web: B dorian <-> D lydian (parent scale A major), planing downward in the B section
  web: {
    sections: {
      A: ['9 m11', '9 m11', '2 13sus', '2 13sus', '9 m11', '9 m11', '2 13sus', '2 9'],                    // Bm11 | E13sus ... E9
      B: ['0 maj9#11', '0 maj9#11', '11 m11p', '11 m11p', '9 m11', '7 maj9/11', '2 13sus', '2 13sus'],     // Dmaj9#11 C#m11 Bm11 A/C# E13sus
    }, order: ['A', 'B'], drift: true,
  },
  // widescreen wonder: E dorian colours resolving to D, with a bVI-bVII lift at the end of the form
  galaxy: {
    sections: {
      A: ['2 m11', '7 13sus', '0 maj9', '5 maj9#11', '2 m11', '7 13sus', '9 m11~aeo', '9 m11~aeo'],        // Em11 A13sus Dmaj9 Gmaj9#11 ... Bm11
      B: ['5 maj9#11', '4 m11p', '2 m11', '7 13sus', '8 maj7#11', '10 maj9#11', '7 13sus', '7 13'],        // G F#m Em A13sus | Bbmaj7#11 Cmaj9#11 A13sus A13
    }, order: ['A', 'B'], drift: true,
  },
  // intimate, curious: G lydian centre
  system: {
    sections: { A: ['5 maj9#11', '5 maj9#11', '2 m9', '2 m9', '10 maj9~lyd', '10 maj9~lyd', '0 6/9', '0 6/9'] }, // G | Em9 | Cmaj9 | D6/9
    order: ['A'], drift: true,
  },
  // sunrise: the harmonisation of the main theme (see THEME), then a bVII / bVI coloured bridge
  orbit: {
    sections: {
      A: ['0 add9', '2 maj~mix/0', '9 m11~aeo', '5 maj9', '2 m11', '0 add9/4', '5 maj7#11 | 7 13sus', '0 add9'], // D E/D Bm11 Gmaj9 Em11 D/F# G A13sus D
      B: ['10 add9~lyd', '5 maj/9', '8 maj7#11', '7 13sus | 7 9'],                                                // C G/B Bbmaj7#11 A13sus A9
    }, order: ['A', 'A', 'B', 'A'], drift: false,
  },
  // walking a living world: D mixolydian, earthy
  surface: {
    sections: {
      A: ['0 9sus', '0 9', '5 maj9', '5 6/9', '9 m11~aeo', '9 m11~aeo', '10 maj9#11', '7 13sus'],          // D9sus D9 Gmaj9 G6/9 Bm11 Cmaj9#11 A13sus
      B: ['2 m11', '4 m11p', '5 maj9', '7 13sus', '2 m11', '4 m11p', '5 maj9#11', '10 9#11'],              // Em F#m G A13sus ... C9#11
    }, order: ['A', 'A', 'B', 'A'], drift: true,
  },
  // flight: B minor, with the 7#9 colour as V and as dorian IV
  ride: {
    sections: {
      A: ['9 m9~aeo', '9 m9~aeo', '5 maj9#11', '5 maj9#11', '0 add9/7', '7 13sus', '2 m11', '6 7#9'],      // Bm9 Gmaj9#11 D/A A13sus Em11 F#7#9
      B: ['9 m9', '2 9', '9 m9', '2 7#9', '5 maj9', '7 13sus', '9 m9~aeo', '6 7#9'],                        // Bm9 E9 Bm9 E7#9 Gmaj9 A13sus Bm9 F#7#9
    }, order: ['A', 'B'], drift: true,
  },
  // the event horizon: a D pedal under slowly turning clusters
  blackhole: {
    sections: { A: ['0 mM9', '0 mM9', '1 maj7#11/0', '1 maj7#11/0', '0 5', '5 mM9/0', '5 mM9/0', '0 mM9'] },
    order: ['A'], home: true,
  },
  // the climax (played once), then an afterglow that loops
  title: {
    sections: {
      C: ['0 add9', '9 m11~aeo | 5 maj9', '8 maj7#11', '10 add9~lyd | 7 13sus', '0 add9', '0 add9'],       // D | Bm11 Gmaj9 | Bbmaj7#11 | C A13sus | D | D
      L: ['0 add9', '5 maj9/0', '0 add9', '7 13sus'],                                                       // D | G/D | D | A13sus
    }, once: ['C'], order: ['L'], home: true,
  },
};

/**
 * THE THEME — eight bars in 4/4, one bar per entry: [beat, duration (beats), semitones above the tonic].
 * Pentatonic rise-and-fall with a lydian lift in bar 2, climax in bar 6, stepwise fall to the tonic.
 * It returns all over the score: glass tones in the void, celesta in `system`, vibraphone in `galaxy`,
 * chord-melody guitar in `orbit`, and the sustained lead in `title`.
 */
export const THEME = [
  [[0.5, 0.5, 4], [1, 0.5, 7], [1.5, 1, 9], [2.5, 0.5, 7], [3, 1, 4]],              // F# A B— A F#—
  [[0.5, 0.5, 4], [1, 0.5, 6], [1.5, 1.5, 9], [3, 1, 7]],                            // F# G# B—— A—
  [[0.5, 0.5, 9], [1, 0.5, 12], [1.5, 1.5, 14], [3, 0.5, 12], [3.5, 0.5, 9]],        // B D E—— D B
  [[0, 2, 7], [2, 1, 4], [3, 1, 2]],                                                 // A——— F#— E—
  [[0.5, 0.5, 2], [1, 0.5, 7], [1.5, 1, 9], [2.5, 0.5, 12], [3, 1, 14]],             // E A B— D E—
  [[0, 1.5, 16], [1.5, 0.5, 14], [2, 1, 12], [3, 1, 9]],                             // F#—— E D— B—
  [[0, 1, 7], [1, 0.5, 9], [1.5, 0.5, 7], [2, 1, 4], [3, 1, 2]],                     // A— B A F#— E—
  [[0, 4, 0]],                                                                       // D————
];

/** The title climax line for the lead voice (6 bars): [beat, dur, semitones above tonic, articulation]. */
export const CLIMAX = [
  [[0, 2.5, 16, 'bend2'], [2.5, 0.5, 14], [3, 1, 12]],                               // (E^)F#——— E D
  [[0, 1, 9], [1, 0.5, 12], [1.5, 0.5, 14], [2, 1.5, 16, 'vib'], [3.5, 0.5, 14]],    // B D E | F#—— E
  [[0, 3, 15, 'vib'], [3, 0.5, 17], [3.5, 0.5, 19]],                                 // F♮——— G A   (over bVI)
  [[0, 2, 17, 'vib'], [2, 1, 19], [3, 1, 23, 'bend2']],                              // G—— A | (B^)C#
  [[0, 8, 24, 'bloom']],                                                             // D ———————— feedback bloom
  [],
];

function parseBar(str) {
  return str.replace(/6\/9/g, '69').split('|').map((s, i, arr) => {
    const m = /^\s*(-?\d+)\s+([^~/\s]+)(?:~(\w+))?(?:\/(\d+))?\s*$/.exec(s);
    if (!m) throw new Error('bad chord "' + s + '"');
    return { frac: i / arr.length, off: +m[1], q: m[2], mode: m[3] || null, bass: m[4] == null ? null : +m[4] };
  });
}
const PARSED = {};
for (const [name, f] of Object.entries(FORMS)) {
  const sections = {};
  for (const [k, bars] of Object.entries(f.sections)) sections[k] = bars.map(parseBar);
  const flat = (order) => order.flatMap((k) => sections[k]);
  PARSED[name] = { once: f.once ? flat(f.once) : [], loop: flat(f.order), home: !!f.home, drift: !!f.drift };
}

const MOVES = [5, 7, 2, -2, 3, -3];      // up a 4th / 5th, whole tone either way, minor third either way

export function createHarmony({ rng, drift = true }) {
  const H = {
    key: HOME_KEY, home: HOME_KEY, pendingKey: null, barsInKey: 0, drift,
    keyName: () => pcName(H.key),
    /** tonic as a MIDI note in the octave starting at `oct` (C-based), e.g. tonic(4) = D4 = 62 */
    tonic: (oct = 4) => 12 * (oct + 1) + H.key,
    enter(scene) { if (PARSED[scene].home) { H.key = H.home; H.pendingKey = null; H.barsInKey = 0; } },
    formLength(scene) { return PARSED[scene].loop.length; },
    /** Chords of bar `i` (bars since the scene began): { segs:[{frac, ch}], pos, len, once, last } */
    bar(scene, i) {
      const P = PARSED[scene];
      if (H.pendingKey != null && (i < P.once.length || (i - P.once.length) % P.loop.length === 0)) {
        H.key = H.pendingKey; H.pendingKey = null; H.barsInKey = 0;
      }
      let spec, pos, len, once = false;
      if (i < P.once.length) { spec = P.once[i]; pos = i; len = P.once.length; once = true; }
      else { pos = (i - P.once.length) % P.loop.length; len = P.loop.length; spec = P.loop[pos]; }
      H.barsInKey++;
      const last = !once && pos === len - 1;
      // pivot modulation: at the end of a form, sometimes replace the last bar by V13sus of a related key
      if (last && P.drift && H.drift && H.barsInKey >= 24 && rng.chance(0.6)) {
        const dist = ((H.key - H.home + 18) % 12) - 6;                       // signed distance from home
        let move = rng.pick(MOVES);
        if (dist !== 0 && rng.chance(0.55)) move = -dist;                    // gravity toward home
        const nk = (((H.key + move) % 12) + 12) % 12;
        H.pendingKey = nk;
        const ch = makeChord(nk + 7, '13sus');
        return { segs: [{ frac: 0, ch }], pos, len, once, last, pivot: true };
      }
      const segs = spec.map((s) => ({ frac: s.frac, ch: makeChord(H.key + s.off, s.q, s.bass == null ? null : H.key + s.bass, s.mode) }));
      return { segs, pos, len, once, last, pivot: false };
    },
    /** First chord of bar i+1 without advancing any state (for bass approaches / anticipations). */
    peek(scene, i) {
      const P = PARSED[scene], j = i + 1;
      const key = H.pendingKey != null && j >= P.once.length && (j - P.once.length) % P.loop.length === 0 ? H.pendingKey : H.key;
      const s = (j < P.once.length ? P.once[j] : P.loop[(j - P.once.length) % P.loop.length])[0];
      return makeChord(key + s.off, s.q, s.bass == null ? null : key + s.bass, s.mode);
    },
  };
  return H;
}
