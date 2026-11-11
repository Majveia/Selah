// Sky, sun, moon, clouds and sea for a world's surface — and the day itself: one slowly turning light that every
// surface material shares (golden hours linger, nights are short and full of stars).

import * as THREE from 'three';
import { GLSL } from '../../core/glsl.js';
import { LIGHT_GLSL } from './terrain.js';
import { clamp, smoothstep, lerp } from '../../core/rng.js';

const SKY_FRAG = /* glsl */ `
${GLSL.hash}
${GLSL.snoise3}
${GLSL.fbm3}
uniform vec3 uZenith, uHorizon, uSun, uSunCol, uMoon, uCloudLit, uCloudDark; uniform float uNight, uTime, uCloud; uniform vec2 uWind;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir); float y = max(d.y, 0.0);
  vec3 col = mix(uHorizon, uZenith, pow(y, 0.42));
  float sd = max(dot(d, uSun), 0.0);
  col += uSunCol * (pow(sd, 7.0) * 0.16 + pow(sd, 60.0) * 0.45) * smoothstep(-0.25, 0.05, uSun.y);
  if (uNight > 0.01) {                                             // stars and the galaxy's band
    vec3 p = d * 140.0, ip = floor(p), fp = fract(p) - 0.5; vec3 h = hash33(ip);
    float st = smoothstep(0.1, 0.0, length(fp - (h - 0.5) * 0.7)) * pow(h.x, 10.0) * 26.0;
    float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.6, -0.7))) * 3.2, 2.0));
    col += (st * mix(vec3(1.0, 0.75, 0.55), vec3(0.65, 0.8, 1.0), h.y) + vec3(0.2, 0.24, 0.4) * band * (0.05 + 0.05 * snoise(d * 6.0))) * uNight * smoothstep(-0.02, 0.2, d.y);
  }
  float md = dot(d, uMoon);                                        // the moon, lit from the sun's side
  if (md > 0.99935) { vec3 mn = normalize(d - uMoon * md); float ph = smoothstep(-0.25, 0.35, dot(mn, normalize(uSun - uMoon * dot(uSun, uMoon)))); col = mix(col, vec3(0.9, 0.92, 1.0) * (0.25 + 1.4 * ph) * (0.8 + 0.2 * snoise(d * 900.0)), smoothstep(0.99935, 0.9995, md)); }
  col += uSunCol * smoothstep(0.99955, 0.99985, sd) * 26.0 * smoothstep(-0.03, 0.02, d.y);   // the sun's disc
  if (d.y > 0.015 && uCloud > 0.01) {                              // high cloud decks, lit from the sun's direction
    vec2 q = d.xz / (d.y + 0.14) * 1.15 + uWind * uTime * 0.0035;
    float c = fbm(vec3(q, uTime * 0.006), 5) * 0.5 + 0.5, c2 = fbm(vec3(q + uSun.xz * 0.12, uTime * 0.006), 3) * 0.5 + 0.5;
    float cov = smoothstep(0.86 - uCloud * 0.5, 1.05 - uCloud * 0.42, c + 0.12);
    vec3 cc = mix(uCloudDark, uCloudLit, clamp(0.5 + (c - c2) * 3.5, 0.0, 1.0)) + uSunCol * pow(sd, 5.0) * 0.5;
    col = mix(col, cc, cov * smoothstep(0.015, 0.22, d.y) * 0.92);
  }
  col = mix(col, uHorizon * 0.55, smoothstep(0.0, -0.25, d.y));
  gl_FragColor = vec4(col, 1.0);
}`;

const WATER_FRAG = /* glsl */ `
${LIGHT_GLSL}
uniform vec3 uZenith, uHorizon, uDeep, uSunSky, uSunCol;
varying vec3 vW;
void main(){
  vec3 V = normalize(cameraPosition - vW); float dist = length(cameraPosition - vW);
  vec2 p = vW.xz; float t = uTime;
  float k = 1.0 / (1.0 + dist * 0.012);                           // calm the far field so it doesn't shimmer
  vec3 N = normalize(vec3((snoise(vec3(p * 0.09 + t * 0.12, 1.0)) * 0.5 + snoise(vec3(p * 0.37 - t * 0.2, 4.0)) * 0.3) * 0.34 * k, 1.0, (snoise(vec3(p * 0.09 - t * 0.1, 7.0)) * 0.5 + snoise(vec3(p * 0.41 + t * 0.17, 2.0)) * 0.3) * 0.34 * k));
  float F = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  vec3 sky = mix(uHorizon, uZenith, pow(R.y, 0.5));
  float sd = max(dot(R, uSunSky), 0.0);
  vec3 glit = uSunCol * (pow(sd, 420.0) * 9.0 + pow(sd, 40.0) * 0.22) * smoothstep(-0.05, 0.05, uSunSky.y);
  vec3 body = uDeep * (uSkyColor * 1.4 + uSunColor * 0.35 * cloudShade(vW));
  vec3 col = mix(body, sky, F) + glit;
  gl_FragColor = vec4(fogged(col, vW), 0.78 + 0.22 * F);
}`;

