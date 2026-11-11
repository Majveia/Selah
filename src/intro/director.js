// The opening film. One continuous shot through the real, interactive realms:
//   silence → first light → expansion and cooling → gravity weaves the cosmic web → into a galaxy →
//   sunrise over a living world → SELAH → the controls are yours.
// The director owns a clock (the audio clock when sound is running, so picture and voice cannot drift),
// a list of timed cues, and a few keyframed tracks that drive the web realm's cinematic state.

import { blackbody } from '../core/color.js';
import { clamp, smoothstep } from '../core/rng.js';
import { D_NOW } from '../realms/web/index.js';

// Fallback script (used for captions when the narration manifest is unavailable).
const SCRIPT = {
  intro_01: ['Before the first light,', 'there was silence.', 'A silence so complete,', 'it had no edge.'],
  intro_02: ['And then…', 'the silence took a breath.'],
  intro_03: ['In its first minutes,', 'the universe made hydrogen.', 'Everything else,', 'it left to the stars.'],
  intro_04: ['Then gravity began to sing.', 'And slowly,', 'the darkness gathered itself into rivers…', 'and the rivers caught fire.'],
  intro_05: ['This is the cosmic web.', 'Every thread,', 'a river of galaxies.', 'Every galaxy,', 'a hundred billion suns.'],
  intro_06: ['And around those suns…', 'worlds.', 'Oceans.', 'Mountains.', 'Cities.', 'Someone, somewhere,', 'looking up.'],
  intro_07: ['It took thirteen billion years to make eyes that could look back.', 'Yours.'],
  intro_08: ['In the old songs,', 'there is a word for this moment.', 'Selah.', 'Pause…', 'and behold.'],
  intro_09: ['This universe is yours now.', 'Go anywhere.'],
};
// When each line begins (seconds). Slots are sized for the slower narrator.
const AT = { intro_01: 2.5, intro_02: 12.4, intro_03: 21.0, intro_04: 32.0, intro_05: 45.5, intro_06: 58.5, intro_07: 74.0, intro_08: 82.0, intro_09: 94.5 };
const BANG = 17.6, WEB_FORM = 31.0, FLY_IN = 46.5, GALAXY_DIVE = 50.4, WORLD_DIVE = 60.0, END = 100.5;

/** piecewise keyframes with smooth easing: keys = [[t, v], …] */
function kf(t, keys) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) { const [t0, v0] = keys[i - 1], [t1, v1] = keys[i]; return v0 + (v1 - v0) * smoothstep(t0, t1, t); }
  }
  return keys[keys.length - 1][1];
}

export class Director {
  static openingState() {
    return { D: 0.03, heat: 1, heatColor: [3, 2.8, 2.6], scale: 0.0005, gain: 0, galaxies: 0, deep: 0, phaseSpeed: 0.004, beacon: [26, 0] };
  }

  constructor(app) {
    this.app = app; this.playing = false; this.t = 0;
    this._cues = []; this._caps = []; this._off = [];
    app.addUpdater((dt) => this.update(dt));
  }

  _lines() {
    const n = this.app.narrator, out = {};
    for (const id of Object.keys(SCRIPT)) {
      const caps = n && n.captions(id).length ? n.captions(id) : null;
      if (caps) out[id] = { duration: n.duration(id), caps };
      else { // estimate timings from text length
        let t = 0.1; const cs = SCRIPT[id].map((text) => { const d = 0.55 + text.length * 0.062; const c = { t0: t, t1: t + d, text }; t += d + (/[….]$/.test(text) ? 0.9 : 0.4); return c; });
        out[id] = { duration: t, caps: cs };
      }
    }
    return out;
  }

  /** replay from anywhere */
  async play() { await this.prepare(); return this.run(); }

