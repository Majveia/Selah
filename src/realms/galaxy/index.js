// A galaxy. Hundreds of thousands of stars on differentially rotating orbits; the spiral arms are a density wave
// (a rotating pattern the stars pass through, crowding and lighting up as they do), with dust lanes on the arms'
// inner edges, pink star-forming regions, and a golden old bulge. Every point in the disk is a door to a star system.

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { OrbitRig } from '../../core/controls.js';
import { createStarfield, createBeacon } from '../../core/stars.js';
import { RNG, hashInts, clamp, smoothstep } from '../../core/rng.js';
import { GLSL } from '../../core/glsl.js';

const KLY = 1; // 1 world unit = 1,000 light-years

const COMMON = /* glsl */ `
uniform float uTime, uProj, uPixelRatio, uArms, uPitchK, uPattern, uArmK, uV;
// returns world position; outputs arm strength (0..1) at the star's current place
vec3 orbit(vec3 rtz, float phase, out float arm){
  float r = rtz.x;
  float th = rtz.y + uV / sqrt(r * r + 16.0) * uTime;                 // flat rotation curve, solid-body core
  float k = uArmK * smoothstep(2.5, 9.0, r) * (1.0 - smoothstep(40.0, 56.0, r));
  float w = uPattern * uTime + uPitchK * log(r + 0.6) + phase;
  th -= k * sin(uArms * (th - w)) / uArms;                            // density wave: stars linger in the arms
  arm = pow(0.5 + 0.5 * cos(uArms * (th - w)), 1.5) * smoothstep(2.5, 9.0, r) * (1.0 - smoothstep(34.0, 52.0, r));
  return vec3(r * cos(th), rtz.z, r * sin(th));
}`;

const STAR_VERT = /* glsl */ `
${COMMON}
uniform float uSize, uGain;
attribute vec4 aRnd;
varying vec3 vColor;
void main(){
  float arm; vec3 p = orbit(position, 0.0, arm);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 1e-3), r = position.x;
  float oldPop = 1.0 - smoothstep(1.5, 11.0, r) * 0.82;               // the bulge and inter-arm disk are old and golden
  float young = arm * step(aRnd.x, 0.62) * (1.0 - oldPop * 0.7);
  vec3 col = mix(vec3(1.0, 0.72, 0.42), vec3(1.0, 0.9, 0.76), aRnd.y);            // K → G giants
  col = mix(col, mix(vec3(0.55, 0.72, 1.0), vec3(0.78, 0.86, 1.0), aRnd.y) * 1.5, young);   // O/B associations
  float hii = step(0.988, aRnd.z) * step(0.45, arm);
  col = mix(col, vec3(1.0, 0.16, 0.36) * 2.4, hii);
  float lum = 0.10 + 2.6 * pow(aRnd.w, 9.0) + 0.5 * young + 0.9 * hii;
  lum *= 1.0 + 1.6 * exp(-r * 0.32);                                 // crowded, brilliant core
  float px = uSize * (0.6 + 1.6 * pow(aRnd.w, 6.0) + 1.3 * hii) * uProj / depth;
  float I = uGain * lum;
  float minPx = 1.25 * uPixelRatio;
  if (px < minPx) { I *= (px * px) / (minPx * minPx); px = minPx; }
  I *= smoothstep(0.02, 0.4, depth);
  gl_PointSize = min(px, 46.0 * uPixelRatio);
  vColor = col * I;
}`;
const STAR_FRAG = /* glsl */ `
varying vec3 vColor;
void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard; gl_FragColor = vec4(vColor * (exp(-r2 * 4.2) - 0.015), 1.0); }`;

// soft sprites: dust (multiplicative) and nebula glow (additive)
const CLOUD_VERT = /* glsl */ `
${COMMON}
uniform float uSize, uGain, uPhase;
attribute vec4 aRnd;
varying float vA; varying vec4 vRnd;
void main(){
  float arm; vec3 p = orbit(position, uPhase, arm);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 1e-3);
  float px = uSize * (0.5 + aRnd.x) * uProj / depth;
  vA = uGain * pow(arm, 1.6) * (0.35 + 0.65 * aRnd.y) * smoothstep(0.3, 2.5, depth) * (1.0 - smoothstep(60.0 * uPixelRatio, 150.0 * uPixelRatio, px));
  vRnd = aRnd;
  gl_PointSize = min(px, 150.0 * uPixelRatio);
  if (vA < 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const DUST_FRAG = /* glsl */ `
