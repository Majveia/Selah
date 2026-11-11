// A star and its worlds. Orbits follow Kepler's third law (P² ∝ a³/M); distances are log-compressed so the inner
// rocks and the far giants share one view. Double-tap a world to fall toward it.

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { OrbitRig } from '../../core/controls.js';
import { createStarfield } from '../../core/stars.js';
import { createPlanet, createSun } from '../../universe/planet.js';
import { systemFromSeed, STAR_LABEL } from '../../universe/model.js';
import { RNG } from '../../core/rng.js';

const rVis = (a) => 9 + 12.5 * Math.log2(1 + a / 0.28);         // AU → world units
const aOf = (r) => 0.28 * (Math.pow(2, (r - 9) / 12.5) - 1);

export default class SystemRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.05, 6000);
    this.post = { bloom: 1.0, bloomThreshold: 1.0, bloomKnee: 0.7, bloomScatter: 0.78, exposure: 1.0, saturation: 1.08, vignette: 0.3, grain: 0.012, sharpen: 0.5, ca: 0.08 };
    this.worlds = []; this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._hover = -1; this.t0 = 0;
  }

  async init() {
    const q = this.app.quality;
    this.stars = createStarfield({ count: q.tier === 'low' ? 1500 : 5000, seed: 'system:stars', radius: 3000, band: { normal: [0.2, 1, 0.35], strength: 1.2 }, brightness: 0.8 });
    this.stars.material.depthTest = true; this.scene.add(this.stars);
    this.sun = createSun([1, 0.93, 0.82], 34); this.scene.add(this.sun);
    this.pool = []; for (let i = 0; i < 8; i++) { const p = createPlanet(q, 10); p.group.visible = false; this.scene.add(p.group); this.pool.push(p); }
    this.orbits = new THREE.Group(); this.scene.add(this.orbits);
    // asteroid belt
    const n = q.tier === 'low' ? 1200 : 5000, rng = new RNG('belt'), pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = rng.gauss(0, 0.045); pos[i * 3 + 1] = rng.next() * Math.PI * 2; pos[i * 3 + 2] = rng.gauss(0, 0.25); }
    const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.beltU = { uR: { value: 30 }, uTime: { value: 0 }, uPixelRatio: { value: 1 } };
    this.belt = new THREE.Points(bg, new THREE.ShaderMaterial({
      uniforms: this.beltU, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
      vertexShader: `uniform float uR, uTime, uPixelRatio; varying float vB; void main(){ float r = uR * (1.0 + position.x); float a = position.y + uTime * 0.02 / (1.0 + position.x * 2.0); vec4 mv = modelViewMatrix * vec4(r * cos(a), position.z, r * sin(a), 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = 1.5 * uPixelRatio; vB = 0.25 + 0.5 * fract(position.y * 91.7); }`,
      fragmentShader: `varying float vB; void main(){ gl_FragColor = vec4(vec3(0.75, 0.68, 0.6) * vB * 0.5, 1.0); }`,
    }));
    this.belt.frustumCulled = false; this.scene.add(this.belt);
    this.rig = new OrbitRig(this.camera, this.app.input, { distance: 95, minDistance: 3.2, maxDistance: 260, yaw: 0.5, pitch: 0.42, idleSpin: 0.006, smooth: 0.1 });
    this.rig.onZoomOutLimit = () => this.app.ascend();
    this.rig.onZoomInLimit = () => { if (this._focus >= 0) this._enter(this._focus); };
  }

  enter(params = {}) {
    const fresh = !params.returning || !this.sys || this.sys.seed !== (params.seed ?? this.sys.seed);
    if (fresh) {
      const sys = (this.sys = systemFromSeed(params.seed ?? 'home'));
      this.t0 = new RNG(sys.seed).float(0, 1000);
      this.sun.material.uniforms.uColor.value.set(0.45 + 0.55 * sys.star.color[0], 0.45 + 0.55 * sys.star.color[1], 0.45 + 0.55 * sys.star.color[2]);
      this.sun.material.uniforms.uSize.value = 26 + 9 * Math.log2(1 + sys.star.radius);
      this.orbits.clear(); this.worlds = [];
      sys.planets.slice(0, 8).forEach((d, i) => {
        const p = this.pool[i]; p.configure(d, sys.star);
        const s = ((0.36 + 0.3 * Math.log2(1 + d.radius)) * 1.55) / 10; p.group.scale.setScalar(s); p.group.visible = true;
        const r = rVis(d.a);
        const pts = []; for (let k = 0; k <= 160; k++) { const a = (k / 160) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)); }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x8fa2c8, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }));
        this.orbits.add(line);
        this.worlds.push({ d, p, r, size: s * 10 });
      });
      for (let i = sys.planets.length; i < 8; i++) this.pool[i].group.visible = false;
      this.belt.visible = !!sys.belt; if (sys.belt) this.beltU.uR.value = rVis(sys.belt.a);
    }
    this._off = [this.app.input.on('doubletap', (t) => { const i = this._pick(t.x, t.y, 60); if (i >= 0) this._enter(i); })];
    this._focus = -1;
    if (params.returning && this._lastIdx != null && this.worlds[this._lastIdx]) {
      this._place(this.app.time); const w = this.worlds[this._lastIdx];
      this.rig.set({ target: w.p.group.position.clone(), distance: w.size * 4 }); this.rig.flyTo({ target: new THREE.Vector3(), distance: 95 }, 3.4, { ease: 'inOut', interruptible: true });
    } else { this.rig.set({ target: new THREE.Vector3(), distance: 3.4, yaw: 0.5, pitch: 0.42 }); this.rig.flyTo({ distance: 95 }, 3.2, { ease: 'out', interruptible: true }); }
  }
  exit() { this._off?.forEach((f) => f()); this._off = null; this.app.hud?.setTag(null); }

  _place(time) {
    for (const w of this.worlds) {
      const a = w.d.phase + ((this.t0 + time) * 0.045) / w.d.period;       // Kepler: angular rate ∝ 1/P
      w.p.group.position.set(Math.cos(a) * w.r, 0, Math.sin(a) * w.r);
      w.p.tick(time, this._s.copy(w.p.group.position).multiplyScalar(-1).normalize());
    }
  }
  _pick(x, y, radius) {
    const vp = this.app.viewport; let best = -1, bd = radius;
    this.worlds.forEach((w, i) => { const p = this._p.copy(w.p.group.position).project(this.camera); if (p.z > 1) return; const d = Math.hypot((p.x * 0.5 + 0.5) * vp.cssWidth - x, (-p.y * 0.5 + 0.5) * vp.cssHeight - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  async _enter(i) {
    if (this.app.travelling || this.rig.flying) return;
    const w = this.worlds[i]; this._lastIdx = i; this.app.hud?.setTag(null);
    const follow = this.app.addUpdater(() => this.rig._flight && this.rig._flight.to.target.copy(w.p.group.position));
    await this.rig.flyTo({ target: w.p.group.position.clone(), distance: w.size * 3.2 }, 2.6, { ease: 'inOut' }); follow();
    const ok = await this.app.descend('orbit', { seed: this.sys.seed, planet: i }, { duration: 2.4 });
    if (!ok) this.rig.flyTo({ target: new THREE.Vector3(), distance: 95 }, 2.4, { ease: 'out', interruptible: true });
  }

  update(dt, time) {
    this._place(time);
    this.rig.update(dt);
    this.stars.tick(this.app); this.beltU.uTime.value = this.t0 + time; this.beltU.uPixelRatio.value = this.app.viewport.pixelRatio;
    const hud = this.app.hud, vp = this.app.viewport;
    if (hud && !this.app.travelling && !this.rig.flying) {
      const inp = this.app.input, i = inp.lastDevice === 'mouse' ? this._pick(inp.pointer.x, inp.pointer.y, 46) : this._pick(vp.cssWidth / 2, vp.cssHeight / 2, 120);
      this._focus = i;
      if (i >= 0) { const w = this.worlds[i], p = this._p.copy(w.p.group.position).project(this.camera); hud.setTag((p.x * 0.5 + 0.5) * vp.cssWidth, (-p.y * 0.5 + 0.5) * vp.cssHeight - 10, w.d.name, `${w.d.label} · ${w.d.a.toFixed(w.d.a < 10 ? 2 : 0)} AU`); }
      else hud.setTag(null);
    }
  }

  describe() {
    const s = this.sys?.star; if (!s) return { title: 'System' };
    const au = aOf(Math.max(9.01, this.rig.distance * Math.tan((this.camera.fov * Math.PI) / 360)));
    return { title: s.name, subtitle: `${STAR_LABEL[s.cls]} · ${Math.round(s.tempK / 100) * 100} K · ${this.sys.planets.length} worlds`, scale: `${au < 10 ? au.toFixed(1) : Math.round(au)} AU` };
  }
  hints(touch) { return touch ? 'drag to turn · pinch to zoom · double-tap a world to visit · pinch out for the galaxy' : 'drag to turn · scroll to zoom · double-click a world to visit · scroll out for the galaxy'; }
}
