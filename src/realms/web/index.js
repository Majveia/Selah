// The Cosmic Web — structure formation you can hold.
//
// Millions of mass tracers start on a jittered Lagrangian lattice and move by the Zel'dovich approximation
// x = q + D(a)·ψ(q), with D(a) the ΛCDM linear growth factor. Colour and brightness come from the exact Zel'dovich
// density 1/|det(I + D∇ψ)|, so sheets, filaments and nodes light up as their caustics form. The displacement field is
// a slowly rotating blend of two independent Gaussian random fields, so the web never stops flowing. The view is a
// periodic box wrapped around the observer and faded to a sphere: an "observable universe" you can fly through forever.

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { OrbitRig } from '../../core/controls.js';
import { createStarfield, createBeacon } from '../../core/stars.js';
import { RNG, hashInts, clamp, damp } from '../../core/rng.js';
import { buildField, samplePsi, buildCosmology } from './field.js';

const BOX = 100;                       // world units per box side
const BOX_MLY = (250 / 0.674) * 3.2616; // box side in million light-years (250 Mpc/h)
export const D_NOW = 1.55;                    // displacement amplitude today (rms linear δ on the grid scale)
const A_MIN = 0.04, A_MAX = 1.9;

const WEB_COMMON = /* glsl */ `
precision highp sampler3D;
uniform sampler3D tA0, tA1, tA2, tB0, tB1, tB2;
uniform float uD, uPhase, uTime, uProj, uPixelRatio, uScale;
uniform vec3 uCenter;
uint pcg(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
vec3 rnd3(uint id){ uint a = pcg(id), b = pcg(a), c = pcg(b); return vec3(a, b, c) * (1.0 / 4294967295.0); }
// Zel'dovich map: Lagrangian q → Eulerian x (box units), plus local density contrast and a regional hue value
vec3 webMap(vec3 q, out float rho, out float hue){
  float c = cos(uPhase), s = sin(uPhase);
  vec4 a0 = texture(tA0, q), a1 = texture(tA1, q), a2 = texture(tA2, q);
  vec4 b0 = texture(tB0, q), b1 = texture(tB1, q), b2 = texture(tB2, q);
  vec3 psi = c * a0.xyz + s * b0.xyz;
  float dxx = c * a0.w + s * b0.w, dyy = c * a1.x + s * b1.x, dzz = c * a1.y + s * b1.y;
  float dxy = c * a1.z + s * b1.z, dxz = c * a1.w + s * b1.w, dyz = c * a2.x + s * b2.x;
  hue = c * a2.y + s * b2.y;
  mat3 J = mat3(1.0 + uD * dxx, uD * dxy, uD * dxz, uD * dxy, 1.0 + uD * dyy, uD * dyz, uD * dxz, uD * dyz, 1.0 + uD * dzz);
  rho = 1.0 / max(abs(determinant(J)), 0.004);
  return q + uD * psi;
}
`;

