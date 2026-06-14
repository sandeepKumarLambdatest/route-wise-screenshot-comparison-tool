#!/usr/bin/env node
/**
 * build-4env-video-report.js — MULTI-ENV per-route video report. Consumes N
 * record-routes.js output dirs (one per environment) and lays out, FOR EACH
 * route, the per-env <video> side by side in a grid so a reviewer can eyeball a
 * before/after × prod/onprem sync diff per route. Self-contained: every .webm is
 * copied into --out under <envKey>/<file> with relative src, servable by a plain
 * static server (serve-report.js).
 *
 *   node tools/build-4env-video-report.js --out report \
 *     --env "before-onprem:before On-Prem:/abs/videos/before-onprem" \
 *     --env "before-prod:before Prod:/abs/videos/before-prod" \
 *     --env "after-onprem:after On-Prem:/abs/videos/after-onprem" \
 *     --env "after-prod:after Prod:/abs/videos/after-prod" \
 *     [--routes routes.json] [--title "..."]
 *
 * --env spec = key:label:dir  (key = safe dir/css token; dir has manifest.json + *.webm)
 * Env column order is the order of the --env flags. Routes are the union across
 * all env manifests, ordered by the first env that has them.
 */
const fs = require('fs');
const path = require('path');

function args(flag) { const o = []; process.argv.forEach((a, i) => { if (a === flag) o.push(process.argv[i + 1]); }); return o; }
function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }

const OUT = arg('--out', 'report');
const ROUTES_FILE = arg('--routes');
const TITLE = arg('--title', 'Per-route Video — 4-environment sync comparison');
const ENV_SPECS = args('--env');
if (!ENV_SPECS.length) { console.error('need at least one --env key:label:dir'); process.exit(2); }

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// parse env specs (key:label:dir — label may itself be empty, dir is the last colon-field's remainder)
const envs = ENV_SPECS.map((spec) => {
  const first = spec.indexOf(':');
  const second = spec.indexOf(':', first + 1);
  const key = spec.slice(0, first);
  const label = spec.slice(first + 1, second);
  const dir = spec.slice(second + 1);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { routes: [], base: '(missing)', generatedAt: '' };
  const byPath = new Map((manifest.routes || []).map((r) => [r.path, r]));
  return { key, label, dir, manifest, byPath };
});

// union of routes, first-seen order
const routeOrder = [];
const seen = new Set();
for (const e of envs) for (const r of e.manifest.routes || []) { if (!seen.has(r.path)) { seen.add(r.path); routeOrder.push(r.path); } }

const routesMeta = ROUTES_FILE ? (JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')).routes || []) : [];
const metaByPath = new Map(routesMeta.map((r) => [r.path, r]));

// copy each env's webm into OUT/<key>/
fs.mkdirSync(OUT, { recursive: true });
let copied = 0;
const sizes = [];
for (const e of envs) {
  const destDir = path.join(OUT, e.key);
  fs.mkdirSync(destDir, { recursive: true });
  for (const r of e.manifest.routes || []) {
    if (!r.video) continue;
    const src = path.join(e.dir, r.video);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(destDir, r.video)); copied++; sizes.push(r.bytes || fs.statSync(src).size); }
  }
}

const fmtKB = (b) => b ? (b / 1024).toFixed(0) + ' KB' : '—';

// per-route grid of env cells
const routeBlocks = routeOrder.map((rp) => {
  const meta = metaByPath.get(rp);
  const cmp = meta && meta.component ? ` · <code>${esc(meta.component)}</code>` : '';
  const cells = envs.map((e) => {
    const r = e.byPath.get(rp);
    if (!r) return `<div class="cell"><div class="ehd">${esc(e.label)}</div><div class="novid">not captured</div></div>`;
    const okBadge = r.ok ? '<span class="ok">ok</span>' : `<span class="bad">err${r.error ? ': ' + esc(r.error) : ''}</span>`;
    const media = r.video && r.bytes
      ? `<video controls preload="metadata" src="${esc(e.key)}/${esc(r.video)}"></video>`
      : '<div class="novid">no video</div>';
    const cov = (r.discovered != null)
      ? `disc <b>${r.discovered}</b> · exer <b class="exb">${r.exercised}</b>${r.revealed_subtrees ? ` · rev <b class="rvb">${r.revealed_subtrees}</b>` : ''}${r.modals_opened ? ` · mod <b class="mob">${r.modals_opened}</b>` : ''}`
      : '';
    return `<div class="cell">
      <div class="ehd">${esc(e.label)} ${okBadge}</div>
      ${media}
      <div class="cap">${esc(r.video || '')} · ${fmtKB(r.bytes)}</div>
      <div class="cov">${cov}</div>
    </div>`;
  }).join('');
  return `<section class="route">
    <h3><code class="rp">${esc(rp)}</code>${cmp}</h3>
    <div class="grid" style="grid-template-columns:repeat(${envs.length},1fr)">${cells}</div>
  </section>`;
}).join('\n');

