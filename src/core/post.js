// HDR post pipeline tuned for OLED: scene-referred half-float rendering → threshold bloom (13-tap down / tent up,
// Karis-averaged so tiny stars don't flicker) → tone-map (AgX punchy | ACES) → display-space grade → CAS sharpening →
// luma-aware grain + dither that never lifts true black.
//
// Realms render into `post.sceneTarget` (MSAA, HalfFloat, linear). Brightness convention: 1.0 = paper white,
// anything above `bloomThreshold` glows. Keep empty space at exactly 0 so OLED pixels switch off.

import * as THREE from 'three';

export const POST_DEFAULTS = {
  exposure: 1.0,
  tonemap: 'agx',          // 'agx' | 'aces' | 'none'
  bloom: 0.85,             // additive strength
  bloomThreshold: 1.0, bloomKnee: 0.7, bloomRadius: 1.0, bloomScatter: 0.72,
  contrast: 1.0, saturation: 1.0,
  lift: [0, 0, 0], gain: [1, 1, 1],
  temperature: 0,          // -1 (cool) .. +1 (warm)
  vignette: 0.22,
  ca: 0.0,                 // chromatic aberration at the frame edge (0..1, keep ≤ 0.25)
  grain: 0.018,
  sharpen: 0.4,            // CAS amount 0..1
  fade: 1.0,               // global multiplier (cinematic fades)
  flash: 0.0,              // additive scene-referred white (big bang)
};

const VERT = /* glsl */ `
in vec3 position; out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const triGeo = new THREE.BufferGeometry();
triGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
const passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

/** A fullscreen fragment pass. Shader must declare `out vec4 fragColor;` and may read `in vec2 vUv;`. */
export class FullscreenPass {
  constructor(fragmentShader, uniforms = {}, opts = {}) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT,
      fragmentShader: `precision highp float; precision highp sampler2D;\n${fragmentShader}`,
      uniforms, depthTest: false, depthWrite: false, blending: opts.blending ?? THREE.NoBlending, transparent: !!opts.transparent,
    });
    this.mesh = new THREE.Mesh(triGeo, this.material); this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.mesh);
    this.uniforms = this.material.uniforms;
  }
  render(renderer, target = null) {
    const prev = renderer.autoClear; renderer.autoClear = false;
    renderer.setRenderTarget(target); renderer.render(this.scene, passCam);
    renderer.autoClear = prev;
  }
  dispose() { this.material.dispose(); }
}

const FRAG_DOWN = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uFirst, uThreshold, uKnee;
in vec2 vUv; out vec4 fragColor;
vec3 s(vec2 o){ return texture(tSrc, vUv + o * uTexel).rgb; }
float kw(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
void main(){
  vec3 a = s(vec2(-2., 2.)), b = s(vec2(0., 2.)), c = s(vec2(2., 2.));
  vec3 d = s(vec2(-2., 0.)), e = s(vec2(0., 0.)), f = s(vec2(2., 0.));
  vec3 g = s(vec2(-2.,-2.)), h = s(vec2(0.,-2.)), i = s(vec2(2.,-2.));
  vec3 j = s(vec2(-1., 1.)), k = s(vec2(1., 1.)), l = s(vec2(-1.,-1.)), m = s(vec2(1.,-1.));
  vec3 col;
  if (uFirst > 0.5) {
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = kw(g0) * 0.125, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    col = clamp(col, 0.0, 96.0);
    float br = max(col.r, max(col.g, col.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee); soft = soft * soft / (4.0 * uKnee + 1e-5);
    col *= max(soft, br - uThreshold) / max(br, 1e-5);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  fragColor = vec4(col, 1.0);
}`;

const FRAG_UP = /* glsl */ `
uniform sampler2D tLow, tHigh; uniform vec2 uTexel; uniform float uRadius, uScatter;
in vec2 vUv; out vec4 fragColor;
void main(){
  vec2 o = uTexel * uRadius;
  vec3 up = texture(tLow, vUv).rgb * 4.0;
  up += (texture(tLow, vUv + vec2(o.x, 0.)).rgb + texture(tLow, vUv - vec2(o.x, 0.)).rgb + texture(tLow, vUv + vec2(0., o.y)).rgb + texture(tLow, vUv - vec2(0., o.y)).rgb) * 2.0;
  up += texture(tLow, vUv + o).rgb + texture(tLow, vUv - o).rgb + texture(tLow, vUv + vec2(o.x, -o.y)).rgb + texture(tLow, vUv + vec2(-o.x, o.y)).rgb;
  up *= 1.0 / 16.0;
  fragColor = vec4(mix(texture(tHigh, vUv).rgb, up, uScatter), 1.0);
}`;

