// Selah — the score. A small generative ensemble that reads one shared harmony (harmony.js) and plays it differently
// in every realm: drones and glass in the void, harp/Rhodes clouds over the cosmic web, a brushed trio in the galaxy,
// chord-melody guitar at sunrise, a singing overdriven lead for flight and for the title. Everything is synthesized.
//
// Scheduling is bar-based: scheduleUntil(t) lays down whole bars slightly ahead of the audio clock.

import { createHarmony, THEME, CLIMAX } from './harmony.js';
import { voicing, ladder, nearestIndex, nearestPc } from './theory.js';
import { makeKit, makeNoiseBuffer, tubeCurve, mtof, clamp } from './dsp.js';

const SCENES = {
  void:      { bpm: 52, mix: { drone: 0.9, bell: 0.4 } },
  genesis:   { bpm: 56, mix: { drone: 0.55, pad: 0.85, choir: 0.6, harp: 0.55, bell: 0.3 } },
  web:       { bpm: 66, mix: { pad: 0.55, harp: 0.85, rhodes: 0.5, bass: 0.55, bell: 0.3 } },
  galaxy:    { bpm: 72, swing: 0.61, mix: { pad: 0.42, rhodes: 0.75, bass: 0.8, drums: 0.5, bell: 0.55, harp: 0.25 } },
  system:    { bpm: 60, mix: { pad: 0.5, bell: 0.75, rhodes: 0.4, bass: 0.35 } },
  orbit:     { bpm: 63, mix: { pad: 0.5, gtr: 0.85, bass: 0.55, rhodes: 0.22, drums: 0.16 } },
  surface:   { bpm: 86, swing: 0.58, mix: { rhodes: 0.62, bass: 0.8, drums: 0.6, gtr: 0.5, pad: 0.3, harp: 0.22 } },
  ride:      { bpm: 108, mix: { bass: 0.85, drums: 0.78, rhodes: 0.45, gtr: 0.85, pad: 0.36 } },
  blackhole: { bpm: 40, mix: { drone: 1.0, pad: 0.5, choir: 0.35, bell: 0.22 } },
  title:     { bpm: 63, mix: { pad: 0.75, choir: 0.7, harp: 0.6, bass: 0.7, drums: 0.4, gtr: 0.95, rhodes: 0.28 } },
};
const LAYERS = { drone: [0.13, 0.3], pad: [0.2, 0.45], choir: [0.12, 0.6], rhodes: [0.27, 0.28], harp: [0.24, 0.5], bell: [0.22, 0.6], bass: [0.42, 0.04], drums: [0.33, 0.14], gtr: [0.34, 0.3], fx: [0.42, 0.45] };