const PARTICLE_VERT = /* glsl */ `
${WEB_COMMON}
uniform float uN, uSize, uGain, uHeat, uVirial, uFocus;
uniform vec3 uHeatColor;
attribute float aSeed;
varying vec3 vColor;
void main(){
  uint id = uint(gl_VertexID);
  float fi = float(gl_VertexID);
  vec3 g = vec3(mod(fi, uN), mod(floor(fi / uN), uN), floor(fi / (uN * uN)));
  vec3 r = rnd3(id);
  vec3 q = (g + r) / uN;
  float rho, hue;
  vec3 x = webMap(q, rho, hue);
  float ld = log2(rho);
  // bound structures are not frozen: let collapsed matter swarm gently ("virial" motion)
  float coll = smoothstep(2.5, 6.0, ld);
  vec3 o = rnd3(id ^ 2654435769u) - 0.5;
  float ph = uTime * (0.22 + r.x * 0.55) + r.y * 6.2831853;
  x += uVirial * coll * (o * sin(ph) + cross(o, normalize(o.zxy + 0.013)) * cos(ph));
  vec3 rel = fract(x - uCenter + 0.5) - 0.5;
  float fadeS = smoothstep(0.5, 0.34, length(rel));
  vec4 mv = viewMatrix * vec4(rel * ${BOX.toFixed(1)} * uScale, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 1e-3);

  // colour ramp over log-density: indigo voids → ultramarine walls → azure filaments → ice → gold nodes
  float t = clamp((ld + 2.2) / 9.6, 0.0, 1.0);
  vec3 col = mix(vec3(0.050, 0.035, 0.26), vec3(0.11, 0.16, 0.80), smoothstep(0.0, 0.30, t));
  col = mix(col, vec3(0.13, 0.55, 1.00), smoothstep(0.26, 0.55, t));
  col = mix(col, vec3(0.80, 0.92, 1.00), smoothstep(0.52, 0.78, t));
  col = mix(col, vec3(1.00, 0.74, 0.40), smoothstep(0.80, 1.0, t));
  // regional tint: some superclusters lean rose/violet, others teal — a painter's universe
  float h = clamp(hue * 2.6, -1.0, 1.0);
  col *= mix(vec3(1.0), h > 0.0 ? vec3(1.28, 0.74, 1.12) : vec3(0.70, 1.12, 1.02), abs(h) * (1.0 - 0.75 * smoothstep(0.7, 1.0, t)));
  col = mix(col, uHeatColor, uHeat);

  float I = uGain * mix(0.045 + 0.955 * pow(min(rho, 200.0), 0.58) * 0.62, 1.0, uHeat) * fadeS;
  float px = uSize * (0.7 + 0.6 * r.z) * uProj / depth;
  // thin-lens flavour: tracers far from the focal distance swell into soft discs (surface brightness falls with area)
  float coc = abs(depth - uFocus) / max(uFocus, 1e-3);
  float blur = 1.0 + 2.2 * smoothstep(0.35, 1.0, coc) * step(depth, uFocus);
  px *= blur; I /= blur * blur;
  float minPx = 1.3 * uPixelRatio, maxPx = 40.0 * uPixelRatio;
  if (px < minPx) { I *= (px * px) / (minPx * minPx); px = minPx; }
  I *= smoothstep(0.06, 0.9, depth) * (1.0 - smoothstep(maxPx * 0.6, maxPx, px));
  gl_PointSize = min(px, maxPx);
  vColor = col * I;
}`;

const PARTICLE_FRAG = /* glsl */ `
varying vec3 vColor;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * (exp(-r2 * 3.4) - 0.0334), 1.0);
}`;

