// Narrator — plays the pre-rendered narration lines (assets/voice/**, see tools/voice) with exact caption timing.
// The files are dry; space is added here: a touch of presence EQ, a send into the shared deep reverb, and a faint wide
// "aura" (two short modulated delays) so the voice seems to come from everywhere without losing intelligibility.
// Fallbacks: missing/undecodable audio → speechSynthesis if available → captions only (manifest timings).

export async function createNarrator({ ctx, output, reverbSend = null, baseUrl = null, voice = null } = {}) {
  const base = baseUrl || new URL('../../assets/voice/', import.meta.url);
  let manifest = { default: 'none', voices: {} };
  try { manifest = await (await fetch(new URL('manifest.json', base))).json(); } catch (e) { console.warn('[narrator] no manifest', e.message); }
  const voices = Object.keys(manifest.voices);
  let current = voice && manifest.voices[voice] ? voice : manifest.default;
  let enabled = true;
  const buffers = new Map();     // `${voice}/${id}` → AudioBuffer | null (failed)
  const listeners = new Map();
  const emit = (type, data) => { const s = listeners.get(type); if (s) for (const fn of [...s]) { try { fn(data); } catch (e) { console.error(e); } } };

  // ---- voice chain --------------------------------------------------------------------------------------
  const input = ctx.createGain();
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 170; low.gain.value = 1.5;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 5200; air.gain.value = 2.5;
  const dry = ctx.createGain(); dry.gain.value = 1.0;
  input.connect(low); low.connect(air); air.connect(dry); dry.connect(output);
  const send = ctx.createGain(); send.gain.value = 0.2; air.connect(send);
  if (reverbSend) send.connect(reverbSend);
  else { // small internal hall
    const len = Math.floor(ctx.sampleRate * 3.2), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); let s = 12345 + c * 777; for (let i = 0; i < len; i++) { s = (s * 1664525 + 1013904223) >>> 0; d[i] = ((s / 4294967296) * 2 - 1) * Math.pow(1 - i / len, 2.6) * 0.5; } }
    const conv = ctx.createConvolver(); conv.buffer = ir; const ret = ctx.createGain(); ret.gain.value = 0.5;
    send.connect(conv); conv.connect(ret); ret.connect(output);
  }
  const aura = ctx.createGain(); aura.gain.value = 0.16; air.connect(aura);
  [[0.023, -0.9, 0.11], [0.031, 0.9, 0.17]].forEach(([time, pan, rate]) => {
    const d = ctx.createDelay(0.1); d.delayTime.value = time;
    const lfo = ctx.createOscillator(); lfo.frequency.value = rate; const lg = ctx.createGain(); lg.gain.value = 0.0016; lfo.connect(lg); lg.connect(d.delayTime); lfo.start();
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : ctx.createGain(); if (p.pan) p.pan.value = pan;
    aura.connect(d); d.connect(p); p.connect(output);
  });

  const line = (id) => manifest.voices[current]?.lines[id] || null;
  async function load(id, v = current) {
    const key = `${v}/${id}`; if (buffers.has(key)) return buffers.get(key);
    const L = manifest.voices[v]?.lines[id]; if (!L) { buffers.set(key, null); return null; }
    const p = (async () => {
      try { const ab = await (await fetch(new URL(L.file, base))).arrayBuffer(); return await ctx.decodeAudioData(ab); }
      catch (e) { console.warn('[narrator] could not load', key, e.message); return null; }
    })();
    buffers.set(key, p); const b = await p; buffers.set(key, b); return b;
  }

  const active = new Set();
  let ticking = false;
  function tick() {
    if (!active.size) { ticking = false; return; }
    const now = ctx.currentTime;
    for (const h of active) {
      const t = now - h.startTime;
      while (h._i < h._caps.length && t >= h._caps[h._i].t0) { const c = h._caps[h._i]; emit('caption', { id: h.id, text: c.text, t0: c.t0, t1: c.t1, index: h._i, total: h._caps.length }); h._open = h._i; h._i++; }
      if (h._open >= 0 && t >= h._caps[h._open].t1 + 0.35 && (h._i >= h._caps.length || t < h._caps[h._i].t0)) { emit('captionend', { id: h.id, index: h._open }); h._open = -1; }
      if (!h._started && t >= 0) { h._started = true; emit('linestart', { id: h.id }); }
      if (t >= h.duration + 0.05) finish(h);
    }
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(tick); else setTimeout(tick, 60);
  }
  function finish(h) {
    if (!active.has(h)) return; active.delete(h);
    if (h._open >= 0) emit('captionend', { id: h.id, index: h._open });
    emit('lineend', { id: h.id }); h._resolve();
  }

  const api = {
    manifest, voices,
    get voice() { return current; },
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    duration(id) { return line(id)?.duration ?? 0; },
    captions(id) { return line(id)?.captions ?? []; },
    async preload(ids) { const L = manifest.voices[current]?.lines || {}; await Promise.all((ids || Object.keys(L).filter((k) => k.startsWith('intro'))).map((id) => load(id))); },
    setVoice(name) { if (manifest.voices[name]) current = name; },
    setEnabled(on) { enabled = !!on; if (!on) api.stop(0.2); },
    /** Speak a line. Returns { id, duration, startTime, ended: Promise, stop(fade) } immediately. */
    say(id, { when = null, gain = 1, reverb = null } = {}) {
      const L = line(id);
      const h = { id, duration: L?.duration ?? 2.5, startTime: when ?? ctx.currentTime + 0.06, _caps: L?.captions || [], _i: 0, _open: -1, _started: false, _src: null, _g: null };
      h.ended = new Promise((r) => (h._resolve = r));
      h.stop = (fade = 0.3) => {
        if (h._g) { const t = ctx.currentTime; h._g.gain.cancelScheduledValues(t); h._g.gain.setTargetAtTime(0, t, fade / 3); try { h._src.stop(t + fade + 0.05); } catch { /* already stopped */ } }
        if (h._utter && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
        finish(h);
      };
      if (!L) { queueMicrotask(() => finish(h)); return h; }
      active.add(h); if (!ticking) { ticking = true; tick(); }
      if (enabled) {
        const key = `${current}/${id}`; const cached = buffers.get(key);
        const start = (buf) => {
          if (!active.has(h)) return;
          if (!buf) { // fall back to the browser's own voice, if it has one
            try {
              if (typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices().length && !ctx.startRendering) {
                const u = new SpeechSynthesisUtterance(L.text.replace(/Selah/g, 'Saylah')); u.rate = 0.82; u.pitch = 0.9; u.volume = 0.9;
                const en = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang)); u.voice = en.find((v) => /Daniel|Google UK English Male|Natural|Serena|Samantha/i.test(v.name)) || en[0] || null;
                h._utter = u; speechSynthesis.speak(u);
              }
            } catch { /* captions only */ }
            return;
          }
          const src = ctx.createBufferSource(); src.buffer = buf; const g = ctx.createGain(); g.gain.value = gain;
          src.connect(g); g.connect(input);
          if (reverb != null) { const extra = ctx.createGain(); extra.gain.value = Math.max(0, reverb - 0.2); g.connect(extra); extra.connect(reverbSend || output); }
          const now = ctx.currentTime;
          if (h.startTime < now) src.start(now, Math.min(buf.duration, now - h.startTime)); else src.start(h.startTime);
          h._src = src; h._g = g;
        };
        if (cached && !(cached instanceof Promise)) start(cached); else load(id).then(start);
      }
      return h;
    },
    stop(fade = 0.3) { for (const h of [...active]) h.stop(fade); },
  };
  return api;
}
