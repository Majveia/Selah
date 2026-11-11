#!/usr/bin/env node
// Zero-dependency static file server for Selah.  usage: node tools/serve.mjs [port] [root]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const root = path.resolve(process.argv[3] || path.join(here, '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.wasm': 'application/wasm', '.glsl': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.bin': 'application/octet-stream', '.woff2': 'font/woff2',
};

http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  let file = path.normalize(path.join(root, p));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); }
    fs.stat(file, (err2, st2) => {
      if (err2 || !st2.isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found: ' + p); }
      const headers = {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': st2.size, 'cache-control': 'no-store', 'accept-ranges': 'bytes',
      };
      const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), st2.size - 1) : st2.size - 1;
        headers['content-range'] = `bytes ${start}-${end}/${st2.size}`; headers['content-length'] = end - start + 1;
        res.writeHead(206, headers); return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, headers);
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  });
}).listen(port, () => console.log(`Selah → http://localhost:${port}/  (root ${root})`));
