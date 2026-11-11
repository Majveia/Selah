// Plucked-string physical model (extended Karplus–Strong) for the guitar voice.
// Polyphonic, sample-accurate note starts, fractional delay, loop damping (brightness), pick-position comb,
// per-note pitch bends / slides / vibrato (the delay length glides, so legato hammer-ons and bends are continuous),
// and an optional "sustain" mode where the loop barely decays (for singing, feedback-like notes).
//
// port messages: { type:'note', t, midi, vel, dur, bright, pick, bendFrom, bendTime, bendDelay, vibDepth, vibRate, vibDelay, sustain, legato }
//                { type:'off' }  (damp everything)

const SIZE = 4096;

class Voice {
  constructor() { this.buf = new Float32Array(SIZE); this.w = 0; this.active = false; this.age = 0; this.lp = 0; this.level = 0; }
  start(m, sr, legato) {
    this.midi = m.midi; this.vel = m.vel ?? 0.8; this.t = 0; this.dur = m.dur ?? 1; this.sr = sr;
    this.bendFrom = m.bendFrom || 0; this.bendTime = Math.max(0.005, m.bendTime || 0.08); this.bendDelay = m.bendDelay || 0;
    this.vibDepth = m.vibDepth || 0; this.vibRate = m.vibRate || 5.4; this.vibDelay = m.vibDelay ?? 0.18;
    this.bright = Math.min(0.98, Math.max(0.15, m.bright ?? 0.6));
    this.sustain = !!m.sustain; this.released = false; this.active = true; this.age = 0;
    if (legato && this.level > 1e-4) return;          // hammer-on / slide: keep the string ringing, just retune
    const f = 440 * Math.pow(2, (this.midi + this.bendFrom - 69) / 12), len = Math.min(SIZE - 4, sr / f);
    const pick = Math.max(2, Math.floor(len * (m.pick ?? 0.18)));
    // excitation: one period of low-passed noise, combed by the pick position, written behind the write head
    let s = 0, seed = (Math.random() * 4294967296) >>> 0; const n = Math.ceil(len); const ex = new Float32Array(n);
    const soft = 0.25 + 0.6 * this.vel;
    for (let i = 0; i < n; i++) { seed = (seed * 1664525 + 1013904223) >>> 0; const x = (seed / 2147483648 - 1); s += soft * (x - s); ex[i] = s; }
    let peak = 1e-6; for (let i = 0; i < n; i++) { const y = ex[i] - (i >= pick ? ex[i - pick] : 0); ex[i] = y; if (Math.abs(y) > peak) peak = Math.abs(y); }
    const g = (0.35 + 0.65 * this.vel) / peak;
    for (let i = 0; i < n; i++) { const k = (this.w - n + i + SIZE * 2) % SIZE; this.buf[k] = this.buf[k] * 0.3 + ex[i] * g; }
    this.level = 1;
  }
  tick() {
    const sr = this.sr, t = this.t; this.t += 1 / sr;
    let semis = 0;
    if (this.bendFrom) { const u = Math.min(1, Math.max(0, (t - this.bendDelay) / this.bendTime)); semis += this.bendFrom * (1 - u * u * (3 - 2 * u)); }
    if (this.vibDepth && t > this.vibDelay) semis += this.vibDepth * Math.min(1, (t - this.vibDelay) / 0.35) * Math.sin(6.2831853 * this.vibRate * (t - this.vibDelay));
    const f = 440 * Math.pow(2, (this.midi + semis - 69) / 12);
    const len = Math.min(SIZE - 4, Math.max(8, sr / f - 0.5 - (1 - this.bright) * 0.9));
    let r = this.w - len; if (r < 0) r += SIZE;
    const i0 = r | 0, fr = r - i0, a = this.buf[i0], b = this.buf[(i0 + 1) % SIZE];
    const y = a + (b - a) * fr;
    this.lp += this.bright * (y - this.lp);                         // loop low-pass = string damping
    if (!this.released && t >= this.dur) this.released = true;
    // loop gain → decay time: sustained notes ring, released notes die in ~60 ms
    const g = this.released ? 0.955 : this.sustain ? 0.99985 : 0.9972 + 0.0022 * Math.min(1, len / 500);
    this.buf[this.w] = this.lp * g;
    this.w = (this.w + 1) % SIZE;
    this.level += 0.002 * (Math.abs(y) - this.level);
    if (this.released && this.level < 2e-4) { this.active = false; this.level = 0; }
    return y;
  }
}

class StringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.voices = []; for (let i = 0; i < 7; i++) this.voices.push(new Voice());
    this.queue = []; this.clock = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'off') { this.queue.length = 0; for (const v of this.voices) v.released = true; return; }
      if (m.type === 'flush') { this.queue = this.queue.filter((q) => q.t <= m.after); return; }
      let i = this.queue.length; while (i > 0 && this.queue[i - 1].t > m.t) i--; this.queue.splice(i, 0, m);
    };
  }
  alloc(m) {
    if (m.legato) { let best = null; for (const v of this.voices) if (v.active && (!best || v.age < best.age)) best = v; if (best) return best; }
    for (const v of this.voices) if (!v.active) return v;
    let old = this.voices[0]; for (const v of this.voices) if (v.age > old.age) old = v; return old;
  }
  process(inputs, outputs) {
    const out = outputs[0][0]; if (!out) return true;
    const n = out.length, dt = 1 / sampleRate, t0 = currentTime;
    for (let i = 0; i < n; i++) {
      const now = t0 + i * dt;
      while (this.queue.length && this.queue[0].t <= now) { const m = this.queue.shift(); if (now - m.t < 0.25) this.alloc(m).start(m, sampleRate, m.legato); }
      let s = 0; for (const v of this.voices) if (v.active) { s += v.tick(); v.age++; }
      out[i] = s;
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('selah-string', StringProcessor);
