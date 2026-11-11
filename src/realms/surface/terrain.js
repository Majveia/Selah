// Planet surface: an endless, seeded height-field streamed in chunks around the traveller, with everything that
// lives on it — forests, stones, meadows, and settlements whose windows light up at dusk.

import * as THREE from 'three';
import { GLSL } from '../../core/glsl.js';
import { RNG, Noise, hashInts, clamp, smoothstep, lerp } from '../../core/rng.js';

export const CHUNK = 128, RES = 32;          // metres per chunk, quads per side (4 m)
const SITE = 900;                            // one possible settlement per SITE×SITE cell

// ---- lighting shared by every surface material ----------------------------------------------------------------
export const LIGHT_UNIFORMS = () => ({
  uSunDir: { value: new THREE.Vector3(0.5, 0.4, 0.3).normalize() }, uSunColor: { value: new THREE.Vector3(1.6, 1.3, 1.0) },
  uSkyColor: { value: new THREE.Vector3(0.2, 0.3, 0.5) }, uGroundColor: { value: new THREE.Vector3(0.1, 0.08, 0.06) },
  uFogColor: { value: new THREE.Vector3(0.5, 0.6, 0.7) }, uFogSun: { value: new THREE.Vector3(1.0, 0.7, 0.4) }, uFogDensity: { value: 0.0009 },
  uTime: { value: 0 }, uNight: { value: 0 }, uWind: { value: new THREE.Vector2(1, 0.3) },
});
export const LIGHT_GLSL = /* glsl */ `
uniform vec3 uSunDir, uSunColor, uSkyColor, uGroundColor, uFogColor, uFogSun; uniform float uFogDensity, uTime, uNight; uniform vec2 uWind;
${GLSL.snoise3}
float cloudShade(vec3 wp){ // slow shadows of drifting clouds dapple the land
  vec2 p = wp.xz * 0.0016 + uWind * uTime * 0.006;
  return mix(0.38, 1.0, smoothstep(-0.25, 0.35, snoise(vec3(p, 0.0)) + 0.5 * snoise(vec3(p * 2.3, 3.0))));
}
vec3 shade(vec3 albedo, vec3 N, vec3 wp, float ao){
  float ndl = dot(N, uSunDir);
  vec3 sun = uSunColor * max(ndl * 0.85 + 0.15, 0.0) * smoothstep(-0.06, 0.1, uSunDir.y) * cloudShade(wp);
  vec3 amb = mix(uGroundColor, uSkyColor, N.y * 0.5 + 0.5);
  return albedo * (sun + amb) * ao;
}
vec3 fogged(vec3 col, vec3 wp){
  vec3 v = wp - cameraPosition; float d = length(v); vec3 dir = v / max(d, 1e-3);
  float hf = exp(-max(wp.y, 0.0) * 0.004);                                  // haze pools in the lowlands
  float f = 1.0 - exp(-d * uFogDensity * (0.35 + 0.65 * hf));
  float s = pow(max(dot(dir, uSunDir), 0.0), 6.0);
  return mix(col, mix(uFogColor, uFogSun, s * 0.8), clamp(f, 0.0, 1.0));
}`;

