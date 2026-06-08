#!/usr/bin/env node
/** serve-report.js — static file server for a report dir. PORT/OUTDIR env. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTDIR = path.resolve(process.env.OUTDIR || './reports/run');
const PORT = parseInt(process.env.PORT || '5056', 10);
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css', '.js': 'text/javascript' };

http
  .createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel === '/') rel = '/index.html';
    const fp = path.normalize(path.join(OUTDIR, rel));
    if (!fp.startsWith(OUTDIR)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(fp, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(fp)] || 'application/octet-stream' });
      res.end(buf);
    });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`serving ${OUTDIR} on :${PORT}`));