// Realm-to-realm transition: 'dive' (old scene rushes outward, the new one grows out of the centre),
// 'rise' (the reverse) and plain 'fade'.
const FRAG_MIX = /* glsl */ `
uniform sampler2D tA, tB; uniform float uT; uniform int uType; uniform vec2 uCenter;
in vec2 vUv; out vec4 fragColor;
vec3 zoomBlur(sampler2D tex, float scale, float blur){
  vec2 c = vUv - uCenter; vec3 acc = vec3(0.0); float ws = 0.0;
  for (int i = 0; i < 14; i++) {
    float f = float(i) / 13.0; float sc = scale * (1.0 + blur * (f - 0.5));
    vec2 uv = uCenter + c * sc;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float w = 1.0 - abs(f - 0.5); acc += texture(tex, uv).rgb * inside * w; ws += w;
  }
  return acc / ws;
}
void main(){
  float t = clamp(uT, 0.0, 1.0);
  if (uType == 0) { fragColor = vec4(mix(texture(tA, vUv).rgb, texture(tB, vUv).rgb, smoothstep(0.0, 1.0, t)), 1.0); return; }
  float e = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  float speed = 30.0 * t * t * (1.0 - t) * (1.0 - t);          // d(e)/dt, peaks mid-way
  vec3 a, b; float fa, fb;
  if (uType == 1) {            // dive
    a = zoomBlur(tA, 1.0 / (1.0 + 5.0 * e * e), speed * 0.22);
    b = zoomBlur(tB, 1.0 + 3.4 * (1.0 - e) * (1.0 - e), speed * 0.16);
  } else {                     // rise
    a = zoomBlur(tA, 1.0 + 4.2 * e * e, speed * 0.16);
    b = zoomBlur(tB, 1.0 / (1.0 + 3.0 * (1.0 - e) * (1.0 - e)), speed * 0.22);
  }
  fa = 1.0 - smoothstep(0.25, 0.72, t); fb = smoothstep(0.3, 0.8, t);
  vec3 col = a * fa + b * fb;
  col *= 1.0 + 0.6 * speed / 1.875;                             // a breath of extra light at peak velocity
  fragColor = vec4(col, 1.0);
}`;

const FRAG_COMPOSITE = /* glsl */ `
uniform sampler2D tScene, tBloom;
uniform float uBloom, uExposure, uContrast, uSaturation, uVignette, uCA, uFade, uFlash, uAspect;
uniform int uTonemap; uniform vec3 uLift, uGain, uWB;
in vec2 vUv; out vec4 fragColor;

vec3 agxContrast(vec3 x){ vec3 x2 = x * x, x4 = x2 * x2; return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
vec3 agx(vec3 v){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float minEv = -12.47393, maxEv = 4.026069;
  v = m * v; v = clamp(log2(max(v, 1e-10)), minEv, maxEv); v = (v - minEv) / (maxEv - minEv);
  v = agxContrast(v);
  // "punchy" look
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722)); v = pow(max(v, 0.0), vec3(1.35)); v = l + 1.4 * (v - l);
  v = mi * v;
  return clamp(v, 0.0, 1.0);   // display-referred (≈ sRGB encoded)
}
vec3 aces(vec3 x){ // Narkowicz fit, returns linear
  x *= 0.6; return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }

void main(){
  vec2 c = vUv - 0.5;
  vec3 col;
  if (uCA > 0.0005) {
    vec2 d = c * dot(c, c) * uCA * 0.06;
    col = vec3(texture(tScene, vUv + d).r, texture(tScene, vUv).g, texture(tScene, vUv - d).b);
    col += vec3(texture(tBloom, vUv + d).r, texture(tBloom, vUv).g, texture(tBloom, vUv - d).b) * uBloom;
  } else {
    col = texture(tScene, vUv).rgb + texture(tBloom, vUv).rgb * uBloom;
  }
  if (any(isnan(col))) col = vec3(0.0);
  col = max(col, 0.0) * uExposure * uWB + uFlash;
  if (uTonemap == 0) col = agx(col);
  else if (uTonemap == 1) col = toSRGB(aces(col));
  else col = toSRGB(clamp(col, 0.0, 1.0));
  // display-space grade
  col = col * uGain + uLift * (1.0 - col);
  col = (col - 0.5) * uContrast + 0.5;
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = l + (col - l) * uSaturation;
  vec2 vc = c * vec2(mix(1.0, uAspect, 0.35), 1.0);
  float v = smoothstep(0.25, 1.05, length(vc) * 1.35);
  col *= 1.0 - uVignette * v * v;
  fragColor = vec4(max(col, 0.0) * uFade, 1.0);
}`;

