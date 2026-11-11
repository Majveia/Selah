// Selah — entry point. Boots the app, shows the gate, then hands over to the opening film (or straight to a realm
// with ?realm=NAME for development: e.g. ?realm=web&q=low&freeze=4).

import { App } from './core/app.js';
import { REALMS } from './realms/index.js';
import { HUD } from './ui/hud.js';

const canvas = document.getElementById('gl');
const api = (window.__selah = { ready: false, app: null });

function fatal(msg) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;text-align:center;padding:32px;color:#cdd3e6;font:300 14px/1.7 system-ui;letter-spacing:.04em;background:#000;z-index:9';
  d.innerHTML = `<div><div style="letter-spacing:.5em;text-transform:uppercase;font-size:11px;margin-bottom:18px">Selah</div>${msg}</div>`;
  document.body.appendChild(d);
}

async function boot() {
  let app;
  try { app = new App(canvas); } catch (e) { console.error(e); return fatal('This universe needs WebGL 2.<br>Please open it in a recent version of Chrome, Edge, Firefox or Safari.'); }
  api.app = app;
  for (const [name, loader] of Object.entries(REALMS)) app.register(name, loader);
  const hud = (app.hud = new HUD(app)); api.hud = hud;
  const p = app.params;
  if (p.get('hud') === '0') document.getElementById('hud').style.display = 'none';

  // ---- audio (lazy: needs a user gesture; everything degrades to silence + captions) ----
  let soundOn = p.get('sound') !== '0';
  const audio = (app.sound = {
    engine: null, narrator: null,
    async init() {
      if (this.engine || this._tried) return; this._tried = true;
      try {
        const { createAudioEngine } = await import('./audio/engine.js');
        this.engine = await createAudioEngine(); app.audio = this.engine;
        await this.engine.resume(); this.engine.setMuted(!soundOn);
        this.engine.music.start();
      } catch (e) { console.warn('[selah] music engine unavailable:', e.message); }
      try {
        const { createNarrator } = await import('./audio/narrator.js');
        const ctx = this.engine?.ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (!this.engine) { await ctx.resume(); this._ownCtx = ctx; }
        this.narrator = await createNarrator({ ctx, output: this.engine?.buses.voice || ctx.destination, reverbSend: this.engine?.reverb });
        app.narrator = this.narrator;
        let saved = null; try { saved = localStorage.getItem('selah.voice'); } catch { /* storage may be blocked */ }
        if (saved === 'off') this.narrator.setEnabled(false); else if (saved && this.narrator.voices.includes(saved)) this.narrator.setVoice(saved);
        hud.setVoices([...this.narrator.voices, 'off'], saved || this.narrator.manifest.default);
      } catch (e) { console.warn('[selah] narrator unavailable:', e.message); }
      app.emit('audio', this);
    },
  });
  app.on('ui:sound', () => { soundOn = !soundOn; hud.setSound(soundOn); audio.engine?.setMuted(!soundOn); if (audio._ownCtx) (soundOn ? audio._ownCtx.resume() : audio._ownCtx.suspend()); if (soundOn) audio.init(); });
  app.on('ui:voice', (v) => { try { localStorage.setItem('selah.voice', v); } catch { /* private mode */ } if (!audio.narrator) return; if (v === 'off') audio.narrator.setEnabled(false); else { audio.narrator.setEnabled(true); audio.narrator.setVoice(v); } });
  hud.setSound(soundOn);
  // the score follows the journey
  const SCENE = { web: 'web', galaxy: 'galaxy', system: 'system', orbit: 'orbit', surface: 'surface', blackhole: 'blackhole' };
  app.on('realm', ({ realm }) => { if (!app.director?.playing) audio.engine?.music.setScene(realm.musicScene || SCENE[realm.name] || 'web', { fade: 5 }); });
  app.on('travelstart', ({ type }) => { if (!app.director?.playing) audio.engine?.music.cue(type === 'rise' ? 'arrival' : 'dive'); });

  // ---- development entry: straight into one realm ----
  const dev = p.get('realm');
  if (dev) {
    hud.hideGate();
    const params = {};
    for (const [k, v] of p) if (!['realm', 'q', 'freeze', 'hud', 'dpr', 'msaa', 'scale', 'sound', 'ffsteps'].includes(k)) params[k] = v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v;
    const ok = await app.travel(dev, params, { type: 'cut' });
    if (!ok) fatal(`Realm “${dev}” failed to load — see the console.`);
    app.start(); api.ready = true;
    canvas.addEventListener('pointerdown', () => audio.init(), { once: true });
    return;
  }

  // ---- the real entrance ----
  let Director = null;
  try { ({ Director } = await import('./intro/director.js')); } catch (e) { console.warn('[selah] intro unavailable:', e.message); }
  const webReady = app.ensure('web').then(() => hud.setProgress(0.85));
  hud.setProgress(0.25);
  const gate = hud.gate(webReady);
  await webReady;
  const skipIntro = p.get('intro') === '0' || !Director;
  await app.travel('web', skipIntro ? {} : { cine: Director.openingState() }, { type: 'cut' });
  if (p.has('freeze')) { hud.hideGate(); } else { await gate; await audio.init(); }
  if (skipIntro) { app.start(); api.ready = true; hud.showControls(9); return; }
  const director = (app.director = new Director(app));
  app.on('ui:intro', () => director.play());
  await director.prepare();
  app.start(); api.ready = true;
  await director.run();
}

boot().catch((e) => { console.error(e); fatal('Something went wrong while starting Selah.<br><small style="opacity:.6">' + (e && e.message) + '</small>'); });
