// Shared GLSL chunks. Import the strings you need and paste them into your shaders:
//   import { GLSL } from '../core/glsl.js';
//   fragmentShader: `${GLSL.hash} ${GLSL.snoise3} ${GLSL.fbm3} void main(){ ... }`
// All chunks are GLSL ES 3.00 compatible and also work in three's ShaderMaterial (GLSL1-style) shaders.

export const GLSL = {};

// --- hashes without sine (Dave Hoskins) — stable across GPUs --------------------------------------
GLSL.hash = /* glsl */ `
float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2  hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3  hash33(vec3 p3){ p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec3  hash31(float p){ vec3 p3 = fract(vec3(p) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
`;

// --- 3D simplex noise (Ashima Arts / Ian McEwan, MIT) -----------------------------------------------
GLSL.snoise3 = /* glsl */ `
vec3 _mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 _permute(vec4 x){ return _mod289(((x * 34.0) + 10.0) * x); }
vec4 _taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0); const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy)); vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz); vec3 l = 1.0 - g; vec3 i1 = min(g.xyz, l.zxy); vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx; vec3 x2 = x0 - i2 + C.yyy; vec3 x3 = x0 - D.yyy;
  i = _mod289(i);
  vec4 p = _permute(_permute(_permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857; vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z); vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy; vec4 y = y_ * ns.x + ns.yyyy; vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy); vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0; vec4 s1 = floor(b1) * 2.0 + 1.0; vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy; vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x); vec3 p1 = vec3(a0.zw, h.y); vec3 p2 = vec3(a1.xy, h.z); vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = _taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0); m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// --- fBm / ridged / domain-warped helpers built on snoise ---------------------------------------------
GLSL.fbm3 = /* glsl */ `
float fbm(vec3 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 9; i++) { if (i >= octaves) break; s += a * snoise(p); n += a; p = p * 2.02 + vec3(19.1, -7.3, 3.7); a *= 0.5; }
  return s / n;
}
float ridged(vec3 p, int octaves){
  float a = 0.5, s = 0.0, n = 0.0, prev = 1.0;
  for (int i = 0; i < 9; i++) { if (i >= octaves) break; float v = 1.0 - abs(snoise(p)); v *= v; s += a * v * prev; n += a; prev = v; p = p * 2.07 + vec3(11.3, 5.7, -3.1); a *= 0.5; }
  return s / n;
}
vec3 curlNoise(vec3 p){
  const float e = 0.1;
  float n1 = snoise(p + vec3(0.0, e, 0.0)), n2 = snoise(p - vec3(0.0, e, 0.0));
  float n3 = snoise(p + vec3(0.0, 0.0, e)), n4 = snoise(p - vec3(0.0, 0.0, e));
  float n5 = snoise(p + vec3(e, 0.0, 0.0)), n6 = snoise(p - vec3(e, 0.0, 0.0));
  vec3 q = p + vec3(31.4, -17.2, 9.9);
  float m1 = snoise(q + vec3(0.0, e, 0.0)), m2 = snoise(q - vec3(0.0, e, 0.0));
  float m3 = snoise(q + vec3(0.0, 0.0, e)), m4 = snoise(q - vec3(0.0, 0.0, e));
  float m5 = snoise(q + vec3(e, 0.0, 0.0)), m6 = snoise(q - vec3(e, 0.0, 0.0));
  return vec3((n1 - n2) - (m3 - m4), (n3 - n4) - (n5 - n6), (m5 - m6) - (m1 - m2)) / (2.0 * e);
}
`;

// --- cheap value noise (when simplex is overkill) -----------------------------------------------------
GLSL.vnoise = /* glsl */ `
float vnoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  float n = dot(i, vec3(1.0, 57.0, 113.0));
  #define _VH(o) fract(sin(n + (o)) * 43758.5453123)
  float r = mix(mix(mix(_VH(0.0), _VH(1.0), f.x), mix(_VH(57.0), _VH(58.0), f.x), f.y),
                mix(mix(_VH(113.0), _VH(114.0), f.x), mix(_VH(170.0), _VH(171.0), f.x), f.y), f.z);
  #undef _VH
  return r;
}
`;

// --- colour science ------------------------------------------------------------------------------------
GLSL.color = /* glsl */ `
// Approximate black-body colour (linear sRGB, normalised so the max channel is ~1) for T in Kelvin, 1000..40000.
vec3 blackbody(float T){
  float t = T / 100.0; vec3 c;
  c.r = t <= 66.0 ? 1.0 : clamp(1.29293618606 * pow(t - 60.0, -0.1332047592), 0.0, 1.0);
  c.g = t <= 66.0 ? clamp(0.39008157876 * log(t) - 0.63184144378, 0.0, 1.0) : clamp(1.12989086089 * pow(t - 60.0, -0.0755148492), 0.0, 1.0);
  c.b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.54320678911 * log(t - 10.0) - 1.19625408914, 0.0, 1.0));
  return pow(c, vec3(2.2)); // the fit is in display space → linearise
}
vec3 linearToSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
vec3 sRGBToLinear(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c)); }
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hsv2rgb(vec3 c){ vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www); return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
// IQ cosine palette
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d){ return a + b * cos(6.28318530718 * (c * t + d)); }
`;

// --- screen-space dithering noise (Jimenez interleaved gradient noise) -------------------------------------
GLSL.dither = /* glsl */ `
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

