// Selah — DSP helpers. Everything here is synthesized: impulse responses, noise, waveshaper curves and the
// percussion "kit" are computed once at start-up (the only per-sample JavaScript that runs outside a worklet).

export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const dB = (d) => Math.pow(10, d / 20);

/** Deterministic RNG (mulberry32) with a few musical helpers. fork(label) gives an independent stream. */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  const r = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (lo, hi) => lo + (hi - lo) * r();
  r.int = (n) => Math.floor(r() * n);
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  r.sign = () => (r() < 0.5 ? -1 : 1);
  r.gauss = () => (r() + r() + r() + r() - 2) * 0.8660254; // ~unit variance, bounded
  r.fork = (label) => {
    let h = 2166136261 ^ seed;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
    return makeRng((h ^ (h >>> 13)) >>> 0);
  };
  return r;
}

/** Looping white-noise buffer (mono). */
export function makeNoiseBuffer(ctx, seconds, rng) {
  const n = Math.floor(seconds * ctx.sampleRate);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = rng() * 2 - 1;
  return buf;
}

/**
 * Synthesized stereo reverb impulse response: exponentially decaying noise whose brightness falls with time
 * (frequency-dependent decay), a diffuse build-up, a few early reflections, decorrelated L/R, unit energy.
 */
export function makeReverbIR(ctx, o, rng) {
  const sr = ctx.sampleRate;
  const { seconds = 6, rt60 = 5.5, bright = 9000, dark = 1400, darkTime = 1.6, build = 0.035, predelay = 0.018, early = 0.5, lowcut = 110 } = o || {};
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(2, n, sr);
  const pre = Math.floor(predelay * sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp1 = 0, lp2 = 0, hp = 0, hpx = 0, a = 1;
    const hpc = Math.exp(-TAU * lowcut / sr);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      if (((i - pre) & 63) === 0) {
        const fc = dark + (bright - dark) * Math.exp(-t / darkTime);
        a = 1 - Math.exp(-TAU * fc / sr);
      }
      const x = rng() * 2 - 1;
      lp1 += a * (x - lp1); lp2 += a * (lp1 - lp2);
      // compensate the energy the low-pass removes so the low band still decays at rt60
      const env = Math.exp(-6.9078 * t / rt60) * (1 - Math.exp(-t / build)) / Math.sqrt(a);
      const y = lp2 * env;
      hp = hpc * (hp + y - hpx); hpx = y;
      d[i] = hp;
    }
    // early reflections: sparse decaying taps, different per channel
    const taps = 14;
    for (let k = 0; k < taps; k++) {
      const tt = 0.006 + Math.pow(rng(), 1.4) * 0.09;
      const idx = pre + Math.floor(tt * sr);
      if (idx < n) d[idx] += (rng() < 0.5 ? -1 : 1) * early * 0.5 * Math.exp(-tt / 0.045) * (0.5 + rng() * 0.5) * 0.05;
    }
    // fade the last 80 ms to exact zero
    const f = Math.floor(0.08 * sr);
    for (let i = 0; i < f; i++) d[n - 1 - i] *= i / f;
  }
  // normalise: unit energy per channel
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let e = 0;
    for (let i = 0; i < n; i++) e += d[i] * d[i];
    const g = 1 / Math.sqrt(e || 1);
    for (let i = 0; i < n; i++) d[i] *= g;
  }
  return buf;
}

/** Odd soft-saturation curve y = tanh(k x)/tanh(k) for WaveShaperNode. */
export function tanhCurve(k = 1.5, n = 2049) {
  const c = new Float32Array(n), norm = Math.tanh(k);
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / norm; }
  return c;
}