const TERRAIN_VERT = /* glsl */ `varying vec3 vW, vN; void main(){ vW = (modelMatrix * vec4(position, 1.0)).xyz; vN = normal; gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0); }`;
const TERRAIN_FRAG = /* glsl */ `
${LIGHT_GLSL}
uniform vec3 uLand0, uLand1, uLand2, uSand; uniform float uSnowLine, uLava, uSea;
varying vec3 vW, vN;
void main(){
  vec3 N = normalize(vN); float h = vW.y, slope = 1.0 - N.y;
  float n1 = snoise(vec3(vW.xz * 0.011, 1.0)), n2 = snoise(vec3(vW.xz * 0.07, 5.0)), n3 = snoise(vec3(vW.xz * 0.9, 9.0));
  // close-up relief
  N = normalize(N + 0.16 * vec3(snoise(vec3(vW.xz * 0.55, 2.0)), 0.0, snoise(vec3(vW.xz * 0.55, 6.0))) * (0.4 + slope * 2.0));
  vec3 col = mix(uLand0, uLand1, smoothstep(-0.25, 0.45, n1 + 0.35 * n2 + h * 0.004));
  col *= 0.86 + 0.2 * n2 + 0.08 * n3;
  col = mix(col, uLand2 * (0.8 + 0.3 * n2), smoothstep(0.16, 0.36, slope + 0.05 * n3) );          // cliffs and scree
  col = mix(col, uLand2 * 1.1, smoothstep(140.0, 230.0, h + 30.0 * n1));                              // bare heights
  col = mix(col, vec3(0.9, 0.93, 0.98), smoothstep(uSnowLine, uSnowLine + 28.0, h + 24.0 * n1) * (1.0 - smoothstep(0.38, 0.6, slope)));
  if (uSea > -900.0) {
    col = mix(uSand * (0.9 + 0.15 * n3), col, smoothstep(1.2, 4.5, h + 1.5 * n2));                    // beaches
    col *= mix(0.55, 1.0, smoothstep(-0.2, 0.9, h));                                                 // wet sand
    float foam = smoothstep(0.34, 0.0, abs(h - 0.12 - 0.12 * sin(uTime * 0.9 + vW.x * 0.07 + vW.z * 0.05 + n2 * 3.0)));
    col = mix(col, vec3(0.95), foam * 0.75 * step(-0.5, h));
    col = mix(col, col * vec3(0.35, 0.55, 0.6), smoothstep(0.0, -5.0, h));                           // seabed dims with depth
  }
  vec3 lit = shade(col, N, vW, 1.0);
  if (uLava > 0.5) { float cr = pow(1.0 - abs(snoise(vec3(vW.xz * 0.02, 4.0))), 14.0) + 0.5 * pow(1.0 - abs(snoise(vec3(vW.xz * 0.07, 8.0))), 18.0); lit += vec3(1.0, 0.25, 0.04) * cr * 5.0 * (0.7 + 0.3 * sin(uTime + vW.x * 0.1)); }
  gl_FragColor = vec4(fogged(lit, vW), 1.0);
}`;