export async function createMusic(engine, { rng }) {
  const ctx = engine.ctx, out = engine.buses.music, rev = engine.reverb, sr = ctx.sampleRate;
  const H = createHarmony({ rng: rng.fork('harmony') });
  const R = rng.fork('play');
  const kit = await makeKit(ctx, rng.fork('kit'));
  const noise = makeNoiseBuffer(ctx, 2, rng.fork('noise'));

  // ---- layer buses: each has a level (scene mix) and a reverb send --------------------------------------
  out.gain.value = 0.8;                                  // the score sits under the narrator
  const tone = ctx.createBiquadFilter(); tone.type = 'highshelf'; tone.frequency.value = 3000; tone.gain.value = -5; tone.connect(out); // warm, never piercing
  const revBus = ctx.createGain(); revBus.gain.value = 0.36; revBus.connect(rev);                // all sends, post-fader
  const L = {};
  for (const [name, [gain, send]] of Object.entries(LAYERS)) {
    const input = ctx.createGain(), level = ctx.createGain(), trim = ctx.createGain(), s = ctx.createGain();
    level.gain.value = 0; trim.gain.value = gain; s.gain.value = send;
    input.connect(level); level.connect(trim); trim.connect(tone); trim.connect(s); s.connect(revBus);
    L[name] = { input, level };
  }
  // Rhodes: slow stereo tremolo
  const trem = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain();
  if (trem.pan) { const lfo = ctx.createOscillator(); lfo.frequency.value = 0.9; const lg = ctx.createGain(); lg.gain.value = 0.55; lfo.connect(lg); lg.connect(trem.pan); lfo.start(); }
  trem.connect(L.rhodes.input);

  let pending = [];                               // { t, stop } for everything scheduled in the future
  const track = (t, node) => pending.push({ t, node });
  const done = (src, tEnd, ...nodes) => { src.stop(tEnd); src.onended = () => { try { src.disconnect(); for (const n of nodes) n.disconnect(); } catch { /* gone */ } }; };
  const jit = (t) => t + R.range(0, 0.012);

  // ---- voices ---------------------------------------------------------------------------------------------
  /** decaying partial(s): harp, celesta, vibraphone, glass */
  function pluck(dest, t, midi, vel, { tau = 1.1, bright = 0.3, ratio = 2, pan = 0, attack = 0.004 } = {}) {
    const f = mtof(midi), g = ctx.createGain(), o = ctx.createOscillator(), o2 = ctx.createOscillator(), g2 = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f; o2.type = 'sine'; o2.frequency.value = f * ratio;
    const k = tau * clamp(1.5 - (midi - 48) / 60, 0.5, 1.6);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel, t + attack); g.gain.setTargetAtTime(0, t + attack, k);
    g2.gain.setValueAtTime(bright, t); g2.gain.setTargetAtTime(0, t, k * 0.22);
    o.connect(g); o2.connect(g2); g2.connect(g);
    let last = g; if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; }
    last.connect(dest); o.start(t); o2.start(t); done(o, t + k * 6 + 0.2, g, g2, last); o2.stop(t + k * 2 + 0.2); track(t, o); track(t, o2);
  }
  /** 2-operator FM electric piano */
  function rhodes(t, midi, vel, dur) {
    const f = mtof(midi), car = ctx.createOscillator(), mod = ctx.createOscillator(), idx = ctx.createGain(), g = ctx.createGain();
    car.frequency.value = f; mod.frequency.value = f; idx.gain.setValueAtTime(f * (0.9 + 1.9 * vel), t); idx.gain.setTargetAtTime(f * 0.22, t, 0.32);
    mod.connect(idx); idx.connect(car.frequency);
    const tine = ctx.createOscillator(), tg = ctx.createGain(); tine.frequency.value = f * 4; tg.gain.setValueAtTime(vel * 0.1, t); tg.gain.setTargetAtTime(0, t, 0.07); tine.connect(tg); tg.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vel * 0.5, t + 0.006); g.gain.setTargetAtTime(vel * 0.16, t + 0.006, 1.1); g.gain.setTargetAtTime(0, t + dur, 0.22);
    car.connect(g); g.connect(trem); car.start(t); mod.start(t); tine.start(t); tine.stop(t + 0.6); mod.stop(t + dur + 1.6); done(car, t + dur + 1.6, g, idx, tg); track(t, car); track(t, mod); track(t, tine);
  }
  /** upright bass: plucked or bowed */
  function bass(t, midi, vel, dur, bowed = false) {
    const f = mtof(midi), o = ctx.createOscillator(), o2 = ctx.createOscillator(), lp = ctx.createBiquadFilter(), g = ctx.createGain(), g2 = ctx.createGain();
    o.type = 'sine'; o2.type = bowed ? 'sawtooth' : 'triangle'; lp.type = 'lowpass'; lp.frequency.value = bowed ? 520 : 760; lp.Q.value = 0.6;
    o.frequency.setValueAtTime(f * (bowed ? 1 : 0.972), t); o.frequency.exponentialRampToValueAtTime(f, t + 0.028); o2.frequency.value = f;
    g2.gain.value = bowed ? 0.22 : 0.42; o2.connect(lp); lp.connect(g2); g2.connect(g); o.connect(g);
    g.gain.setValueAtTime(0, t);
    if (bowed) { g.gain.linearRampToValueAtTime(vel * 0.55, t + 0.5); g.gain.setTargetAtTime(0, t + dur, 0.5); }
    else { g.gain.linearRampToValueAtTime(vel * 0.8, t + 0.007); g.gain.setTargetAtTime(vel * 0.28, t + 0.007, 0.22); g.gain.setTargetAtTime(0, t + dur, 0.07); }
    g.connect(L.bass.input); o.start(t); o2.start(t); const end = t + dur + (bowed ? 3 : 0.5); o2.stop(end); done(o, end, g, g2, lp); track(t, o); track(t, o2);
  }
  /** string / choir pad chord */
  function pad(dest, t, notes, dur, { cutoff = 1100, attack = 1.3, release = 2.0, gain = 0.2, formant = false } = {}) {
    const g = ctx.createGain(), f = ctx.createBiquadFilter(); f.type = formant ? 'bandpass' : 'lowpass'; f.frequency.value = cutoff; f.Q.value = formant ? 0.9 : 0.4;
    if (!formant) { f.frequency.setValueAtTime(cutoff * 0.55, t); f.frequency.linearRampToValueAtTime(cutoff, t + attack * 1.4); }
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(gain, t + attack); g.gain.setTargetAtTime(0, t + dur, release / 3);
    f.connect(g); g.connect(dest);
    const end = t + dur + release * 1.6; let first = null;
    for (const m of notes) for (const det of [-7, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det + R.range(-2, 2);
      o.connect(f); o.start(t); if (first) o.stop(end); else first = o; track(t, o);
    }
    if (first) done(first, end, g, f);
  }
  function drum(t, name, vel = 0.8, pan = 0, rate = 1) {
    const b = kit[name]; if (!b) return; const s = ctx.createBufferSource(), g = ctx.createGain(); s.buffer = b; s.playbackRate.value = rate; g.gain.value = vel;
    s.connect(g); let last = g; if (pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); last = p; }
    last.connect(L.drums.input); s.start(t); s.onended = () => { try { s.disconnect(); g.disconnect(); last.disconnect(); } catch { /* gone */ } }; track(t, s);
  }
  /** cymbal / noise swell: crescendo of `lead` seconds ending at t (optionally crashing) */
  function swell(t, lead, peak = 0.5, tail = 3.5, dest = L.fx.input) {
    const s = ctx.createBufferSource(), g = ctx.createGain(), hp = ctx.createBiquadFilter(); s.buffer = kit.wash || noise; s.loop = true; hp.type = 'highpass';
    hp.frequency.setValueAtTime(5000, t - lead); hp.frequency.exponentialRampToValueAtTime(900, t);
    g.gain.setValueAtTime(0.0001, t - lead); g.gain.exponentialRampToValueAtTime(peak, t); g.gain.setTargetAtTime(0, t, tail / 3.5);
    s.connect(hp); hp.connect(g); g.connect(dest); s.start(Math.max(ctx.currentTime, t - lead)); done(s, t + tail * 1.6, g, hp);
  }
  function whoosh(t, dur, f0 = 300, f1 = 3800, peak = 0.3) {
    const s = ctx.createBufferSource(), g = ctx.createGain(), bp = ctx.createBiquadFilter(); s.buffer = noise; s.loop = true; bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + dur * 0.7); g.gain.setTargetAtTime(0, t + dur * 0.75, dur * 0.12);
    s.connect(bp); bp.connect(g); g.connect(L.fx.input); s.start(t); done(s, t + dur * 1.8, g, bp);
  }
  function gliss(t, ch, lo, hi, n = 18, step = 0.042, vel = 0.3, down = false) {
    const lad = ladder(ch, lo, hi, 'pent'); if (!lad.length) return;
    for (let i = 0; i < n; i++) { const k = Math.round((i / (n - 1)) * (lad.length - 1)); const m = lad[down ? lad.length - 1 - k : k]; pluck(L.harp.input, t + i * step, m, vel * (0.5 + 0.5 * (i / n)), { tau: 1.2, pan: -0.6 + (1.2 * i) / n }); }
  }

  // ---- drone (persistent) -----------------------------------------------------------------------------------
  {
    const mk = (midi, g0, det = 0) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = mtof(midi); o.detune.value = det; g.gain.value = g0; o.connect(g); g.connect(L.drone.input); o.start(); return o; };
    mk(26, 0.5); mk(38, 0.42, -4); mk(38, 0.3, 5); mk(45, 0.2, 3); mk(50, 0.07, -6);
    const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain(); s.buffer = noise; s.loop = true; bp.type = 'bandpass'; bp.frequency.value = 520; bp.Q.value = 2.2; g.gain.value = 0.05;
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.07; lg.gain.value = 260; lfo.connect(lg); lg.connect(bp.frequency); lfo.start();
    s.connect(bp); bp.connect(g); g.connect(L.drone.input); s.start();
  }

  // ---- guitar: string-model worklet → tube stage → cabinet → Uni-Vibe → tape echo ------------------------------
  const gtr = { node: null, pre: ctx.createGain(), post: ctx.createGain() };
  try {
    await ctx.audioWorklet.addModule(new URL('../worklets/string.js', import.meta.url));
    gtr.node = new AudioWorkletNode(ctx, 'selah-string', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    const shaper = ctx.createWaveShaper(); shaper.curve = tubeCurve(12, 0.16); shaper.oversample = '4x';
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 95;
    const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 2300; mid.Q.value = 0.9; mid.gain.value = 3.5;
    const cab = ctx.createBiquadFilter(); cab.type = 'lowpass'; cab.frequency.value = 4300; cab.Q.value = 0.7;
    gtr.node.connect(gtr.pre); gtr.pre.connect(shaper); shaper.connect(hp); hp.connect(mid); mid.connect(cab); cab.connect(gtr.post);
    // Uni-Vibe: four all-pass stages swept by a slow LFO, mixed with the dry signal
    const vibeIn = gtr.post, wet = ctx.createGain(); wet.gain.value = 0.55; let prev = vibeIn;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.85; lfo.start();
    [520, 880, 1350, 2050].forEach((fc, i) => { const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.frequency.value = fc; ap.Q.value = 0.6; const lg = ctx.createGain(); lg.gain.value = fc * (0.42 + 0.06 * i); lfo.connect(lg); lg.connect(ap.frequency); prev.connect(ap); prev = ap; });
    prev.connect(wet); wet.connect(L.gtr.input); vibeIn.connect(L.gtr.input);
    const dl = ctx.createDelay(1.2), fb = ctx.createGain(), dlp = ctx.createBiquadFilter(), dg = ctx.createGain(); dl.delayTime.value = 0.36; fb.gain.value = 0.3; dlp.type = 'lowpass'; dlp.frequency.value = 2400; dg.gain.value = 0.26;
    vibeIn.connect(dl); dl.connect(dlp); dlp.connect(fb); fb.connect(dl); dlp.connect(dg); dg.connect(L.gtr.input);
  } catch (e) { console.warn('[music] guitar worklet unavailable:', e && e.message); }
  let drive = 0;
  function setDrive(x, t = ctx.currentTime) { drive = x; gtr.pre.gain.setTargetAtTime(0.07 + 0.75 * x * x, t, 0.15); gtr.post.gain.setTargetAtTime(1.5 - 1.05 * x, t, 0.15); }
  setDrive(0);
  function pick(t, midi, vel, dur, o = {}) { if (gtr.node) gtr.node.port.postMessage({ type: 'note', t, midi, vel, dur, bright: 0.5 + 0.3 * vel, ...o }); }
  /** amp feedback: a harmonic blooms out of a held note (a sine pushed through the same tube stage) */
  function bloom(t, midi, dur, level = 0.35) {
    if (!gtr.node) return; const o = ctx.createOscillator(), g = ctx.createGain(), v = ctx.createOscillator(), vg = ctx.createGain();
    o.frequency.value = mtof(midi); v.frequency.value = 5.2; vg.gain.value = mtof(midi) * 0.006; v.connect(vg); vg.connect(o.frequency);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(level, t + dur * 0.55); g.gain.setTargetAtTime(0, t + dur, 0.5);
    o.connect(g); g.connect(gtr.pre); o.start(t); v.start(t); v.stop(t + dur + 2.5); done(o, t + dur + 2.5, g, vg); track(t, o);
  }

  // ---- arranger -----------------------------------------------------------------------------------------------
  const st = { scene: 'void', bar: 0, barTime: 0, bpm: SCENES.void.bpm, intensity: 0.6, started: false, chord: null, prevPad: null, prevKeys: null, lastLead: 72, arp: 0, params: {} };
  const beatCbs = new Set();

  function applyMix(scene, fade) {
    const mix = SCENES[scene].mix, t = ctx.currentTime;
    for (const name in L) { const p = L[name].level.gain; p.cancelScheduledValues(t); p.setTargetAtTime(name === 'fx' ? 1 : mix[name] || 0, t, Math.max(0.03, fade / 3)); }
    setDrive(scene === 'ride' || scene === 'title' ? 0.85 : scene === 'surface' ? 0.3 : 0.1, t);
  }

  function scheduleBar(t0) {
    const sc = SCENES[st.scene], spb = 60 / st.bpm, barDur = 4 * spb, I = st.intensity, mix = sc.mix;
    const B = H.bar(st.scene, st.bar), segs = B.segs, ch0 = segs[0].ch; st.chord = ch0;
    const chordAt = (beat) => { let c = segs[0].ch; for (const s of segs) if (s.frac * 4 <= beat + 1e-6) c = s.ch; return c; };
    const at = (beat) => { const b = Math.floor(beat), f = beat - b; return t0 + (b + (sc.swing && Math.abs(f - 0.5) < 0.01 ? sc.swing : f)) * spb; };
    const tonic = (oct) => H.tonic(oct);
    for (let b = 0; b < 4; b++) { const tb = t0 + b * spb, bar = st.bar; for (const fn of beatCbs) { const info = { bar, beat: b, time: tb }; if (!engine.offline) setTimeout(() => fn(info), Math.max(0, (tb - ctx.currentTime - 0.03) * 1000)); } }

    // pad / choir: one voice-led chord per harmony segment
    if (mix.pad || mix.choir) segs.forEach((s, i) => {
      const t = t0 + s.frac * barDur, dur = ((segs[i + 1]?.frac ?? 1) - s.frac) * barDur;
      const v = voicing(s.ch, { lo: 53, hi: 74, n: 4, prev: st.prevPad }); st.prevPad = v;
      if (mix.pad) pad(L.pad.input, t, v, dur, { cutoff: 700 + 1500 * I, gain: 0.16 });
      if (mix.choir && i === 0) pad(L.choir.input, t, [v[v.length - 1] + 12, v[v.length - 2] + 12], barDur, { cutoff: 1250, formant: true, attack: 1.8, release: 3, gain: 0.5 });
    });

    // Rhodes
    if (mix.rhodes) {
      const cells = st.scene === 'ride' ? [[0, 1.5, 3.5], [0.5, 2, 3.5], [0, 2.5]] : st.scene === 'galaxy' || st.scene === 'surface' ? [[0, 2.5], [0, 1.5, 3], [0.5, 2.5], [0, 3.5]] : [[0], [0, 2.5]];
      for (const beat of R.pick(cells)) {
        const c = chordAt(beat), v = voicing(c, { lo: 55, hi: 77, n: 4, prev: st.prevKeys }); st.prevKeys = v;
        const roll = st.scene === 'web' || st.scene === 'system' || st.scene === 'orbit' ? 0.045 : 0.008, vel = (beat === 0 ? 0.62 : 0.46) * (0.8 + 0.4 * R());
        v.forEach((m, i) => rhodes(jit(at(beat)) + i * roll, m, vel * (i === v.length - 1 ? 1.1 : 0.85), spb * (beat === 0 ? 2.6 : 1.2)));
      }
    }

    // harp
    if (mix.harp) {
      if (st.scene === 'web') {
        for (let i = 0; i < 8; i++) {
          if (R.chance(0.14)) { st.arp++; continue; }
          const c = chordAt(i / 2), lad = ladder(c, 54, 81, 'pent'); if (!lad.length) continue;
          const wave = Math.sin(st.arp * 0.5) * 0.5 + 0.5, k = Math.round(wave * (lad.length - 1)); st.arp++;
          pluck(L.harp.input, jit(t0 + i * spb * 0.5), lad[k], 0.2 + 0.16 * wave + (i % 4 === 0 ? 0.08 : 0), { tau: 1.4, pan: -0.5 + wave });
        }
      } else if ((st.scene === 'genesis' || st.scene === 'title') && st.bar % 2 === 0) gliss(t0 + 0.02, ch0, 50, 93, 22, st.scene === 'title' ? 0.05 : 0.07, 0.3);
      else if (R.chance(0.3)) gliss(at(3), chordAt(3), 62, 86, 7, 0.07, 0.2, R.chance(0.5));
    }

    // bells: glass in the void, the theme in system / galaxy, sparkles elsewhere
    if (mix.bell) {
      if (st.scene === 'system' || (st.scene === 'galaxy' && B.pos < 8 && Math.floor(st.bar / 16) % 2 === 0)) {
        for (const [beat, dur, semi] of THEME[st.bar % 8]) pluck(L.bell.input, jit(at(beat)), tonic(5) + semi, 0.28, { tau: 0.8 + 0.25 * dur, ratio: 4, bright: 0.22, pan: 0.2 });
      } else {
        const n = st.scene === 'void' || st.scene === 'blackhole' ? 1 : 2, lad = ladder(ch0, 74, 96, 'pent');
        for (let i = 0; i < n; i++) if (R.chance(0.6) && lad.length) pluck(L.bell.input, t0 + R.range(0, barDur), R.pick(lad), 0.12 + 0.1 * R(), { tau: 2.2, ratio: 3.01, bright: 0.12, pan: R.range(-0.7, 0.7) });
      }
    }

    // bass
    if (mix.bass) {
      const root = (c) => nearestPc(c.bass, 38), next = H.peek(st.scene, st.bar), nr = nearestPc(next.bass, 38);
      if (st.scene === 'web') bass(t0, root(ch0), 0.6, barDur * 0.95, true);
      else if (st.scene === 'ride') {
        for (let i = 0; i < 8; i++) { const c = chordAt(i / 2), r = root(c); bass(jit(t0 + i * spb * 0.5), i === 7 ? nr + (R.chance(0.5) ? -1 : 1) : i % 4 === 3 ? r + 12 : i % 4 === 2 ? nearestPc(c.fifth, r + 6) : r, i % 2 ? 0.5 : 0.72, spb * 0.42); }
      } else if (st.scene === 'surface') {
        for (const [beat, kind] of [[0, 0], [1.5, 1], [2, 0], [3.5, 2]]) { const c = chordAt(beat), r = root(c); bass(jit(at(beat)), kind === 0 ? r : kind === 1 ? nearestPc(c.fifth, r + 6) : nr + (nr > r ? -1 : 1), kind === 0 ? 0.72 : 0.5, spb * (kind === 0 ? 1.2 : 0.45)); }
      } else if (st.scene === 'galaxy') {
        bass(jit(t0), root(ch0), 0.7, spb * 1.8); const c2 = chordAt(2); bass(jit(at(2)), segs.length > 1 ? root(c2) : nearestPc(c2.fifth, root(c2) + 6), 0.55, spb * 1.4);
        if (R.chance(0.55)) bass(jit(at(3.5)), nr + (R.chance(0.5) ? -1 : 2), 0.42, spb * 0.45);
      } else { bass(jit(t0), root(ch0), 0.62, spb * 3.4); if (segs.length > 1) bass(jit(at(2)), root(chordAt(2)), 0.5, spb * 1.6); }
    }

    // drums
    if (mix.drums) {
      const D = (beat, n, v, pan, rate) => drum(jit(at(beat)), n, v * (0.85 + 0.3 * R()), pan, rate);
      if (st.scene === 'galaxy') {
        for (let b = 0; b < 4; b++) { D(b, 'ride', b % 2 ? 0.34 : 0.26, 0.25); if (b % 2 && R.chance(0.8)) D(b + 0.5, 'ride', 0.16, 0.25); }
        D(1, 'sweep', 0.3, -0.2); D(3, 'sweep', 0.3, -0.2); D(0, 'kick', 0.22); if (R.chance(0.3)) D(3.5, 'tap', 0.22, -0.15); if (B.last) D(3, 'rim', 0.3, 0.1);
      } else if (st.scene === 'surface') {
        D(0, 'kick', 0.6); D(2.5, 'kick', 0.45); D(1, 'rim', 0.4, -0.1); D(3, 'rim', 0.42, -0.1);
        for (let i = 0; i < 8; i++) D(i * 0.5, 'shaker', i % 2 ? 0.2 : 0.3, 0.35);
        if (R.chance(0.5)) { D(3.5, 'conga', 0.4, 0.3); D(3.75, 'slap', 0.25, 0.3); } if (st.bar % 4 === 3) D(3.25, 'conga', 0.3, 0.3, 1.2);
      } else if (st.scene === 'ride') {
        D(0, 'kick', 0.75); D(1.5, 'kick', 0.5); D(2, 'kick', 0.62); D(1, 'snare', 0.5, -0.05); D(3, 'snare', 0.55, -0.05);
        for (let i = 0; i < 8; i++) D(i * 0.5, i === 7 ? 'hatOpen' : 'hat', (i % 2 ? 0.18 : 0.3) * (0.7 + 0.6 * I), 0.3);
        if (st.bar % 4 === 3) { D(3.5, 'snare', 0.4, -0.05); D(3.75, 'tom', 0.45, 0.2); }
      } else if (st.scene === 'title') {
        D(0, 'tom', 0.7, 0, 0.8); D(0, 'ride', 0.3, 0.2); D(2, 'ride', 0.22, 0.2); if (st.bar % 2 === 1) swell(t0 + barDur, barDur * 0.9, 0.3, 3, L.drums.input);
        if (B.once && (st.bar === 0 || st.bar === 4)) D(0, 'kickDeep', 0.9);
      } else { D(0, 'ride', 0.22, 0.2); if (R.chance(0.5)) D(2, 'ride', 0.15, 0.2); }
    }

    // guitar
    if (mix.gtr && gtr.node) {
      if (st.scene === 'orbit') {
        // chord-melody: thumb bass + double-stop under the theme, with hammer-on graces and singing long notes
        const r = nearestPc(ch0.bass, 45), third = nearestPc(ch0.third, r + 16), fifth = nearestPc(ch0.fifth, r + 7);
        pick(jit(t0), r, 0.62, spb * 3, { bright: 0.45, pick: 0.25 }); pick(t0 + 0.028, fifth, 0.45, spb * 2.2, { bright: 0.5 }); pick(t0 + 0.05, third, 0.5, spb * 2.2, { bright: 0.55 });
        for (const [beat, dur, semi] of THEME[st.bar % 8]) {
          const grace = R.chance(0.4) && dur >= 0.5;
          pick(jit(at(beat)), tonic(4) + semi, 0.6 + 0.2 * R(), dur * spb * 1.05, { bright: 0.72, pick: 0.14, bendFrom: grace ? -2 : 0, bendTime: 0.055, vibDepth: dur >= 1 ? 0.16 : 0, vibRate: 5.1, vibDelay: 0.22 });
        }
        if (segs.length > 1) { const c = chordAt(2), rr = nearestPc(c.bass, 45); pick(jit(at(2)), rr, 0.5, spb * 1.8, { bright: 0.45 }); pick(at(2) + 0.03, nearestPc(c.third, rr + 16), 0.42, spb * 1.5); }
      } else if (st.scene === 'title' && B.once) {
        for (const [beat, dur, semi, art] of CLIMAX[st.bar] || []) {
          const m = tonic(4) + semi, t = at(beat), d = dur * spb;
          pick(t, m, 0.9, d * 1.02, { bright: 0.8, pick: 0.12, sustain: true, bendFrom: art === 'bend2' ? -2 : 0, bendTime: 0.28, vibDepth: art || dur >= 1 ? 0.3 : 0.1, vibRate: 5.6, vibDelay: art === 'bend2' ? 0.4 : 0.25 });
          if (art === 'bloom') { bloom(t + 1.2, m + 12, d - 1.0, 0.3); bloom(t + d * 0.45, m + 19, d * 0.5, 0.16); }
        }
      } else if (st.scene === 'ride' || st.scene === 'title') {
        // generative lead: a short pentatonic phrase every other bar, bends into chord tones, vibrato on the last note
        if (st.bar % 2 === 0 || R.chance(0.25)) {
          const lad = ladder(ch0, 64, 88, 'pent'); if (lad.length > 3) {
            let k = clamp(nearestIndex(lad, st.lastLead) + R.int(3) - 1, 0, lad.length - 1), beat = R.pick([0, 0.5, 1]); const n = 3 + R.int(4);
            for (let i = 0; i < n && beat < 3.8; i++) {
              const lastNote = i === n - 1, d = lastNote ? 1.5 + R() : R.pick([0.5, 0.5, 0.75, 1]);
              k = clamp(k + R.pick([-2, -1, -1, 1, 1, 2]), 0, lad.length - 1);
              const bend = R.chance(0.34) && k > 0 ? lad[k - 1] - lad[k] : 0;
              pick(jit(at(beat)), lad[k], 0.75 + 0.2 * R(), d * spb, { bright: 0.78, sustain: lastNote, bendFrom: Math.max(-3, bend), bendTime: 0.16, vibDepth: lastNote ? 0.32 : 0.08, vibRate: 5.7, vibDelay: 0.2 });
              if (lastNote && R.chance(0.35)) bloom(at(beat) + 0.6, lad[k] + 12, d * spb, 0.16);
              beat += d; st.lastLead = lad[k];
            }
          }
        }
      } else if (st.scene === 'surface' && (st.bar % 4 === 3 || R.chance(0.15))) {
        // clean double-stop fills: sliding sixths / fourths
        const lad = ladder(chordAt(2), 59, 81, 'pent'); let k = R.int(Math.max(1, lad.length - 4));
        for (let i = 0; i < 3 && k + 3 < lad.length; i++) { const t = jit(at(2 + i * 0.5)); pick(t, lad[k], 0.5, spb * 0.6, { bendFrom: i ? -2 : 0, bendTime: 0.07 }); pick(t + 0.012, lad[k + 3], 0.5, spb * 0.6, { bendFrom: i ? -2 : 0, bendTime: 0.07 }); k += R.pick([1, 1, -1]); if (k < 0) k = 0; }
      }
    }
  }

  let timer = null;
  const music = {
    start() { if (st.started) return; st.started = true; st.barTime = ctx.currentTime + 0.15; applyMix(st.scene, 1.5); if (!engine.offline) timer = setInterval(() => music.scheduleUntil(ctx.currentTime + 0.45), 90); },
    stop(fade = 3) { const t = ctx.currentTime; for (const name in L) L[name].level.gain.setTargetAtTime(0, t, fade / 3); clearInterval(timer); timer = null; st.started = false; },
    scheduleUntil(t) {
      if (!st.started) return; let guard = 0;
      if (st.barTime < ctx.currentTime - 0.5) st.barTime = ctx.currentTime + 0.05;       // tab was asleep: don't replay the past
      while (st.barTime < t && guard++ < 8) { try { scheduleBar(st.barTime); } catch (e) { console.error('[music]', e); } st.barTime += 240 / st.bpm; st.bar++; }
      if (pending.length > 600) { const now = ctx.currentTime; pending = pending.filter((p) => p.t > now); }
    },
    setScene(name, { fade = 4 } = {}) {
      if (!SCENES[name] || name === st.scene) return;
      const now = ctx.currentTime;
      // drop what was scheduled for the old scene but has not sounded yet, then begin the new form right away
      for (const p of pending) if (p.t > now + 0.03) { try { p.node.stop(now); } catch { /* not started */ } }
      pending = []; gtr.node?.port.postMessage({ type: 'flush', after: now + 0.03 });
      st.scene = name; st.bar = 0; st.bpm = SCENES[name].bpm; st.barTime = now + 0.12; st.prevPad = st.prevKeys = null; H.enter(name);
      applyMix(name, fade);
      if (st.started) music.scheduleUntil(now + 0.45);
    },
    setIntensity(x) { st.intensity = clamp(x, 0, 1); },
    setParam(name, v) { st.params[name] = v; if (name === 'speed') st.intensity = clamp(0.4 + 0.6 * v, 0, 1); },
    getState() { return { scene: st.scene, bpm: st.bpm, bar: st.bar, beat: 0, chord: st.chord?.name || '', key: H.keyName(), time: ctx.currentTime }; },
    onBeat(fn) { beatCbs.add(fn); return () => beatCbs.delete(fn); },
    cue(name, o = {}) {
      const t = ctx.currentTime + 0.06, ch = st.chord || H.peek(st.scene, -1);
      switch (name) {
        case 'bigbang': {
          const lead = o.lead ?? 2.5, T = t + lead;
          swell(T, lead, 0.55, 5); whoosh(t, lead, 120, 2600, 0.22);
          drum(T, 'kickDeep', 1.0); drum(T, 'tom', 0.8, 0, 0.6);
          const s = ctx.createOscillator(), g = ctx.createGain(); s.frequency.setValueAtTime(82, T); s.frequency.exponentialRampToValueAtTime(27, T + 2.6);
          g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(0.85, T + 0.02); g.gain.setTargetAtTime(0, T + 0.3, 1.1); s.connect(g); g.connect(L.fx.input); s.start(T); done(s, T + 7, g);
          gliss(T + 0.05, ch, 50, 98, 30, 0.035, 0.4); pad(L.fx.input, T, [50, 57, 66, 73, 76], 6, { cutoff: 2600, attack: 0.05, release: 6, gain: 0.2 });
          break;
        }
        case 'dive': gliss(t, ch, 55, 93, 20, 0.036, 0.3); whoosh(t, 1.9, 260, 4200, 0.2); break;
        case 'arrival': { const v = voicing(ch, { lo: 67, hi: 88, n: 4 }); v.reverse().forEach((m, i) => pluck(L.bell.input, t + i * 0.11, m, 0.3, { tau: 1.8, ratio: 4, bright: 0.2, pan: -0.4 + 0.27 * i })); whoosh(t, 1.6, 3200, 300, 0.13); break; }
        case 'sunrise': swell(t + 4.2, 4.2, 0.36, 5); gliss(t + 1.4, ch, 52, 90, 16, 0.16, 0.26); bass(t + 4.2, nearestPc(ch.bass, 38), 0.7, 4, true); break;
        case 'title': swell(t + 0.9, 0.9, 0.5, 5); drum(t + 0.9, 'kickDeep', 0.9); gliss(t + 0.95, ch, 50, 96, 26, 0.04, 0.36); break;
        case 'discover': { const bar = THEME[R.int(8)], n = Math.min(bar.length, 3 + R.int(2)), spb = 0.42; for (let i = 0; i < n; i++) pluck(L.bell.input, t + (bar[i][0] - bar[0][0]) * spb, H.tonic(5) + bar[i][2], 0.32, { tau: 1.3, ratio: 4, bright: 0.2, pan: 0.3 }); break; }
        case 'land': drum(t, 'tom', 0.6, 0, 0.7); pluck(L.bell.input, t + 0.05, nearestPc(ch.root, 50), 0.4, { tau: 2.4, ratio: 2 }); whoosh(t, 1.2, 2400, 240, 0.14); break;
        case 'takeoff': gliss(t, ch, 50, 90, 16, 0.045, 0.3); swell(t + 1.6, 1.6, 0.34, 3); break;
        default: break;
      }
    },
  };
  return music;
}