const totalBytes = sizes.reduce((a, b) => a + b, 0);
const envSummary = envs.map((e) => {
  const rs = e.manifest.routes || [];
  const ok = rs.filter((r) => r.ok).length;
  const vids = rs.filter((r) => r.video && r.bytes).length;
  return `<tr><td>${esc(e.label)}</td><td><code>${esc(e.manifest.base || '')}</code></td><td>${rs.length}</td><td>${ok}</td><td>${vids}</td></tr>`;
}).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(TITLE)}</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
 header{padding:20px 28px;border-bottom:1px solid #21262d}
 h1{margin:0 0 6px;font-size:20px} .sub{color:#8b949e;font-size:13px}
 h2{font-size:15px;padding:0 28px;margin:22px 0 8px}
 table.envs{border-collapse:collapse;margin:0 28px 10px;font-size:12px}
 table.envs th,table.envs td{border:1px solid #30363d;padding:5px 10px;text-align:left}
 table.envs th{background:#161b22;color:#8b949e}
 .route{border-top:1px solid #21262d;padding:14px 28px}
 .route h3{margin:0 0 8px;font-size:14px}
 .grid{display:grid;gap:12px}
 .cell{border:1px solid #30363d;border-radius:8px;background:#161b22;padding:8px}
 .ehd{font-size:12px;color:#c9d1d9;margin-bottom:6px;display:flex;align-items:center;gap:6px}
 video{width:100%;border:1px solid #30363d;border-radius:6px;background:#000;display:block}
 .novid{color:#f85149;font-size:12px;padding:24px;text-align:center;border:1px dashed #30363d;border-radius:6px}
 .cap{font-size:10px;color:#8b949e;margin-top:4px} .cov{font-size:11px;color:#8b949e;margin-top:2px}
 code{color:#79c0ff;background:#0d1117;padding:2px 6px;border-radius:4px;font-size:12px} .rp{color:#79c0ff}
 .exb{color:#3fb950} .mob{color:#d2a8ff} .rvb{color:#f0b429}
 .ok{color:#3fb950;font-size:10px;border:1px solid #238636;border-radius:10px;padding:0 7px}
 .bad{color:#f85149;font-size:10px;border:1px solid #cf222e;border-radius:10px;padding:0 7px}
 .note{margin:8px 28px;padding:10px 14px;background:#161b22;border:1px solid #30363d;border-radius:8px;font-size:12px;color:#c9d1d9}
</style></head><body>
<header>
 <h1>${esc(TITLE)}</h1>
 <div class="sub">${envs.length} environments · ${routeOrder.length} routes · ${copied} videos · ${(totalBytes / 1048576).toFixed(1)} MB total · generated ${esc(new Date().toISOString())}</div>
</header>
<h2>Environments</h2>
<table class="envs"><tr><th>env</th><th>base</th><th>routes</th><th>ok</th><th>videos</th></tr>${envSummary}</table>
<div class="note"><b>Read me — auth scope.</b> These are static SPA builds; auth-gated routes redirect client-side to <code>/login</code> (no on-prem/prod credentials available from this ephemeral origin). Routes shown here are the unauthenticated / distinct-rendering set plus a few gated samples (which uniformly show the login screen — itself a comparable state). Each video is a real per-route interaction walk recorded with Playwright recordVideo; nothing is mocked.</div>
<h2>Per-route recordings (before/after × prod/on-prem)</h2>
${routeBlocks}
<div style="height:40px"></div>
</body></html>`;

fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, 'report-manifest.json'), JSON.stringify({
  title: TITLE, generatedAt: new Date().toISOString(), out: OUT,
  envs: envs.map((e) => ({ key: e.key, label: e.label, base: e.manifest.base, routes: (e.manifest.routes || []).length, videos: (e.manifest.routes || []).filter((r) => r.video && r.bytes).length })),
  routes: routeOrder.length, videos_copied: copied, total_bytes: totalBytes,
}, null, 2));
console.log(JSON.stringify({ ok: true, out: OUT, envs: envs.length, routes: routeOrder.length, videos: copied, total_mb: +(totalBytes / 1048576).toFixed(1) }));