// instanced props (trees, stones, houses, towers): per-instance tint + emissive windows on buildings
const PROP_VERT = /* glsl */ `
uniform float uTime, uSway; uniform vec2 uWind;
attribute vec3 color; attribute vec3 aTint; attribute float aSeed;
varying vec3 vW, vN, vC, vL; varying float vSeed;
void main(){
  vec3 p = position; vL = position; vSeed = aSeed;
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  float k = uSway * color.g * smoothstep(0.5, 6.0, position.y);                 // foliage sways, trunks do not
  w.xz += k * uWind * (sin(uTime * 1.3 + w.x * 0.21 + w.z * 0.17 + aSeed * 6.0) * 0.22 + sin(uTime * 2.9 + w.x * 0.9) * 0.05);
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal); vC = color * aTint;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const PROP_FRAG = /* glsl */ `
${LIGHT_GLSL}
${GLSL.hash}
uniform float uWindows; uniform vec3 uGlow;
varying vec3 vW, vN, vC, vL; varying float vSeed;
void main(){
  vec3 N = normalize(vN);
  vec3 lit = shade(vC, N, vW, 0.82 + 0.18 * smoothstep(0.0, 3.0, vL.y));
  if (uWindows > 0.5 && abs(N.y) < 0.5) {                                        // lit windows after dusk
    vec2 g = vec2(dot(vL.xz, vec2(N.z, -N.x)) * 0.62 + vSeed * 13.0, vL.y * 0.55);
    vec2 c = fract(g) - 0.5; float on = step(0.45, hash12(floor(g) + vSeed * 91.0));
    float win = smoothstep(0.34, 0.28, abs(c.x)) * smoothstep(0.36, 0.28, abs(c.y)) * step(0.6, vL.y);
    lit += uGlow * win * on * (0.15 + 2.6 * uNight);
  }
  gl_FragColor = vec4(fogged(lit, vW), 1.0);
}`;

const GRASS_VERT = /* glsl */ `
uniform float uTime; uniform vec2 uWind; uniform vec3 uPlayer;
attribute vec3 aTint; attribute float aSeed;
varying vec3 vW, vC; varying float vH;
void main(){
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  float t = position.y;                                                         // 0 at the root, 1 at the tip
  float gust = sin(uTime * 1.7 + w.x * 0.35 + w.z * 0.27 + aSeed * 6.0) * 0.5 + sin(uTime * 0.6 + w.x * 0.05 + w.z * 0.08) * 0.8;
  w.xz += uWind * gust * 0.16 * t * t;
  vec2 away = w.xz - uPlayer.xz; float d = length(away);                          // blades part around your feet
  w.xz += normalize(away + 1e-4) * (1.0 - smoothstep(0.2, 1.3, d)) * 0.5 * t;
  vW = w.xyz; vH = t; vC = aTint;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const GRASS_FRAG = /* glsl */ `
${LIGHT_GLSL}
varying vec3 vW, vC; varying float vH;
void main(){ vec3 lit = shade(vC * (0.45 + 0.75 * vH), vec3(0.0, 1.0, 0.0), vW, 1.0) + vC * uSunColor * 0.12 * vH * vH; gl_FragColor = vec4(fogged(lit, vW), 1.0); }`;

function paint(geo, r, g, b) { const n = geo.attributes.position.count, c = new Float32Array(n * 3); for (let i = 0; i < n; i++) { c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b; } geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo; }
function merge(list) {
  let n = 0, ni = 0; for (const g of list) { n += g.attributes.position.count; ni += g.index.count; }
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3), idx = new Uint32Array(ni); let o = 0, oi = 0;
  for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); col.set(g.attributes.color.array, o * 3); for (let i = 0; i < g.index.count; i++) idx[oi + i] = g.index.array[i] + o; o += g.attributes.position.count; oi += g.index.count; }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.BufferAttribute(col, 3)); out.setIndex(new THREE.BufferAttribute(idx, 1)); return out;
}
// vertex colour: rgb = albedo, and green > 0.5 doubles as the "sways in the wind" mask for foliage
const GEO = {
  broadleaf() { const t = paint(new THREE.CylinderGeometry(0.16, 0.3, 3.2, 6).translate(0, 1.6, 0), 0.2, 0.12, 0.07); const a = paint(new THREE.IcosahedronGeometry(2.3, 1).scale(1, 0.85, 1).translate(0, 4.6, 0), 0.5, 0.8, 0.3); const b = paint(new THREE.IcosahedronGeometry(1.5, 1).translate(1.2, 3.7, 0.5), 0.45, 0.75, 0.28); return merge([t, a, b]); },
  conifer() { const t = paint(new THREE.CylinderGeometry(0.12, 0.26, 2.2, 6).translate(0, 1.1, 0), 0.18, 0.11, 0.07); const cs = [0, 1, 2].map((i) => paint(new THREE.ConeGeometry(1.9 - i * 0.45, 3.0, 7).translate(0, 2.8 + i * 1.7, 0), 0.3, 0.62 + i * 0.05, 0.3)); return merge([t, ...cs]); },
  spire() { return merge([paint(new THREE.ConeGeometry(1.2, 7, 5).translate(0, 3.5, 0), 0.9, 0.42, 0.7), paint(new THREE.ConeGeometry(0.7, 4, 5).translate(1.0, 2, 0.4), 0.8, 0.4, 0.65)]); },
  stone() { return paint(new THREE.IcosahedronGeometry(1, 1).scale(1.3, 0.8, 1), 0.62, 0.4, 0.58); },
  house() { const w = paint(new THREE.BoxGeometry(6, 4.4, 5).translate(0, 2.2, 0), 0.86, 0.45, 0.76); const r = paint(new THREE.ConeGeometry(4.9, 3.0, 4).rotateY(Math.PI / 4).scale(1, 1, 0.84).translate(0, 5.9, 0), 0.55, 0.25, 0.2); return merge([w, r]); },
  tower() { const w = paint(new THREE.BoxGeometry(5, 26, 5).translate(0, 13, 0), 0.78, 0.45, 0.8); const c = paint(new THREE.ConeGeometry(3.9, 5, 4).rotateY(Math.PI / 4).translate(0, 28.5, 0), 0.5, 0.3, 0.28); return merge([w, c]); },
  dome() { const w = paint(new THREE.CylinderGeometry(3.4, 3.8, 3.4, 10).translate(0, 1.7, 0), 0.85, 0.45, 0.68); const d = paint(new THREE.SphereGeometry(3.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 3.4, 0), 0.9, 0.45, 0.8); return merge([w, d]); },
  obelisk() { return merge([paint(new THREE.CylinderGeometry(0.9, 2.2, 34, 4).translate(0, 17, 0), 0.7, 0.42, 0.66), paint(new THREE.OctahedronGeometry(2.2).translate(0, 37, 0), 3.0, 0.45, 2.2)]); },
  blade() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, -0.3, 0.5, 0, 0.3, 0.5, 0, 0, 1, 0]), 3)); g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]); return g; },
};