const GALAXY_VERT = /* glsl */ `
${WEB_COMMON}
uniform float uGalSize, uGalGain;
attribute vec3 aQ; attribute vec4 aRand;
varying vec4 vRand; varying float vA; varying float vEll;
void main(){
  float rho, hue;
  vec3 x = webMap(aQ, rho, hue);
  vec3 rel = fract(x - uCenter + 0.5) - 0.5;
  float fadeS = smoothstep(0.46, 0.30, length(rel));
  vec4 mv = viewMatrix * vec4(rel * ${BOX.toFixed(1)} * uScale, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 1e-3);
  float px = uGalSize * (0.45 + 1.1 * aRand.x * aRand.x) * uProj / depth;
  float ld = log2(rho);
  // galaxies only shine where matter has gathered, and only resolve once you are close
  vA = fadeS * smoothstep(0.2, 2.2, ld) * smoothstep(2.2 * uPixelRatio, 6.0 * uPixelRatio, px) * smoothstep(0.05, 0.5, depth) * uGalGain;
  vEll = step(aRand.w, 0.12 + 0.5 * smoothstep(3.0, 7.0, ld)); // morphology–density relation: ellipticals crowd the nodes
  vRand = aRand;
  gl_PointSize = min(px, 110.0 * uPixelRatio);
  if (vA < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;

const GALAXY_FRAG = /* glsl */ `
varying vec4 vRand; varying float vA; varying float vEll;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float ang = vRand.y * 6.2831853; float ca = cos(ang), sa = sin(ang);
  p = vec2(ca * p.x - sa * p.y, sa * p.x + ca * p.y);
  float incl = mix(0.22, 1.0, vRand.z);
  vec2 d = vec2(p.x, p.y / mix(incl, 0.62 + 0.38 * vRand.z, vEll));
  float r = length(d);
  if (r > 1.0) discard;
  float bulge = exp(-r * 11.0), disk = exp(-r * 4.4);
  float arms = 0.5 + 0.5 * cos(2.0 * atan(d.y, d.x) - 5.2 * log(r + 0.03) * (vRand.x > 0.5 ? 1.0 : -1.0) + vRand.w * 40.0);
  vec3 col = mix(vec3(1.0, 0.86, 0.64) * bulge * 2.6 + vec3(0.55, 0.74, 1.0) * disk * (0.28 + 0.9 * arms * arms) * 0.9,
                 vec3(1.0, 0.80, 0.56) * (bulge * 2.2 + disk * 0.7), vEll);
  gl_FragColor = vec4(col * smoothstep(1.0, 0.62, r) * vA, 1.0);
}`;

const SYL_A = ['Ae', 'Be', 'Ca', 'Do', 'El', 'Fa', 'Ga', 'Ha', 'Il', 'Jo', 'Ka', 'Lu', 'Ma', 'Ne', 'O', 'Pa', 'Qu', 'Ra', 'Sa', 'Te', 'U', 'Va', 'Wy', 'Xa', 'Ya', 'Ze'];
const SYL_B = ['la', 'ri', 'no', 'the', 'lu', 'ma', 'se', 'dra', 'vi', 'ko', 'ne', 'sha', 'ro', 'li', 'mu', 'ta'];
const SYL_C = ['h', 'n', 's', 'ra', 'x', 'th', 'ris', 'on', 'el', 'ia', 'um', 'os'];
export function galaxyName(seed) {
  const r = new RNG(seed);
  return r.pick(SYL_A) + r.pick(SYL_B) + (r.chance(0.6) ? r.pick(SYL_B) : '') + r.pick(SYL_C);
}

export default class WebRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(48, 1, 0.02, 3000);
    this.post = { bloom: 0.8, bloomThreshold: 0.55, bloomKnee: 0.5, bloomScatter: 0.74, exposure: 1.0, vignette: 0.34, saturation: 1.1, contrast: 1.04, grain: 0.012, sharpen: 0.45, ca: 0.1 };
    this.center = new THREE.Vector3(0.5, 0.5, 0.5);   // box coordinates of the observer's focus
    this._centerGoal = this.center.clone();
    this.a = 1; this._aGoal = 1;                      // scale factor shown
    this.phase = 0.35; this.phaseSpeed = 0.011;
    this.cine = null;                                 // director override: { D, heat, heatColor:[r,g,b], scale, gain, phaseSpeed }
    this.cosmo = buildCosmology(A_MAX + 0.1);
    this.seed = app.params.get('seed') || 'selah';
    this._hover = null; this._hoverT = 0; this._tmp = new Float32Array(3); this._tmp2 = new Float32Array(3);
    this._v = new THREE.Vector3(); this._proj = new THREE.Vector3();
  }

  async init() {
    const q = this.app.quality;
    const M = q.tier === 'low' ? 32 : 64;
    const [fa, fb] = await Promise.all([this._field(M, `${this.seed}:A`), this._field(M, `${this.seed}:B`)]);
    this.fieldA = fa; this.fieldB = fb;
    const tex = (data) => {
      const t = new THREE.Data3DTexture(data, M, M, M);
      t.format = THREE.RGBAFormat; t.type = THREE.HalfFloatType; t.minFilter = t.magFilter = THREE.LinearFilter;
      t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.unpackAlignment = 1; t.needsUpdate = true; return t;
    };
    const U = this.uniforms = {
      tA0: { value: tex(fa.t0) }, tA1: { value: tex(fa.t1) }, tA2: { value: tex(fa.t2) },
      tB0: { value: tex(fb.t0) }, tB1: { value: tex(fb.t1) }, tB2: { value: tex(fb.t2) },
      uD: { value: D_NOW }, uPhase: { value: this.phase }, uTime: { value: 0 }, uProj: { value: 800 }, uPixelRatio: { value: 1 }, uScale: { value: 1 },
      uCenter: { value: this.center },
    };
    // --- mass tracers ---
    const N = Math.max(40, Math.round(Math.cbrt(2.1e6 * q.particles)));
    this.N = N; const count = N * N * N;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('aSeed', new THREE.BufferAttribute(new Uint8Array(count), 1, true));
    geo.setDrawRange(0, count);
    this.baseGain = 2.7 * Math.pow(175000 / count, 0.82);
    this.pUniforms = { ...U, uN: { value: N }, uSize: { value: 0.12 }, uGain: { value: this.baseGain }, uHeat: { value: 0 }, uHeatColor: { value: new THREE.Vector3(3, 2.6, 2.2) }, uVirial: { value: 0.0016 }, uFocus: { value: 60 } };
    const pm = new THREE.ShaderMaterial({ vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: this.pUniforms, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true });
    this.points = new THREE.Points(geo, pm); this.points.frustumCulled = false;
    this.scene.add(this.points);

    // --- galaxies (resolve when you get close; these are the doors to the next scale) ---
    const G = q.tier === 'low' ? 22 : q.tier === 'mid' ? 30 : 38; const gc = G * G * G;
    const rng = new RNG(`${this.seed}:gal`);
    const aQ = new Float32Array(gc * 3), aR = new Float32Array(gc * 4);
    for (let i = 0; i < gc; i++) {
      aQ[i * 3] = ((i % G) + rng.next()) / G; aQ[i * 3 + 1] = ((Math.floor(i / G) % G) + rng.next()) / G; aQ[i * 3 + 2] = (Math.floor(i / (G * G)) + rng.next()) / G;
      aR[i * 4] = rng.next(); aR[i * 4 + 1] = rng.next(); aR[i * 4 + 2] = rng.next(); aR[i * 4 + 3] = rng.next();
    }
    this.galQ = aQ; this.galR = aR; this.galCount = gc;
    const gg = new THREE.BufferGeometry();
    gg.setAttribute('aQ', new THREE.BufferAttribute(aQ, 3)); gg.setAttribute('aRand', new THREE.BufferAttribute(aR, 4)); gg.setDrawRange(0, gc);
    this.gUniforms = { ...U, uGalSize: { value: 0.3 }, uGalGain: { value: 1.5 } };
    const gm = new THREE.ShaderMaterial({ vertexShader: GALAXY_VERT, fragmentShader: GALAXY_FRAG, uniforms: this.gUniforms, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true });
    this.galaxies = new THREE.Points(gg, gm); this.galaxies.frustumCulled = false;
    this.scene.add(this.galaxies);

    // --- the deep field beyond our bubble ---
    this.deep = createStarfield({ count: q.tier === 'low' ? 900 : 2600, seed: `${this.seed}:deep`, radius: 1200, brightness: 0.22 });
    this.scene.add(this.deep);

    // --- the first light (driven by the opening film) ---
    this.beacon = createBeacon(); this.beacon.set(30, 0); this.scene.add(this.beacon);

    this.rig = new OrbitRig(this.camera, this.app.input, { distance: 118, minDistance: 0.55, maxDistance: 190, yaw: 0.6, pitch: 0.22, idleSpin: 0.016, idleDelay: 2.5, smooth: 0.1 });
    this.rig.onZoomInLimit = () => this._diveNearest();

    this.timeControl = {
      name: 'cosmic time',
      get: () => Math.sqrt((this._aGoal - A_MIN) / (A_MAX - A_MIN)),
      set: (v) => { this._aGoal = A_MIN + (A_MAX - A_MIN) * v * v; },
      label: () => {
        const a = this.a, age = this.cosmo.age(a);
        if (a > 1.02) return `+${(age - this.cosmo.ageNow).toFixed(1)} Gyr from now`;
        if (a > 0.985) return `${age.toFixed(1)} Gyr · today`;
        return `${age < 1 ? age.toFixed(2) : age.toFixed(1)} Gyr · z ${(1 / a - 1).toFixed(a < 0.2 ? 0 : 1)}`;
      },
    };
    this._offTap = null;
  }

  _field(M, seed) {
    return new Promise((resolve) => {
      const local = () => resolve(buildField(M, seed));
      if (this.app.params.get('worker') === '0' || typeof Worker === 'undefined') return local();
      try {
        const w = new Worker(new URL('./field-worker.js', import.meta.url), { type: 'module' });
        const t = setTimeout(() => { w.terminate(); local(); }, 15000);
        w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data); };
        w.onerror = () => { clearTimeout(t); w.terminate(); local(); };
        w.postMessage({ M, seed });
      } catch { local(); }
    });
  }

  enter(params = {}) {
    const inp = this.app.input;
    this._offTap = [inp.on('doubletap', (t) => this._onDouble(t)), inp.on('tap', (t) => this._onTap(t))];
    if (params.returning && this._last) {
      // come back up from a galaxy: start close to where we dived and pull away
      this.center.copy(this._last.center); this._centerGoal.copy(this._last.center);
      this.rig.set({ distance: 0.7 }); this.rig.flyTo({ distance: this._last.distance }, 3.2, { ease: 'out', interruptible: true });
    } else if (params.pose) this.rig.set(params.pose);
    if (params.distance) this.rig.set({ distance: params.distance, yaw: params.yaw ?? this.rig.yaw, pitch: params.pitch ?? this.rig.pitch });
    if (params.a) this.a = this._aGoal = params.a;
    if (params.cine !== undefined) this.cine = params.cine;
  }
  exit() { this._offTap?.forEach((f) => f()); this._offTap = null; this.app.hud?.setTag(null); }

  // ---- galaxies on the CPU (picking / labels) ---------------------------------------------------------
  _galaxyWorld(i, out) {
    const q = this.galQ, c = Math.cos(this.phase), s = Math.sin(this.phase), D = this.uniforms.uD.value;
    const qx = q[i * 3], qy = q[i * 3 + 1], qz = q[i * 3 + 2];
    const a = samplePsi(this.fieldA, qx, qy, qz, this._tmp), b = samplePsi(this.fieldB, qx, qy, qz, this._tmp2);
    const x = qx + D * (c * a[0] + s * b[0]), y = qy + D * (c * a[1] + s * b[1]), z = qz + D * (c * a[2] + s * b[2]);
    out.box = out.box || new THREE.Vector3(); out.box.set(x, y, z);
    const w = (v, cc) => { let r = (v - cc + 0.5) % 1; if (r < 0) r += 1; return r - 0.5; };
    return out.set(w(x, this.center.x), w(y, this.center.y), w(z, this.center.z)).multiplyScalar(BOX * this.uniforms.uScale.value);
  }
  _pick(px, py, radius = 46) {
    const vp = this.app.viewport, v = this._v, p = this._proj; let best = -1, bestScore = 1e9;
    for (let i = 0; i < this.galCount; i++) {
      this._galaxyWorld(i, v);
      const rr = v.length() / BOX; if (rr > 0.44) continue;
      p.copy(v).project(this.camera); if (p.z > 1 || p.z < -1) continue;
      const sx = (p.x * 0.5 + 0.5) * vp.cssWidth, sy = (-p.y * 0.5 + 0.5) * vp.cssHeight;
      const d = Math.hypot(sx - px, sy - py); if (d > radius) continue;
      const depth = v.distanceTo(this.camera.position);
      const score = d + depth * 2.2;              // prefer what is close to the pointer and close to the eye
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return best;
  }

  _onTap() { /* reserved: single taps do nothing so exploring never triggers accidental travel */ }
  _onDouble(t) {
    if (this.cine || this.app.travelling || this.rig.flying) return;
    const g = this.rig.distance < 60 ? this._pick(t.x, t.y) : -1;
    if (g >= 0) return this._diveInto(g);
    // otherwise: glide toward the point you tapped and move closer
    const ray = new THREE.Vector3(t.nx, t.ny, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    const hit = this.camera.position.clone().addScaledVector(ray, this.rig.distance);
    this._centerGoal.copy(this.center).addScaledVector(hit, 1 / (BOX * this.uniforms.uScale.value));
    this.rig.flyTo({ distance: Math.max(this.rig.minDistance * 1.5, this.rig.distance * 0.45) }, 2.2, { ease: 'inOut', interruptible: true });
  }
  _diveNearest() {
    if (this.cine || this.app.travelling || this.rig.flying) return;
    const vp = this.app.viewport; const g = this._pick(vp.cssWidth / 2, vp.cssHeight / 2, Math.min(vp.cssWidth, vp.cssHeight) * 0.3);
    if (g >= 0) this._diveInto(g);
  }
  async _diveInto(g) {
    const seed = hashInts(new RNG(this.seed).seed, g, 7);
    this._galaxyWorld(g, this._v);
    const box = this._v.box.clone();
    this._last = { center: box.clone(), distance: Math.max(8, this.rig.distance) };
    this._centerGoal.copy(box); this._snapCenter = 0.5;
    this.app.hud?.setTag(null);
    await this.rig.flyTo({ distance: 0.8 }, 2.4, { ease: 'inOut' });
    const ok = await this.app.descend('galaxy', { seed, name: galaxyName(seed) }, { duration: 2.6 });
    if (!ok) { this.app.hud?.toast('this galaxy is still condensing — soon'); this.rig.flyTo({ distance: 6 }, 2, { ease: 'out', interruptible: true }); }
  }

  update(dt, time) {
    const U = this.uniforms, vp = this.app.viewport, cine = this.cine;
    this.rig.enabled = !cine || cine.free === true;
    this.rig.update(dt);
    // focus glides (periodic shortest path)
    const tau = this._snapCenter || 0.9;
    for (const k of ['x', 'y', 'z']) {
      let d = this._centerGoal[k] - this.center[k]; d -= Math.round(d);
      const n = damp(0, d, tau, dt); this.center[k] += d - n; this._centerGoal[k] = this.center[k] + n;
    }
    this.a = damp(this.a, this._aGoal, 0.35, dt);
    this.phase += dt * (cine?.phaseSpeed ?? this.phaseSpeed);
    const breathe = 1 + 0.035 * Math.sin(time * 0.19) + 0.015 * Math.sin(time * 0.071 + 1.3);
    U.uD.value = cine?.D ?? D_NOW * this.cosmo.growth(this.a) * breathe;
    U.uPhase.value = this.phase; U.uTime.value = time; U.uPixelRatio.value = vp.pixelRatio; U.uScale.value = cine?.scale ?? 1;
    U.uProj.value = vp.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const P = this.pUniforms;
    P.uGain.value = this.baseGain * (cine?.gain ?? 1) * (0.55 + 0.45 * clamp(this.rig.distance / 60));
    P.uHeat.value = cine?.heat ?? 0; if (cine?.heatColor) P.uHeatColor.value.fromArray(cine.heatColor);
    P.uFocus.value = this.rig.distance;
    this.gUniforms.uGalGain.value = cine?.galaxies ?? 1.5;
    this.beacon.tick(this.app); if (!cine) this.beacon.set(30, 0); else if (cine.beacon) this.beacon.set(cine.beacon[0], cine.beacon[1]);
    this.deep.tick(this.app); this.deep.material.uniforms.uBrightness.value = 0.22 * (cine?.deep ?? 1);

    // hover label (desktop) / nearest-galaxy label when close
    this._hoverT -= dt;
    if (!cine && this._hoverT <= 0 && this.rig.distance < 26 && !this.rig.flying && !this.app.travelling) {
      this._hoverT = 0.14;
      const inp = this.app.input, mouse = inp.lastDevice === 'mouse';
      const g = mouse ? this._pick(inp.pointer.x, inp.pointer.y, 30) : this._pick(vp.cssWidth / 2, vp.cssHeight / 2, 70);
      this._hover = g;
    } else if (cine || this.rig.distance >= 26) this._hover = -1;
    if (this._hover >= 0 && this.app.hud) {
      this._galaxyWorld(this._hover, this._v); this._proj.copy(this._v).project(this.camera);
      const seed = hashInts(new RNG(this.seed).seed, this._hover, 7);
      this.app.hud.setTag((this._proj.x * 0.5 + 0.5) * vp.cssWidth, (-this._proj.y * 0.5 + 0.5) * vp.cssHeight, galaxyName(seed), 'galaxy · double-tap to enter');
    } else this.app.hud?.setTag(null);
  }

  describe() {
    const mly = 2 * this.rig.distance * Math.tan((this.camera.fov * Math.PI) / 360) * (BOX_MLY / BOX);
    return {
      title: 'Cosmic Web',
      subtitle: `${(this.N ** 3 / 1e6).toFixed(this.N ** 3 > 1e6 ? 1 : 2)} million mass tracers · ΛCDM gravity, Zel'dovich flow`,
      scale: mly >= 1000 ? `${(mly / 1000).toFixed(1)} billion light-years` : `${Math.round(mly)} million light-years`,
    };
  }
  hints(touch) { return touch ? 'drag to turn · pinch to fly in · double-tap a galaxy to enter · slide cosmic time' : 'drag to turn · scroll to fly in · double-click a galaxy to enter · drag cosmic time'; }
}
