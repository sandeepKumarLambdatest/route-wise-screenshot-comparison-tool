#!/usr/bin/env node
/**
 * selector-inventory.js — CONCRETE, GENERAL per-route full selector inventory.
 *
 * For each route of a served SPA, navigate to it and emit the COMPLETE list of
 * interactive/actionable selectors present on that route — not a sample, not
 * tied to one repo's class names. Works off the REAL rendered DOM (more reliable
 * than static AST), so it captures everything the user can actually act on:
 *   links (a[href]), buttons, inputs/textareas/selects, [role=button|tab|link|
 *   menuitem|menuitemcheckbox|radio|checkbox|switch|combobox|option|slider|
 *   treeitem|gridcell|spinbutton], [onclick], [tabindex>=0], summary/details,
 *   [contenteditable], label[for], and anything carrying data-testid/aria-label.
 *
 * For every element it synthesizes a STABLE selector with this preference order:
 *   data-testid  ->  #id (if unique & not auto-generated)  ->  [name="..."]
 *   ->  a[href="..."]  ->  [aria-label="..."]  ->  role+text  ->  robust CSS path
 * It also emits tag, role, type, visible text/label, href, and a disabled flag.
 * De-duped by stable selector. Output is deterministic (document order).
 *
 *   node tools/selector-inventory.js --base http://localhost:5000 --routes routes.json [--out inventory]
 *   node tools/selector-inventory.js --base http://localhost:5000 --repo /path/to/app   [--out inventory]
 *   node tools/selector-inventory.js --base http://localhost:5098 --url /widgets.html   [--out inventory]
 *
 * --routes  extract-routes.js JSON ({routes:[{path,...}]}).  --repo runs it.
 * --url     single path via direct full-page nav (static page / MPA).
 * --hash    HashRouter: deep-link via location.hash.
 * --storage Playwright storageState JSON -> authed session for gated routes.
 * --include-hidden  also list elements that are present but not visible.
 *
 * Emits <out>/inventory.json  +  <out>/inventory.md (human-readable) and prints a
 * JSON summary {routes, totalSelectors, perRoute:[{path,count}]} to stdout.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

function arg(flag, def) { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : def; }
function has(flag) { return process.argv.includes(flag); }

const BASE = (arg('--base') || '').replace(/\/$/, '');
const ROUTES_FILE = arg('--routes');
const REPO = arg('--repo');
const URL_ONE = arg('--url');
const OUT = arg('--out', 'inventory');
const MAX = arg('--max') ? parseInt(arg('--max'), 10) : Infinity;
const INCLUDE_TEMPLATED = has('--templated');
const HASH = has('--hash');
const STORAGE = arg('--storage');
const WAITUNTIL = arg('--waituntil', 'networkidle');
const INCLUDE_HIDDEN = has('--include-hidden');

if (!BASE || (!ROUTES_FILE && !REPO && !URL_ONE)) {
  console.error('usage: selector-inventory.js --base <url> (--routes <file.json> | --repo <dir> | --url <path>) [--out inventory] [--max N] [--hash] [--storage cookies.json] [--include-hidden]');
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
function stem(p) {
  if (!p || p === '/') return 'root';
  return p.replace(/^\/+|\/+$/g, '').replace(/:/g, '$').replace(/\*/g, 'star').replace(/[^\w$.-]+/g, '_') || 'root';
}

