// Deterministic randomness + CPU noise. Everything in Selah's universe is derived from seeds,
// so the same seed always yields the same galaxy, star, world, city and blade of grass.

export function hashString(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hashInts(a, b = 0, c = 0, d = 0) {
  let h = 0x9e3779b9 ^ Math.imul(a | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) ^ Math.imul(b | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 13), 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) ^ Math.imul(d | 0, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function toSeed(seed) {
  return typeof seed === 'number' ? seed >>> 0 : hashString(String(seed));
}

export class RNG {
  constructor(seed = 1) {
    this.seed = toSeed(seed);
    this._f = mulberry32(this.seed);
    this._spare = null;
  }
  /** Independent child stream; `label` may be a string or number. */
  fork(label = 0) {
    return new RNG(hashInts(this.seed, typeof label === 'number' ? label : hashString(String(label)), 0x51ed));
  }
  next() { return this._f(); }
  float(a = 0, b = 1) { return a + (b - a) * this._f(); }
  int(a, b) { return Math.floor(a + (b - a + 1) * this._f()); } // inclusive
  chance(p) { return this._f() < p; }
  sign() { return this._f() < 0.5 ? -1 : 1; }
  pick(arr) { return arr[Math.floor(this._f() * arr.length)]; }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(this._f() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  }
  weighted(items, weights) {
    let sum = 0; for (const w of weights) sum += w;
    let r = this._f() * sum;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r <= 0) return items[i]; }
    return items[items.length - 1];
  }
  gauss(mean = 0, sd = 1) {
    if (this._spare !== null) { const s = this._spare; this._spare = null; return mean + sd * s; }
    let u, v, s;
    do { u = this._f() * 2 - 1; v = this._f() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    this._spare = v * m;
    return mean + sd * u * m;
  }
  /** log-uniform between a and b */
  logFloat(a, b) { return Math.exp(this.float(Math.log(a), Math.log(b))); }
  /** power-law sample in [a,b] with pdf ∝ x^-alpha */
  power(a, b, alpha) {
    const u = this._f();
    if (Math.abs(alpha - 1) < 1e-6) return a * Math.pow(b / a, u);
    const e = 1 - alpha;
    return Math.pow(u * (Math.pow(b, e) - Math.pow(a, e)) + Math.pow(a, e), 1 / e);
  }
  /** uniform direction on the unit sphere → [x,y,z] */
  onSphere() {
    const z = this._f() * 2 - 1, a = this._f() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    return [r * Math.cos(a), z, r * Math.sin(a)];
  }
}

// ---------------------------------------------------------------------------------------------
// Simplex noise (2D/3D), seeded. Based on Stefan Gustavson's public-domain reference implementation.
// ---------------------------------------------------------------------------------------------
const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3, G3 = 1 / 6;
const GRAD3 = new Float32Array([1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1]);

export class Noise {
  constructor(seed = 0) {
    const rng = new RNG(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(rng.next() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512);
    this.perm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { this.perm[i] = p[i & 255]; this.perm12[i] = this.perm[i] % 12; }
  }

  simplex2(xin, yin) {
    const perm = this.perm, perm12 = this.perm12;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = perm12[ii + perm[jj]] * 3; t0 *= t0; n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = perm12[ii + i1 + perm[jj + j1]] * 3; t1 *= t1; n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = perm12[ii + 1 + perm[jj + 1]] * 3; t2 *= t2; n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2); }
    return 70 * n; // [-1, 1]
  }

  simplex3(xin, yin, zin) {
    const perm = this.perm, perm12 = this.perm12;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    let n = 0;
    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) { const g = perm12[ii + perm[jj + perm[kk]]] * 3; t0 *= t0; n += t0 * t0 * (GRAD3[g] * x0 + GRAD3[g + 1] * y0 + GRAD3[g + 2] * z0); }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) { const g = perm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; t1 *= t1; n += t1 * t1 * (GRAD3[g] * x1 + GRAD3[g + 1] * y1 + GRAD3[g + 2] * z1); }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) { const g = perm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; t2 *= t2; n += t2 * t2 * (GRAD3[g] * x2 + GRAD3[g + 1] * y2 + GRAD3[g + 2] * z2); }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) { const g = perm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; t3 *= t3; n += t3 * t3 * (GRAD3[g] * x3 + GRAD3[g + 1] * y3 + GRAD3[g + 2] * z3); }
    return 32 * n; // [-1, 1]
  }

  /** fractal Brownian motion, 2D. Returns roughly [-1,1]. */
  fbm2(x, y, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 0.5, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(x, y); norm += amp;
      x = x * lacunarity + 19.19; y = y * lacunarity - 7.31; amp *= gain;
    }
    return sum / norm;
  }
  fbm3(x, y, z, octaves = 5, lacunarity = 2, gain = 0.5) {
    let amp = 0.5, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex3(x, y, z); norm += amp;
      x = x * lacunarity + 19.19; y = y * lacunarity - 7.31; z = z * lacunarity + 3.7; amp *= gain;
    }
    return sum / norm;
  }
  /** ridged multifractal, 2D. Returns [0,1] — sharp mountain crests. */
  ridged2(x, y, octaves = 5, lacunarity = 2.05, gain = 0.5) {
    let amp = 0.5, sum = 0, norm = 0, prev = 1;
    for (let o = 0; o < octaves; o++) {
      let n = 1 - Math.abs(this.simplex2(x, y)); n *= n;
      sum += amp * n * prev; norm += amp; prev = n;
      x = x * lacunarity + 11.3; y = y * lacunarity + 5.7; amp *= gain;
    }
    return sum / norm;
  }
}

// small math helpers shared everywhere
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const smootherstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
/** frame-rate independent exponential approach: value moves toward target with time constant `tau` seconds */
export const damp = (cur, target, tau, dt) => (tau <= 0 ? target : target + (cur - target) * Math.exp(-dt / tau));
export const TAU = Math.PI * 2;