varying float vA; varying vec4 vRnd;
void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard; float a = vA * exp(-r2 * 2.6) * (1.0 - r2);
  gl_FragColor = vec4(vec3(0.62, 0.8, 0.95) * a, 1.0); }`; // absorbs blue more than red: reddening
const NEB_FRAG = /* glsl */ `
varying float vA; varying vec4 vRnd;
void main(){ vec2 p = gl_PointCoord * 2.0 - 1.0; float r2 = dot(p, p); if (r2 > 1.0) discard; float a = vA * exp(-r2 * 3.0) * (1.0 - r2);
  vec3 c = mix(vec3(1.0, 0.2, 0.42), vec3(0.2, 0.75, 0.95), step(0.72, vRnd.z)); gl_FragColor = vec4(c * a, 1.0); }`;

// unresolved starlight: a continuous luminous disk under the resolved stars (same density-wave pattern, with
// noise-warped arms, dust lanes hugging their inner edges and star-forming knots)
const GLOW_VERT = /* glsl */ `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const GLOW_FRAG = /* glsl */ `
${GLSL.snoise3}
${GLSL.fbm3}
uniform float uTime, uArms, uPitchK, uPattern, uGlow;
varying vec2 vP;
void main(){
  float r = length(vP); if (r > 58.0) discard;
  float th = atan(vP.y, vP.x), w = uPattern * uTime + uPitchK * log(r + 0.6);
  float n1 = fbm(vec3(vP * 0.15, uTime * 0.003), 4), n2 = fbm(vec3(vP * 0.42 + 11.3, 4.0), 4);
  float ph = uArms * (th - w) + 1.5 * n1;
  float span = smoothstep(2.5, 8.0, r) * (1.0 - smoothstep(30.0, 52.0, r));
  float arm = pow(0.5 + 0.5 * cos(ph), 2.0) * span;
  float disk = exp(-r / 9.5), bulge = exp(-r / 2.3) * 2.4 + exp(-r / 0.7) * 3.0;
  vec3 col = vec3(1.0, 0.72, 0.44) * (disk * 0.42 + bulge) + vec3(0.40, 0.58, 1.0) * arm * disk * (2.1 + 1.6 * n2);
  float lane = pow(0.5 + 0.5 * cos(ph + 0.95), 5.0) * span * clamp(0.7 + 0.9 * n2, 0.0, 1.0);
  col *= 1.0 - 0.82 * lane; col = mix(col, col * vec3(1.3, 0.78, 0.5), lane * 0.6);
  float knots = smoothstep(0.5, 0.82, snoise(vec3(vP * 1.15, 3.0))) * arm;
  col += vec3(1.0, 0.18, 0.38) * knots * disk * 2.2;
  gl_FragColor = vec4(col * uGlow * (1.0 - smoothstep(46.0, 58.0, r)), 1.0);
}`;

const TYPES = ['grand-design spiral', 'barred spiral', 'flocculent spiral', 'multi-arm spiral'];

