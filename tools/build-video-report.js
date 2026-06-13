#!/usr/bin/env node
/**
 * build-video-report.js — turn a record-routes.js output dir (manifest.json +
 * per-route .webm) into a self-contained static report: one <video controls>
 * per route + a route x interactive-element-type coverage matrix. All assets
 * copied into --out with relative paths so a plain http.server can serve it.
 *
 *   node tools/build-video-report.js --videos <dir> [--routes <file.json>] [--coverage <test-map.json>] [--out report]
 *
 * --videos  : dir with manifest.json + *.webm (from record-routes.js).
 * --routes  : extract-routes.js JSON; drives the coverage matrix (route x type).
 * --coverage: optional webpack test-map.json (route -> {type: count}); preferred
 *             over --routes for the matrix when present.
 */
const fs = require('fs');
const path = require('path');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }

const VIDEOS = arg('--videos');
const ROUTES_FILE = arg('--routes');
const COVERAGE_FILE = arg('--coverage');
const OUT = arg('--out', 'report');

if (!VIDEOS) {
  console.error('usage: build-video-report.js --videos <dir> [--routes <file.json>] [--coverage <test-map.json>] [--out report]');
  process.exit(2);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const manifest = JSON.parse(fs.readFileSync(path.join(VIDEOS, 'manifest.json'), 'utf8'));
const routes = ROUTES_FILE ? (JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')).routes || []) : [];
const routeByPath = new Map(routes.map((r) => [r.path, r]));

// runtime per-route coverage is in the manifest (record-routes.js full-coverage pass)
const runtimeCoverage = manifest.routes.some((r) => r.elements && r.elements.length);

// coverage matrix: { route -> { type -> count } }.
// precedence: explicit test-map > RUNTIME exercised elements (manifest) > static AST.
const matrix = {};
const typeSet = new Set();
if (COVERAGE_FILE) {
  const tm = JSON.parse(fs.readFileSync(COVERAGE_FILE, 'utf8'));
  for (const [route, types] of Object.entries(tm)) {
    matrix[route] = {};
    for (const [t, n] of Object.entries(types)) { matrix[route][t] = Number(n) || 0; typeSet.add(t); }
  }
} else if (runtimeCoverage) {
  for (const r of manifest.routes) {
    matrix[r.path] = {};
    for (const el of (r.elements || [])) {
      if (!el.exercised) continue;
      matrix[r.path][el.type] = (matrix[r.path][el.type] || 0) + 1; typeSet.add(el.type);
    }
  }
} else {
  for (const r of routes) {
    matrix[r.path] = {};
    for (const el of (r.interactive || [])) { matrix[r.path][el.type] = (matrix[r.path][el.type] || 0) + 1; typeSet.add(el.type); }
  }
}
const types = [...typeSet].sort();

// copy webm assets into OUT so the dir is self-contained
fs.mkdirSync(OUT, { recursive: true });
let copied = 0;
for (const r of manifest.routes) {
  if (!r.video) continue;
  const src = path.join(VIDEOS, r.video);
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(OUT, r.video)); copied++; }
}

const totalEls = Object.values(matrix).reduce((a, m) => a + Object.values(m).reduce((x, y) => x + y, 0), 0);
const okCount = manifest.routes.filter((r) => r.ok).length;
const totDiscovered = manifest.routes.reduce((a, r) => a + (r.discovered || 0), 0);
const totExercised = manifest.routes.reduce((a, r) => a + (r.exercised || 0), 0);
const totModals = manifest.routes.reduce((a, r) => a + (r.modals_opened || 0), 0);