  /** build the timeline (async: preloads realms and narration); the clock starts in run() */
  async prepare() {
    if (this.playing || this._preparing) return;
    const app = this.app, hud = app.hud, snd = app.sound;
    this._preparing = true; this.t = 0; this._done = false; this._capOn = -1;
    hud.setCinema(true); hud.showTitle(false); hud.caption(null);
    // (re)enter the web in its primordial state
    if (app.active?.name !== 'web' || !app.active.cine) { app.path.length = 0; await app.travel('web', { cine: Director.openingState() }, { type: app.active ? 'fade' : 'cut', duration: 1.2 }); }
    this.web = app.get('web'); this.web.cine = Director.openingState();
    const [hasGalaxy, hasOrbit] = await Promise.all(['galaxy', 'orbit'].map((r) => app.ensure(r).then(() => true, () => false)));
    this.hasGalaxy = hasGalaxy; this.hasOrbit = hasGalaxy && hasOrbit;
    try { await app.narrator?.preload(); } catch { /* captions still run */ }
    const music = snd?.engine?.music, engine = snd?.engine;
    const ctx = engine?.ctx || app.narrator?._ctx || null;
    this._ctx = ctx; this.t = 0;

    // ---- captions + voice ----
    const lines = this._lines(); this._caps = []; this._cues = [];
    const cue = (t, fn) => this._cues.push({ t, fn });
    for (const [id, L] of Object.entries(lines)) {
      const at = AT[id];
      cue(at, () => {
        const h = app.narrator?.say(id);
        if (engine && h) { const release = engine.duck(-5.5, 0.4, 1.6); h.ended.then(release); }
      });
      for (const c of L.caps) this._caps.push({ t0: at + c.t0, t1: at + c.t1, text: c.text });
    }
    this._caps.sort((a, b) => a.t0 - b.t0);
    const l8 = lines.intro_08, selahCap = l8.caps.find((c) => /^Selah/i.test(c.text)) || l8.caps[2] || { t0: 5 };
    const TITLE = AT.intro_08 + selahCap.t0 - 0.15;

    // ---- score ----
    cue(0, () => music?.setScene('void', { fade: 0.5 }));
    cue(BANG - 2.6, () => music?.cue('bigbang', { lead: 2.6 }));
    cue(BANG, () => { music?.setScene('genesis', { fade: 2.5 }); this.web.rig.shake(2.4); });
    cue(WEB_FORM - 1, () => music?.setScene('web', { fade: 7 }));
    // ---- into a galaxy ----
    cue(FLY_IN, () => { const g = this.web._pick(app.viewport.cssWidth / 2, app.viewport.cssHeight / 2, Math.min(app.viewport.cssWidth, app.viewport.cssHeight) * 0.42); this._gal = g; if (g >= 0) { this.web._galaxyWorld(g, this.web._v); this.web._centerGoal.copy(this.web._v.box); this.web._snapCenter = 1.6; } });
    if (this.hasGalaxy) {
      cue(GALAXY_DIVE, async () => {
        music?.cue('dive'); music?.setScene('galaxy', { fade: 5 });
        this.web._last = { center: this.web.center.clone(), distance: 30 };
        await app.descend('galaxy', { seed: 'home-galaxy', name: 'Ilúvien', home: true, cine: { kind: 'intro', duration: WORLD_DIVE + 2.6 - GALAXY_DIVE } }, { duration: 2.8 });
      });
    }
    if (this.hasOrbit) {
      cue(WORLD_DIVE, async () => {
        music?.cue('sunrise'); music?.setScene('orbit', { fade: 6 });
        app.path.push({ name: 'system', params: { seed: 'home', home: true }, label: 'Selah System' });
        await app.descend('orbit', { seed: 'home', home: true, cine: { kind: 'sunrise', duration: END - WORLD_DIVE, crest: AT.intro_07 + 4.6 - WORLD_DIVE } }, { duration: 2.8 });
      });
    }
    cue(TITLE, () => { hud.showTitle(true); music?.cue('title'); music?.setScene('title', { fade: 2 }); });
    cue(AT.intro_09 + 4.6, () => hud.showTitle(false));
    cue(END, () => this.finish(false));
    this._cues.sort((a, b) => a.t - b.t);

    // ---- skipping ----
    this._off.push(app.input.on('longpress', () => this.finish(true)), app.input.on('key', (c) => { if (c === 'Escape') this.finish(true); }));
    const onSkip = () => this.finish(true); hud.skip.addEventListener('click', onSkip); this._off.push(() => hud.skip.removeEventListener('click', onSkip));
    setTimeout(() => { if (this.playing) { hud.skip.textContent = app.input.lastDevice === 'touch' ? 'hold to skip' : 'esc to skip'; hud.setSkipVisible(true); } }, 5000);
    this._preparing = false; this._prepared = true;
  }

  /** start the clock; resolves when the film ends or is skipped */
  run() {
    if (!this._prepared || this.playing) return Promise.resolve();
    const ctx = this._ctx; this._prepared = false;
    this._clock = ctx && ctx.state === 'running' && this.app.freezeAt == null ? { ctx, t0: ctx.currentTime } : null;
    this.t = 0; this.playing = true;
    return new Promise((r) => (this._resolve = r));
  }