// ── the full per-route selector inventory (runs IN-PAGE) ─────────────────────
// Enumerates EVERY interactive/actionable element in the live DOM and builds a
// stable, human-meaningful selector for each. General: keyed off semantic
// tags/roles/attributes, never an app's bespoke class names.
function INVENTORY(includeHidden) {
  return `(() => {
  const INCLUDE_HIDDEN = ${includeHidden ? 'true' : 'false'};
  const SEL = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'option', 'label[for]',
    'summary', 'details', 'audio[controls]', 'video[controls]', 'iframe',
    '[contenteditable]', '[contenteditable=true]', '[onclick]', '[tabindex]',
    '[role=button]', '[role=link]', '[role=tab]', '[role=menuitem]',
    '[role=menuitemcheckbox]', '[role=menuitemradio]', '[role=checkbox]',
    '[role=radio]', '[role=switch]', '[role=slider]', '[role=spinbutton]',
    '[role=combobox]', '[role=option]', '[role=searchbox]', '[role=textbox]',
    '[role=treeitem]', '[role=gridcell]', '[aria-haspopup]', '[aria-expanded]',
    '[data-testid]', '[data-test]', '[data-cy]', '[aria-label]'
  ].join(',');

  const A = (el, n) => el.getAttribute(n);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) return false;
    return true;
  };
  const isDisabled = (el) => !!(el.disabled || A(el, 'aria-disabled') === 'true' || A(el, 'disabled') != null);
  // is the element in persistent page chrome (nav/sidebar/header/footer) vs route content?
  const isChrome = (el) => !!el.closest('nav,[role=navigation],aside,header,footer,.sidebar,.app-header,.app-footer,.navbar,.ant-menu,.MuiDrawer-root,[class*="sidebar" i],[class*="navbar" i],[class*="header" i],[class*="footer" i]');

  // visible text / accessible label, trimmed
  const labelOf = (el) => {
    const aria = A(el, 'aria-label'); if (aria) return aria.trim().slice(0, 80);
    const labelledby = A(el, 'aria-labelledby');
    if (labelledby) {
      const t = labelledby.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? (n.textContent || '').trim() : ''; }).join(' ').trim();
      if (t) return t.slice(0, 80);
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (el.id) { const lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]'); if (lab) return (lab.textContent || '').trim().slice(0, 80); }
      const ph = A(el, 'placeholder'); if (ph) return ph.trim().slice(0, 80);
      const nm = A(el, 'name'); if (nm) return nm.slice(0, 80);
    }
    const txt = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (txt) return txt.slice(0, 80);
    const title = A(el, 'title'); if (title) return title.trim().slice(0, 80);
    const alt = A(el, 'alt'); if (alt) return alt.trim().slice(0, 80);
    return '';
  };

  // semantic kind for the matcher (general, role/tag-driven)
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = (A(el, 'role') || '').toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') { const t = (A(el, 'type') || 'text').toLowerCase(); if (/^(checkbox)$/.test(t)) return 'checkbox'; if (/^(radio)$/.test(t)) return 'radio'; if (/^(submit|button|reset|image)$/.test(t)) return 'button'; return 'input'; }
    if (tag === 'textarea') return 'textarea';
    if (tag === 'select') return 'select';
    if (tag === 'label') return 'label';
    if (tag === 'summary' || tag === 'details') return 'disclosure';
    if (el.hasAttribute('contenteditable')) return 'contenteditable';
    if (role) return role; // tab/menuitem/switch/slider/combobox/option/treeitem...
    if (el.hasAttribute('onclick')) return 'clickable';
    return 'interactive';
  };

  // is the id app-meaningful (not an auto-generated/hashed token)?
  const STABLE_ID = (id) => id && id.length <= 64 && !/^(:|r[0-9a-z]+:|radix-|headlessui-|mui-|react-|ember\\d|ext-gen|\\d)/i.test(id) && !/[0-9a-f]{8,}/i.test(id) && /^[A-Za-z][\\w:.-]*$/.test(id);

  const esc = (v) => (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\\\]/g, '\\\\$&');
  const uniq = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch { return false; } };

  // robust CSS path: nearest ancestor with a stable id/testid, then tag:nth-of-type chain
  const cssPath = (el) => {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6; depth++) {
      const tid = node.getAttribute && (node.getAttribute('data-testid') || node.getAttribute('data-test') || node.getAttribute('data-cy'));
      if (tid) { parts.unshift('[data-testid="' + esc(tid) + '"]'); break; }
      const id = node.id;
      if (STABLE_ID(id)) { parts.unshift('#' + esc(id)); break; }
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(' > ');
  };

  // STABLE selector, preference-ordered. Always returns the most meaningful UNIQUE one.
  const stableSelector = (el) => {
    const tid = A(el, 'data-testid') || A(el, 'data-test') || A(el, 'data-cy');
    if (tid) { const s = '[data-testid="' + esc(tid) + '"]'; if (uniq(s)) return { selector: s, basis: 'data-testid' }; return { selector: s, basis: 'data-testid-nonuniq' }; }
    if (STABLE_ID(el.id)) { const s = '#' + esc(el.id); if (uniq(s)) return { selector: s, basis: 'id' }; }
    const nm = A(el, 'name');
    if (nm) { const s = el.tagName.toLowerCase() + '[name="' + esc(nm) + '"]'; if (uniq(s)) return { selector: s, basis: 'name' }; }
    if (el.tagName === 'A' && el.getAttribute('href')) { const href = el.getAttribute('href'); const s = 'a[href="' + esc(href) + '"]'; if (uniq(s)) return { selector: s, basis: 'href' }; }
    const aria = A(el, 'aria-label');
    if (aria) { const s = el.tagName.toLowerCase() + '[aria-label="' + esc(aria) + '"]'; if (uniq(s)) return { selector: s, basis: 'aria-label' }; }
    const role = A(el, 'role');
    if (role) { const s = '[role="' + esc(role) + '"]'; if (uniq(s)) return { selector: s, basis: 'role' }; }
    return { selector: cssPath(el), basis: 'css-path' };
  };

  const nodes = [...document.querySelectorAll(SEL)];
  const out = [];
  const seen = new Set();
  for (const el of nodes) {
    const vis = isVisible(el);
    if (!vis && !INCLUDE_HIDDEN) continue;
    const tag = el.tagName.toLowerCase();
    if (tag === 'option') continue; // listed under their <select>, not standalone
    const ss = stableSelector(el);
    if (seen.has(ss.selector)) continue;
    seen.add(ss.selector);
    const rec = {
      selector: ss.selector,
      selectorBasis: ss.basis,
      kind: kindOf(el),
      tag,
      role: A(el, 'role') || '',
      type: tag === 'input' ? (A(el, 'type') || 'text') : '',
      label: labelOf(el),
      href: tag === 'a' ? (el.getAttribute('href') || '') : '',
      testid: A(el, 'data-testid') || A(el, 'data-test') || A(el, 'data-cy') || '',
      ariaLabel: A(el, 'aria-label') || '',
      name: A(el, 'name') || '',
      placeholder: A(el, 'placeholder') || '',
      disabled: isDisabled(el),
      visible: vis,
      region: isChrome(el) ? 'chrome' : 'content',
    };
    if (tag === 'select') {
      rec.options = [...el.options].map((o) => ({ value: o.value, label: (o.textContent || '').trim().slice(0, 60) }));
    }
    out.push(rec);
  }
  return out;
})()`;
}