/** One instanced draw call per prop type; chunks contribute and withdraw their instances. */
class Scatter {
  constructor(geo, mat, max) {
    this.mesh = new THREE.InstancedMesh(geo, mat, max); this.mesh.count = 0; this.mesh.frustumCulled = false; this.max = max;
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3); this.seed = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute('aTint', this.tint); geo.setAttribute('aSeed', this.seed);
    this.parts = new Map(); this.dirty = false;
  }
  set(key, m, t, s) { if (m.length) { this.parts.set(key, { m, t, s }); this.dirty = true; } }
  remove(key) { if (this.parts.delete(key)) this.dirty = true; }
  clear() { this.parts.clear(); this.dirty = true; }
  flush() {
    if (!this.dirty) return; this.dirty = false; let n = 0; const M = this.mesh.instanceMatrix.array;
    for (const p of this.parts.values()) { const c = Math.min(p.s.length, this.max - n); if (c <= 0) break; M.set(p.m.subarray(0, c * 16), n * 16); this.tint.array.set(p.t.subarray(0, c * 3), n * 3); this.seed.array.set(p.s.subarray(0, c), n); n += c; }
    this.mesh.count = n; this.mesh.instanceMatrix.needsUpdate = true; this.tint.needsUpdate = true; this.seed.needsUpdate = true;
  }
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _sc = new THREE.Vector3();
class Batch { // growable per-chunk instance list
  constructor() { this.m = []; this.t = []; this.s = []; }
  add(x, y, z, yaw, sx, sy, sz, r, g, b, seed, tilt = 0) { _e.set(tilt, yaw, 0); _q.setFromEuler(_e); _m.compose(_p.set(x, y, z), _q, _sc.set(sx, sy, sz)); for (let i = 0; i < 16; i++) this.m.push(_m.elements[i]); this.t.push(r, g, b); this.s.push(seed); }
  pack() { return [new Float32Array(this.m), new Float32Array(this.t), new Float32Array(this.s)]; }
}

export class World {
  /** desc: planet descriptor from universe/model.js; origin: {x,z} offset in metres chosen from the landing lat/lon */
  constructor(scene, quality, light) {
    this.scene = scene; this.quality = quality; this.light = light;
    this.radius = quality.tier === 'low' ? 4 : quality.tier === 'mid' ? 5 : quality.tier === 'high' ? 7 : 9;
    this.chunks = new Map(); this.queue = []; this.sites = new Map(); this.group = new THREE.Group(); scene.add(this.group);
    this.tU = { ...light, uLand0: { value: new THREE.Vector3() }, uLand1: { value: new THREE.Vector3() }, uLand2: { value: new THREE.Vector3() }, uSand: { value: new THREE.Vector3(0.62, 0.55, 0.4) }, uSnowLine: { value: 240 }, uLava: { value: 0 }, uSea: { value: 0 } };
    this.terrainMat = new THREE.ShaderMaterial({ vertexShader: TERRAIN_VERT, fragmentShader: TERRAIN_FRAG, uniforms: this.tU });
    const prop = (windows, sway, glow = [1, 0.72, 0.4]) => new THREE.ShaderMaterial({ vertexShader: PROP_VERT, fragmentShader: PROP_FRAG, uniforms: { ...light, uWindows: { value: windows }, uSway: { value: sway }, uGlow: { value: new THREE.Vector3(...glow) } } });
    this.glowMats = [];
    const big = quality.tier === 'low' ? 0.4 : 1;
    const S = (name, mat, max) => { const s = new Scatter(GEO[name](), mat, Math.round(max * big)); this.group.add(s.mesh); return s; };
    const bm = () => { const m = prop(1, 0); this.glowMats.push(m); return m; };
    this.sc = { broadleaf: S('broadleaf', prop(0, 1), 9000), conifer: S('conifer', prop(0, 0.6), 9000), spire: S('spire', prop(0, 0), 4000), stone: S('stone', prop(0, 0), 6000), house: S('house', bm(), 2500), tower: S('tower', bm(), 900), dome: S('dome', bm(), 2500), obelisk: S('obelisk', bm(), 200) };
    this.gU = { ...light, uPlayer: { value: new THREE.Vector3() } };
    this.grass = new Scatter(GEO.blade(), new THREE.ShaderMaterial({ vertexShader: GRASS_VERT, fragmentShader: GRASS_FRAG, uniforms: this.gU, side: THREE.DoubleSide }), quality.tier === 'low' ? 14000 : quality.tier === 'mid' ? 45000 : 110000);
    this.group.add(this.grass.mesh);
    this.grassPer = quality.tier === 'low' ? 1400 : quality.tier === 'mid' ? 4500 : 9000;
  }

