// App — owns the renderer, the HDR post pipeline, input, the realm registry and the travel/transition system.

import * as THREE from 'three';
import { detectQuality } from './quality.js';
import { PostPipeline } from './post.js';
import { Input } from './input.js';

const MAX_PIXELS = { low: 1.3e6, mid: 2.8e6, high: 5.2e6, ultra: 8.4e6 };

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.params = new URLSearchParams(location.search);
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, depth: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: this.params.has('freeze') || this.params.has('shot'),
    });
    this.renderer.setPixelRatio(1);          // we manage physical pixels ourselves
    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.info.autoReset = true;
    this.quality = detectQuality(this.renderer.getContext());
    this.post = new PostPipeline(this.renderer, this.quality);
    this.input = new Input(canvas);

    this.time = 0; this.dt = 0; this.frame = 0; this.timeScale = 1; this.paused = false;
    this.renderScale = Number(this.params.get('scale')) || 1;
    this.viewport = { width: 2, height: 2, cssWidth: 2, cssHeight: 2, pixelRatio: 1, aspect: 1, displayWidth: 2, displayHeight: 2 };
    this.active = null;            // current realm
    this.path = [];                // location stack: [{ name, params }]
    this._registry = new Map();
    this._transition = null;
    this._updaters = new Set();
    this._listeners = new Map();
    this._ema = 1 / 60; this._slow = 0; this._fast = 0;
    this._errors = new Set();
    this.freezeAt = this.params.has('freeze') ? Number(this.params.get('freeze')) : null;
    this.frozen = false;
    this.audio = null; this.narrator = null; this.hud = null; // attached by main.js

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.emit('contextlost'); });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
    this.resize();
    this._tick = this._tick.bind(this);
  }

  // ----- tiny event emitter ------------------------------------------------------------------------
  on(type, fn) { if (!this._listeners.has(type)) this._listeners.set(type, new Set()); this._listeners.get(type).add(fn); return () => this._listeners.get(type)?.delete(fn); }
  emit(type, data) { const s = this._listeners.get(type); if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(e); } } }
  /** register a per-frame callback fn(dt, time); returns an unsubscribe function */
  addUpdater(fn) { this._updaters.add(fn); return () => this._updaters.delete(fn); }

  // ----- sizing ---------------------------------------------------------------------------------------
  resize() {
    const cssW = Math.max(2, this.canvas.clientWidth || window.innerWidth), cssH = Math.max(2, this.canvas.clientHeight || window.innerHeight);
    const cap = Math.sqrt((MAX_PIXELS[this.quality.tier] || 4e6) / (cssW * cssH));
    const dpr = Math.min(this.quality.pixelRatio, Math.max(0.5, cap));
    const dw = Math.round(cssW * dpr), dh = Math.round(cssH * dpr);
    if (this.renderer.domElement.width !== dw || this.renderer.domElement.height !== dh) this.renderer.setSize(dw, dh, false);
    const w = Math.max(2, Math.round(dw * this.renderScale)), h = Math.max(2, Math.round(dh * this.renderScale));
    this.post.setSize(w, h, dw, dh);
    Object.assign(this.viewport, { width: w, height: h, cssWidth: cssW, cssHeight: cssH, pixelRatio: w / cssW, aspect: cssW / cssH, displayWidth: dw, displayHeight: dh });
    for (const e of this._registry.values()) if (e.instance) { try { e.instance.resize(this.viewport); } catch (err) { this._report(err, 'resize'); } }
    this.emit('resize', this.viewport);
  }

  _dynamicRes(rawDt) {
    if (!this.quality.dynamicRes || this.frozen || this.freezeAt != null) return;
    this._ema += (rawDt - this._ema) * 0.08;
    if (this._ema > 1 / 48) { this._slow += rawDt; this._fast = 0; } else if (this._ema < 1 / 57) { this._fast += rawDt; this._slow = 0; } else { this._slow = this._fast = 0; }
    let s = this.renderScale;
    if (this._slow > 0.7 && s > this.quality.minScale) { s = Math.max(this.quality.minScale, s * 0.88); this._slow = 0; }
    else if (this._fast > 4 && s < 1) { s = Math.min(1, s * 1.06); this._fast = 0; }
    if (s !== this.renderScale) { this.renderScale = s; this.resize(); }
  }

  // ----- realms -----------------------------------------------------------------------------------------
  /** loader: () => Promise<module with default export class extends Realm> */
  register(name, loader) { this._registry.set(name, { loader, instance: null, promise: null }); }
  has(name) { return this._registry.has(name); }
  get(name) { return this._registry.get(name)?.instance || null; }
  ensure(name) {
    const e = this._registry.get(name);
    if (!e) return Promise.reject(new Error(`unknown realm "${name}"`));
    if (!e.promise) {
      e.promise = (async () => {
        const mod = await e.loader();
        const Cls = mod.default || mod.Realm;
        const inst = new Cls(this);
        inst.name = name;
        await inst.init();
        inst.resize(this.viewport);
        e.instance = inst;
        return inst;
      })();
      e.promise.catch((err) => { e.promise = null; this._report(err, `init ${name}`); });
    }
    return e.promise;
  }

  get travelling() { return !!this._transition; }

  /** Go to a realm. opts: { type: 'dive'|'rise'|'fade'|'cut', duration, center:[x,y] (0..1 screen), push: true|false|'replace' } */
  async travel(name, params = {}, opts = {}) {
    if (this._transition) { await this._transition.promise; }
    let to;
    try { to = await this.ensure(name); } catch (err) { this.emit('travelfailed', { name, error: err }); return false; }
    if (this._transition) { await this._transition.promise; }
    const from = this.active;
    const type = opts.type || 'dive';
    const duration = opts.duration ?? (type === 'fade' ? 1.6 : 2.4);
    if (opts.push === 'replace') this.path.pop();
    if (opts.push !== false) this.path.push({ name, params });
    this.emit('travelstart', { from, to, name, params, type, duration });

    if (!from || type === 'cut' || duration <= 0) {
      if (from) { from.exit(to); from.active = false; }
      this.active = to; to.active = true; to.enter(params, from); this.input.setMode(to.inputMode || 'orbit');
      this.emit('realm', { realm: to, from, params });
      return true;
    }
    let resolve; const promise = new Promise((r) => (resolve = r));
    if (from === to) {
      // same realm, new destination: dip through black
      this._transition = { same: true, from, to, params, t: 0, duration, type: 'fade', promise, resolve, swapped: false };
    } else {
      to.enter(params, from);
      this._transition = { from, to, params, t: 0, duration, type, center: opts.center, promise, resolve };
    }
    return promise;
  }

  /** travel "down" one level (push) / "up" one level (pop) keeping the location stack coherent */
  descend(name, params = {}, opts = {}) { return this.travel(name, params, { type: 'dive', ...opts, push: true }); }
  ascend(opts = {}) {
    if (this.path.length < 2 || this._transition) return Promise.resolve(false);
    this.path.pop();
    const parent = this.path[this.path.length - 1];
    return this.travel(parent.name, { ...parent.params, returning: true }, { type: 'rise', ...opts, push: false });
  }

  _stepTransition(dt) {
    const tr = this._transition; if (!tr) return null;
    tr.t = Math.min(1, tr.t + dt / tr.duration);
    if (tr.same) {
      const half = tr.t < 0.5;
      this.post.master.fade = half ? 1 - tr.t * 2 : (tr.t - 0.5) * 2;
      if (!half && !tr.swapped) { tr.swapped = true; tr.from.exit(tr.to); tr.to.enter(tr.params, tr.from); this.emit('realm', { realm: tr.to, from: tr.from, params: tr.params }); }
      if (tr.t >= 1) { this.post.master.fade = 1; this._transition = null; tr.resolve(true); }
      return null;
    }
    if (tr.t >= 1) {
      tr.from.exit(tr.to); tr.from.active = false;
      this.active = tr.to; tr.to.active = true; this.input.setMode(tr.to.inputMode || 'orbit');
      this._transition = null;
      this.emit('realm', { realm: tr.to, from: tr.from, params: tr.params });
      tr.resolve(true);
      return null;
    }
    return tr;
  }

  _report(err, where) {
    const key = `${where}:${err && err.message}`;
    if (this._errors.has(key)) return; this._errors.add(key);
    console.error(`[selah] ${where}:`, err);
    this.emit('error', { error: err, where });
  }

  // ----- main loop ------------------------------------------------------------------------------------------
  start() { this._last = performance.now(); requestAnimationFrame(this._tick); }

  _advance(dt) {
    this.dt = dt; this.time += dt; this.frame++;
    this.input.update(dt);
    for (const fn of [...this._updaters]) { try { fn(dt, this.time); } catch (err) { this._report(err, 'updater'); } }
    const tr = this._stepTransition(dt);
    const a = this.active;
    if (a) { try { a.update(dt, this.time); } catch (err) { this._report(err, `update ${a.name}`); } }
    if (tr && !tr.same) { try { tr.to.update(dt, this.time); } catch (err) { this._report(err, `update ${tr.to.name}`); } }
    return tr;
  }

  _draw(dt, tr) {
    if (!this.active) { this.renderer.setRenderTarget(null); this.renderer.clear(); return; }
    try { this.post.render(this.active, dt, tr && !tr.same ? tr : null); } catch (err) { this._report(err, `render ${this.active.name}`); }
  }

  _tick(now) {
    requestAnimationFrame(this._tick);
    const raw = Math.min(0.25, Math.max(0, (now - this._last) / 1000)); this._last = now;
    if (this.freezeAt != null) {
      // deterministic fast-forward for screenshots/tests: fixed steps, draw only when we arrive
      if (!this.frozen) {
        let n = 0; let tr = null;
        const stepDt = 1 / 30, maxSteps = Number(this.params.get('ffsteps')) || 12;
        while (this.time < this.freezeAt - 1e-6 && n++ < maxSteps) tr = this._advance(Math.min(stepDt, this.freezeAt - this.time));
        this.input.endFrame();
        if (this.time >= this.freezeAt - 1e-6) { this._draw(0, tr); this._draw(0, tr); this.frozen = true; this.emit('frozen'); }
        return;
      }
      const tr = this._advance(0); this._draw(0, tr); this.input.endFrame();
      return;
    }
    const dt = this.paused ? 0 : Math.min(raw, 1 / 15) * this.timeScale;
    const tr = this._advance(dt);
    this._draw(dt, tr);
    this.input.endFrame();
    this._dynamicRes(raw);
    this.emit('frame', dt);
  }
}
