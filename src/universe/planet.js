// A world seen from space: procedural continents, oceans with sun-glint, biomes, drifting cloud decks with shadows,
// polar ice, city lights on the night side, lava worlds, banded giants — wrapped in a scattering atmosphere that
// burns orange at the terminator and flares when you look sunward through the limb. One shader, driven by `look`
// descriptors from universe/model.js, shared by the orbit and system realms.

import * as THREE from 'three';
import { GLSL } from '../core/glsl.js';

const SURF_VERT = /* glsl */ `
varying vec3 vObj, vW, vN;
void main(){ vObj = normalize(position); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;

const SURF_FRAG = /* glsl */ `
${GLSL.snoise3}
${GLSL.fbm3}
uniform vec3 uSun, uSunColor, uOcean0, uOcean1, uLand0, uLand1, uLand2, uAtmo, uBand0, uBand1, uBand2;
uniform float uTime, uSea, uSnow, uCloud, uLights, uLava, uGas, uSeed, uAtmoDensity, uHue;
uniform int uOct;
varying vec3 vObj, vW, vN;

vec3 bump(vec3 pos, vec3 n, float h, float k){
  vec3 sx = dFdx(pos), sy = dFdy(pos); vec3 r1 = cross(sy, n), r2 = cross(n, sx); float det = dot(sx, r1);
  vec3 g = sign(det) * (dFdx(h) * r1 + dFdy(h) * r2);
  return normalize(abs(det) * n - k * g);
}
float clouds(vec3 p){
  vec3 q = p * 2.4 + vec3(uSeed * 0.37, 0.0, uTime * 0.012);
  q += 0.35 * vec3(snoise(q * 1.3 + 5.0), snoise(q * 1.3 - 9.0), snoise(q * 1.3 + 17.0));   // swirl
  float c = fbm(q, uOct - 1) * 0.5 + 0.5;
  c += 0.25 * (snoise(p * vec3(1.0, 5.0, 1.0) + uSeed) * 0.5);                               // zonal streaks
  float t0 = 0.93 - 0.62 * uCloud; return smoothstep(t0, t0 + 0.2, c);
}
void main(){
  vec3 Ns = normalize(vN), V = normalize(cameraPosition - vW), L = normalize(uSun), p = vObj;
  float ndls = dot(Ns, L), nv = max(dot(Ns, V), 0.0);
  vec3 col, emis = vec3(0.0); float spec = 0.0, ndl = ndls, cl = 0.0;
  if (uGas > 0.5) {
    // banded giant: zonal jets sheared by turbulence, with storms
    float warp = fbm(vec3(p.xz * 2.6, p.y * 5.0) + uSeed + vec3(uTime * 0.006, 0.0, 0.0), 4);
    float y = p.y + 0.055 * warp;
    float b = sin(y * 15.0 + uSeed) * 0.5 + 0.5, b2 = sin(y * 41.0 + 1.7 * uSeed) * 0.5 + 0.5;
    col = mix(uBand0, uBand1, smoothstep(0.2, 0.8, b)); col = mix(col, uBand2, 0.45 * smoothstep(0.55, 1.0, b2));
    col *= 0.82 + 0.3 * fbm(vec3(p.x * 9.0, y * 30.0, p.z * 9.0) + uSeed, 3);
    float storm = smoothstep(0.62, 0.9, snoise(vec3(p.xz * 3.0, y * 9.0) + 3.0 * uSeed)); col = mix(col, uBand1 * 1.25, storm * 0.5);
    ndl = ndls;
  } else {
    vec3 q = p * 1.55 + uSeed;
    q += 0.22 * vec3(snoise(q * 0.9 + 3.1), snoise(q * 0.9 - 7.7), snoise(q * 0.9 + 11.3));
    float h = fbm(q, uOct) * 0.9 + 0.42 * ridged(q * 2.2 + 4.0, uOct - 2) - 0.2;
    float land = h - uSea, lat = abs(p.y);
    float n2 = snoise(q * 6.0) * 0.5 + 0.5, moist = fbm(q * 2.3 + 23.0, 3) * 0.5 + 0.5;
    vec3 N = Ns;
    if (land > 0.0) {
      N = bump(vW, Ns, h, 11.0);
      float e = clamp(land * 1.6, 0.0, 1.0);
      col = mix(uLand0, uLand1, smoothstep(0.35, 0.72, 1.0 - moist + e * 0.5 + lat * 0.25));
      col = mix(col, uLand2, smoothstep(0.42, 0.8, e + 0.25 * n2));
      col *= 0.78 + 0.44 * n2;
      float snow = smoothstep(uSnow, uSnow + 0.09, lat + e * 0.55 + 0.1 * n2 - 0.05);
      col = mix(col, vec3(0.86, 0.9, 0.95), snow);
      if (uLava > 0.5) { float cr = pow(1.0 - abs(snoise(q * 4.2)), 12.0) + 0.35 * pow(1.0 - abs(snoise(q * 11.0 + 5.0)), 16.0); emis += vec3(1.0, 0.24, 0.04) * cr * 3.2 * (0.6 + 0.4 * sin(uTime * 0.7 + h * 20.0)); }
      // civilisation: clustered lights hugging coasts and lowlands
      float pop = smoothstep(0.05, 0.5, fbm(q * 3.1 + 40.0, 3)) * (1.0 - smoothstep(0.02, 0.5, e)) * (1.0 - snow);
      float lights = pop * smoothstep(0.35, 0.9, snoise(p * 85.0 + uSeed) * 0.6 + snoise(p * 240.0) * 0.4 + 0.42);
      emis += vec3(1.0, 0.7, 0.36) * lights * uLights * 4.2 * (1.0 - smoothstep(-0.16, 0.06, ndls));
    } else {
      float d = clamp(-land * 3.2, 0.0, 1.0);
      col = mix(uOcean1, uOcean0, smoothstep(0.0, 0.7, d));
      if (uSea > -0.5) { vec3 Hh = normalize(L + V); float nh = max(dot(Ns, Hh), 0.0); spec = (pow(nh, 260.0) * 3.0 + pow(nh, 40.0) * 0.07) * smoothstep(0.0, 0.1, ndls); }
      float ice = smoothstep(uSnow + 0.1, uSnow + 0.17, lat + 0.06 * n2); col = mix(col, vec3(0.82, 0.88, 0.94), ice); spec *= 1.0 - ice;
      if (uLava > 0.5) { emis += vec3(1.0, 0.3, 0.05) * (0.6 + 1.6 * pow(n2, 3.0)) * smoothstep(0.0, 0.5, d) * 1.6; col *= 0.3; }
    }
    ndl = dot(N, L);
    if (uCloud > 0.01) {
      cl = clouds(p);
      float sh = clouds(normalize(p + L * 0.035));                       // cloud shadows fall away from the sun
      col *= 1.0 - 0.45 * sh * smoothstep(0.0, 0.3, ndls);
      spec *= 1.0 - cl; emis *= 1.0 - 0.85 * cl;
    }
  }
  float day = smoothstep(-0.06, 0.32, ndl) * smoothstep(-0.12, 0.2, ndls);
  vec3 lit = col * (day * max(ndl * 0.92 + 0.08, 0.0) * uSunColor + vec3(0.0035, 0.0045, 0.007));   // a breath of moonlight on the night side
  lit += spec * uSunColor;
  if (cl > 0.0) {
    vec3 cc = mix(vec3(1.0, 0.46, 0.2), vec3(1.0), smoothstep(-0.02, 0.36, ndls)) * uSunColor * smoothstep(-0.14, 0.22, ndls) * (0.35 + 0.65 * max(ndls, 0.0));
    lit = mix(lit, cc * 0.95 + 0.002, cl * 0.92);
  }
  // aerial perspective: the atmosphere brightens toward the limb and reddens at the terminator
  float rim = pow(1.0 - nv, 2.6);
  vec3 sky = mix(vec3(1.0, 0.4, 0.15), uAtmo, smoothstep(-0.02, 0.42, ndls));
  lit += sky * uSunColor * (rim * 0.85 + 0.05) * smoothstep(-0.3, 0.28, ndls) * uAtmoDensity;
  gl_FragColor = vec4(lit + emis, 1.0);
}`;

const ATMO_VERT = /* glsl */ `varying vec3 vW, vN; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vN = normalize(mat3(modelMatrix) * normal); gl_Position = projectionMatrix * viewMatrix * w; }`;
const ATMO_FRAG = /* glsl */ `
uniform vec3 uSun, uSunColor, uAtmo; uniform float uAtmoDensity, uLimb;
varying vec3 vW, vN;
void main(){
  vec3 N = normalize(vN), V = normalize(cameraPosition - vW);
  float nv = dot(N, V);
  float halo = smoothstep(0.0, uLimb, nv) * (1.0 - smoothstep(uLimb, uLimb + 0.3, nv));
  halo = pow(halo, 1.8);
  float sun = dot(N, normalize(uSun));
  vec3 col = mix(vec3(1.0, 0.36, 0.12), uAtmo, smoothstep(-0.08, 0.42, sun));
  float fwd = pow(max(dot(-V, normalize(uSun)), 0.0), 7.0);                // looking sunward through the air
  float lit = smoothstep(-0.38, 0.3, sun);
  vec3 c = col * halo * lit * 1.05 + mix(vec3(1.0, 0.34, 0.1), vec3(1.0, 0.82, 0.6), fwd) * fwd * halo * smoothstep(-0.55, 0.05, sun) * 3.6;
  gl_FragColor = vec4(c * uSunColor * uAtmoDensity, 1.0);
}`;

const RING_VERT = /* glsl */ `varying vec3 vW; varying vec2 vP; void main(){ vP = position.xz; vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const RING_FRAG = /* glsl */ `
${GLSL.hash}
uniform vec3 uSun, uSunColor, uCenter, uTint; uniform float uR, uSeed;
varying vec3 vW; varying vec2 vP;
float n1(float x){ float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(hash11(i + uSeed), hash11(i + 1.0 + uSeed), f); }
void main(){
  float r = length(vP) / uR; if (r < 1.35 || r > 2.5) discard;
  float d = n1(r * 14.0) * 0.5 + n1(r * 47.0) * 0.3 + n1(r * 160.0) * 0.2;
  float a = smoothstep(1.35, 1.5, r) * (1.0 - smoothstep(2.3, 2.5, r)) * (0.25 + 0.75 * d);
  a *= 1.0 - 0.85 * smoothstep(0.02, 0.0, abs(r - 1.95) - 0.03);                    // a Cassini-like gap
  // the planet's shadow across the rings
  vec3 L = normalize(uSun), oc = vW - uCenter; float b = dot(oc, L); float c = dot(oc, oc) - uR * uR; float hh = b * b - c;
  float shadow = (hh > 0.0 && b < 0.0) ? 0.06 : 1.0;
  vec3 col = uTint * (0.55 + 0.6 * d) * uSunColor * shadow;
  gl_FragColor = vec4(col * a, a * 0.9);
}`;

const SUN_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uPower; varying vec2 vUv;
void main(){
  vec2 p = vUv * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard;
  float core = smoothstep(0.075, 0.062, r) * 60.0 + exp(-r * 26.0) * 16.0;
  float halo = pow(max(1.0 - r, 0.0), 4.0) * 0.5 + exp(-r * 6.0) * 0.6;
  vec2 a = abs(p); float spikes = exp(-a.y * 70.0) * exp(-a.x * 3.2) + exp(-a.x * 70.0) * exp(-a.y * 3.2);
  vec2 d = abs(vec2(p.x + p.y, p.x - p.y) * 0.7071); spikes += 0.4 * (exp(-d.y * 80.0) * exp(-d.x * 4.5) + exp(-d.x * 80.0) * exp(-d.y * 4.5));
  gl_FragColor = vec4(uColor * (core + halo + spikes * 1.3) * uPower * smoothstep(1.0, 0.7, r), 1.0);
}`;

/** A camera-facing sun: blinding core, soft corona, diffraction spikes. Depth-tested, so worlds eclipse it properly. */
export function createSun(color = [1, 0.93, 0.82], size = 150) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
    vertexShader: `varying vec2 vUv; uniform float uSize; void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0); mv.xy += (uv - 0.5) * uSize; gl_Position = projectionMatrix * mv; }`,
    fragmentShader: SUN_FRAG, uniforms: { uColor: { value: new THREE.Vector3(...color) }, uPower: { value: 1 }, uSize: { value: size } },
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
  }));
  m.frustumCulled = false; m.renderOrder = 6;
  return m;
}

export function createPlanet(quality, radius = 10) {
  const seg = quality.tier === 'low' ? 48 : 96;
  const v3 = () => ({ value: new THREE.Vector3() });
  const U = {
    uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Vector3(1, 0.96, 0.9) }, uTime: { value: 0 },
    uOcean0: v3(), uOcean1: v3(), uLand0: v3(), uLand1: v3(), uLand2: v3(), uAtmo: v3(), uBand0: v3(), uBand1: v3(), uBand2: v3(),
    uSea: { value: 0 }, uSnow: { value: 0.75 }, uCloud: { value: 0.5 }, uLights: { value: 1 }, uLava: { value: 0 }, uGas: { value: 0 }, uSeed: { value: 1 }, uAtmoDensity: { value: 1 }, uHue: { value: 0 },
    uOct: { value: quality.tier === 'low' ? 4 : quality.tier === 'mid' ? 5 : 6 }, uLimb: { value: 0.36 },
    uCenter: v3(), uTint: { value: new THREE.Vector3(0.8, 0.72, 0.6) }, uR: { value: radius },
  };
  const group = new THREE.Group();
  const spin = new THREE.Group(); group.add(spin);
  const surface = new THREE.Mesh(new THREE.SphereGeometry(radius, seg * 2, seg), new THREE.ShaderMaterial({ vertexShader: SURF_VERT, fragmentShader: SURF_FRAG, uniforms: U }));
  spin.add(surface);
  const ratio = 1.034; U.uLimb.value = Math.sqrt(1 - 1 / (ratio * ratio));
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(radius * ratio, seg * 2, seg), new THREE.ShaderMaterial({ vertexShader: ATMO_VERT, fragmentShader: ATMO_FRAG, uniforms: U, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
  atmo.renderOrder = 2; group.add(atmo);
  const ringGeo = new THREE.RingGeometry(radius * 1.3, radius * 2.55, 128, 1); ringGeo.rotateX(-Math.PI / 2);
  const rings = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({ vertexShader: RING_VERT, fragmentShader: RING_FRAG, uniforms: U, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  rings.renderOrder = 3; group.add(rings);

  return {
    group, spin, surface, atmo, rings, uniforms: U, radius, desc: null,
    configure(desc, star) {
      const k = desc.look; this.desc = desc;
      const set = (u, c) => u.value.fromArray(c);
      if (k.gas) { set(U.uBand0, k.bands[0]); set(U.uBand1, k.bands[1]); set(U.uBand2, k.bands[2]); U.uGas.value = 1; U.uCloud.value = 0; U.uLights.value = 0; U.uLava.value = 0; }
      else {
        U.uGas.value = 0; set(U.uOcean0, k.ocean[0]); set(U.uOcean1, k.ocean[1]); set(U.uLand0, k.land[0]); set(U.uLand1, k.land[1]); set(U.uLand2, k.land[2]);
        U.uSea.value = k.sea; U.uSnow.value = k.snow; U.uCloud.value = k.cloud; U.uLava.value = k.lava;
        U.uLights.value = k.lights * ({ cities: 1, spacefaring: 1.3, villages: 0.35, ruins: 0.04, none: 0 }[desc.civ] ?? 0);
      }
      set(U.uAtmo, k.atmo); U.uAtmoDensity.value = k.atmoDensity; U.uSeed.value = (desc.terrainSeed % 1000) * 0.137 + 1; U.uHue.value = desc.hue;
      if (star) U.uSunColor.value.set(0.55 + 0.45 * star.color[0], 0.55 + 0.45 * star.color[1], 0.55 + 0.45 * star.color[2]).multiplyScalar(1.15);
      rings.visible = !!desc.rings; atmo.visible = k.atmoDensity > 0.03;
      U.uTint.value.set(0.82, 0.74 + 0.1 * desc.hue, 0.62 - 0.1 * desc.hue);
      group.rotation.set(0, 0, 0); group.rotation.z = desc.tilt || 0;
    },
    /** sunDir: world-space unit vector toward the star */
    tick(time, sunDir) {
      U.uTime.value = time; U.uSun.value.copy(sunDir);
      spin.rotation.y = time * 0.012 / Math.max(0.3, this.desc?.day || 1);
      group.getWorldPosition(U.uCenter.value);
      const s = group.getWorldScale(_s).x; U.uR.value = radius * s;
    },
  };
}
const _s = new THREE.Vector3();

/** small airless moon */
export function createMoon(radius, tone = 0.5, seed = 1) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 20), new THREE.ShaderMaterial({
    vertexShader: SURF_VERT,
    fragmentShader: `${GLSL.snoise3}\n${GLSL.fbm3}\nuniform vec3 uSun, uSunColor; uniform float uTone, uSeed; varying vec3 vObj, vW, vN;
      void main(){ vec3 N = normalize(vN); float h = fbm(vObj * 3.0 + uSeed, 5); float cr = smoothstep(0.35, 0.6, snoise(vObj * 7.0 + uSeed));
        float ndl = max(dot(N, normalize(uSun)), 0.0); vec3 c = vec3(uTone) * (0.7 + 0.5 * h) * (1.0 - 0.3 * cr);
        gl_FragColor = vec4(c * ndl * uSunColor + 0.0015, 1.0); }`,
    uniforms: { uSun: { value: new THREE.Vector3(1, 0, 0) }, uSunColor: { value: new THREE.Vector3(1, 0.96, 0.9) }, uTone: { value: tone }, uSeed: { value: seed } },
  }));
}
