#!/usr/bin/env node
/**
 * record-routes.js — one .webm per route. Playwright drives each route in its
 * own video-recording context: SPA-navigate, scroll, defensively click each
 * extracted interactive element, then flush + rename to a deterministic name.
 *
 *   node tools/record-routes.js --base http://localhost:5000 --routes routes.json [--out videos] [--max N]
 *   node tools/record-routes.js --base http://localhost:5000 --repo /path/to/app  [--out videos]
 *
 * --routes takes extract-routes.js JSON ({routes:[{path,name,templated,interactive}]}).
 * --repo runs extract-routes.js itself. Templated routes (/:id) skipped unless --templated.
 * SPA deep-links 404 on static servers, so each route is reached by client-side
 * push (history.pushState + popstate) after loading the base URL.
 * Emits <out>/manifest.json: route -> {video,bytes,interactions,ok,error}.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function has(flag) { return process.argv.includes(flag); }

const BASE = (arg('--base') || '').replace(/\/$/, '');
const ROUTES_FILE = arg('--routes');
const REPO = arg('--repo');
const OUT = arg('--out', 'videos');
const MAX = arg('--max') ? parseInt(arg('--max'), 10) : Infinity;
const INCLUDE_TEMPLATED = has('--templated');

if (!BASE || (!ROUTES_FILE && !REPO)) {
  console.error('usage: record-routes.js --base <url> (--routes <file.json> | --repo <dir>) [--out videos] [--max N] [--templated]');
  process.exit(2);
}

function loadRoutes() {
  if (ROUTES_FILE) return JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf8')).routes || [];
  const { execFileSync } = require('child_process');
  const out = execFileSync('node', [path.join(__dirname, 'extract-routes.js'), REPO, '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).routes || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// wait until a file exists and its size stops growing (ffmpeg finished flushing)
async function waitStable(f, tries = 40) {
  let last = -1;
  for (let i = 0; i < tries; i++) {
    let sz = 0; try { sz = fs.statSync(f).size; } catch { /* not yet */ }
    if (sz > 0 && sz === last) return sz;
    last = sz; await sleep(150);
  }
  return last;
}

// /  -> root ; /products/:id -> products_$id ; sanitize to a safe stem
function stem(p) {
  if (!p || p === '/') return 'root';
  return p.replace(/^\/+|\/+$/g, '').replace(/:/g, '$').replace(/\*/g, 'star').replace(/[^\w$.-]+/g, '_') || 'root';
}

(async () => {
  const all = loadRoutes();
  const routes = all.filter((r) => INCLUDE_TEMPLATED || !r.templated).slice(0, MAX);
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, '.raw');
  fs.mkdirSync(tmp, { recursive: true });

  process.on('unhandledRejection', () => { /* a context torn down mid-cosmetic-pass must not kill the run */ });
  const LAUNCH = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors', '--disable-http2', '--window-size=1920,1080'] };
  let browser = await chromium.launch(LAUNCH);
  const manifest = { generatedAt: new Date().toISOString(), base: BASE, count: 0, routes: [] };
  const nap = (page, ms) => page.waitForTimeout(ms).catch(() => {});

  for (const r of routes) {
    const name = stem(r.path);
    if (!browser.isConnected()) browser = await chromium.launch(LAUNCH); // resurrect a crashed browser
    const ctx = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } },
    });
    const page = await ctx.newPage();
    let ok = true, error = null, interactions = 0;
    try { // critical: load + client-side route
      await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
      if (r.path && r.path !== '/') {
        await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, r.path);
        await nap(page, 1200);
      }
      await nap(page, 800);
    } catch (e) { ok = false; error = String(e).slice(0, 200); }
    // cosmetic: scroll + defensive interaction (never flips ok / never throws out)
    try {
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((s) => setTimeout(s, 120)); }
        window.scrollTo(0, 0);
      }).catch(() => {});
      for (const el of (r.interactive || []).slice(0, 8)) {
        if (page.isClosed()) break;
        try {
          const loc = page.locator(el.selector).first();
          if (await loc.count() && await loc.isVisible()) {
            if (el.type === 'input') await loc.fill('test', { timeout: 1500 });
            else { await loc.scrollIntoViewIfNeeded({ timeout: 1500 }); await loc.click({ timeout: 1500 }); }
            interactions++;
            await nap(page, 400);
            await page.evaluate((p) => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }, r.path).catch(() => {});
            await nap(page, 300);
          }
        } catch { /* element gone / navigated / overlapped — keep recording */ }
      }
      await nap(page, 600);
    } catch { /* page torn down during cosmetic pass — video already captured */ }

    const video = page.video();
    await ctx.close(); // close FIRST: video.path() only resolves after the page closes
    const raw = video ? await video.path().catch(() => null) : null;
    let bytes = 0, file = null;
    if (raw) {
      await waitStable(raw); // ffmpeg flush completes shortly after ctx.close
      file = `${name}.webm`;
      const dest = path.join(OUT, file);
      try { fs.renameSync(raw, dest); } catch { fs.copyFileSync(raw, dest); fs.unlinkSync(raw); }
      bytes = fs.statSync(dest).size;
    }
    manifest.routes.push({ name, path: r.path, video: file, bytes, interactions, ok: ok && bytes > 0, error });
    process.stderr.write(`recorded ${name} (${r.path}) ${bytes}B interactions=${interactions}${error ? ' ERR:' + error : ''}\n`);
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  manifest.count = manifest.routes.length;
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, routes: manifest.count, out: OUT }));
})();
