// Selah — music theory: modes, extended chord qualities, voice-led voicings, scale ladders.

export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
export const pcName = (pc) => NOTE_NAMES[((pc % 12) + 12) % 12];

export const MODES = {
  ion: [0, 2, 4, 5, 7, 9, 11], lyd: [0, 2, 4, 6, 7, 9, 11], mix: [0, 2, 4, 5, 7, 9, 10], dor: [0, 2, 3, 5, 7, 9, 10],
  aeo: [0, 2, 3, 5, 7, 8, 10], phr: [0, 1, 3, 5, 7, 8, 10], mel: [0, 2, 3, 5, 7, 9, 11], ldom: [0, 2, 4, 6, 7, 9, 10],
  blu: [0, 2, 3, 4, 5, 7, 9, 10], pent: [0, 2, 4, 7, 9],
};

// t: chord tones in voicing priority order (guide tones first, root last — the bass usually owns the root)
// s: default scale for melodic material, p: pentatonic (relative to root) that always sounds good over it
export const QUAL = {
  'maj':     { t: [4, 7, 0, 14], s: 'ion', p: [0, 2, 4, 7, 9] },
  'add9':    { t: [4, 14, 7, 0], s: 'ion', p: [0, 2, 4, 7, 9] },
  '6/9':     { t: [4, 9, 14, 7, 0], s: 'ion', p: [0, 2, 4, 7, 9] },
  'maj9':    { t: [4, 11, 14, 7, 0], s: 'ion', p: [0, 2, 4, 7, 9] },
  'maj7#11': { t: [4, 11, 18, 7, 14, 0], s: 'lyd', p: [2, 4, 6, 9, 11] },
  'maj9#11': { t: [4, 11, 14, 18, 7, 0], s: 'lyd', p: [2, 4, 6, 9, 11] },
  'm7':      { t: [3, 10, 7, 0, 17], s: 'dor', p: [0, 3, 5, 7, 10] },
  'm9':      { t: [3, 10, 14, 7, 0], s: 'dor', p: [0, 3, 5, 7, 10] },
  'm11':     { t: [3, 10, 17, 14, 7, 0], s: 'dor', p: [0, 3, 5, 7, 10] },
  'm11p':    { t: [3, 10, 17, 7, 0], s: 'phr', p: [0, 3, 5, 7, 10] },
  'mM9':     { t: [3, 11, 14, 7, 0], s: 'mel', p: [0, 2, 3, 7, 9] },
  '9sus':    { t: [5, 10, 14, 7, 0], s: 'mix', p: [0, 2, 5, 7, 10] },
  '13sus':   { t: [5, 10, 14, 21, 7, 0], s: 'mix', p: [0, 2, 5, 7, 9] },
  '9':       { t: [4, 10, 14, 7, 0], s: 'mix', p: [0, 2, 4, 7, 9] },
  '13':      { t: [4, 10, 21, 14, 0, 7], s: 'mix', p: [0, 2, 4, 7, 9] },
  '7#9':     { t: [4, 10, 15, 0, 7], s: 'blu', p: [0, 3, 5, 7, 10] },
  '9#11':    { t: [4, 10, 14, 18, 0], s: 'ldom', p: [0, 2, 4, 6, 9] },
  '5':       { t: [7, 0, 14], s: 'ion', p: [0, 2, 7, 9] },
};

QUAL['69'] = QUAL['6/9'];

const chordCache = new Map();

/** Build (and cache) an absolute chord: root/bass pitch classes, tones by priority, scale, lookup tables. */
export function makeChord(root, q, bass = null, mode = null) {
  root = ((root % 12) + 12) % 12;
  const bs = bass == null ? root : ((bass % 12) + 12) % 12;
  const key = root + '|' + q + '|' + bs + '|' + (mode || '');
  let ch = chordCache.get(key);
  if (ch) return ch;
  const Q = QUAL[q];
  if (!Q) throw new Error('unknown chord quality ' + q);
  const scaleIv = MODES[mode || Q.s];
  const tones = Q.t.map((iv) => (root + iv) % 12);
  const isTone = new Uint8Array(12), inScale = new Uint8Array(12), inPent = new Uint8Array(12);
  for (const pc of tones) isTone[pc] = 1;
  for (const iv of scaleIv) inScale[(root + iv) % 12] = 1;
  for (const pc of tones) inScale[pc] = 1;
  for (const iv of Q.p) inPent[(root + iv) % 12] = 1;
  ch = {
    root, bass: bs, q, mode: mode || Q.s, tones, isTone, inScale, inPent,
    ivs: Q.t, third: (root + Q.t[0]) % 12, fifth: (root + 7) % 12,
    minor: Q.t[0] === 3, sus: Q.t[0] === 5, dom: Q.t.includes(10) && (Q.t[0] === 4 || Q.t[0] === 5),
    name: pcName(root) + q + (bs !== root ? '/' + pcName(bs) : ''),
  };
  chordCache.set(key, ch);
  return ch;
}

