// Colour helpers (CPU side). All outputs are linear-sRGB unless stated.
import { clamp } from './rng.js';

/** Black-body colour for temperature K (1000..40000) → [r,g,b] linear, max channel ≈ 1. Tanner Helland fit. */
export function blackbody(K) {
  const t = clamp(K, 1000, 40000) / 100;
  let r, g, b;
  r = t <= 66 ? 1 : clamp(1.29293618606 * Math.pow(t - 60, -0.1332047592));
  g = t <= 66 ? clamp(0.39008157876 * Math.log(t) - 0.63184144378) : clamp(1.12989086089 * Math.pow(t - 60, -0.0755148492));
  b = t >= 66 ? 1 : t <= 19 ? 0 : clamp(0.54320678911 * Math.log(t - 10) - 1.19625408914);
  return [Math.pow(r, 2.2), Math.pow(g, 2.2), Math.pow(b, 2.2)];
}
export const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** '#rrggbb' → [r,g,b] linear */
export function hex(h) {
  const n = parseInt(h.replace('#', ''), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}
export function hsl(h, s, l) { // h in turns → linear rgb
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h * 12) % 12; return srgbToLinear(l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))); };
  return [f(0), f(8), f(4)];
}
export const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