/** Final safety clipper: unity up to `knee`, then a smooth approach to `ceil` (never exceeded, even for |x| >= 1). */
export function ceilingCurve(knee = 0.6, ceil = 0.82, n = 4097) {
  const c = new Float32Array(n), span = ceil - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + span * Math.tanh((ax - knee) / span);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/**
 * Asymmetric tube-ish transfer curve for the guitar amp. The input is pre-scaled so that x = +-1 maps to a
 * drive of `range`; small signals stay almost linear (clean), large ones compress and add even harmonics.
 */
export function tubeCurve(range = 12, bias = 0.18, n = 8193) {
  const c = new Float32Array(n), off = Math.tanh(bias);
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    // softer knee on the negative half (grid conduction) + tanh on the positive half
    const y = x >= 0 ? Math.tanh(x + bias) - off : (Math.tanh(0.8 * x + bias) - off) / 0.8 * 0.92;
    c[i] = y;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------------------
// Percussion kit — modal / noise synthesis rendered into short AudioBuffers.
// ---------------------------------------------------------------------------------------------------------

function addPartial(d, sr, f, amp, tau, phase = 0, start = 0, attack = 0) {
  // recursive sine oscillator with exponential decay
  const w = TAU * f / sr, k = 2 * Math.cos(w), dec = tau > 0 ? Math.exp(-1 / (tau * sr)) : 1;
  let y1 = Math.sin(phase - w), y2 = Math.sin(phase - 2 * w), env = amp;
  const n = d.length, s0 = Math.floor(start * sr), na = Math.floor(attack * sr);
  for (let i = s0; i < n; i++) {
    const y = k * y1 - y2; y2 = y1; y1 = y;
    const a = na > 0 && i - s0 < na ? (i - s0) / na : 1;
    d[i] += y * env * a; env *= dec;
    if (env < 1e-5) break;
  }
}

function addNoise(d, sr, rng, { amp = 1, tau = 0.1, attack = 0.001, hp = 0, lp = 20000, start = 0, bp = 0, q = 1 }) {
  const n = d.length, s0 = Math.floor(start * sr), na = Math.max(1, Math.floor(attack * sr));
  const al = 1 - Math.exp(-TAU * Math.min(lp, sr * 0.45) / sr), ah = Math.exp(-TAU * hp / sr);
  const dec = Math.exp(-1 / (tau * sr));
  let l1 = 0, l2 = 0, h = 0, hx = 0, env = amp;
  // optional resonant band-pass (RBJ)
  let b0 = 0, a1 = 0, a2 = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  if (bp > 0) {
    const w = TAU * bp / sr, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    b0 = alpha / a0; a1 = (-2 * Math.cos(w)) / a0; a2 = (1 - alpha) / a0;
  }
  for (let i = s0; i < n; i++) {
    let x = rng() * 2 - 1;
    l1 += al * (x - l1); l2 += al * (l1 - l2); x = l2;
    if (hp > 0) { h = ah * (h + x - hx); hx = x; x = h; }
    if (bp > 0) { const y = b0 * x - b0 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; x = y; }
    const a = i - s0 < na ? (i - s0) / na : 1;
    d[i] += x * env * a; env *= dec;
    if (env < 1e-5 && i - s0 > na) break;
  }
}

function addSweep(d, sr, { f0, f1, tauF, amp, tau, start = 0, attack = 0.001 }) {
  // sine with exponentially falling pitch (kick / tom / conga fundamentals)
  const n = d.length, s0 = Math.floor(start * sr), na = Math.max(1, Math.floor(attack * sr));
  let ph = 0, env = amp; const dec = Math.exp(-1 / (tau * sr));
  for (let i = s0; i < n; i++) {
    const t = (i - s0) / sr, f = f1 + (f0 - f1) * Math.exp(-t / tauF);
    ph += TAU * f / sr;
    const a = i - s0 < na ? (i - s0) / na : 1;
    d[i] += Math.sin(ph) * env * a; env *= dec;
    if (env < 1e-5) break;
  }
}

function finish(d, sr, peak = 0.9, fade = 0.01) {
  let m = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > m) m = a; }
  const g = m > 0 ? peak / m : 1, nf = Math.min(d.length, Math.floor(fade * sr));
  for (let i = 0; i < d.length; i++) d[i] *= g;
  for (let i = 0; i < nf; i++) d[d.length - 1 - i] *= i / nf;
}

