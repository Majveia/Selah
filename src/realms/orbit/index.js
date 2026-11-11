// A world from orbit. Drag to circle it, fall toward it to land, pull away to see its whole system.
// Also stages the opening film's sunrise: low orbit over the night side, city lights below, the sun breaking the limb.

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { OrbitRig } from '../../core/controls.js';
import { createStarfield } from '../../core/stars.js';
import { createPlanet, createMoon, createSun } from '../../universe/planet.js';
import { systemFromSeed } from '../../universe/model.js';
import { clamp, smoothstep } from '../../core/rng.js';

const R = 10;
const CIV = { cities: 'cities glitter on its night side', spacefaring: 'a spacefaring civilisation', villages: 'scattered villages, first fires', ruins: 'ruins of someone long gone', none: '' };

export default class OrbitRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.05, 6000);
    this.post = { bloom: 1.0, bloomThreshold: 1.0, bloomKnee: 0.7, bloomScatter: 0.78, exposure: 1.05, saturation: 1.08, contrast: 1.05, vignette: 0.26, grain: 0.014, sharpen: 0.5, ca: 0.1 };
    this.sunDir = new THREE.Vector3(1, 0.1, 0.22).normalize();
    this._cine = null; this._ct = 0; this.moons = [];
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
  }

  async init() {
    const q = this.app.quality;
    this.stars = createStarfield({ count: q.tier === 'low' ? 1800 : 6000, seed: 'orbit:stars', radius: 3000, band: { normal: [0.25, 1, 0.3], strength: 1.2 }, brightness: 0.85 });
    this.stars.material.depthTest = true; this.scene.add(this.stars);
    this.sun = createSun([1, 0.93, 0.82], 900); this.sun.position.copy(this.sunDir).multiplyScalar(2600); this.scene.add(this.sun);
    this.planet = createPlanet(q, R); this.scene.add(this.planet.group);
    this.moonGroup = new THREE.Group(); this.scene.add(this.moonGroup);
    this.rig = new OrbitRig(this.camera, this.app.input, { distance: 32, minDistance: 12.4, maxDistance: 140, yaw: 2.4, pitch: 0.25, idleSpin: 0.008, smooth: 0.1 });
    this.rig.onZoomOutLimit = () => { if (!this._cine) this.app.ascend(); };
    this.rig.onZoomInLimit = () => this._land();
  }

  enter(params = {}) {
    const sys = (this.sys = systemFromSeed(params.seed ?? 'home'));
    const idx = (this.index = params.planet ?? Math.max(0, sys.planets.findIndex((p) => p.kind === 'garden')));
    const d = (this.desc = sys.planets[idx]);
    this.planet.configure(d, sys.star);
    this.sun.material.uniforms.uColor.value.set(0.5 + 0.5 * sys.star.color[0], 0.5 + 0.5 * sys.star.color[1], 0.5 + 0.5 * sys.star.color[2]);
    this.moonGroup.clear(); this.moons = [];
    for (const m of d.moons.slice(0, 3)) { const mesh = createMoon(R * m.radius, m.tone, m.phase * 10); this.moonGroup.add(mesh); this.moons.push({ mesh, m }); }
    this._off = [this.app.input.on('doubletap', () => { if (!this._cine && this.rig.distance < 40) this._land(); })];
    this._cine = params.cine === 'sunrise' ? { kind: 'sunrise', duration: 40, crest: 18 } : params.cine || null; this._ct = 0;
    if (params.returning && this._last) { this.rig.set({ distance: 12.6 }); this.rig.flyTo({ distance: this._last }, 3, { ease: 'out', interruptible: true }); }
    else if (params.distance) this.rig.set({ distance: params.distance, yaw: params.yaw ?? 2.4, pitch: params.pitch ?? 0.25 });
    else if (!this._cine) { this.rig.set({ distance: 90, yaw: 2.4, pitch: 0.2 }); this.rig.flyTo({ distance: 30 }, 3.2, { ease: 'out', interruptible: true }); }
  }
  exit() { this._off?.forEach((f) => f()); this._off = null; }
  endCine() { if (!this._cine) return; this._cine = null; this._handover(); }

  _handover() { // give the camera back to the rig exactly where the film left it
    const c = this.camera.position; const d = c.length();
    this.rig.set({ target: new THREE.Vector3(), distance: d, yaw: Math.atan2(c.x, c.z), pitch: Math.asin(clamp(c.y / d, -1, 1)) });
    this.rig.flyTo({ distance: 30 }, 5, { ease: 'out', interruptible: true });
  }

  async _land() {
    if (this._cine || this.app.travelling || this.rig.flying) return;
    if (this.desc.look.gas) { this.app.hud?.toast('no ground down there — only storms'); return; }
    // the point beneath the camera, in the planet's own rotating frame
    const local = this.planet.spin.worldToLocal(this.camera.position.clone()).normalize();
    this._last = Math.max(26, this.rig.distance);
    await this.rig.flyTo({ distance: 12.3 }, 2.2, { ease: 'in' });
    const ok = await this.app.descend('surface', { seed: this.sys.seed, planet: this.index, lat: Math.asin(local.y), lon: Math.atan2(local.z, local.x) }, { duration: 2.6 });
    if (!ok) { this.app.hud?.toast('the surface is still being dreamed — soon'); this.rig.flyTo({ distance: this._last }, 2.4, { ease: 'out', interruptible: true }); }
  }

  update(dt, time) {
    const S = this.sunDir;
    if (this._cine) {
      // sunrise: slide along a low orbit from the night side until the star clears the limb
      this._ct += dt; const t = this._ct, cn = this._cine, crest = cn.crest ?? 18, dur = cn.duration ?? 40;
      const d0 = 14.4, alpha = Math.asin(R / d0);
      const W = this._a.set(0, 1, 0).cross(S).normalize();                       // orbit plane = (S, W)
      const th = alpha + (t < crest ? -0.30 * (1 - smoothstep(0, crest, t)) - 0.012 * (1 - t / crest) : 0.34 * smoothstep(crest, dur, t));
      const out = smoothstep(dur - 9, dur - 0.5, t);                             // final pull-back toward the free camera
      const d = d0 + 13 * out;
      const cx = -Math.cos(th) * d, cw = Math.sin(th) * d;
      this.camera.position.set(0, 0, 0).addScaledVector(S, cx).addScaledVector(W, cw).addScaledVector(this._b.set(0, 1, 0), 0.9 + 3 * out);
      const phi = Math.PI / 2 - th + alpha;
      const nT = this._b.set(0, 0, 0).addScaledVector(S, Math.cos(phi)).addScaledVector(W, Math.sin(phi));  // outward normal at the limb
      const look = this._c.copy(nT).multiplyScalar(R + 2.4).multiplyScalar(1 - out);
      this.camera.up.copy(nT).lerp(new THREE.Vector3(0, 1, 0), out).normalize();
      this.camera.lookAt(look); this.camera.updateMatrixWorld();
      if (t >= dur) this.endCine();
    } else { this.rig.enabled = true; this.rig.update(dt); }
    this.planet.tick(time, S);
    for (const { mesh, m } of this.moons) {
      const a = m.phase + time * m.speed * 0.25; mesh.position.set(Math.cos(a) * R * m.dist, Math.sin(a * 0.3) * 0.8, Math.sin(a) * R * m.dist);
      mesh.rotation.y = a; mesh.material.uniforms.uSun.value.copy(S);
    }
    this.stars.tick(this.app);
    // the star's glare eases off while you look away from it
    const facing = this._c.copy(this.camera.position).normalize().dot(S);
    this.sun.material.uniforms.uPower.value = 0.85 + 0.25 * clamp(facing, 0, 1);
  }

  describe() {
    const d = this.desc; if (!d) return { title: 'Orbit' };
    const km = 2 * Math.max(0.2, this.camera.position.length() - R) * Math.tan((this.camera.fov * Math.PI) / 360) * ((d.radius * 6371) / R);
    return { title: d.name, subtitle: [d.label, CIV[d.civ]].filter(Boolean).join(' · '), scale: `${km >= 1000 ? `${(km / 1000).toFixed(1)} thousand` : Math.round(km)} km` };
  }
  hints(touch) { return this.desc?.look.gas ? (touch ? 'drag to orbit · pinch out for the whole system' : 'drag to orbit · scroll out for the whole system') : touch ? 'drag to orbit · pinch in (or double-tap) to land · pinch out for the system' : 'drag to orbit · scroll in (or double-click) to land · scroll out for the system'; }
}
