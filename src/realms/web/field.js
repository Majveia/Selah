// Initial conditions for the cosmic web.
//
// We build a Gaussian random density field δ(k) with a ΛCDM-shaped power spectrum P(k) ∝ k^ns · T(k)² (BBKS transfer
// function), then derive the Zel'dovich displacement field ψ(q) = ∇⁻²∇δ and its deformation tensor ∂ψ_i/∂q_j.
// Particles later move as x(q, t) = q + D(t)·ψ(q): first-order Lagrangian perturbation theory, the classic analytic
// model of gravitational instability in an expanding universe. Local density follows from mass conservation:
// ρ/ρ̄ = 1 / |det(δ_ij + D ∂ψ_i/∂q_j)| — pancakes, filaments and nodes are where 1, 2 or 3 eigen-directions collapse.

import { RNG } from '../../core/rng.js';

// ---- radix-2 complex FFT ------------------------------------------------------------------------------
function makeFFT(n) {
  const levels = Math.log2(n) | 0;
  const rev = new Uint16Array(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b); rev[i] = r; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const tr = new Float64Array(n), ti = new Float64Array(n);
  /** in-place transform of a strided line inside (re, im) */
  return function fftLine(re, im, offset, stride, inverse) {
    for (let i = 0; i < n; i++) { const s = offset + rev[i] * stride; tr[i] = re[s]; ti[i] = im[s]; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const xr = tr[b] * wr - ti[b] * wi, xi = tr[b] * wi + ti[b] * wr;
          tr[b] = tr[a] - xr; ti[b] = ti[a] - xi; tr[a] += xr; ti[a] += xi;
        }
      }
    }
    const s = inverse ? 1 / n : 1;
    for (let i = 0; i < n; i++) { const d = offset + i * stride; re[d] = tr[i] * s; im[d] = ti[i] * s; }
  };
}

function fft3d(re, im, M, inverse, line) {
  const M2 = M * M;
  for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) line(re, im, z * M2 + y * M, 1, inverse);
  for (let z = 0; z < M; z++) for (let x = 0; x < M; x++) line(re, im, z * M2 + x, M, inverse);
  for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) line(re, im, y * M + x, M2, inverse);
}

/** BBKS (Bardeen, Bond, Kaiser & Szalay 1986) cold-dark-matter transfer function; k in h/Mpc */
function transferBBKS(k, gamma) {
  const q = k / gamma;
  if (q < 1e-6) return 1;
  return (Math.log(1 + 2.34 * q) / (2.34 * q)) * Math.pow(1 + 3.89 * q + (16.1 * q) ** 2 + (5.46 * q) ** 3 + (6.71 * q) ** 4, -0.25);
}

/**
 * @returns {{M:number, psi:Float32Array (M³·3), tensor:Float32Array (M³·6: xx,yy,zz,xy,xz,yz), hue:Float32Array (M³)}}
 * Normalised so that rms(∇·ψ) = 1, i.e. D is the linear rms density contrast on the grid scale.
 */
