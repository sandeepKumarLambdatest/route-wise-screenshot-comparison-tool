#!/usr/bin/env node
/**
 * record-routes.js — one .webm per route + RUNTIME full interactive coverage via
 * a RECURSIVE lazy-tree traversal with a synthetic animated cursor/highlight.
 * Playwright drives each route in its own video-recording context: navigate,
 * inject the visual layer, scroll, then EXERCISE the UI as an AST-like tree:
 * ENUMERATE (scoped) -> classify each element into an interactable FAMILY
 * (visual-interaction.js registry) -> perform the family's visible action ->
 * detectReveal -> RECURSE into the freshly-revealed subtree (modal/menu/listbox/
 * accordion/tabpanel) scoped to its container -> unwind. Bounded by depth + a
 * visited cycle-guard + per-level --cap. Flush + rename to a deterministic name.
 *
 *   node tools/record-routes.js --base http://localhost:5000 --routes routes.json [--out videos] [--max N] [--cap 60] [--depth 4]
 *   node tools/record-routes.js --base http://localhost:5000 --repo /path/to/app  [--out videos]
 *   node tools/record-routes.js --base http://localhost:5098 --url /widgets.html  [--out videos]  (single static page)
 *
 * --routes takes extract-routes.js JSON ({routes:[{path,name,templated,interactive}]}).
 * --repo runs extract-routes.js itself. --url records ONE path via direct full-page nav.
 * Templated routes (/:id) skipped unless --templated.
 * SPA deep-links 404 on static servers, so each route is reached by client-side
 * push (history.pushState + popstate) after loading the base URL.
 * --cap caps interactive elements exercised PER LEVEL (default 60); capping is LOGGED.
 *
 * Emits <out>/manifest.json: route -> {video,bytes,ok,error,discovered,exercised,
 *   modals_opened,revealed_subtrees,max_depth_reached, elements:[{descriptor,type,
 *   family,scenario,depth,revealed,options_total,options_selected,exercised,opened_modal,error}]}.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const VI = require('./visual-interaction');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function has(flag) { return process.argv.includes(flag); }

const BASE = (arg('--base') || '').replace(/\/$/, '');
const ROUTES_FILE = arg('--routes');
const REPO = arg('--repo');
const URL_ONE = arg('--url'); // single-page mode: record just this one path
const OUT = arg('--out', 'videos');
const MAX = arg('--max') ? parseInt(arg('--max'), 10) : Infinity;
const CAP = arg('--cap') ? parseInt(arg('--cap'), 10) : 60; // per-LEVEL cap
const MAX_DEPTH = arg('--depth') ? parseInt(arg('--depth'), 10) : 4;
const INCLUDE_TEMPLATED = has('--templated');
const HASH = has('--hash'); // app uses HashRouter -> deep-link via location.hash (#/path)
const NO_VIDEO = has('--novideo'); // coverage walk only — skip recordVideo (screenshot/coverage-only mode)
const STORAGE = arg('--storage'); // Playwright storageState JSON (cookie jar) -> authed session for gated routes
const WAITUNTIL = arg('--waituntil', 'networkidle'); // goto wait state; authed SPAs rarely go idle -> use 'domcontentloaded'

if (!BASE || (!ROUTES_FILE && !REPO && !URL_ONE)) {
  console.error('usage: record-routes.js --base <url> (--routes <file.json> | --repo <dir> | --url <path>) [--out videos] [--max N] [--cap 60] [--depth 4] [--templated] [--hash] [--novideo] [--storage cookies.json]');
  process.exit(2);
}

function loadRoutes() {
  if (URL_ONE) return [{ path: URL_ONE, name: URL_ONE }];
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

// ── runtime DOM enumeration (SCOPED) ─────────────────────────────────────────
// Runs IN-PAGE: collect visible+enabled interactive elements WITHIN a scope
// (CSS selector string, '' = whole document). Surfaces role/aria/class hints so
// the family registry can classify ANY widget. Skips already-visited tokens.
// Tags each with a fresh data-rrx token + a STABLE token for the visited set.
function ENUMERATE(scopeSel, visitedArr, seq) {
  return `(() => {
  const scope = ${JSON.stringify(scopeSel)} ? document.querySelector(${JSON.stringify(scopeSel)}) : document;
  if (!scope) return [];
  const visited = new Set(${JSON.stringify(visitedArr || [])});
  let SEQ = ${seq || 0};
  const SEL = [
    'button', '[role=button]', 'a[href]', 'input', 'textarea', 'select',
    '[role=tab]', '[role=menuitem]', '[role=menuitemcheckbox]', '[role=switch]',
    '[role=slider]', '[role=combobox]', '[role=option]', '[aria-haspopup]',
    '[aria-expanded]', '[data-testid]', 'summary', '[contenteditable]', '[contenteditable=true]'
  ].join(',');
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };
  const A = (el, n) => el.getAttribute(n);
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return /^(checkbox|radio)$/.test((A(el, 'type') || 'text').toLowerCase()) ? 'check' : 'input';
    if (tag === 'textarea') return 'input';
    if (tag === 'select') return 'select';
    if (tag === 'a') return 'link';
    if (A(el, 'contenteditable') != null) return 'contenteditable';
    const role = A(el, 'role');
    if (role === 'tab') return 'tab';
    if (role === 'menuitem' || role === 'menuitemcheckbox') return 'menuitem';
    if (role === 'switch') return 'switch';
    if (role === 'option') return 'option';
    return 'button';
  };
  const label = (el) => (
    A(el, 'data-testid') || A(el, 'aria-label') ||
    (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40) ||
    A(el, 'name') || A(el, 'placeholder') ||
    A(el, 'title') || A(el, 'href') || ''
  );
  const isChrome = (el) => !!el.closest('nav,[role=navigation],aside,header,footer,.sidebar,.app-header,.app-footer,.navbar,.ant-menu,.MuiDrawer-root');
  const root = scope === document ? document : scope;
  const nodes = [...root.querySelectorAll(SEL)].filter(vis);
  const seen = new Set();
  const content = [], chrome = [];
  for (const el of nodes) {
    const type = kindOf(el);
    const lab = label(el);
    const stable = type + '|' + lab + '|' + el.tagName + '|' + (A(el, 'href') || '');
    if (visited.has(stable) || seen.has(stable)) continue;
    seen.add(stable);
    const token = 'rrx-' + (SEQ++);
    el.setAttribute('data-rrx', token);
    const info = {
      descriptor: type + ':' + (lab || el.tagName.toLowerCase()),
      type, token, stable, chrome: isChrome(el),
      tag: el.tagName.toLowerCase(),
      role: A(el, 'role') || '',
      inputType: el.tagName.toLowerCase() === 'input' ? (A(el, 'type') || 'text') : '',
      haspopup: A(el, 'aria-haspopup') || '',
      expanded: A(el, 'aria-expanded'),
      multiselectable: A(el, 'aria-multiselectable') === 'true' || A(el, 'role') === 'listbox' && A(el, 'aria-multiselectable') === 'true',
      contenteditable: A(el, 'contenteditable') != null,
      classHint: (el.className && el.className.toString ? el.className.toString() : '').slice(0, 200),
    };
    // ant-select multiple is a class signal, not aria — surface it for multiselect match
    if (/ant-select-multiple/.test(info.classHint)) info.multiselectable = true;
    (info.chrome ? chrome : content).push(info);
  }
  return { seq: SEQ, els: content.concat(chrome) }; // content-first
})()`;
}

(async () => {
  const all = loadRoutes();
  const routes = all.filter((r) => INCLUDE_TEMPLATED || !r.templated).slice(0, MAX);
  fs.mkdirSync(OUT, { recursive: true });
  const tmp = path.join(OUT, '.raw');
  fs.mkdirSync(tmp, { recursive: true });

  process.on('unhandledRejection', () => { /* a context torn down mid-interaction must not kill the run */ });
  const LAUNCH = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors', '--disable-http2', '--window-size=1920,1080'] };
  let browser = await chromium.launch(LAUNCH);
  const manifest = { generatedAt: new Date().toISOString(), base: BASE, cap: CAP, maxDepth: MAX_DEPTH, count: 0, routes: [] };
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

  // scenario rotation so different multiselect instances demo different cases
  const SCENARIOS = ['x-of-n', 'select-all', 'toggle'];

  // unwind a revealed subtree back up: Escape, then a close/collapse control
  const closeReveal = async (page, reveal) => {
    if (!reveal) return;
    await page.keyboard.press('Escape').catch(() => {});
    await nap(page, 200);
    try {
      const still = await page.locator('[data-rrx-reveal="1"]').count().catch(() => 0);
      if (still) {
        const closer = page.locator(
          '[data-rrx-reveal="1"] [aria-label*="lose" i], [data-rrx-reveal="1"] [aria-label*="ismiss" i],'
          + '.ant-modal-close, .ant-drawer-close, .modal .close, [data-rrx-reveal="1"] button:has-text("Close"),'
          + '[data-rrx-reveal="1"] button:has-text("Cancel")').first();
        if (await closer.count().catch(() => 0)) { await VI.visualClick(page, closer, 'close', reveal.depth).catch(() => {}); await nap(page, 200); }
      }
    } catch { /* */ }
    // collapse aria-expanded triggers that are still open (accordion/menu)
    await page.evaluate(() => { document.querySelectorAll('[data-rrx-reveal="1"]').forEach((e) => e.removeAttribute('data-rrx-reveal')); }).catch(() => {});
    await VI.clearHighlight(page).catch(() => {});
  };

  for (const r of routes) {
    const name = stem(r.path);
    if (!browser.isConnected()) browser = await chromium.launch(LAUNCH); // resurrect a crashed browser
    const ctxOpts = {
      ignoreHTTPSErrors: true,
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
    };
    if (STORAGE && fs.existsSync(STORAGE)) ctxOpts.storageState = STORAGE; // authed cookie jar -> gated routes render
    if (!NO_VIDEO) ctxOpts.recordVideo = { dir: tmp, size: { width: 1920, height: 1080 } };
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    let ok = true, error = null;
    let discovered = 0, exercised = 0, modalsOpened = 0, capped = false;
    let revealedSubtrees = 0, maxDepthReached = 0;
    const elements = [];
    const visited = new Set();
    const seqRef = { v: 0 };
    try { // critical: load + route. --url mode = direct full-page nav (static page).
      if (URL_ONE) {
        await page.goto(BASE + r.path, { waitUntil: WAITUNTIL, timeout: 45000 });
        await nap(page, 700);
      } else {
        await page.goto(BASE + '/', { waitUntil: WAITUNTIL, timeout: 45000 });
        if (r.path && r.path !== '/') { await deepLink(page, r.path); await nap(page, 1200); }
        await nap(page, 900);
      }
      await VI.ensureLayer(page);
    } catch (e) { ok = false; error = String(e).slice(0, 200); }

    // recursive lazy-tree traversal — descends into freshly-revealed subtrees,
    // SCOPED to the revealed container. Never flips ok, never throws out.
    const exercise = async (scopeSel, depth) => {
      if (depth > MAX_DEPTH || page.isClosed()) return;
      if (depth > maxDepthReached) maxDepthReached = depth;
      let res;
      try { res = await page.evaluate(ENUMERATE(scopeSel, [...visited], seqRef.v)); } catch { res = { seq: seqRef.v, els: [] }; }
      seqRef.v = res.seq || seqRef.v;
      let els = res.els || [];
      if (depth === 0) discovered += els.length;
      if (els.length > CAP) { capped = true; process.stderr.write(`  CAPPED ${name} d${depth}: ${els.length} > cap ${CAP}; first ${CAP}\n`); els = els.slice(0, CAP); }

      for (const el of els) {
        if (page.isClosed()) break;
        if (visited.has(el.stable)) continue;
        visited.add(el.stable);
        const rec = { descriptor: el.descriptor, type: el.type, family: null, scenario: null, depth, revealed: false, options_total: null, options_selected: null, exercised: false, opened_modal: false, error: null };
        try {
          if (!(await VI.hasLayer(page))) await VI.ensureLayer(page);
          const loc = page.locator(`[data-rrx="${el.token}"]`).first();
          if (!(await loc.count())) { rec.error = 'gone'; elements.push(rec); continue; }
          if (!(await loc.isVisible().catch(() => false))) { rec.error = 'hidden'; elements.push(rec); continue; }
          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});

          const fam = VI.classify(el);
          const scenario = SCENARIOS[exercised % SCENARIOS.length];
          const before = await page.evaluate(VI.REVEAL_SNAPSHOT).catch(() => ({ overlays: 0, expanded: 0, details: 0, tabpanels: 0 }));
          const r2 = await fam.interact(page, loc, { depth, scenario, el, label: el.descriptor.slice(0, 18) }).catch((e) => ({ family: fam.name, scenario: 'error', notes: String(e.message || e).slice(0, 60) }));
          rec.family = r2.family; rec.scenario = r2.scenario;
          if (r2.options_total != null) rec.options_total = r2.options_total;
          if (r2.options_selected != null) rec.options_selected = r2.options_selected;
          if (r2.skip) { rec.error = 'skipped-nav'; elements.push(rec); continue; }
          rec.exercised = true; exercised++;
          await nap(page, 250);

          // general reveal detection -> recurse into the revealed scope
          let reveal = null;
          try { reveal = await page.evaluate(VI.REVEAL_DETECT(before)); } catch { reveal = null; }
          if (reveal) {
            rec.revealed = true; revealedSubtrees++;
            if (reveal.kind === 'dialog') { rec.opened_modal = true; modalsOpened++; }
            reveal.depth = depth;
            await VI.clearHighlight(page).catch(() => {});
            await exercise('[data-rrx-reveal="1"]', depth + 1);
            await closeReveal(page, reveal);
          }

          // a click may have navigated us off the route — re-deep-link back
          const here = await currentPath(page);
          if (here != null && r.path && here !== r.path) { await deepLink(page, r.path); await nap(page, 400); await VI.ensureLayer(page); }
        } catch (e) { rec.error = String(e.message || e).slice(0, 80); }
        elements.push(rec);
      }
    };

    try {
      await page.evaluate(async () => {
        for (let y = 0; y <= document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise((s) => setTimeout(s, 100)); }
        window.scrollTo(0, 0);
      }).catch(() => {});
      await VI.ensureLayer(page);
      await exercise('', 0);
      await nap(page, 500);
    } catch { /* page torn down during interaction pass — video already captured */ }

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
      revealed_subtrees: revealedSubtrees, max_depth_reached: maxDepthReached,
      elements, ok: NO_VIDEO ? ok : (ok && bytes > 0), error,
    });
    process.stderr.write(`recorded ${name} (${r.path}) ${bytes}B discovered=${discovered} exercised=${exercised} revealed=${revealedSubtrees} maxDepth=${maxDepthReached} modals=${modalsOpened}${error ? ' ERR:' + error : ''}\n`);
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  manifest.count = manifest.routes.length;
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ ok: true, routes: manifest.count, out: OUT }));
})();
