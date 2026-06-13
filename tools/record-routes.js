#!/usr/bin/env node
/**
 * record-routes.js — one .webm per route + RUNTIME full interactive coverage.
 * Playwright drives each route in its own video-recording context: SPA-navigate,
 * scroll, then ENUMERATE every interactive element live from the rendered DOM
 * (not the static AST) and EXERCISE each one (fill/select/click), opening and
 * closing modals as it goes, then flush + rename to a deterministic name.
 *
 *   node tools/record-routes.js --base http://localhost:5000 --routes routes.json [--out videos] [--max N] [--cap 60]
 *   node tools/record-routes.js --base http://localhost:5000 --repo /path/to/app  [--out videos]
 *
 * --routes takes extract-routes.js JSON ({routes:[{path,name,templated,interactive}]}).
 * --repo runs extract-routes.js itself. Templated routes (/:id) skipped unless --templated.
 * SPA deep-links 404 on static servers, so each route is reached by client-side
 * push (history.pushState + popstate) after loading the base URL.
 * --cap caps interactive elements exercised per route (default 60); capping is LOGGED.
 *
 * Emits <out>/manifest.json: route -> {video,bytes,ok,error,
 *   discovered,exercised,modals_opened, elements:[{descriptor,type,exercised,opened_modal,error}]}.
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
const CAP = arg('--cap') ? parseInt(arg('--cap'), 10) : 60;
const INCLUDE_TEMPLATED = has('--templated');
const HASH = has('--hash'); // app uses HashRouter -> deep-link via location.hash (#/path)

if (!BASE || (!ROUTES_FILE && !REPO)) {
  console.error('usage: record-routes.js --base <url> (--routes <file.json> | --repo <dir>) [--out videos] [--max N] [--cap 60] [--templated]');
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

// ── runtime DOM enumeration ──────────────────────────────────────────────────
// Runs IN-PAGE: collect visible+enabled interactive elements, tag each with a
// stable descriptor + a one-shot data attribute we can re-find it by, even after
// the DOM re-renders. De-duped by descriptor. Returns plain JSON descriptors.
const ENUMERATE = `(() => {
  const SEL = [
    'button', '[role=button]', 'a[href]', 'input', 'textarea', 'select',
    '[role=tab]', '[role=menuitem]', '[role=switch]', '[aria-haspopup]',
    '[data-testid]', 'summary', '[contenteditable]', '[contenteditable=true]'
  ].join(',');
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return (el.getAttribute('type') || 'text').toLowerCase() === 'checkbox' || el.type === 'radio' ? 'check' : 'input';
    if (tag === 'textarea') return 'input';
    if (tag === 'select') return 'select';
    if (tag === 'a') return 'link';
    if (el.getAttribute('contenteditable') != null) return 'contenteditable';
    if (el.getAttribute('role') === 'tab') return 'tab';
    if (el.getAttribute('role') === 'menuitem') return 'menuitem';
    if (el.getAttribute('role') === 'switch') return 'switch';
    return 'button';
  };
  const label = (el) => (
    el.getAttribute('data-testid') || el.getAttribute('aria-label') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) ||
    el.getAttribute('name') || el.getAttribute('placeholder') ||
    el.getAttribute('title') || el.getAttribute('href') || ''
  );
  // chrome = nav/sidebar/header/footer — clicking these re-renders layout and
  // strands the in-content elements, so exercise MAIN CONTENT first.
  const isChrome = (el) => !!el.closest('nav,[role=navigation],aside,header,footer,.sidebar,.app-header,.app-footer,.navbar,.ant-menu,.MuiDrawer-root');
  const nodes = [...document.querySelectorAll(SEL)].filter(vis);
  const seen = new Set();
  const content = [], chrome = [];
  let i = 0;
  for (const el of nodes) {
    const type = kindOf(el);
    const dedupe = type + '|' + label(el) + '|' + el.tagName + '|' + (el.getAttribute('href') || '');
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const token = 'rrx-' + (i++);
    el.setAttribute('data-rrx', token);
    (isChrome(el) ? chrome : content).push({ descriptor: type + ':' + (label(el) || el.tagName.toLowerCase()), type, token, chrome: isChrome(el) });
  }
  return content.concat(chrome); // content-first ordering
})()`;

// IN-PAGE: is a modal/dialog currently open?
const MODAL_OPEN = `(() => {
  const m = document.querySelector('[role=dialog],[aria-modal=true],.modal.show,.modal.in,.ant-modal-wrap:not([style*="display: none"]),.chakra-modal__content,.MuiDialog-root,.MuiModal-root');
  return !!(m && m.offsetParent !== null || m && getComputedStyle(m).display !== 'none');
})()`;

(async () => {
  const all = loadRoutes();
  const routes = all.filter((r) => INCLUDE_TEMPLATED || !r.templated).slice(0, MAX);
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, '.raw');
  fs.mkdirSync(tmp, { recursive: true });

  process.on('unhandledRejection', () => { /* a context torn down mid-interaction must not kill the run */ });
  const LAUNCH = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors', '--disable-http2', '--window-size=1920,1080'] };
  let browser = await chromium.launch(LAUNCH);
  const manifest = { generatedAt: new Date().toISOString(), base: BASE, cap: CAP, count: 0, routes: [] };
  const nap = (page, ms) => page.waitForTimeout(ms).catch(() => {});

  const deepLink = async (page, p) => {
    if (HASH) {
      // HashRouter: drive the hash + fire hashchange so the router re-renders
      await page.evaluate((pp) => { window.location.hash = pp; window.dispatchEvent(new HashChangeEvent('hashchange')); }, p).catch(() => {});
    } else {
      await page.evaluate((pp) => { window.history.pushState({}, '', pp); window.dispatchEvent(new PopStateEvent('popstate')); }, p).catch(() => {});
    }
  };
  const currentPath = (page) => page.evaluate((isHash) => (isHash ? (location.hash.replace(/^#/, '') || '/') : location.pathname), HASH).catch(() => null);

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
    let ok = true, error = null;
    let discovered = 0, exercised = 0, modalsOpened = 0, capped = false;
    const elements = [];
    try { // critical: load + client-side route
      await page.goto(BASE + '/', { waitUntil: 'networkidle', timeout: 45000 });
      if (r.path && r.path !== '/') { await deepLink(page, r.path); await nap(page, 1200); }
      await nap(page, 900);
    } catch (e) { ok = false; error = String(e).slice(0, 200); }

    // RUNTIME full-coverage interaction pass — never flips ok, never throws out
    try {
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((s) => setTimeout(s, 100)); }
        window.scrollTo(0, 0);
      }).catch(() => {});

      let live = [];
      try { live = await page.evaluate(ENUMERATE); } catch { live = []; }
      discovered = live.length;
      if (live.length > CAP) { capped = true; live = live.slice(0, CAP); }

      for (const el of live) {
        if (page.isClosed()) break;
        const rec = { descriptor: el.descriptor, type: el.type, exercised: false, opened_modal: false, error: null };
        // chrome nav links navigate away and re-render layout — record but don't click
        if (el.chrome && el.type === 'link') { rec.error = 'skipped-nav'; elements.push(rec); continue; }
        try {
          const loc = page.locator(`[data-rrx="${el.token}"]`).first();
          if (!(await loc.count())) { rec.error = 'gone'; elements.push(rec); continue; }
          if (!(await loc.isVisible().catch(() => false))) { rec.error = 'hidden'; elements.push(rec); continue; }
          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          if (el.type === 'input') {
            await loc.fill('test', { timeout: 1500 });
          } else if (el.type === 'select') {
            const vals = await loc.evaluate((s) => [...s.options].map((o) => o.value).filter(Boolean)).catch(() => []);
            if (vals.length) await loc.selectOption(vals[Math.min(1, vals.length - 1)], { timeout: 1500 }).catch(() => loc.selectOption(vals[0], { timeout: 1500 }));
          } else {
            await loc.click({ timeout: 2000 });
          }
          rec.exercised = true; exercised++;
          await nap(page, 350);

          // modal detection + exercise-a-couple + close
          const modal = await page.evaluate(MODAL_OPEN).catch(() => false);
          if (modal) {
            rec.opened_modal = true; modalsOpened++;
            try {
              const inner = page.locator('[role=dialog] button, [aria-modal=true] button, .modal button, .ant-modal button, .MuiDialog-root button');
              const n = Math.min(2, await inner.count());
              for (let k = 0; k < n; k++) {
                const b = inner.nth(k);
                const t = (await b.innerText().catch(() => '')).toLowerCase();
                if (/close|cancel|ok|×|x|dismiss|save|submit|confirm/.test(t)) continue; // don't pre-trip the close button
                await b.click({ timeout: 1200 }).catch(() => {});
                await nap(page, 200);
              }
            } catch { /* inner exercise best-effort */ }
            // CLOSE: Escape, then a close/cancel/x button
            await page.keyboard.press('Escape').catch(() => {});
            await nap(page, 250);
            if (await page.evaluate(MODAL_OPEN).catch(() => false)) {
              const closer = page.locator('[role=dialog] [aria-label*="lose" i], [role=dialog] [aria-label*="ismiss" i], .ant-modal-close, .modal .close, .MuiDialog-root [aria-label*="lose" i], button:has-text("Cancel"), button:has-text("Close")').first();
              if (await closer.count().catch(() => 0)) await closer.click({ timeout: 1200 }).catch(() => {});
              await nap(page, 250);
            }
          }

          // a click may have navigated us off the route — re-deep-link back
          const here = await currentPath(page);
          if (here != null && r.path && here !== r.path) { await deepLink(page, r.path); await nap(page, 400); }
        } catch (e) { rec.error = String(e.message || e).slice(0, 80); }
        elements.push(rec);
      }
      await nap(page, 500);
    } catch { /* page torn down during interaction pass — video already captured */ }

    if (capped) process.stderr.write(`  CAPPED ${name}: discovered ${discovered} > cap ${CAP}; exercised first ${CAP}\n`);

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
    manifest.routes.push({
      name, path: r.path, video: file, bytes,
      discovered, exercised, modals_opened: modalsOpened, capped,
      elements, ok: ok && bytes > 0, error,
    });
    process.stderr.write(`recorded ${name} (${r.path}) ${bytes}B discovered=${discovered} exercised=${exercised} modals=${modalsOpened}${error ? ' ERR:' + error : ''}\n`);
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  manifest.count = manifest.routes.length;
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, routes: manifest.count, out: OUT }));
})();