const FRAG_PRESENT = /* glsl */ `
uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uSharpen, uGrain, uTime;
in vec2 vUv; out vec4 fragColor;
float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main(){
  vec3 c = texture(tSrc, vUv).rgb;
  if (uSharpen > 0.001) { // AMD FidelityFX CAS (compact form)
    vec3 a = texture(tSrc, vUv + vec2(0.0, -uTexel.y)).rgb, b = texture(tSrc, vUv + vec2(-uTexel.x, 0.0)).rgb;
    vec3 d = texture(tSrc, vUv + vec2(uTexel.x, 0.0)).rgb, e = texture(tSrc, vUv + vec2(0.0, uTexel.y)).rgb;
    vec3 mn = min(min(min(a, b), min(d, e)), c), mx = max(max(max(a, b), max(d, e)), c);
    vec3 amp = sqrt(clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0));
    vec3 w = amp * (-1.0 / mix(8.0, 5.0, uSharpen));
    c = clamp((c + (a + b + d + e) * w) / (1.0 + 4.0 * w), 0.0, 1.0);
  }
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec2 px = gl_FragCoord.xy;
  // film grain: stronger in mid-tones, absent in true black so OLED pixels stay off
  float n = h12(px + fract(uTime * 7.13) * 311.7) - 0.5;
  c += n * uGrain * smoothstep(0.0, 0.06, l) * (1.0 - 0.6 * l);
  // triangular-pdf dither against banding (again: never on pure black)
  float d1 = h12(px * 1.37 + fract(uTime) * 91.3), d2 = h12(px * 0.73 + 17.0 + fract(uTime * 1.7) * 53.1);
  c += (d1 + d2 - 1.0) / 255.0 * smoothstep(0.0, 1.5 / 255.0, l);
  fragColor = vec4(max(c, 0.0), 1.0);
}`;

const TONEMAPS = { agx: 0, aces: 1, none: 2 };
const TRANSITIONS = { fade: 0, dive: 1, rise: 2 };

