#!/usr/bin/env node
/**
 * merge-video-runs.js — merge per-env video dirs from several record-routes runs
 * into one set of per-env source dirs (each with a synthesized manifest.json), so
 * build-4env-video-report.js can lay out the UNION of routes across runs. Used to
 * grow a partial 4-env report up to full route coverage without re-recording the
 * routes already captured in an earlier run.
 *
 *   node tools/merge-video-runs.js --out /abs/merged/videos \
 *     --routes /abs/extract-routes.json \
 *     --env before-prod \
 *     --src curated-24:/abs/oldreport/before-prod \
 *     --src remaining-35:/abs/run/videos/before-prod \
 *     ... (repeat --env + its --src lines per environment)
 *
 * For each env: copies every *.webm from each --src (first-seen stem wins), and
 * derives each route's `path` from the src's own manifest.json when present, else
 * from the shared --routes file (stem -> path), else falls back to '/'+stem.
 * A src dir may be a record-routes output (has manifest.json) OR a flat dir of
 * webms copied by build-4env-video-report.js (no manifest — path via --routes).
 */
const fs = require('fs');
const path = require('path');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function stem(p) { if (!p || p === '/') return 'root'; return p.replace(/^\/+|\/+$/g, '').replace(/:/g, '$').replace(/\*/g, 'star').replace(/[^\w$.-]+/g, '_') || 'root'; }

const OUT = arg('--out');
const ROUTES_FILE = arg('--routes');
if (!OUT) { console.error('need --out /abs/merged/videos'); process.exit(2); }

// parse interleaved --env <key> [--src tag:dir]...  groups
const groups = [];
let cur = null;
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--env') { cur = { env: process.argv[i + 1], srcs: [] }; groups.push(cur); }
  else if (process.argv[i] === '--src' && cur) {
    const spec = process.argv[i + 1];
    const c = spec.indexOf(':');
    cur.srcs.push({ tag: spec.slice(0, c), dir: spec.slice(c + 1) });
  }
}
if (!groups.length) { console.error('need at least one --env <key> with --src tag:dir'); process.exit(2); }

const stemToPath = new Map();
if (ROUTES_FILE && fs.existsSync(ROUTES_FILE)) {
  const j = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8'));
  (Array.isArray(j) ? j : (j.routes || [])).forEach((r) => stemToPath.set(stem(r.path), r.path));
}

const summary = {};
for (const g of groups) {
  const outDir = path.join(OUT, g.env);
  fs.mkdirSync(outDir, { recursive: true });
  const routes = []; const seen = new Set(); const counts = {};
  for (const src of g.srcs) {
    counts[src.tag] = 0;
    if (!fs.existsSync(src.dir)) continue;
    let manRoutes = null;
    const mp = path.join(src.dir, 'manifest.json');
    if (fs.existsSync(mp)) { try { manRoutes = JSON.parse(fs.readFileSync(mp, 'utf8')).routes; } catch { /* */ } }
    for (const f of fs.readdirSync(src.dir)) {
      if (!f.endsWith('.webm')) continue;
      const st = f.replace('.webm', '');
      if (seen.has(st)) continue;
      fs.copyFileSync(path.join(src.dir, f), path.join(outDir, f));
      const bytes = fs.statSync(path.join(outDir, f)).size;
      const rec = manRoutes && manRoutes.find((r) => r.video === f || stem(r.path) === st);
      const p = rec ? rec.path : (stemToPath.get(st) || '/' + st);
      routes.push({ path: p, name: st, video: f, bytes, ok: true, source: src.tag,
        discovered: rec ? rec.discovered : undefined, exercised: rec ? rec.exercised : undefined });
      seen.add(st); counts[src.tag]++;
    }
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), base: '(merged)', count: routes.length, routes }, null, 2));
  summary[g.env] = { ...counts, total: routes.length };
}
console.log(JSON.stringify(summary, null, 2));
