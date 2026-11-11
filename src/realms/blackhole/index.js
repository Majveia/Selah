// A black hole, ray-traced. Every pixel follows a photon backwards through Schwarzschild spacetime (the exact null
// geodesic shape, integrated as x'' = -3/2 h² x / r⁵ in units of the Schwarzschild radius), so the sky wraps into an
// Einstein ring, the far side of the accretion disk arches over the shadow, and a thin photon ring traces light that
// circled the hole. The disk is a thin Keplerian flow: hotter inward, Doppler-beamed and blue-shifted where it
// rushes toward you, red-shifted and dimmed by gravity near the inner edge (ISCO at 3 r_s).

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { OrbitRig } from '../../core/controls.js';
import { FullscreenPass } from '../../core/post.js';
import { GLSL } from '../../core/glsl.js';

const FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.snoise3}
${GLSL.color}
uniform vec3 uPos, uRight, uUp, uFwd; uniform float uTan, uAspect, uTime; uniform int uSteps;
in vec2 vUv; out vec4 fragColor;
const float RIN = 3.0, ROUT = 15.0;

vec3 sky(vec3 d){
  vec3 col = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float sc = i == 0 ? 55.0 : 130.0; vec3 p = d * sc, ip = floor(p), fp = fract(p) - 0.5; vec3 h = hash33(ip);
    float dd = length(fp - (h - 0.5) * 0.7);
    float b = pow(h.x, i == 0 ? 9.0 : 16.0) * (i == 0 ? 26.0 : 60.0);
    col += smoothstep(0.11, 0.0, dd) * b * mix(vec3(1.0, 0.7, 0.45), vec3(0.6, 0.78, 1.0), h.y);
  }
  float band = exp(-pow(d.y * 2.6 + 0.35 * snoise(d * 2.0), 2.0));
  col += vec3(0.32, 0.36, 0.55) * band * (0.035 + 0.05 * max(snoise(d * 5.0), 0.0)) + vec3(0.9, 0.5, 0.3) * 0.018 * band * max(snoise(d * 9.0 + 4.0), 0.0);
  return col;
}
vec4 disk(vec3 hit, vec3 vel){
  float r = length(hit.xz); if (r < RIN || r > ROUT) return vec4(0.0);
  float om = 0.7071 * pow(r, -1.5), ang = uTime * om * 6.0;                      // Keplerian shear
  float ca = cos(ang), sa = sin(ang); vec2 q = vec2(ca * hit.x - sa * hit.z, sa * hit.x + ca * hit.z);
  float n = snoise(vec3(q * 0.55, r * 0.35)) * 0.55 + snoise(vec3(q * 1.7, r * 1.1 + 7.0)) * 0.3 + snoise(vec3(q * 4.5, 3.0)) * 0.15;
  float rings = 0.62 + 0.38 * sin(r * 5.2 + n * 4.0);
  float dens = (0.55 + 0.45 * n) * rings * smoothstep(RIN, RIN + 0.5, r) * (1.0 - smoothstep(ROUT * 0.55, ROUT, r));
  // thin-disk temperature profile, peaking just outside the inner edge
  float T = pow(RIN / r, 0.75) * pow(max(1.0 - sqrt(RIN / r) * 0.82, 0.0), 0.25);
  // relativistic shifts: orbital Doppler beaming × gravitational redshift
  float beta = sqrt(0.5 / r); vec3 tdir = normalize(vec3(-hit.z, 0.0, hit.x));
  float mu = dot(tdir, -normalize(vel));
  float shift = sqrt(max(1.0 - 1.0 / r, 0.0)) * sqrt(1.0 - beta * beta) / (1.0 - beta * mu);
  vec3 col = blackbody(4300.0 * (0.35 + 1.5 * T) * shift) * pow(shift, 3.6) * (0.25 + 5.0 * T * T) * 2.4;
  return vec4(col, clamp(dens * 1.5, 0.0, 0.94));
}
void main(){
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uAspect, 1.0) * uTan;
  vec3 pos = uPos, vel = normalize(uFwd + p.x * uRight + p.y * uUp);
  vec3 hv = cross(pos, vel); float h2 = dot(hv, hv);
  vec3 col = vec3(0.0); float A = 0.0; bool captured = false;
  for (int i = 0; i < 260; i++) {
    if (i >= uSteps) break;
    float r2 = dot(pos, pos), r = sqrt(r2);
    if (r < 1.0) { captured = true; break; }
    if (r > 70.0 && dot(pos, vel) > 0.0) break;
    float dt = clamp(0.085 * r, 0.03, 2.4) * (0.6 + 0.4 * smoothstep(0.0, 1.2, abs(pos.y)));
    vel += -1.5 * h2 * pos / (r2 * r2 * r) * dt;
    vec3 np = pos + vel * dt;
    if (pos.y * np.y < 0.0) {
      vec4 d = disk(mix(pos, np, pos.y / (pos.y - np.y)), vel);
      col += (1.0 - A) * d.a * d.rgb; A += (1.0 - A) * d.a;
      if (A > 0.985) break;
    }
    pos = np;
  }
  if (!captured) col += (1.0 - A) * sky(normalize(vel));
  fragColor = vec4(col, 1.0);
}`;

export default class BlackHoleRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
    this.post = { bloom: 1.05, bloomThreshold: 0.9, bloomKnee: 0.7, bloomScatter: 0.8, exposure: 0.95, saturation: 1.1, contrast: 1.06, vignette: 0.34, grain: 0.02, sharpen: 0.35, ca: 0.16 };
    this.musicScene = 'blackhole'; this.label = 'Black Hole';
  }
  async init() {
    const q = this.app.quality;
    this.pass = new FullscreenPass(FRAG, {
      uPos: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() }, uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
      uTan: { value: 0.5 }, uAspect: { value: 1 }, uTime: { value: 0 }, uSteps: { value: Math.round(150 * q.steps) },
    });
    this.rig = new OrbitRig(this.camera, this.app.input, { distance: 30, minDistance: 4.2, maxDistance: 64, yaw: 0.3, pitch: 0.11, minPitch: -1.4, maxPitch: 1.4, idleSpin: 0.02, idleDelay: 2, smooth: 0.11 });
    this.rig.onZoomOutLimit = () => this.app.ascend();
  }
  enter(params = {}) {
    this.label = params.galaxy ? `${params.galaxy} A*` : 'Black Hole';
    if (params.distance) this.rig.set({ distance: params.distance, yaw: params.yaw ?? 0.3, pitch: params.pitch ?? 0.11 });
    else { this.rig.set({ distance: 62, yaw: 0.3, pitch: 0.5 }); this.rig.flyTo({ distance: 26, pitch: 0.1 }, 5, { ease: 'out', interruptible: true }); }
  }
  update(dt) { this.rig.update(dt); }
  render(renderer, target) {
    const u = this.pass.uniforms, m = this.camera.matrixWorld.elements;
    u.uPos.value.copy(this.camera.position); u.uRight.value.set(m[0], m[1], m[2]); u.uUp.value.set(m[4], m[5], m[6]); u.uFwd.value.set(-m[8], -m[9], -m[10]);
    u.uTan.value = Math.tan((this.camera.fov * Math.PI) / 360); u.uAspect.value = this.app.viewport.aspect; u.uTime.value = this.app.time;
    this.pass.render(renderer, target);
  }
  describe() { return { title: this.label, subtitle: 'supermassive black hole · light bent by gravity, a disk beamed by its own speed', scale: `${this.rig.distance.toFixed(0)} Schwarzschild radii away` }; }
  hints(touch) { return touch ? 'drag to circle the hole · pinch closer if you dare · pinch out to leave' : 'drag to circle the hole · scroll closer if you dare · scroll out to leave'; }
}