  configure(desc, origin) {
    for (const c of this.chunks.values()) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    this.chunks.clear(); this.queue.length = 0; this.sites.clear(); for (const k in this.sc) this.sc[k].clear(); this.grass.clear();
    this.desc = desc; this.ox = origin.x; this.oz = origin.z;
    this.noise = new Noise(desc.terrainSeed); this.seed = desc.terrainSeed | 0;
    const k = desc.look, kind = desc.kind;
    this.P = {
      garden: { cont: 40, hills: 22, mtn: 210, bias: 9, dune: 0, flora: 1 }, ocean: { cont: 30, hills: 14, mtn: 120, bias: -8, dune: 0, flora: 0.8 },
      desert: { cont: 14, hills: 10, mtn: 240, bias: 30, dune: 9, flora: 0.12 }, ice: { cont: 26, hills: 16, mtn: 260, bias: 14, dune: 3, flora: 0.06 },
      lava: { cont: 20, hills: 18, mtn: 200, bias: 22, dune: 0, flora: 0 }, rock: { cont: 18, hills: 20, mtn: 230, bias: 30, dune: 0, flora: 0 },
    }[kind] || { cont: 40, hills: 22, mtn: 210, bias: 9, dune: 0, flora: 1 };
    this.hasSea = k.sea > -0.5 && kind !== 'lava';
    const U = this.tU; U.uLand0.value.fromArray(k.land[0]).multiplyScalar(1.5); U.uLand1.value.fromArray(k.land[1]).multiplyScalar(1.3); U.uLand2.value.fromArray(k.land[2]);
    U.uSnowLine.value = kind === 'ice' ? 30 : kind === 'desert' || kind === 'lava' ? 9999 : 200; U.uLava.value = k.lava; U.uSea.value = this.hasSea ? 0 : -999;
    if (kind === 'desert') U.uSand.value.fromArray(k.land[1]); else if (kind === 'ice') U.uSand.value.set(0.8, 0.86, 0.92); else U.uSand.value.set(0.62, 0.55, 0.4);
    const glow = desc.mood === 'neon' || desc.civ === 'spacefaring' ? [0.35, 0.9, 1.0] : [1, 0.72, 0.4];
    for (const m of this.glowMats) m.uniforms.uGlow.value.fromArray(glow);
    this.civ = { cities: 1, spacefaring: 1.2, villages: 0.45, ruins: 0.3, none: 0 }[desc.civ] ?? 0;
    this.tree = kind === 'desert' || kind === 'ice' ? 'spire' : null;
    this.flora = [k.land[0][0] * 2.2 + 0.05, k.land[0][1] * 2.4 + 0.08, k.land[0][2] * 2.2 + 0.03];
  }