export function generateField(M, seed, { boxMpcH = 250, ns = 0.965, gamma = 0.21, smoothCells = 1.15 } = {}) {
  const N3 = M * M * M, M2 = M * M, half = M / 2;
  const line = makeFFT(M);
  const rng = new RNG(seed);
  const dRe = new Float32Array(N3), dIm = new Float32Array(N3);
  for (let i = 0; i < N3; i++) dRe[i] = rng.gauss();
  fft3d(dRe, dIm, M, false, line);

  const kf = (2 * Math.PI) / boxMpcH;           // fundamental mode, h/Mpc
  const freq = (i) => (i < half ? i : i - M);
  // shape the white noise: amplitude ∝ sqrt(P(k)), plus a Gaussian window so the smallest scales stay coherent
  for (let z = 0; z < M; z++) {
    const kz = freq(z);
    for (let y = 0; y < M; y++) {
      const ky = freq(y);
      for (let x = 0; x < M; x++) {
        const kx = freq(x), i = z * M2 + y * M + x;
        const k2 = kx * kx + ky * ky + kz * kz;
        if (k2 === 0) { dRe[i] = dIm[i] = 0; continue; }
        const kk = Math.sqrt(k2), kp = kk * kf;
        const T = transferBBKS(kp, gamma);
        const w = Math.exp(-0.5 * (kk * smoothCells * 2 * Math.PI / M) ** 2);
        const amp = Math.sqrt(Math.pow(kp, ns)) * T * w;
        dRe[i] *= amp; dIm[i] *= amp;
      }
    }
  }

  // ψ_c(k) = i k_c δ(k) / k²   (k in units of 2π / box → positions in box units)
  const psi = new Float32Array(N3 * 3);
  const tRe = new Float32Array(N3), tIm = new Float32Array(N3);
  for (let c = 0; c < 3; c++) {
    for (let z = 0; z < M; z++) {
      const kz = freq(z);
      for (let y = 0; y < M; y++) {
        const ky = freq(y);
        for (let x = 0; x < M; x++) {
          const kx = freq(x), i = z * M2 + y * M + x;
          const k2 = kx * kx + ky * ky + kz * kz;
          const kc = c === 0 ? kx : c === 1 ? ky : kz;
          if (k2 === 0 || kc === -half) { tRe[i] = tIm[i] = 0; continue; } // drop Nyquist of this axis → real output
          const f = kc / (k2 * 2 * Math.PI);
          tRe[i] = -dIm[i] * f; tIm[i] = dRe[i] * f;
        }
      }
    }
    fft3d(tRe, tIm, M, true, line);
    for (let i = 0; i < N3; i++) psi[i * 3 + c] = tRe[i];
  }

  // deformation tensor by central differences on the periodic grid (h = 1/M)
  const tensor = new Float32Array(N3 * 6);
  const inv2h = M / 2;
  const at = (x, y, z, c) => psi[(((z + M) % M) * M2 + ((y + M) % M) * M + ((x + M) % M)) * 3 + c];
  let sumDiv2 = 0;
  for (let z = 0; z < M; z++) for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
    const i = z * M2 + y * M + x;
    const dxx = (at(x + 1, y, z, 0) - at(x - 1, y, z, 0)) * inv2h, dyy = (at(x, y + 1, z, 1) - at(x, y - 1, z, 1)) * inv2h, dzz = (at(x, y, z + 1, 2) - at(x, y, z - 1, 2)) * inv2h;
    const dxy = 0.5 * ((at(x, y + 1, z, 0) - at(x, y - 1, z, 0)) + (at(x + 1, y, z, 1) - at(x - 1, y, z, 1))) * inv2h;
    const dxz = 0.5 * ((at(x, y, z + 1, 0) - at(x, y, z - 1, 0)) + (at(x + 1, y, z, 2) - at(x - 1, y, z, 2))) * inv2h;
    const dyz = 0.5 * ((at(x, y, z + 1, 1) - at(x, y, z - 1, 1)) + (at(x, y + 1, z, 2) - at(x, y - 1, z, 2))) * inv2h;
    tensor[i * 6] = dxx; tensor[i * 6 + 1] = dyy; tensor[i * 6 + 2] = dzz; tensor[i * 6 + 3] = dxy; tensor[i * 6 + 4] = dxz; tensor[i * 6 + 5] = dyz;
    const div = dxx + dyy + dzz; sumDiv2 += div * div;
  }
  const norm = 1 / Math.sqrt(sumDiv2 / N3);
  for (let i = 0; i < psi.length; i++) psi[i] *= norm;
  for (let i = 0; i < tensor.length; i++) tensor[i] *= norm;

  // a very smooth auxiliary field (largest modes only) used for regional colour variation
  const hue = new Float32Array(N3);
  for (let z = 0; z < M; z++) {
    const kz = freq(z);
    for (let y = 0; y < M; y++) {
      const ky = freq(y);
      for (let x = 0; x < M; x++) {
        const kx = freq(x), i = z * M2 + y * M + x, k2 = kx * kx + ky * ky + kz * kz;
        const w = k2 === 0 ? 0 : Math.exp(-k2 / 7) / Math.sqrt(k2);
        // rotate phases so the hue field is statistically independent of the density field
        tRe[i] = -dIm[i] * w; tIm[i] = dRe[i] * w;
      }
    }
  }
  // enforce Hermitian symmetry is already satisfied (multiplying by i·w(|k|) keeps δ(-k) = conj(δ(k)) only up to sign) → take the real part
  fft3d(tRe, tIm, M, true, line);
  let hmax = 1e-9; for (let i = 0; i < N3; i++) hmax = Math.max(hmax, Math.abs(tIm[i]) + Math.abs(tRe[i]));
  for (let i = 0; i < N3; i++) hue[i] = (tRe[i] + tIm[i]) / hmax;

  return { M, psi, tensor, hue };
}

/** Trilinear periodic sample of ψ at Lagrangian coordinate q∈[0,1)³ (CPU twin of the vertex shader; used for picking). */
export function samplePsi(field, qx, qy, qz, out) {
  const { M, psi } = field, M2 = M * M;
  const fx = qx * M - 0.5, fy = qy * M - 0.5, fz = qz * M - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = fx - x0, ty = fy - y0, tz = fz - z0;
  const xa = ((x0 % M) + M) % M, xb = (xa + 1) % M, ya = ((y0 % M) + M) % M, yb = (ya + 1) % M, za = ((z0 % M) + M) % M, zb = (za + 1) % M;
  for (let c = 0; c < 3; c++) {
    const v = (x, y, z) => psi[(z * M2 + y * M + x) * 3 + c];
    const a = v(xa, ya, za) * (1 - tx) + v(xb, ya, za) * tx, b = v(xa, yb, za) * (1 - tx) + v(xb, yb, za) * tx;
    const cc = v(xa, ya, zb) * (1 - tx) + v(xb, ya, zb) * tx, d = v(xa, yb, zb) * (1 - tx) + v(xb, yb, zb) * tx;
    out[c] = (a * (1 - ty) + b * ty) * (1 - tz) + (cc * (1 - ty) + d * ty) * tz;
  }
  return out;
}