export class PostPipeline {
  constructor(renderer, quality) {
    this.renderer = renderer; this.quality = quality;
    this.width = 2; this.height = 2; this.displayWidth = 2; this.displayHeight = 2;
    this.time = 0;
    const hdr = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false, ...o,
    });
    this._hdr = hdr;
    this.sceneTarget = hdr(2, 2, { depthBuffer: true, samples: quality.msaa });
    this.sceneTargetB = null;       // allocated lazily for transitions
    this.mixTarget = hdr(2, 2);
    this.ldrTarget = hdr(2, 2);
    this.mips = []; this.ups = [];
    for (let i = 0; i < quality.bloomMips; i++) { this.mips.push(hdr(2, 2)); this.ups.push(hdr(2, 2)); }

    this.down = new FullscreenPass(FRAG_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } });
    this.up = new FullscreenPass(FRAG_UP, { tLow: { value: null }, tHigh: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1 }, uScatter: { value: 0.7 } });
    this.mix = new FullscreenPass(FRAG_MIX, { tA: { value: null }, tB: { value: null }, uT: { value: 0 }, uType: { value: 0 }, uCenter: { value: new THREE.Vector2(0.5, 0.5) } });
    this.composite = new FullscreenPass(FRAG_COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null }, uBloom: { value: 1 }, uExposure: { value: 1 }, uContrast: { value: 1 }, uSaturation: { value: 1 },
      uVignette: { value: 0.2 }, uCA: { value: 0 }, uFade: { value: 1 }, uFlash: { value: 0 }, uAspect: { value: 1 }, uTonemap: { value: 0 },
      uLift: { value: new THREE.Vector3() }, uGain: { value: new THREE.Vector3(1, 1, 1) }, uWB: { value: new THREE.Vector3(1, 1, 1) },
    });
    this.present = new FullscreenPass(FRAG_PRESENT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uSharpen: { value: 0.4 }, uGrain: { value: 0.02 }, uTime: { value: 0 } });
    this.settings = { ...POST_DEFAULTS };
    // global overrides the director animates (multiplied/added on top of realm settings)
    this.master = { fade: 1, flash: 0, exposure: 1 };
  }

  /** w,h: internal render size in physical pixels; dw,dh: canvas drawing-buffer size */
  setSize(w, h, dw, dh) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    this.displayWidth = dw; this.displayHeight = dh;
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    this.sceneTarget.setSize(w, h); this.sceneTargetB?.setSize(w, h); this.mixTarget.setSize(w, h); this.ldrTarget.setSize(w, h);
    let mw = w, mh = h;
    for (let i = 0; i < this.mips.length; i++) {
      mw = Math.max(2, Math.floor(mw / 2)); mh = Math.max(2, Math.floor(mh / 2));
      this.mips[i].setSize(mw, mh); this.ups[i].setSize(mw, mh);
    }
  }

  _drawRealm(realm, target, dt) {
    const r = this.renderer;
    if (typeof realm.render === 'function') { realm.render(r, target, this, dt); return; }
    r.setRenderTarget(target); r.setClearColor(0x000000, 1); r.clear(true, true, true);
    r.render(realm.scene, realm.camera);
  }

  static blend(a, b, t) {
    const out = {};
    for (const k in POST_DEFAULTS) {
      const va = a[k] ?? POST_DEFAULTS[k], vb = b[k] ?? POST_DEFAULTS[k];
      if (typeof va === 'number') out[k] = va + (vb - va) * t;
      else if (Array.isArray(va)) out[k] = va.map((x, i) => x + (vb[i] - x) * t);
      else out[k] = t < 0.5 ? va : vb;
    }
    return out;
  }

  /** Render one frame. `transition` = { to: realm, t: 0..1, type: 'dive'|'rise'|'fade', center?: [x,y] } or null. */
  render(realm, dt, transition = null) {
    const r = this.renderer; this.time += dt;
    let s = { ...POST_DEFAULTS, ...(realm.post || {}) };
    this._drawRealm(realm, this.sceneTarget, dt);
    let sceneTex = this.sceneTarget.texture;
    if (transition && transition.to) {
      if (!this.sceneTargetB) { this.sceneTargetB = this._hdr(this.width, this.height, { depthBuffer: true, samples: this.quality.msaa }); }
      this._drawRealm(transition.to, this.sceneTargetB, dt);
      const u = this.mix.uniforms;
      u.tA.value = this.sceneTarget.texture; u.tB.value = this.sceneTargetB.texture; u.uT.value = transition.t;
      u.uType.value = TRANSITIONS[transition.type] ?? 0;
      if (transition.center) u.uCenter.value.set(transition.center[0], transition.center[1]); else u.uCenter.value.set(0.5, 0.5);
      this.mix.render(r, this.mixTarget);
      sceneTex = this.mixTarget.texture;
      s = PostPipeline.blend(s, { ...POST_DEFAULTS, ...(transition.to.post || {}) }, transition.t);
    }
    this.settings = s;

    // ---- bloom ----
    const d = this.down.uniforms; let src = sceneTex, sw = this.width, sh = this.height;
    d.uThreshold.value = s.bloomThreshold; d.uKnee.value = s.bloomKnee;
    for (let i = 0; i < this.mips.length; i++) {
      d.tSrc.value = src; d.uTexel.value.set(1 / sw, 1 / sh); d.uFirst.value = i === 0 ? 1 : 0;
      this.down.render(r, this.mips[i]);
      src = this.mips[i].texture; sw = this.mips[i].width; sh = this.mips[i].height;
    }
    const u = this.up.uniforms; u.uRadius.value = s.bloomRadius; u.uScatter.value = s.bloomScatter;
    let low = this.mips[this.mips.length - 1];
    for (let i = this.mips.length - 2; i >= 0; i--) {
      u.tLow.value = low.texture; u.tHigh.value = this.mips[i].texture; u.uTexel.value.set(1 / low.width, 1 / low.height);
      this.up.render(r, this.ups[i]); low = this.ups[i];
    }

    // ---- composite + tonemap + grade ----
    const c = this.composite.uniforms;
    c.tScene.value = sceneTex; c.tBloom.value = low.texture; c.uBloom.value = s.bloom;
    c.uExposure.value = s.exposure * this.master.exposure; c.uContrast.value = s.contrast; c.uSaturation.value = s.saturation;
    c.uVignette.value = s.vignette; c.uCA.value = s.ca; c.uFade.value = s.fade * this.master.fade; c.uFlash.value = s.flash + this.master.flash;
    c.uAspect.value = this.width / this.height; c.uTonemap.value = TONEMAPS[s.tonemap] ?? 0;
    c.uLift.value.fromArray(s.lift); c.uGain.value.fromArray(s.gain);
    const tK = s.temperature; c.uWB.value.set(1 + 0.12 * tK, 1.0, 1 - 0.14 * tK);
    this.composite.render(r, this.ldrTarget);

    // ---- present (sharpen, grain, dither) ----
    const p = this.present.uniforms;
    p.tSrc.value = this.ldrTarget.texture; p.uTexel.value.set(1 / this.width, 1 / this.height);
    p.uSharpen.value = s.sharpen; p.uGrain.value = s.grain; p.uTime.value = this.time;
    r.setRenderTarget(null); r.setViewport(0, 0, this.displayWidth, this.displayHeight);
    this.present.render(r, null);
  }

  dispose() {
    [this.sceneTarget, this.sceneTargetB, this.mixTarget, this.ldrTarget, ...this.mips, ...this.ups].forEach((t) => t && t.dispose());
    [this.down, this.up, this.mix, this.composite, this.present].forEach((p) => p.dispose());
  }
}
