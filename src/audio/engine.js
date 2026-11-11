// Selah — master audio engine.
//
//   buses.{music,voice,sfx,ambience} ─┐
//   reverb (send) → hall convolver ───┼→ glue compressor → soft saturation → limiter → ceiling → volume → master → out
//                                     └ (music passes through a duck gain first)                └→ analyser
//
// Nothing is loaded from disk or network: the reverb impulse response and every instrument are synthesized.
// Works with a normal AudioContext and with an OfflineAudioContext (tests / offline renders).

import { createMusic } from './music/index.js';
import { makeRng, makeReverbIR, tanhCurve, ceilingCurve, dB } from './music/dsp.js';

const BUS_NAMES = ['music', 'voice', 'sfx', 'ambience'];

export async function createAudioEngine(opts = {}) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = opts.context || new AC({ latencyHint: opts.latencyHint || 'interactive' });
  const offline = typeof ctx.startRendering === 'function';
  const seed = opts.seed == null ? 20260311 : opts.seed;
  const rng = makeRng(seed);

  // ---- master chain -------------------------------------------------------------------------------------
  const sum = ctx.createGain();
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -21; glue.knee.value = 14; glue.ratio.value = 2.2; glue.attack.value = 0.03; glue.release.value = 0.28;
  const glueTrim = ctx.createGain(); glueTrim.gain.value = dB(-GLUE_MAKEUP_DB);        // undo the node's built-in make-up
  const sat = ctx.createWaveShaper(); sat.curve = tanhCurve(0.9); sat.oversample = '2x';
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -5; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.0015; limiter.release.value = 0.11;
  const limTrim = ctx.createGain(); limTrim.gain.value = dB(-LIMITER_MAKEUP_DB);
  const ceiling = ctx.createWaveShaper(); ceiling.curve = ceilingCurve(0.62, 0.8); ceiling.oversample = '4x';
  const volume = ctx.createGain();
  const master = ctx.createGain();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.8;
  sum.connect(glue); glue.connect(glueTrim); glueTrim.connect(sat); sat.connect(limiter); limiter.connect(limTrim);
  limTrim.connect(ceiling); ceiling.connect(volume); volume.connect(master); master.connect(ctx.destination);
  ceiling.connect(analyser);                                            // pre-volume, so visuals keep reacting when muted

  // ---- buses --------------------------------------------------------------------------------------------
  const buses = {};
  for (const name of BUS_NAMES) { buses[name] = ctx.createGain(); }
  const musicDuck = ctx.createGain();
  buses.music.connect(musicDuck); musicDuck.connect(sum);
  buses.voice.connect(sum); buses.sfx.connect(sum); buses.ambience.connect(sum);

  // ---- shared "deep space / cathedral" reverb send --------------------------------------------------------
  const reverb = ctx.createGain();                                      // send input (public)
  const revHP = ctx.createBiquadFilter(); revHP.type = 'highpass'; revHP.frequency.value = 160; revHP.Q.value = 0.5;
  const revLP = ctx.createBiquadFilter(); revLP.type = 'lowpass'; revLP.frequency.value = 8500; revLP.Q.value = 0.5;
  const conv = ctx.createConvolver(); conv.normalize = false;
  conv.buffer = makeReverbIR(ctx, { seconds: 6.2, rt60: 5.6, bright: 8500, dark: 1300, darkTime: 1.7 }, rng.fork('hall'));
  const revReturn = ctx.createGain(); revReturn.gain.value = 0.9;
  reverb.connect(revHP); revHP.connect(revLP); revLP.connect(conv); conv.connect(revReturn); revReturn.connect(sum);

  // ---- volume / mute / duck -------------------------------------------------------------------------------
  let vol = opts.volume == null ? 1 : opts.volume, muted = false;
  volume.gain.value = vol;
  const applyVolume = (tc = 0.05) => {
    const t = ctx.currentTime, g = muted ? 0 : vol;
    volume.gain.cancelScheduledValues(t);
    volume.gain.setTargetAtTime(g, t, tc);
  };
  const ducks = new Set();
  const applyDuck = (tc) => {
    let d = 0;
    for (const k of ducks) if (k.db < d) d = k.db;
    const t = ctx.currentTime;
    musicDuck.gain.cancelScheduledValues(t);
    musicDuck.gain.setTargetAtTime(dB(d), t, Math.max(0.01, tc / 3));
  };

  const engine = {
    ctx, buses, reverb, master, analyser, offline, seed,
    /** internal nodes, exposed for tools/tests */
    nodes: { sum, glue, sat, limiter, ceiling, volume, musicDuck, convolver: conv, revReturn },
    setVolume(v) { vol = Math.min(1, Math.max(0, +v || 0)); applyVolume(0.06); },
    getVolume() { return vol; },
    setMuted(m) { muted = !!m; applyVolume(0.04); },
    isMuted() { return muted; },
    /** Duck the MUSIC bus by `db` (negative) — returns a function that releases this duck. */
    duck(db = -7, attack = 0.35, release = 1.4) {
      const k = { db: Math.min(0, db) };
      ducks.add(k); applyDuck(attack);
      let done = false;
      return () => { if (done) return; done = true; ducks.delete(k); applyDuck(release); };
    },
    async resume() { if (!offline && ctx.state !== 'running') { try { await ctx.resume(); } catch (e) { /* needs a gesture */ } } },
    suspend() { if (!offline && ctx.state === 'running') return ctx.suspend(); },
    music: null,
  };

  engine.music = await createMusic(engine, { seed, rng: rng.fork('music'), ...(opts.music || {}) });
  return engine;
}

// Chrome/WebKit/Gecko share one DynamicsCompressor design with automatic make-up gain; these constants undo it
// so that quiet material passes the master chain at unity (measured with tools/audio/render.cjs --calibrate).
const GLUE_MAKEUP_DB = 4.6;
const LIMITER_MAKEUP_DB = 2.85;

export default createAudioEngine;
