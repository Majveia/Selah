#!/usr/bin/env node
// Offline render + objective checks for the score (headless Chromium, OfflineAudioContext).
//   node tools/audio/render.cjs [intro|scenes] [out.wav]
// Prints per-window peak / RMS (dBFS), detects clicks/NaN/DC, and optionally writes a WAV for ffmpeg analysis.
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '../..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.mp3': 'audio/mpeg' };
const TIMELINES = {
  intro: { dur: 112, ev: [[0, 'scene', 'void'], [15, 'cue', 'bigbang', { lead: 2.6 }], [17.6, 'scene', 'genesis'], [30, 'scene', 'web'], [50, 'cue', 'dive'], [50.2, 'scene', 'galaxy'], [60, 'cue', 'sunrise'], [60.2, 'scene', 'orbit'], [87, 'cue', 'title'], [87.1, 'scene', 'title'], [102, 'scene', 'orbit']] },
  scenes: { dur: 110, ev: [[0, 'scene', 'surface'], [26, 'cue', 'takeoff'], [28, 'scene', 'ride'], [54, 'cue', 'land'], [56, 'scene', 'system'], [70, 'cue', 'discover'], [80, 'cue', 'arrival'], [82, 'scene', 'blackhole'], [100, 'scene', 'web']] },
};
(async () => {
  const which = process.argv[2] || 'intro', out = process.argv[3];
  const server = http.createServer((req, rsp) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/blank.html') { rsp.writeHead(200, { 'content-type': 'text/html' }); return rsp.end('<!doctype html><title>t</title>'); }
    const f = path.join(root, p); if (!f.startsWith(root) || !fs.existsSync(f)) { rsp.writeHead(404); return rsp.end(); }
    rsp.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(rsp);
  });
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage(); page.setDefaultTimeout(600000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${server.address().port}/blank.html`);
  const t0 = Date.now();
  const res = await page.evaluate(async ({ tl, wantWav }) => {
    const { createAudioEngine } = await import('/src/audio/engine.js');
    const sr = 48000, ctx = new OfflineAudioContext(2, sr * tl.dur, sr);
    const engine = await createAudioEngine({ context: ctx });
    const m = engine.music; const ev = tl.ev.slice();
    const step = 0.25;
    for (let t = 0; t < tl.dur - step; t += step) {
      ctx.suspend(t).then(() => {
        if (t === 0) m.start();
        while (ev.length && ev[0][0] <= t + 1e-6) { const e = ev.shift(); if (e[1] === 'scene') m.setScene(e[2], { fade: 3 }); else m.cue(e[2], e[3] || {}); }
        m.scheduleUntil(t + step + 0.5); ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    const Lc = buf.getChannelData(0), Rc = buf.getChannelData(1), n = Lc.length, win = 5 * sr, rows = [];
    let nan = 0, clicks = 0, dc = 0, peakAll = 0;
    for (let w = 0; w * win < n; w++) {
      let pk = 0, sq = 0, cnt = 0, corr = 0, sl = 0, srr = 0;
      for (let i = w * win; i < Math.min(n, (w + 1) * win); i++) {
        const l = Lc[i], r = Rc[i]; if (!(l === l) || !(r === r)) { nan++; continue; }
        const a = Math.max(Math.abs(l), Math.abs(r)); if (a > pk) pk = a; sq += (l * l + r * r) / 2; cnt++; corr += l * r; sl += l * l; srr += r * r; dc += l;
        if (i > 0 && Math.abs(l - Lc[i - 1]) > 0.35) clicks++;
      }
      if (pk > peakAll) peakAll = pk;
      rows.push([w * 5, +(20 * Math.log10(pk + 1e-9)).toFixed(1), +(10 * Math.log10(sq / Math.max(1, cnt) + 1e-12)).toFixed(1), +(corr / Math.sqrt(sl * srr + 1e-12)).toFixed(2)]);
    }
    let wav = null;
    if (wantWav) { // 16-bit PCM → base64
      const bytes = new Uint8Array(44 + n * 4), dv = new DataView(bytes.buffer); const W = (o, s) => { for (let i = 0; i < s.length; i++) bytes[o + i] = s.charCodeAt(i); };
      W(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); W(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); W(36, 'data'); dv.setUint32(40, n * 4, true);
      for (let i = 0; i < n; i++) { dv.setInt16(44 + i * 4, Math.max(-1, Math.min(1, Lc[i])) * 32767, true); dv.setInt16(46 + i * 4, Math.max(-1, Math.min(1, Rc[i])) * 32767, true); }
      let s = ''; const CH = 0x8000; for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH)); wav = btoa(s);
    }
    return { rows, nan, clicks, dc: dc / n, peak: 20 * Math.log10(peakAll + 1e-9), state: m.getState(), wav };
  }, { tl: TIMELINES[which], wantWav: !!out });
  console.log(`${which}: rendered ${TIMELINES[which].dur}s in ${((Date.now() - t0) / 1000).toFixed(1)}s  peak ${res.peak.toFixed(1)} dBFS  NaN ${res.nan}  clicks ${res.clicks}  DC ${res.dc.toExponential(1)}  last chord ${res.state.chord} key ${res.state.key}`);
  console.log('t(s)  peak  rms  L/R-corr'); for (const r of res.rows) console.log(String(r[0]).padStart(4), String(r[1]).padStart(6), String(r[2]).padStart(6), String(r[3]).padStart(6));
  if (out && res.wav) { fs.writeFileSync(out, Buffer.from(res.wav, 'base64')); console.log('wrote', out); }
  await browser.close(); server.close();
})();