function summarize(els) {
  const byKind = {};
  for (const e of els) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return byKind;
}

function toMarkdown(manifest) {
  const lines = [];
  lines.push(`# Per-route selector inventory`);
  lines.push('');
  lines.push(`Served base: \`${manifest.base}\``);
  lines.push(`Generated: ${manifest.generatedAt}`);
  lines.push(`Routes: ${manifest.routes.length} · Total selectors: ${manifest.totalSelectors}`);
  lines.push('');
  for (const r of manifest.routes) {
    lines.push(`## \`${r.path}\` — ${r.count} selectors`);
    if (r.error) { lines.push(`> error: ${r.error}`); lines.push(''); continue; }
    const byKind = summarize(r.selectors);
    const content = r.selectors.filter((e) => e.region === 'content').length;
    const chrome = r.selectors.length - content;
    lines.push(`content: ${content} · chrome/nav: ${chrome}`);
    lines.push(`by kind: ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(', ') || '(none)'}`);
    lines.push('');
    lines.push('| # | selector | kind | region | label | href/type | basis |');
    lines.push('|---|----------|------|--------|-------|-----------|-------|');
    r.selectors.forEach((e, i) => {
      const sel = '`' + e.selector.replace(/\|/g, '\\|') + '`';
      const lab = (e.label || '').replace(/\|/g, '\\|').slice(0, 40);
      const extra = e.href || e.type || (e.options ? `${e.options.length} options` : '');
      lines.push(`| ${i + 1} | ${sel} | ${e.kind} | ${e.region} | ${lab} | ${extra} | ${e.selectorBasis} |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

(async () => {
  const all = loadRoutes();
  const routes = all.filter((r) => INCLUDE_TEMPLATED || !r.templated).slice(0, MAX);
  fs.mkdirSync(OUT, { recursive: true });

  process.on('unhandledRejection', () => {});
  const LAUNCH = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--ignore-certificate-errors', '--disable-http2', '--window-size=1920,1080'] };
  let browser = await chromium.launch(LAUNCH);
  const manifest = { generatedAt: new Date().toISOString(), base: BASE, includeHidden: INCLUDE_HIDDEN, routes: [], totalSelectors: 0 };

  const deepLink = async (page, p) => {
    if (HASH) await page.evaluate((pp) => { window.location.hash = pp; window.dispatchEvent(new HashChangeEvent('hashchange')); }, p).catch(() => {});
    else await page.evaluate((pp) => { window.history.pushState({}, '', pp); window.dispatchEvent(new PopStateEvent('popstate')); }, p).catch(() => {});
  };

  for (const r of routes) {
    const ctxOpts = { ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 };
    if (STORAGE && fs.existsSync(STORAGE)) ctxOpts.storageState = STORAGE;
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    let selectors = [], error = null;
    try {
      if (URL_ONE) { await page.goto(BASE + r.path, { waitUntil: WAITUNTIL, timeout: 45000 }); await sleep(700); }
      else { await page.goto(BASE + '/', { waitUntil: WAITUNTIL, timeout: 45000 }); if (r.path && r.path !== '/') { await deepLink(page, r.path); await sleep(1200); } await sleep(800); }
      // settle lazy content + scroll so deferred elements mount
      await page.evaluate(async () => { for (let y = 0; y <= document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise((s) => setTimeout(s, 80)); } window.scrollTo(0, 0); }).catch(() => {});
      await sleep(300);
      selectors = await page.evaluate(INVENTORY(INCLUDE_HIDDEN));
    } catch (e) { error = String(e.message || e).slice(0, 200); }
    await ctx.close();
    manifest.routes.push({ path: r.path, name: stem(r.path), count: selectors.length, selectors, error });
    manifest.totalSelectors += selectors.length;
    process.stderr.write(`inventory ${r.path}: ${selectors.length} selectors${error ? ' ERR:' + error : ''}\n`);
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'inventory.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(OUT, 'inventory.md'), toMarkdown(manifest));
  console.log(JSON.stringify({ ok: true, routes: manifest.routes.length, totalSelectors: manifest.totalSelectors, out: OUT, perRoute: manifest.routes.map((r) => ({ path: r.path, count: r.count })) }));
})();