/** Build the whole kit. Yields to the event loop between buffers so start-up never blocks for long. */
export async function makeKit(ctx, rng) {
  const sr = ctx.sampleRate, kit = {};
  const mk = (name, dur, fn, peak = 0.9) => {
    const buf = ctx.createBuffer(1, Math.ceil(dur * sr), sr), d = buf.getChannelData(0);
    fn(d); finish(d, sr, peak); kit[name] = buf;
  };
  const pause = () => new Promise((r) => setTimeout(r, 0));

  // --- ride cymbal: dense inharmonic modes + stick ping + wash
  mk('ride', 2.6, (d) => {
    const N = 84;
    for (let k = 0; k < N; k++) {
      const u = (k + rng()) / N, f = 380 + 10600 * Math.pow(u, 1.25);
      const tilt = f < 4200 ? Math.pow(f / 4200, 0.7) : Math.pow(4200 / f, 1.5);
      const tau = clamp(1.25 * Math.pow(700 / f, 0.42), 0.16, 1.5) * (0.7 + 0.6 * rng());
      addPartial(d, sr, f, tilt * (0.35 + 0.65 * rng()), tau, rng() * TAU);
    }
    for (const [f, a, tau] of [[2930, 2.2, 0.09], [4410, 1.8, 0.07], [5870, 1.2, 0.05], [1190, 1.1, 0.5]]) addPartial(d, sr, f, a, tau, rng() * TAU);
    addNoise(d, sr, rng, { amp: 5, tau: 0.004, hp: 5000, lp: 12000 });
    addNoise(d, sr, rng, { amp: 1.1, tau: 0.42, hp: 3500, lp: 9500, attack: 0.004 });
  });
  await pause();

  // --- stationary cymbal wash loop (for swells / crashes): frequencies snapped to the loop length
  mk('wash', 2.0, (d) => {
    const dur = d.length / sr;
    for (let k = 0; k < 70; k++) {
      const u = (k + rng()) / 70, f0 = 500 + 9000 * Math.pow(u, 1.2), f = Math.round(f0 * dur) / dur;
      const tilt = f < 5000 ? Math.pow(f / 5000, 0.5) : Math.pow(5000 / f, 1.6);
      addPartial(d, sr, f, tilt * (0.3 + 0.7 * rng()), 0, rng() * TAU);
    }
    addNoise(d, sr, rng, { amp: 14, tau: 1e6, hp: 2500, lp: 9000, attack: 0.0001 });
  }, 0.7);
  kit.wash.selahLoop = true;
  await pause();

  // --- brush tap (snare, brushes) and brush sweep accent
  mk('tap', 0.26, (d) => {
    addNoise(d, sr, rng, { amp: 1, tau: 0.045, attack: 0.003, hp: 900, lp: 7000 });
    addNoise(d, sr, rng, { amp: 0.5, tau: 0.09, attack: 0.004, bp: 1900, q: 1.2 });
    addSweep(d, sr, { f0: 215, f1: 185, tauF: 0.03, amp: 0.35, tau: 0.05 });
  });
  mk('sweep', 0.42, (d) => {
    addNoise(d, sr, rng, { amp: 1, tau: 0.11, attack: 0.07, hp: 1500, lp: 8000 });
    addNoise(d, sr, rng, { amp: 0.4, tau: 0.08, attack: 0.05, bp: 2600, q: 0.9 });
  });
  // --- soft snare for the driving scenes
  mk('snare', 0.34, (d) => {
    addNoise(d, sr, rng, { amp: 1, tau: 0.07, attack: 0.001, hp: 1200, lp: 8500 });
    addNoise(d, sr, rng, { amp: 0.7, tau: 0.12, attack: 0.002, bp: 2100, q: 0.8 });
    addSweep(d, sr, { f0: 240, f1: 178, tauF: 0.02, amp: 0.9, tau: 0.075 });
    addPartial(d, sr, 331, 0.3, 0.05);
  });
  // --- kicks
  mk('kick', 0.5, (d) => {
    addSweep(d, sr, { f0: 118, f1: 46, tauF: 0.032, amp: 1, tau: 0.13, attack: 0.002 });
    addNoise(d, sr, rng, { amp: 0.16, tau: 0.008, lp: 1800, attack: 0.0005 });
  });
  mk('kickDeep', 0.8, (d) => {
    addSweep(d, sr, { f0: 150, f1: 41, tauF: 0.04, amp: 1, tau: 0.22, attack: 0.0015 });
    addSweep(d, sr, { f0: 300, f1: 82, tauF: 0.03, amp: 0.25, tau: 0.09, attack: 0.001 });
    addNoise(d, sr, rng, { amp: 0.22, tau: 0.006, lp: 2600, attack: 0.0005 });
  });
  await pause();
  // --- cross-stick / rim
  mk('rim', 0.16, (d) => {
    for (const [f, a, tau] of [[463, 1, 0.022], [1140, 0.8, 0.018], [1795, 0.6, 0.014], [2890, 0.3, 0.009]]) addPartial(d, sr, f, a, tau, 0.5);
    addNoise(d, sr, rng, { amp: 0.6, tau: 0.004, hp: 2000, lp: 9000, attack: 0.0003 });
  });
  // --- hi-hat (closed) and pedal chick
  mk('hat', 0.14, (d) => {
    for (let k = 0; k < 14; k++) addPartial(d, sr, 4200 + 5200 * rng(), 0.3 + 0.5 * rng(), 0.018 + 0.02 * rng(), rng() * TAU);
    addNoise(d, sr, rng, { amp: 1.4, tau: 0.022, hp: 6500, lp: 11500, attack: 0.0006 });
  });
  mk('hatOpen', 0.6, (d) => {
    for (let k = 0; k < 22; k++) addPartial(d, sr, 3800 + 6000 * rng(), 0.3 + 0.5 * rng(), 0.12 + 0.12 * rng(), rng() * TAU);
    addNoise(d, sr, rng, { amp: 1.2, tau: 0.13, hp: 6000, lp: 11000, attack: 0.001 });
  });
  // --- shaker
  mk('shaker', 0.13, (d) => {
    addNoise(d, sr, rng, { amp: 1, tau: 0.022, attack: 0.012, hp: 4500, lp: 10500 });
  });
  // --- conga-like hand drum (open tone) and muted slap
  mk('conga', 0.5, (d) => {
    addSweep(d, sr, { f0: 262, f1: 233, tauF: 0.03, amp: 1, tau: 0.13, attack: 0.002 });
    addPartial(d, sr, 233 * 1.59, 0.3, 0.06); addPartial(d, sr, 233 * 2.14, 0.16, 0.04);
    addNoise(d, sr, rng, { amp: 0.25, tau: 0.01, hp: 600, lp: 5000, attack: 0.0005 });
  });
  mk('slap', 0.18, (d) => {
    addSweep(d, sr, { f0: 420, f1: 370, tauF: 0.01, amp: 0.6, tau: 0.025, attack: 0.001 });
    addNoise(d, sr, rng, { amp: 1, tau: 0.014, hp: 900, lp: 6500, attack: 0.0005 });
  });
  // --- low tom / frame drum
  mk('tom', 0.9, (d) => {
    addSweep(d, sr, { f0: 128, f1: 92, tauF: 0.05, amp: 1, tau: 0.24, attack: 0.003 });
    addPartial(d, sr, 92 * 1.5, 0.28, 0.12); addPartial(d, sr, 92 * 2.3, 0.1, 0.06);
    addNoise(d, sr, rng, { amp: 0.14, tau: 0.012, lp: 2400, attack: 0.001 });
  });
  await pause();
  return kit;
}