  // ---- the ground ------------------------------------------------------------------------------------------
  rawHeight(x, z) {
    const n = this.noise, P = this.P; x += this.ox; z += this.oz;
    const cont = n.fbm2(x / 1900, z / 1900, 3);
    const mask = smoothstep(0.05, 0.6, n.simplex2(x / 2600 + 5, z / 2600 + 9) * 0.5 + 0.38 + cont * 0.35);
    let h = cont * P.cont + P.bias + n.fbm2(x / 260 + 31, z / 260 - 17, 4) * P.hills * (0.4 + 0.6 * mask + 0.3);
    if (mask > 0.001) h += Math.pow(n.ridged2(x / 620, z / 620, 5), 1.6) * P.mtn * mask;
    if (P.dune) h += (1 - Math.abs(n.simplex2(x / 90 + z / 300, z / 60))) * P.dune * (1 - mask);
    return h;
  }
  site(cx, cz) { // settlement candidate for a coarse cell (cached)
    const key = cx * 73856093 ^ cz * 19349663; let s = this.sites.get(key);
    if (s === undefined) {
      s = null;
      if (this.civ > 0) {
        const r = new RNG(hashInts(this.seed, cx, cz, 77));
        if (r.next() < 0.3 + 0.5 * this.civ || (cx === 0 && cz === 0)) {
          const x = (cx + 0.2 + 0.6 * r.next()) * SITE, z = (cz + 0.2 + 0.6 * r.next()) * SITE, h = this.rawHeight(x, z);
          const flat = Math.abs(this.rawHeight(x + 40, z) - h) + Math.abs(this.rawHeight(x, z + 40) - h);
          if (h > (this.hasSea ? 3 : -1e9) && h < 90 && flat < 16) s = { x, z, h, R: 55 + 90 * r.next() * this.civ, seed: r.int(1, 1e9), big: r.next() < 0.3 * this.civ, name: null };
        }
      }
      this.sites.set(key, s);
    }
    return s;
  }
  nearSites(x, z, fn) { const cx = Math.floor(x / SITE), cz = Math.floor(z / SITE); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const s = this.site(cx + i, cz + j); if (s) fn(s); } }
  height(x, z) {
    let h = this.rawHeight(x, z);
    if (this.civ > 0) this.nearSites(x, z, (s) => { const d = Math.hypot(x - s.x, z - s.z); if (d < s.R * 1.5) h = lerp(h, s.h, smoothstep(s.R * 1.5, s.R * 0.75, d)); }); // towns sit on terraces
    return h;
  }
  normal(x, z, out) { const e = 1.5; return out.set(this.height(x - e, z) - this.height(x + e, z), 2 * e, this.height(x, z - e) - this.height(x, z + e)).normalize(); }

  // ---- streaming ---------------------------------------------------------------------------------------------
  _build(cx, cz) {
    const n = RES + 1, x0 = cx * CHUNK, z0 = cz * CHUNK, st = CHUNK / RES, H = new Float32Array((n + 2) * (n + 2));
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) H[(j + 1) * (n + 2) + i + 1] = this.height(x0 + i * st, z0 + j * st);
    const pos = new Float32Array(n * n * 3), nor = new Float32Array(n * n * 3);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 3, c = (j + 1) * (n + 2) + i + 1;
      pos[o] = x0 + i * st; pos[o + 1] = H[c]; pos[o + 2] = z0 + j * st;
      const dx = H[c - 1] - H[c + 1], dz = H[c - (n + 2)] - H[c + (n + 2)], l = Math.hypot(dx, 2 * st, dz);
      nor[o] = dx / l; nor[o + 1] = (2 * st) / l; nor[o + 2] = dz / l;
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); geo.setIndex(World.index());
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + CHUNK / 2, 60, z0 + CHUNK / 2), CHUNK * 3);
    const mesh = new THREE.Mesh(geo, this.terrainMat); this.group.add(mesh);
    const key = `${cx},${cz}`, c = { mesh, cx, cz, key, grass: false }; this.chunks.set(key, c);
    this._populate(c, H, n, st);
    return c;
  }
  static index() {
    if (!World._idx) { const n = RES + 1, a = new Uint16Array(RES * RES * 6); let o = 0; for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) { const p = j * n + i; a[o++] = p; a[o++] = p + n; a[o++] = p + 1; a[o++] = p + 1; a[o++] = p + n; a[o++] = p + n + 1; } World._idx = new THREE.BufferAttribute(a, 1); }
    return World._idx;
  }
  _populate(c, H, n, st) {
    const r = new RNG(hashInts(this.seed, c.cx, c.cz, 5)), x0 = c.cx * CHUNK, z0 = c.cz * CHUNK, nz = this.noise, P = this.P;
    const hAt = (x, z) => { const fx = (x - x0) / st, fz = (z - z0) / st, i = Math.min(n - 2, Math.max(0, Math.floor(fx))), j = Math.min(n - 2, Math.max(0, Math.floor(fz))), u = fx - i, v = fz - j, a = (j + 1) * (n + 2) + i + 1; return (H[a] * (1 - u) + H[a + 1] * u) * (1 - v) + (H[a + n + 2] * (1 - u) + H[a + n + 3] * u) * v; };
    const B = { broadleaf: new Batch(), conifer: new Batch(), spire: new Batch(), stone: new Batch(), house: new Batch(), tower: new Batch(), dome: new Batch(), obelisk: new Batch() };
    const inTown = (x, z) => { let t = false; this.nearSites(x, z, (s) => { if (Math.hypot(x - s.x, z - s.z) < s.R * 1.15) t = true; }); return t; };
    // forests and stones
    const tries = Math.round(70 * Math.max(P.flora, 0.15));
    for (let i = 0; i < tries; i++) {
      const x = x0 + r.next() * CHUNK, z = z0 + r.next() * CHUNK, h = hAt(x, z); if (h < (this.hasSea ? 2.5 : -1e9) || inTown(x, z)) continue;
      const slope = Math.abs(hAt(x + 3, z) - h) + Math.abs(hAt(x, z + 3) - h); if (slope > 3.2) continue;
      const forest = nz.simplex2((x + this.ox) / 340, (z + this.oz) / 340) * 0.5 + 0.5; if (r.next() > forest * forest * 1.5 * P.flora + (P.flora < 0.3 ? 0.03 : 0)) continue;
      const s = r.float(0.75, 1.7), v = r.float(0.75, 1.15), yaw = r.next() * 6.28;
      if (this.tree === 'spire') B.spire.add(x, h - 0.3, z, yaw, s, s * r.float(0.8, 1.8), s, v * (this.desc.kind === 'ice' ? 0.75 : 1.0), v * (this.desc.kind === 'ice' ? 0.95 : 0.62), v * (this.desc.kind === 'ice' ? 1.1 : 0.45), r.next(), r.float(-0.12, 0.12));
      else if (h > 95 || nz.simplex2(x / 500, z / 500 + 40) > 0.25) B.conifer.add(x, h - 0.2, z, yaw, s, s * 1.15, s, this.flora[0] * v * 0.8, this.flora[1] * v * 0.85, this.flora[2] * v + 0.02, r.next());
      else B.broadleaf.add(x, h - 0.2, z, yaw, s, s, s, this.flora[0] * v + (r.next() < 0.06 ? 0.35 : 0), this.flora[1] * v, this.flora[2] * v, r.next());
    }
    for (let i = 0; i < 10; i++) { const x = x0 + r.next() * CHUNK, z = z0 + r.next() * CHUNK, h = hAt(x, z); if (h < -1 || inTown(x, z)) continue; const s = r.float(0.4, 2.6) * (r.next() < 0.08 ? 3 : 1), g = r.float(0.5, 0.95); B.stone.add(x, h - s * 0.25, z, r.next() * 6.28, s, s * r.float(0.6, 1.2), s, g * this.tU.uLand2.value.x * 2.2, g * this.tU.uLand2.value.y * 2.2, g * this.tU.uLand2.value.z * 2.2, r.next(), r.float(-0.3, 0.3)); }
    // settlements: rings of dwellings round a landmark, towers in the big ones
    this.nearSites(x0 + CHUNK / 2, z0 + CHUNK / 2, (s) => {
      const rs = new RNG(s.seed), count = Math.round((s.big ? 70 : 26) * (0.5 + this.civ * 0.6)), ruin = this.desc.civ === 'ruins';
      const style = this.desc.kind === 'desert' || this.desc.mood === 'dunes' ? 'dome' : 'house';
      if (s.x >= x0 && s.x < x0 + CHUNK && s.z >= z0 && s.z < z0 + CHUNK) B.obelisk.add(s.x, s.h - 0.5, s.z, rs.next(), 1, s.big ? 1.5 : 1, 1, 1, 1, 1, rs.next());
      for (let i = 0; i < count; i++) {
        const a = rs.next() * 6.28, d = 14 + Math.sqrt(rs.next()) * (s.R - 14), x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d, sc = rs.float(0.75, 1.35), tall = s.big && rs.next() < 0.3 && d < s.R * 0.6, tint = rs.float(0.7, 1.05), warm = rs.next(), seed = rs.next(), lean = ruin ? rs.float(-0.16, 0.16) : 0, gone = ruin && rs.next() < 0.45;
        if (x < x0 || x >= x0 + CHUNK || z < z0 || z >= z0 + CHUNK || gone) continue;
        const h = this.height(x, z), face = a + Math.PI / 2 + rs.float(-0.3, 0.3), col = [tint * (0.9 + 0.1 * warm), tint * (0.86 + 0.06 * warm), tint * 0.8];
        if (tall) B.tower.add(x, h - 0.4, z, face, sc, rs.float(0.6, 2.2) * (this.desc.civ === 'spacefaring' ? 1.7 : 1), sc, ...col, seed, lean);
        else B[style].add(x, h - 0.3, z, face, sc, sc * (ruin ? rs.float(0.4, 0.9) : 1), sc, ...col, seed, lean);
      }
    });
    for (const k in B) if (B[k].s.length) this.sc[k].set(c.key, ...B[k].pack());
    c.H = H; c.hAt = hAt;
  }
  _grass(c) {
    c.grass = true; if (this.P.flora < 0.25) return;
    const r = new RNG(hashInts(this.seed, c.cx, c.cz, 9)), B = new Batch(), x0 = c.cx * CHUNK, z0 = c.cz * CHUNK, nz = this.noise;
    for (let i = 0; i < this.grassPer; i++) {
      const x = x0 + r.next() * CHUNK, z = z0 + r.next() * CHUNK, h = c.hAt(x, z); if (h < 2.2 || h > 150) continue;
      const m = nz.simplex2((x + this.ox) / 60, (z + this.oz) / 60) * 0.5 + 0.5; if (r.next() > 0.25 + m) continue;
      const s = r.float(0.5, 1.25), fl = r.next() < 0.035, v = r.float(0.7, 1.2);
      B.add(x, h - 0.05, z, r.next() * 6.28, 0.12 * s + (fl ? 0.1 : 0), (0.55 + 0.7 * m) * s, 1, fl ? 1.6 : this.flora[0] * v * 1.2, fl ? 0.75 * r.next() + 0.3 : this.flora[1] * v * 1.25, fl ? 0.5 + r.next() : this.flora[2] * v, r.next());
    }
    this.grass.set(c.key, ...B.pack());
  }

  /** stream chunks around (x,z); budget = chunks built this frame */
  update(x, z, budget = 2) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK), R = this.radius;
    if (cx !== this._cx || cz !== this._cz) {
      this._cx = cx; this._cz = cz; this.queue.length = 0;
      for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) { if (i * i + j * j > R * R + 1) continue; const key = `${cx + i},${cz + j}`; if (!this.chunks.has(key)) this.queue.push([cx + i, cz + j, i * i + j * j]); }
      this.queue.sort((a, b) => b[2] - a[2]);
      for (const c of this.chunks.values()) {
        const d = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz));
        if (d > R + 1) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); this.chunks.delete(c.key); for (const k in this.sc) this.sc[k].remove(c.key); this.grass.remove(c.key); }
        else if (d > 1 && c.grass) { this.grass.remove(c.key); c.grass = false; }
      }
    }
    while (budget-- > 0 && this.queue.length) { const [a, b] = this.queue.pop(); this._build(a, b); }
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) { const c = this.chunks.get(`${cx + i},${cz + j}`); if (c && !c.grass) this._grass(c); }
    for (const k in this.sc) this.sc[k].flush(); this.grass.flush();
    this.gU.uPlayer.value.set(x, 0, z);
    return this.queue.length;
  }
  /** nearest settlement to a point: { x, z, h, dist, name } | null */
  nearestSite(x, z) {
    let best = null; this.nearSites(x, z, (s) => { const d = Math.hypot(x - s.x, z - s.z); if (!best || d < best.dist) best = { ...s, dist: d, ref: s }; });
    return best;
  }
}