  update(dt) {
    if (!this.playing) return;
    const app = this.app;
    this.t = this._clock ? this._clock.ctx.currentTime - this._clock.t0 : this.t + dt;
    const t = this.t;
    while (this._cues.length && this._cues[0].t <= t) { const c = this._cues.shift(); try { c.fn(); } catch (e) { console.error('[director]', e); } }
    // captions
    let on = -1; for (let i = 0; i < this._caps.length; i++) { const c = this._caps[i]; if (t >= c.t0 && t < c.t1 + 0.5) on = i; }
    if (on !== this._capOn) { this._capOn = on; app.hud.caption(on >= 0 ? this._caps[on].text : null); }

    // ---- the web's cinematic state ----
    const web = this.web; if (!web || (app.active !== web)) { app.post.master.flash = 0; return; }
    const tau = t - BANG, c = web.cine || (web.cine = Director.openingState());
    if (tau < 0) {
      // one point of light, breathing — then it inhales
      const inhale = smoothstep(BANG - 2.9, BANG - 0.25, t);
      const pulse = 1 + 0.22 * Math.sin(t * 1.5) + 0.08 * Math.sin(t * 3.7);
      c.beacon = [26 * (1 - 0.55 * inhale) * (0.92 + 0.08 * pulse), smoothstep(0, 2.5, t) * (1.5 * pulse) * (1 - 0.86 * inhale) + 60 * smoothstep(BANG - 0.22, BANG, t)];
      c.scale = 0.0005; c.gain = 0; c.heat = 1; c.D = 0.03; c.galaxies = 0; c.deep = 0;
      app.post.master.flash = 0;
      web.rig.set({ distance: 26, yaw: 0.6 + t * 0.006, pitch: 0.2 });
    } else {
      c.scale = tau > 13 ? 1 : 1 - Math.exp(-tau / 2.35) * (1 - smoothstep(9, 13, tau));
      const T = kf(tau, [[0, 15000], [1.2, 9000], [5, 4200], [10, 2200]]), b = kf(tau, [[0, 3.2], [2, 2.2], [6, 1.25], [11, 0.8]]);
      const bb = blackbody(T); c.heatColor = [bb[0] * b, bb[1] * b, bb[2] * b];
      c.heat = 1 - smoothstep(4.5, 12.5, tau);
      const dark = kf(t, [[BANG + 9, 1], [BANG + 12.5, 0.5], [WEB_FORM + 2, 0.6], [WEB_FORM + 12, 1]]); // the dark ages, then first light
      c.gain = clamp(Math.pow(c.scale, 1.75), 0.0012, 1) * smoothstep(0, 0.25, tau) * dark;
      c.D = kf(t, [[WEB_FORM - 4, 0.03], [WEB_FORM, 0.12], [WEB_FORM + 13.5, D_NOW]]);
      c.galaxies = kf(t, [[WEB_FORM + 8, 0], [WEB_FORM + 14, 1.5]]);
      c.deep = kf(t, [[WEB_FORM + 2, 0], [WEB_FORM + 12, 1]]);
      c.phaseSpeed = 0.005;
      c.beacon = [26 + 420 * smoothstep(0, 0.5, tau), 60 * Math.exp(-tau / 0.45)];
      app.post.master.flash = 5.5 * Math.exp(-tau / 0.75) * smoothstep(-0.02, 0.06, tau);
      const dist = t < FLY_IN ? kf(t, [[BANG, 26], [BANG + 8, 132], [WEB_FORM, 128], [FLY_IN, 96]])
        : this.hasGalaxy ? kf(t, [[FLY_IN, 96], [GALAXY_DIVE + 2.2, 0.9]]) : kf(t, [[FLY_IN, 96], [FLY_IN + 7, 9], [END, 22]]);
      web.rig.set({ distance: dist, yaw: 0.6 + t * 0.006 + 0.5 * smoothstep(BANG, WEB_FORM + 14, t) + 0.35 * smoothstep(FLY_IN, FLY_IN + 8, t), pitch: kf(t, [[BANG, 0.2], [WEB_FORM + 10, 0.3], [FLY_IN + 6, 0.1]]) });
    }
  }

  /** end of the film (or skip): hand the universe over */
  async finish(skipped) {
    if (!this.playing || this._done) return; this._done = true;
    const app = this.app, hud = app.hud, music = app.sound?.engine?.music;
    this._off.forEach((f) => f()); this._off = []; this._cues = []; this._caps = [];
    hud.setSkipVisible(false); hud.caption(null); app.post.master.flash = 0;
    if (skipped) { app.narrator?.stop(0.4); hud.showTitle(false); }
    this.playing = false;
    const web = this.web; if (web) { web.cine = null; web.beacon.set(30, 0); web.a = web._aGoal = 1; }
    if (skipped) {
      if (this.hasOrbit && app.active?.name !== 'orbit') {
        app.path.length = 0; app.path.push({ name: 'web', params: {}, label: 'Cosmic Web' }, { name: 'galaxy', params: { seed: 'home-galaxy', name: 'Ilúvien', home: true }, label: 'Ilúvien' }, { name: 'system', params: { seed: 'home', home: true }, label: 'Selah System' });
        await app.travel('orbit', { seed: 'home', home: true }, { type: 'fade', duration: 1.6 });
      } else if (app.active === web) web.rig.flyTo({ distance: 100 }, 2.5, { ease: 'out', interruptible: true });
    }
    app.active?.endCine?.();
    music?.setScene(app.active?.musicScene || app.active?.name || 'web', { fade: 8 });
    hud.setCinema(false);
    setTimeout(() => hud.showControls(10), 2400);
    this._resolve?.(); this._resolve = null;
  }
}