export class Sky {
  constructor(scene, light, quality) {
    this.light = light; this.phase = 0.2;
    const v = () => ({ value: new THREE.Vector3() });
    this.U = { uZenith: v(), uHorizon: v(), uSun: v(), uSunCol: v(), uMoon: v(), uCloudLit: v(), uCloudDark: v(), uNight: { value: 0 }, uTime: light.uTime, uCloud: { value: 0.5 }, uWind: light.uWind };
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(7000, 48, 24), new THREE.ShaderMaterial({ uniforms: this.U, side: THREE.BackSide, depthWrite: false, depthTest: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0); gl_Position = p.xyww; }`, fragmentShader: SKY_FRAG }));
    this.dome.renderOrder = -100; this.dome.frustumCulled = false; scene.add(this.dome);
    this.WU = { ...light, uZenith: this.U.uZenith, uHorizon: this.U.uHorizon, uDeep: v(), uSunSky: this.U.uSun, uSunCol: this.U.uSunCol };
    const wg = new THREE.PlaneGeometry(16000, 16000, 1, 1); wg.rotateX(-Math.PI / 2);
    this.water = new THREE.Mesh(wg, new THREE.ShaderMaterial({ uniforms: this.WU, transparent: true, depthWrite: false,
      vertexShader: `varying vec3 vW; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`, fragmentShader: WATER_FRAG }));
    this.water.renderOrder = 5; this.water.frustumCulled = false; scene.add(this.water);
    this.sun = new THREE.Vector3(); this.moon = new THREE.Vector3(); this.atmo = new THREE.Vector3(0.25, 0.5, 1); this.night = 0;
  }
  configure(desc, hasSea) {
    const k = desc.look; this.atmo.fromArray(k.atmo); this.dens = clamp(k.atmoDensity, 0.05, 1.3);
    this.U.uCloud.value = k.cloud; this.water.visible = hasSea; this.WU.uDeep.value.fromArray(k.ocean[1]).multiplyScalar(0.9);
    this.phase = 0.035;                                              // arrive in the long light after sunrise
  }
  /** advance the day; writes the shared light uniforms */
  update(dt, camPos, speed = 1) {
    const a0 = this.phase * Math.PI * 2, below = Math.sin(a0) < -0.05;
    this.phase = (this.phase + (dt * speed) / (below ? 300 : 1100)) % 1;           // nights pass faster than days
    const a = this.phase * Math.PI * 2, sun = this.sun.set(Math.cos(a) * 0.9, Math.sin(a) * 0.82, 0.38 * Math.cos(a) + 0.22).normalize();
    this.moon.set(-sun.x * 0.8 + 0.3, Math.max(0.25, -sun.y * 0.9 + 0.2), -sun.z + 0.2).normalize();
    const y = sun.y, day = smoothstep(-0.08, 0.3, y), gold = smoothstep(0.42, 0.02, Math.abs(y)) * smoothstep(-0.2, 0.0, y), night = (this.night = 1 - smoothstep(-0.16, 0.06, y)), D = this.dens;
    const U = this.U, L = this.light, at = this.atmo;
    U.uZenith.value.set(lerp(0.004, at.x * 0.42, day), lerp(0.007, at.y * 0.5, day), lerp(0.02, at.z * 0.62, day)).multiplyScalar(0.4 + 0.6 * D);
    const hz = U.uHorizon.value.set(lerp(0.014, 0.42 + 0.3 * at.x, day), lerp(0.02, 0.5 + 0.3 * at.y, day), lerp(0.045, 0.55 + 0.35 * at.z, day));
    hz.lerp(_c.set(1.0, 0.5, 0.24), gold * 0.72).multiplyScalar(0.45 + 0.55 * D);
    U.uSunCol.value.set(1.0, lerp(0.42, 0.95, smoothstep(0.0, 0.5, y)), lerp(0.16, 0.86, smoothstep(0.0, 0.5, y)));
    U.uSun.value.copy(sun); U.uMoon.value.copy(this.moon); U.uNight.value = night;
    U.uCloudLit.value.copy(U.uSunCol.value).multiplyScalar(1.15 * (0.15 + 0.85 * day)).addScaledVector(U.uZenith.value, 0.6).addScalar(0.02 * night);
    U.uCloudDark.value.copy(U.uHorizon.value).multiplyScalar(0.55).addScaledVector(U.uZenith.value, 0.4);
    // the one light everything shares: the sun by day, the moon by night
    const m = smoothstep(0.02, -0.12, y);
    L.uSunDir.value.copy(sun).lerp(this.moon, m).normalize();
    L.uSunColor.value.copy(U.uSunCol.value).multiplyScalar(2.5 * smoothstep(-0.04, 0.12, y)).lerp(_c.set(0.16, 0.24, 0.42), m);
    L.uSkyColor.value.copy(U.uZenith.value).multiplyScalar(0.9).addScaledVector(U.uHorizon.value, 0.28).addScalar(0.006);
    L.uGroundColor.value.copy(U.uHorizon.value).multiplyScalar(0.2).addScalar(0.004);
    L.uFogColor.value.copy(U.uHorizon.value).multiplyScalar(0.92); L.uFogSun.value.copy(U.uSunCol.value).multiplyScalar(0.9 * smoothstep(-0.1, 0.1, y)).addScaledVector(U.uHorizon.value, 0.3);
    L.uFogDensity.value = (0.00055 + 0.0005 * gold) * (0.5 + 0.7 * D); L.uNight.value = night;
    this.water.position.set(Math.round(camPos.x / 64) * 64, 0, Math.round(camPos.z / 64) * 64);
  }
  label() { const y = this.sun.y; return y < -0.1 ? 'night' : y < 0.02 ? (Math.cos(this.phase * 6.2832) > 0 ? 'first light' : 'dusk') : y < 0.3 ? (Math.cos(this.phase * 6.2832) > 0 ? 'morning' : 'golden hour') : 'high day'; }
}
const _c = new THREE.Vector3();
