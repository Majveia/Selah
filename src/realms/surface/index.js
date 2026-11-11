// The surface of a world, on foot or on a hover-skiff, in third or first person.
// Land from orbit, wander between settlements under a turning sky, and climb back to space by simply rising.

import * as THREE from 'three';
import { Realm } from '../../core/realm.js';
import { RNG, hashInts } from '../../core/rng.js';
import { systemFromSeed, makeName } from '../../universe/model.js';
import { World, LIGHT_UNIFORMS } from './terrain.js';
import { Sky } from './sky.js';
import { Player } from './player.js';

const PLACE = { garden: 'meadows', ocean: 'shores', desert: 'dunes', ice: 'ice fields', lava: 'basalt flats', rock: 'barrens' };

export default class SurfaceRealm extends Realm {
  constructor(app) {
    super(app);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.25, 12000);
    this.inputMode = 'character';
    this.post = { bloom: 0.55, bloomThreshold: 1.15, bloomKnee: 0.6, bloomScatter: 0.72, exposure: 0.95, saturation: 1.08, contrast: 1.04, vignette: 0.24, grain: 0.012, sharpen: 0.5, ca: 0.06 };
    this._p = new THREE.Vector3(); this._night = false; this._ride = false;
  }
  get musicScene() { return this.player?.riding ? 'ride' : 'surface'; }

  async init() {
    this.light = LIGHT_UNIFORMS();
    this.sky = new Sky(this.scene, this.light, this.app.quality);
    this.world = new World(this.scene, this.app.quality, this.light);
    this.player = new Player(this.scene, this.light, this.camera);
  }

  enter(params = {}) {
    const sys = systemFromSeed(params.seed ?? 'home');
    let idx = params.planet ?? sys.planets.findIndex((p) => p.kind === 'garden'); if (idx < 0 || !sys.planets[idx] || sys.planets[idx].look.gas) idx = sys.planets.findIndex((p) => !p.look.gas);
    const d = (this.desc = sys.planets[Math.max(0, idx)]);
    const key = `${sys.seed}:${idx}:${(params.lat ?? 0).toFixed(2)}:${(params.lon ?? 0).toFixed(2)}`;
    if (key !== this._key || !params.returning) {
      this._key = key;
      // the landing site: latitude/longitude pick a patch of the endless terrain
      const origin = { x: Math.round((params.lon ?? 0.3) * 30000), z: Math.round((params.lat ?? 0.2) * 30000) };
      this.world.configure(d, origin); this.sky.configure(d, this.world.hasSea);
      this.light.uWind.value.set(Math.cos(d.hue * 3), Math.sin(d.hue * 3));
      // find firm ground: beside the nearest settlement if there is one, otherwise the first gentle land outward
      let sx = 0, sz = 0, yaw = 0; const W = this.world, site = W.site(0, 0);
      if (site) { sx = site.x + site.R + 26; sz = site.z + 8; yaw = -Math.PI / 2; }
      else { const r = new RNG(hashInts(d.terrainSeed, 3)); for (let i = 0; i < 400; i++) { const a = i * 0.6, rad = i * 14, x = Math.cos(a) * rad, z = Math.sin(a) * rad, h = W.height(x, z); if (h > (W.hasSea ? 3 : -1e8) && h < 80 && Math.abs(W.height(x + 6, z) - h) < 2.5) { sx = x; sz = z; break; } } yaw = r.float(0, 6.28); }
      this.player.reset(sx, sz, W, yaw);
      W._cx = W._cz = null; W.update(sx, sz, this.app.quality.tier === 'low' ? 9 : 21);
      this.player.pos.y = W.height(sx, sz);
      this._night = false;
    } else this.player.arrive = 1;
    this._ride = this.player.riding;
    const inp = this.app.input;
    this._off = [inp.on('tap', () => inp.requestPointerLock())];
    if (params.ride) { this.player.toggleRide(); this.player.altTarget = params.alt ?? 6; this.player.vel.set(Math.sin(this.player.yaw) * 30, 0, Math.cos(this.player.yaw) * 30); }
    if (params.look != null) this.player.camYaw += params.look;
    if (params.phase != null) this.sky.phase = params.phase;
  }
  exit() { this._off?.forEach((f) => f()); this._off = null; this.app.input.exitPointerLock(); this.app.hud?.setTag(null); }

  update(dt, time) {
    const P = this.player, W = this.world, inp = this.app.input, app = this.app;
    this.light.uTime.value = time;
    P.update(dt, inp, W, time);
    W.update(P.pos.x, P.pos.z, this.app.frozen ? 0 : 3);
    this.sky.update(dt, this.camera.position);
    // leave: rise high enough on the skiff, or press M
    if (!app.travelling && ((P.riding && P.alt > 330) || inp.pressed('map'))) { app.audio?.music.cue('takeoff'); app.ascend({ duration: 2.6 }); }
    // the score follows how you move
    if (P.riding !== this._ride) { this._ride = P.riding; app.audio?.music.setScene(P.riding ? 'ride' : 'surface', { fade: 3 }); app.audio?.music.cue(P.riding ? 'takeoff' : 'land'); if (P.riding) app.emit('discover', 'ride'); }
    app.audio?.music.setParam('speed', Math.min(1, P.speed / 50));
    if (!this._night && this.sky.night > 0.85) { this._night = true; app.emit('discover', 'night'); }
    // nearest settlement, as a waypoint
    const hud = app.hud;
    if (hud && !app.travelling) {
      const s = W.nearestSite(P.pos.x, P.pos.z);
      if (s && s.dist > s.R && s.dist < 2400) {
        if (!s.ref.name) s.ref.name = makeName(new RNG(s.seed), 2);
        const p = this._p.set(s.x, s.h + 46, s.z).project(this.camera), vp = app.viewport;
        if (p.z < 1 && Math.abs(p.x) < 0.95 && Math.abs(p.y) < 0.9) hud.setTag((p.x * 0.5 + 0.5) * vp.cssWidth, (-p.y * 0.5 + 0.5) * vp.cssHeight, s.ref.name, `${this.desc.civ === 'ruins' ? 'ruins' : s.big ? 'city' : 'village'} · ${Math.round(s.dist)} m`);
        else hud.setTag(null);
        this._near = s.ref.name;
      } else { hud.setTag(null); this._near = s && s.dist <= s.R ? (s.ref.name || (s.ref.name = makeName(new RNG(s.seed), 2))) : null; this._in = !!(s && s.dist <= s.R); }
    }
  }

  describe() {
    const d = this.desc, P = this.player; if (!d) return { title: 'Surface' };
    const where = this._in && this._near ? `in ${this._near}` : `the ${PLACE[d.kind] || 'wilds'}${this._near ? ` near ${this._near}` : ''}`;
    return { title: d.name, subtitle: `${this.sky.label()} · ${where}`, scale: P.riding ? `${Math.round(P.speed * 3.6)} km/h · ${Math.round(P.alt)} m up` : '' };
  }
  hints(touch) {
    return touch ? 'left thumb to move · right thumb to look · ↑ jump, hold to glide · skiff button to ride, hold ↑ to climb to orbit'
      : 'WASD move · mouse look · Space jump, hold to glide · Shift run · R skiff (hold Space to climb to orbit) · C view · M leave';
  }
}