const videoCards = manifest.routes.map((r) => {
  const meta = routeByPath.get(r.path);
  const cmp = meta && meta.component ? ` · <code>${esc(meta.component)}</code>` : '';
  const badge = r.ok ? '<span class="ok">ok</span>' : `<span class="bad">error${r.error ? ': ' + esc(r.error) : ''}</span>`;
  const media = r.video && r.bytes
    ? `<video controls preload="metadata" src="${esc(r.video)}"></video><div class="cap">${esc(r.video)} · ${(r.bytes / 1024).toFixed(0)} KB</div>`
    : '<div class="novideo">no video captured</div>';
  // runtime coverage counts (record-routes full-coverage pass), fall back to legacy `interactions`
  const cov = r.discovered != null
    ? `discovered <b>${r.discovered}</b> · exercised <b class="exb">${r.exercised}</b>` +
      (r.modals_opened ? ` · modals <b class="mob">${r.modals_opened}</b>` : '') +
      (r.capped ? ' · <span class="bad">capped</span>' : '')
    : `${r.interactions || 0} interaction(s)`;
  return `<section class="card">
    <h3><code class="rp">${esc(r.path)}</code> ${badge}</h3>
    <div class="meta">${cov}${cmp}</div>
    ${media}
  </section>`;
}).join('\n');

const matrixHead = `<tr><th>route</th>${types.map((t) => `<th>${esc(t)}</th>`).join('')}<th>total</th></tr>`;
const matrixRows = Object.keys(matrix).map((route) => {
  const m = matrix[route];
  const tot = Object.values(m).reduce((a, b) => a + b, 0);
  const cells = types.map((t) => `<td class="${m[t] ? 'has' : 'zero'}">${m[t] || ''}</td>`).join('');
  return `<tr><td class="rp"><code>${esc(route)}</code></td>${cells}<td class="tot">${tot}</td></tr>`;
}).join('\n');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Per-route Video + Coverage</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
 header{padding:20px 28px;border-bottom:1px solid #21262d}
 h1{margin:0 0 6px;font-size:20px} .sub{color:#8b949e}
 h2{font-size:16px;padding:0 28px;margin:24px 0 8px;border-top:1px solid #21262d;padding-top:20px}
 .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px;padding:8px 28px}
 .card{border:1px solid #30363d;border-radius:8px;background:#161b22;padding:12px}
 .card h3{margin:0 0 4px;font-size:14px;display:flex;align-items:center;gap:8px}
 code{color:#79c0ff;background:#0d1117;padding:2px 6px;border-radius:4px;font-size:12px}
 .rp{color:#79c0ff} .meta{color:#8b949e;font-size:12px;margin-bottom:8px}
 video{width:100%;border:1px solid #30363d;border-radius:6px;background:#000;display:block}
 .cap{font-size:11px;color:#8b949e;margin-top:4px} .novideo{color:#f85149;font-size:12px;padding:20px;text-align:center}
 .exb{color:#3fb950} .mob{color:#d2a8ff}
 .ok{color:#3fb950;font-size:11px;border:1px solid #238636;border-radius:10px;padding:1px 8px}
 .bad{color:#f85149;font-size:11px;border:1px solid #cf222e;border-radius:10px;padding:1px 8px}
 table{border-collapse:collapse;margin:0 28px;font-size:13px} th,td{border:1px solid #30363d;padding:6px 10px;text-align:center}
 th{background:#161b22;color:#8b949e} td.rp{text-align:left} td.has{color:#3fb950;font-weight:600} td.zero{color:#30363d} td.tot{font-weight:600}
</style></head><body>
<header>
 <h1>Per-route Video + Coverage Matrix</h1>
 <div class="sub">${esc(manifest.generatedAt)} · base ${esc(manifest.base)} · ${manifest.routes.length} routes (${okCount} ok) · ${copied} videos${runtimeCoverage ? ` · runtime coverage: <b class="exb">${totExercised}</b>/${totDiscovered} elements exercised · <b class="mob">${totModals}</b> modals opened` : ` · ${totalEls} interactive elements`}</div>
</header>
<h2>Route recordings</h2>
<div class="cards">${videoCards}</div>
<h2>Coverage matrix — route × ${runtimeCoverage ? 'RUNTIME-exercised element type' : 'interactive-element-type'}</h2>
<table>${matrixHead}${matrixRows}</table>
<div style="height:32px"></div>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
console.log(JSON.stringify({ ok: true, out: OUT, routes: manifest.routes.length, videos: copied, types, totalElements: totalEls, runtimeCoverage, discovered: totDiscovered, exercised: totExercised, modals_opened: totModals }));