/** Nearest MIDI pitch to `target` having pitch class `pc`. */
export function nearestPc(pc, target) {
  let m = Math.round(target) - (((Math.round(target) - pc) % 12) + 12) % 12;
  if (target - m > 6) m += 12;
  return m;
}

/** All pitches in [lo, hi] belonging to the chord's scale (mask = 'scale' | 'tones' | 'pent'). */
export function ladder(ch, lo, hi, mask = 'scale') {
  const tbl = mask === 'tones' ? ch.isTone : mask === 'pent' ? ch.inPent : ch.inScale, out = [];
  for (let m = Math.ceil(lo); m <= hi; m++) if (tbl[((m % 12) + 12) % 12]) out.push(m);
  return out;
}

/** Snap a pitch to the chord's scale (or chord tones); ties prefer chord tones, then the lower neighbour. */
export function fit(midi, ch, mask = 'scale') {
  const tbl = mask === 'tones' ? ch.isTone : mask === 'pent' ? ch.inPent : ch.inScale;
  const pc = ((midi % 12) + 12) % 12;
  if (tbl[pc]) return midi;
  for (let d = 1; d < 7; d++) {
    const a = tbl[(pc - d + 12) % 12], b = tbl[(pc + d) % 12];
    if (a && b) return ch.isTone[(pc + d) % 12] && !ch.isTone[(pc - d + 12) % 12] ? midi + d : midi - d;
    if (a) return midi - d;
    if (b) return midi + d;
  }
  return midi;
}

/** Index of the ladder entry nearest to a pitch. */
export function nearestIndex(lad, midi) {
  let best = 0, bd = 1e9;
  for (let i = 0; i < lad.length; i++) { const d = Math.abs(lad[i] - midi); if (d < bd) { bd = d; best = i; } }
  return best;
}

/**
 * Voice-led chord voicing. Chooses `n` chord tones by priority, enumerates close/drop-2 inversions inside
 * [lo, hi] and returns the one that moves least from `prev`, with penalties for mud, clusters and wide spans.
 */
export function voicing(ch, { lo = 52, hi = 76, n = 4, prev = null, top = null, root = false } = {}) {
  let pcs = ch.tones.slice(0, Math.min(n, ch.tones.length));
  if (root && !pcs.includes(ch.root)) pcs[pcs.length - 1] = ch.root;
  pcs = Array.from(new Set(pcs)).sort((a, b) => a - b);
  const k = pcs.length;
  let best = null, bestCost = 1e9;
  const consider = (v) => {
    if (v[0] < lo || v[k - 1] > hi) return;
    let cost = 0;
    if (prev && prev.length) {
      for (let i = 0; i < k; i++) { let m = 99; for (let j = 0; j < prev.length; j++) m = Math.min(m, Math.abs(v[i] - prev[j])); cost += m; }
      for (let j = 0; j < prev.length; j++) { let m = 99; for (let i = 0; i < k; i++) m = Math.min(m, Math.abs(v[i] - prev[j])); cost += m * 0.5; }
      cost += Math.abs(v[k - 1] - prev[prev.length - 1]) * 0.8;
    } else cost += Math.abs((v[0] + v[k - 1]) / 2 - (lo + hi) / 2) * 0.6;
    if (top != null) cost += Math.abs(v[k - 1] - top) * 1.6;
    for (let i = 1; i < k; i++) {
      const iv = v[i] - v[i - 1];
      if (iv <= 1) cost += i === k - 1 ? 9 : 5;                  // semitone clusters (worst on top)
      else if (iv === 2 && v[i - 1] < 55) cost += 4;             // low seconds = mud
      if (iv > 9) cost += 2;
    }
    if (v[1] - v[0] < 3 && v[0] < 50) cost += 6;
    if (v[k - 1] - v[0] > 19) cost += 3;
    if (ch.isTone[v[k - 1] % 12] && v[k - 1] % 12 === ch.root) cost += 1.5; // prefer a colour tone on top
    cost += Math.abs((v[0] + v[k - 1]) / 2 - (lo + hi) / 2) * 0.12;
    if (cost < bestCost) { bestCost = cost; best = v; }
  };
  for (let r = 0; r < k; r++) {
    for (let base = Math.floor(lo / 12) * 12 - 12; base <= hi; base += 12) {
      const v = new Array(k);
      let p = base + pcs[r];
      v[0] = p;
      for (let i = 1; i < k; i++) { let q = base + pcs[(r + i) % k]; while (q <= p) q += 12; v[i] = q; p = q; }
      consider(v);
      if (k >= 4) {                                              // drop-2
        const d = v.slice(); d[k - 2] -= 12; d.sort((a, b) => a - b); consider(d);
      }
      if (k >= 5) {                                              // drop-2&4 (spread)
        const d = v.slice(); d[k - 2] -= 12; d[k - 4] -= 12; d.sort((a, b) => a - b); consider(d);
      }
    }
  }
  if (!best) {                                                   // range too tight: plain stack from lo
    best = pcs.map((pc) => nearestPc(pc, (lo + hi) / 2)).sort((a, b) => a - b);
  }
  return best;
}
