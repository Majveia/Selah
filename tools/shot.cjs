#!/usr/bin/env node
// Screenshot harness (headless Chromium, software GL).  usage:
//   node tools/shot.cjs "<query string>" out.png [width height] [extraWaitMs]
// e.g. node tools/shot.cjs "realm=web&freeze=6&q=low" /tmp/web.png 1280 720
// With freeze=T the app fast-forwards deterministically to T seconds and stops; otherwise we wait extraWaitMs.
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm' };
function serve() {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname); let f = path.join(root, p);
      if (!f.startsWith(root)) { rsp.writeHead(403); return rsp.end(); }
      if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
      if (!fs.existsSync(f)) { rsp.writeHead(404); return rsp.end('nf'); }
      rsp.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); fs.createReadStream(f).pipe(rsp);
    }).listen(0, () => res(s));
  });
}
(async () => {
  const [query = '', out = 'shot.png', w = '1280', h = '720', wait = '1500'] = process.argv.slice(2);
  const server = await serve(); const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: Number(process.env.DSF || 1) });
  const logs = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  const t0 = Date.now();
  await page.goto(`http://localhost:${port}/index.html?${query}`, { waitUntil: 'load' });
  const frozen = /(^|&)freeze=/.test(query);
  try {
    if (frozen) await page.waitForFunction(() => window.__selah && window.__selah.app && window.__selah.app.frozen, null, { timeout: Number(process.env.TIMEOUT || 240000), polling: 250 });
    else await page.waitForFunction(() => window.__selah && window.__selah.ready, null, { timeout: 120000, polling: 250 });
  } catch (e) { logs.push('[harness] wait failed: ' + e.message.split('\n')[0]); }
  await page.waitForTimeout(+wait);
  if (process.env.EVAL) { try { console.log('eval →', JSON.stringify(await page.evaluate(process.env.EVAL))); } catch (e) { logs.push('[eval] ' + e.message); } }
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => { const a = window.__selah && window.__selah.app; return a ? { realm: a.active && a.active.name, time: +a.time.toFixed(2), tier: a.quality.tier, vp: [a.viewport.width, a.viewport.height], calls: a.renderer.info.render.calls, points: a.renderer.info.render.points, tris: a.renderer.info.render.triangles } : null; }).catch(() => null);
  console.log(JSON.stringify({ out, ms: Date.now() - t0, info }));
  if (logs.length) console.log(logs.slice(0, 30).join('\n'));
  await browser.close(); server.close();
})();