// --- analytic single-scattering atmosphere helpers (Rayleigh + Mie phase functions) ------------------------
GLSL.phase = /* glsl */ `
float phaseRayleigh(float mu){ return 0.0596831036 * (1.0 + mu * mu); }                                  // 3/(16π)(1+μ²)
float phaseMie(float mu, float g){ float g2 = g * g; return 0.1193662073 * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); } // Cornette-Shanks
// ray / sphere: returns (tNear, tFar); tNear > tFar means miss
vec2 raySphere(vec3 ro, vec3 rd, vec3 c, float r){ vec3 oc = ro - c; float b = dot(oc, rd); float cc = dot(oc, oc) - r * r; float h = b * b - cc; if (h < 0.0) return vec2(1e20, -1e20); h = sqrt(h); return vec2(-b - h, -b + h); }
`;

/** Point-sprite star vertex/fragment logic shared by every realm that draws stars, so stars look identical everywhere.
 *  Attributes: position, aColor (linear rgb), aMag (linear brightness multiplier), aSize (px at reference).
 *  Uniforms: uPixelRatio, uSizeScale, uBrightness, uTime (for scintillation), uTwinkle. */
GLSL.starVertex = /* glsl */ `
attribute vec3 aColor; attribute float aMag; attribute float aSize;
uniform float uPixelRatio, uSizeScale, uBrightness, uTime, uTwinkle;
varying vec3 vColor; varying float vSpike;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float s = aSize * uSizeScale * uPixelRatio;
  float tw = 1.0 + uTwinkle * 0.35 * sin(uTime * (1.7 + fract(aSize * 91.7) * 3.0) + aMag * 311.0);
  float bright = aMag * uBrightness * tw;
  // energy-conserving minimum size: sub-pixel stars keep 1.6px footprint but dim instead of aliasing
  float minS = 1.6 * uPixelRatio;
  if (s < minS) { bright *= (s * s) / (minS * minS); s = minS; }
  gl_PointSize = s;
  vColor = aColor * bright;
  vSpike = smoothstep(9.0, 26.0, s / uPixelRatio);
}`;
GLSL.starFragment = /* glsl */ `
varying vec3 vColor; varying float vSpike;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float core = exp(-r2 * 9.0);                 // tight gaussian core
  float halo = pow(max(1.0 - sqrt(r2), 0.0), 3.0) * 0.18; // soft airy halo
  // six-point diffraction spikes on the very brightest stars (JWST-like), fades in with size
  float spike = 0.0;
  if (vSpike > 0.0) {
    vec2 a = abs(p);
    float s1 = exp(-a.y * 46.0) * exp(-a.x * 2.6);
    vec2 q = abs(vec2(p.x * 0.5 + p.y * 0.8660254, -p.x * 0.8660254 + p.y * 0.5));
    float s2 = exp(-q.y * 46.0) * exp(-q.x * 2.6);
    vec2 w = abs(vec2(p.x * 0.5 - p.y * 0.8660254, p.x * 0.8660254 + p.y * 0.5));
    float s3 = exp(-w.y * 46.0) * exp(-w.x * 2.6);
    spike = (s1 + s2 + s3) * 0.55 * vSpike;
  }
  float edge = smoothstep(1.0, 0.72, r2);
  gl_FragColor = vec4(vColor * (core + halo + spike) * edge, 1.0);
}`;