// ---- flat ΛCDM background: age and linear growth ----------------------------------------------------------------
export const COSMO = { Om: 0.315, OL: 0.685, h: 0.674 };
const HUBBLE_TIME_GYR = 977.8 / (100 * COSMO.h); // 1/H0 in Gyr
const E = (a) => Math.sqrt(COSMO.Om / (a * a * a) + COSMO.OL);

/** table of (a, t[Gyr], D normalised to 1 today) for a ∈ (0, aMax] */
export function buildCosmology(aMax = 2.2, n = 600) {
  const a = new Float64Array(n), t = new Float64Array(n), D = new Float64Array(n);
  let it = 0, id = 0, prev = 1e-4; const sub = 24;
  for (let i = 0; i < n; i++) {
    const ai = Math.exp(Math.log(1e-3) + (Math.log(aMax) - Math.log(1e-3)) * (i / (n - 1)));
    for (let s = 0; s < sub; s++) { // midpoint rule in a
      const a0 = prev + ((ai - prev) * s) / sub, a1 = prev + ((ai - prev) * (s + 1)) / sub, am = 0.5 * (a0 + a1), da = a1 - a0;
      it += da / (am * E(am)); id += da / Math.pow(am * E(am), 3);
    }
    prev = ai; a[i] = ai; t[i] = it * HUBBLE_TIME_GYR; D[i] = 2.5 * COSMO.Om * E(ai) * id;
  }
  // analytic start (matter era): t ≈ (2/3) a^1.5 / (H0 √Ωm), D ≈ a
  const t0 = (2 / 3) * Math.pow(1e-4, 1.5) / Math.sqrt(COSMO.Om) * HUBBLE_TIME_GYR; for (let i = 0; i < n; i++) t[i] += t0;
  let D1 = 1; for (let i = 0; i < n; i++) if (a[i] >= 1) { D1 = D[i]; break; }
  for (let i = 0; i < n; i++) D[i] /= D1;
  const lerpAt = (arr, x) => {
    if (x <= a[0]) return arr[0]; if (x >= a[n - 1]) return arr[n - 1];
    const f = ((Math.log(x) - Math.log(1e-3)) / (Math.log(aMax) - Math.log(1e-3))) * (n - 1); const i = Math.floor(f), u = f - i;
    return arr[i] * (1 - u) + arr[i + 1] * u;
  };
  return { age: (x) => lerpAt(t, x), growth: (x) => lerpAt(D, x), aMax, ageNow: lerpAt(t, 1) };
}

// ---- GPU packing: three RGBA16F volumes per field ------------------------------------------------------------
const _f32 = new Float32Array(1), _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v; const x = _u32[0]; const sign = (x >>> 16) & 0x8000; const exp = ((x >>> 23) & 0xff) - 112; let mant = x & 0x7fffff;
  if (exp <= 0) { if (exp < -10) return sign; mant = (mant | 0x800000) >> (1 - exp); return sign | ((mant + 0x1000) >> 13); }
  if (exp >= 31) return sign | 0x7c00;
  return (sign | (exp << 10)) + ((mant + 0x1000) >> 13);
}
/** → { t0: (ψx,ψy,ψz,dxx), t1: (dyy,dzz,dxy,dxz), t2: (dyz,hue,0,0) } as Uint16Array half-floats */
export function packField(f) {
  const n = f.M ** 3, t0 = new Uint16Array(n * 4), t1 = new Uint16Array(n * 4), t2 = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 3, t = i * 6, o = i * 4;
    t0[o] = toHalf(f.psi[p]); t0[o + 1] = toHalf(f.psi[p + 1]); t0[o + 2] = toHalf(f.psi[p + 2]); t0[o + 3] = toHalf(f.tensor[t]);
    t1[o] = toHalf(f.tensor[t + 1]); t1[o + 1] = toHalf(f.tensor[t + 2]); t1[o + 2] = toHalf(f.tensor[t + 3]); t1[o + 3] = toHalf(f.tensor[t + 4]);
    t2[o] = toHalf(f.tensor[t + 5]); t2[o + 1] = toHalf(f.hue[i]);
  }
  return { t0, t1, t2 };
}
/** everything the realm needs for one field; runs in a worker when possible */
export function buildField(M, seed, opts) {
  const f = generateField(M, seed, opts); const packed = packField(f);
  return { M, psi: f.psi, ...packed };
}