export default class GalaxyRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.02, 4000);
    this.post = { bloom: 0.9, bloomThreshold: 0.6, bloomKnee: 0.5, bloomScatter: 0.76, exposure: 1.0, saturation: 1.14, contrast: 1.03, vignette: 0.3, grain: 0.012, sharpen: 0.45, ca: 0.08 };
    this.home = new THREE.Vector3(24 * Math.cos(2.1), 0, 24 * Math.sin(2.1));
    this._cine = null; this._ct = 0; this._proj = new THREE.Vector3();
    this.info = { name: 'Galaxy', type: TYPES[0], suns: 100 };
  }

  async init() {
    const q = this.app.quality;
    const N = Math.round(620000 * q.particles), ND = Math.round(N / 16), NN = Math.round(N / 110);
    const U = this.uniforms = {
      uTime: { value: 0 }, uProj: { value: 800 }, uPixelRatio: { value: 1 }, uArms: { value: 2 }, uPitchK: { value: 3 }, uPattern: { value: 0.012 }, uArmK: { value: 0.5 }, uV: { value: 0.55 },
    };
    const make = (n, seed, fill) => {
      const rng = new RNG(seed), pos = new Float32Array(n * 3), rnd = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) { fill(rng, pos, i * 3); rnd[i * 4] = rng.next(); rnd[i * 4 + 1] = rng.next(); rnd[i * 4 + 2] = rng.next(); rnd[i * 4 + 3] = rng.next(); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 4)); return g;
    };
    const disk = (h, zs) => (rng, pos, o) => { let r; do { r = -h * Math.log(Math.max(1e-6, rng.next() * rng.next())); } while (r > 52 && rng.next() < 0.97); pos[o] = r; pos[o + 1] = rng.next() * Math.PI * 2; pos[o + 2] = rng.gauss() * (zs + 0.011 * r); };
    const stars = (rng, pos, o) => {
      if (rng.next() < 0.22) { const r = -2.4 * Math.log(Math.max(1e-6, rng.next())); pos[o] = r; pos[o + 1] = rng.next() * Math.PI * 2; pos[o + 2] = rng.gauss() * (2.0 * Math.exp(-r / 3.6) + 0.14); } // bulge
      else disk(8.6, 0.26)(rng, pos, o);
    };
    const mat = (vs, fs, uniforms, blending) => new THREE.ShaderMaterial({ vertexShader: vs, fragmentShader: fs, uniforms: { ...U, ...uniforms }, depthTest: false, depthWrite: false, transparent: true, ...blending });
    const add = (geo, m, order) => { const p = new THREE.Points(geo, m); p.frustumCulled = false; p.renderOrder = order; this.scene.add(p); return p; };
    this.gU = { ...U, uGlow: { value: 0.5 } };
    const plane = new THREE.PlaneGeometry(120, 120, 1, 1); plane.rotateX(-Math.PI / 2);
    this.glow = new THREE.Mesh(plane, new THREE.ShaderMaterial({ vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG, uniforms: this.gU, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: true, side: THREE.DoubleSide }));
    this.glow.frustumCulled = false; this.glow.renderOrder = 0; this.scene.add(this.glow);
    this.sU = { uSize: { value: 0.13 }, uGain: { value: 1.15 * Math.pow(620000 / N, 0.8) } };
    this.stars = add(make(N, 'g:stars', stars), mat(STAR_VERT, STAR_FRAG, this.sU, { blending: THREE.AdditiveBlending }), 1);
    this.dU = { uSize: { value: 2.4 }, uGain: { value: 0.085 * Math.pow(38000 / Math.max(ND, 1), 0.7) }, uPhase: { value: 0.42 } };
    this.dust = add(make(ND, 'g:dust', disk(9.5, 0.07)), mat(CLOUD_VERT, DUST_FRAG, this.dU, { blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcColorFactor }), 2);
    this.nU = { uSize: { value: 1.25 }, uGain: { value: 0.075 }, uPhase: { value: 0.0 } };
    this.neb = add(make(NN, 'g:neb', disk(10.5, 0.1)), mat(CLOUD_VERT, NEB_FRAG, this.nU, { blending: THREE.AdditiveBlending }), 3);
    this.core = createBeacon([1, 0.86, 0.62]); this.core.renderOrder = 4; this.scene.add(this.core);
    this.homeMark = createBeacon([0.75, 0.9, 1]); this.homeMark.position.copy(this.home); this.homeMark.renderOrder = 5; this.scene.add(this.homeMark);
    this.deep = createStarfield({ count: q.tier === 'low' ? 700 : 2200, seed: 'g:deep', radius: 2200, brightness: 0.3 }); this.scene.add(this.deep);

    this.rig = new OrbitRig(this.camera, this.app.input, { distance: 120, minDistance: 0.6, maxDistance: 230, yaw: 0.4, pitch: 0.62, minPitch: -1.45, maxPitch: 1.45, idleSpin: 0.01, smooth: 0.1 });
    this.rig.onZoomOutLimit = () => { if (!this._cine) this.app.ascend(); };
    this.rig.onZoomInLimit = () => this._enterSystem();
  }

  _configure(seed, name, home) {
    const r = new RNG(seed);
    const arms = home ? 2 : r.weighted([2, 3, 4, 5], [5, 2, 2, 1]);
    const U = this.uniforms;
    U.uArms.value = arms; U.uPitchK.value = home ? 3.1 : r.float(2.3, 4.2); U.uArmK.value = home ? 0.52 : r.float(0.34, 0.6) * (arms > 3 ? 0.8 : 1);
    this.t0 = r.float(0, 500);
    this.info = { name: name || 'Galaxy', type: TYPES[arms === 2 ? (r.chance(0.4) ? 1 : 0) : arms === 3 ? 3 : 2], suns: Math.round(r.float(60, 420) / 10) * 10 };
    this.seedNum = r.seed; this.isHome = !!home;
    this.homeMark.visible = !!home;
  }

  enter(params = {}) {
    if (!params.returning || this.seedNum == null) this._configure(params.seed ?? 'galaxy', params.name, params.home);
    const inp = this.app.input;
    this._off = [inp.on('doubletap', (t) => this._onDouble(t))];
    this._cine = params.cine || null; this._ct = 0;
    if (params.returning && this._last) { this.rig.set({ target: this._last.target, distance: 1.2 }); this.rig.flyTo({ distance: this._last.distance }, 3, { ease: 'out', interruptible: true }); }
    else if (this._cine) this.rig.set({ target: new THREE.Vector3(), distance: 210, yaw: 0.2, pitch: 1.2 });
    else if (params.distance) this.rig.set({ target: new THREE.Vector3(params.tx || 0, 0, params.tz || 0), distance: params.distance, yaw: params.yaw ?? 0.4, pitch: params.pitch ?? 0.62 });
    else { this.rig.set({ target: new THREE.Vector3(), distance: 0.9, yaw: 0.4, pitch: 0.62 }); this.rig.flyTo({ distance: 115 }, 3.4, { ease: 'out', interruptible: true }); }
  }
  exit() { this._off?.forEach((f) => f()); this._off = null; this.app.hud?.setTag(null); }
  endCine() { this._cine = null; }

  _diskPoint(nx, ny) {
    const ray = new THREE.Vector3(nx, ny, 0.5).unproject(this.camera).sub(this.camera.position).normalize();
    if (Math.abs(ray.y) < 1e-4) return null;
    const t = -this.camera.position.y / ray.y; if (t <= 0) return null;
    const p = this.camera.position.clone().addScaledVector(ray, t); return p.length() < 60 ? p : null;
  }
  _onDouble(t) {
    if (this._cine || this.app.travelling || this.rig.flying) return;
    const p = this._diskPoint(t.nx, t.ny); if (!p) return;
    if (p.length() < 1.6) return this._enterBlackHole();
    if (this.rig.distance < 6 && p.distanceTo(this.rig.target) < this.rig.distance * 0.5) return this._enterSystem();
    this.rig.flyTo({ target: p, distance: Math.max(1.4, this.rig.distance * 0.3) }, 2.4, { ease: 'inOut', interruptible: true });
  }
  async _enterBlackHole() {
    this._last = { target: new THREE.Vector3(), distance: Math.max(20, this.rig.distance) };
    await this.rig.flyTo({ target: new THREE.Vector3(), distance: 1.0 }, 2.4);
    const ok = await this.app.descend('blackhole', { seed: this.seedNum, galaxy: this.info.name });
    if (!ok) { this.app.hud?.toast('the core is veiled for now'); this.rig.flyTo({ distance: 30 }, 2, { ease: 'out', interruptible: true }); }
  }
  async _enterSystem() {
    if (this._cine || this.app.travelling || this.rig.flying) return;
    const tg = this.rig.target; if (tg.length() < 1.6) return this._enterBlackHole();
    const home = this.isHome && tg.distanceTo(this.home) < 1.5;
    const seed = home ? 'home' : hashInts(this.seedNum, Math.round(tg.x * 6), Math.round(tg.z * 6), 11);
    this._last = { target: tg.clone(), distance: Math.max(12, this.rig.distance) };
    await this.rig.flyTo({ distance: 0.6 }, 1.8);
    const ok = await this.app.descend('system', { seed, home });
    if (!ok) { this.app.hud?.toast('this sun is still igniting — soon'); this.rig.flyTo({ distance: 8 }, 2, { ease: 'out', interruptible: true }); }
  }

  update(dt, time) {
    const U = this.uniforms, vp = this.app.viewport;
    if (this._cine) {
      // opening film: fall from far above the disk toward a pale blue point in the Orion-like arm
      this._ct += dt; const u = clamp(this._ct / (this._cine.duration || 10)), e = smoothstep(0, 1, u);
      this.rig.enabled = false;
      this.rig.set({ target: this.home.clone().multiplyScalar(smoothstep(0.15, 0.95, u)), distance: Math.exp(Math.log(210) + (Math.log(2.2) - Math.log(210)) * Math.pow(e, 1.25)), yaw: 0.2 + 0.9 * e, pitch: 1.2 - 0.82 * e });
    } else { this.rig.enabled = true; this.rig.update(dt); }
    U.uTime.value = this.t0 + time; U.uPixelRatio.value = vp.pixelRatio; U.uProj.value = vp.height / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const d = this.rig.distance;
    this.sU.uGain.value = 1.15 * Math.pow(620000 / this.stars.geometry.attributes.position.count, 0.8) * (0.45 + 0.55 * clamp(d / 90));
    this.gU.uGlow.value = 1.8 * smoothstep(0.04, 0.4, Math.abs(this.camera.position.y - this.rig.target.y) / Math.max(d, 1e-3)) * smoothstep(1.5, 12, d);
    this.core.tick(this.app); this.core.set(clamp(2600 / d, 14, 420), 2.2);
    this.homeMark.tick(this.app); if (this.isHome) this.homeMark.set(20, 1.4 + 0.5 * Math.sin(time * 2.2));
    this.deep.tick(this.app);
    // label what is under the reticle when close
    const hud = this.app.hud;
    if (hud && !this._cine && !this.app.travelling) {
      const tg = this.rig.target, p = this._proj;
      if (this.isHome && d > 8) { p.copy(this.home).project(this.camera); if (p.z < 1) hud.setTag((p.x * 0.5 + 0.5) * vp.cssWidth, (-p.y * 0.5 + 0.5) * vp.cssHeight, 'Selah', 'home · double-tap to approach'); else hud.setTag(null); }
      else if (d < 6 && tg.length() > 1.6) hud.setTag(vp.cssWidth / 2, vp.cssHeight / 2, this.isHome && tg.distanceTo(this.home) < 1.5 ? 'Selah' : 'a sun, one of billions', 'keep zooming to enter');
      else if (tg.length() <= 1.6 && d < 14) hud.setTag(vp.cssWidth / 2, vp.cssHeight / 2, 'the galactic core', 'keep zooming — a black hole waits');
      else hud.setTag(null);
    }
  }

  describe() {
    const kly = 2 * this.rig.distance * Math.tan((this.camera.fov * Math.PI) / 360) * KLY;
    return { title: this.info.name, subtitle: `${this.info.type} · ${this.info.suns} billion suns`, scale: kly >= 1 ? `${kly >= 10 ? Math.round(kly) : kly.toFixed(1)} thousand light-years` : `${Math.round(kly * 1000)} light-years` };
  }
  hints(touch) { return touch ? 'drag to turn · pinch to fly · double-tap the disk to approach a sun · pinch out to leave' : 'drag to turn · scroll to fly · double-click the disk to approach a sun · scroll out to leave'; }
}
