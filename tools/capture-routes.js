#!/usr/bin/env node
/**
 * capture-routes.js — screenshot every extracted route, with the authed cookie
 * injected. Supports two modes:
 *   single  : ORIGINS="prod=https://accounts.lambdatest.com"            (one snapshot/route)
 *   compare : ORIGINS="before=https://a;after=https://b"               (before/after/route)
 *
 * Each route gets its own child context (memory-safe), a full-page PNG per
 * origin, plus captured console errors + failed requests in meta.json.
 *
 *   ROUTES_JSON=./reports/routes.generated.json \
 *   ORIGINS="before=https://a;after=https://b" \
 *   COOKIES=./reports/.auth/cookies.json \
 *   OUTDIR=./reports/run node tools/capture-routes.js
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROUTES_JSON = process.env.ROUTES_JSON || './reports/routes.generated.json';
const COOKIES = process.env.COOKIES || './reports/.auth/cookies.json';
const OUTDIR = process.env.OUTDIR || './reports/run';
const SKIP_TEMPLATED = process.env.INCLUDE_TEMPLATED !== '1';
const MAX_ROUTES = process.env.MAX_ROUTES ? parseInt(process.env.MAX_ROUTES, 10) : Infinity;

function parseOrigins(s) {
  if (!s) throw new Error('set ORIGINS, e.g. "before=https://a;after=https://b" (opt 3rd field = per-origin cookie file: "label=url=./cookies.json")');
  return s.split(';').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    const label = p.slice(0, i).trim();
    const rest = p.slice(i + 1).trim();
    // optional per-origin cookie jar: label=url=/abs/cookies.json
    const j = rest.indexOf('=');
    if (j >= 0) return { label, url: rest.slice(0, j).trim().replace(/\/$/, ''), cookies: rest.slice(j + 1).trim() };
    return { label, url: rest.replace(/\/$/, ''), cookies: null };
  });
}

const _stateCache = {};
function loadState(file) {
  if (!file) return undefined;
  if (!(file in _stateCache)) _stateCache[file] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : undefined;
  return _stateCache[file];
}

(async () => {
  const { routes } = JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8'));
  const origins = parseOrigins(process.env.ORIGINS);
  const defaultState = fs.existsSync(COOKIES) ? JSON.parse(fs.readFileSync(COOKIES, 'utf8')) : undefined;
  const todo = routes.filter((r) => !(SKIP_TEMPLATED && r.templated)).slice(0, MAX_ROUTES);
  fs.mkdirSync(OUTDIR, { recursive: true });

  const index = { generatedAt: new Date().toISOString(), origins: origins.map((o) => o.label), routes: [] };
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-http2', '--window-size=1920,1080'] });

  for (const r of todo) {
    const rdir = path.join(OUTDIR, r.name);
    fs.mkdirSync(rdir, { recursive: true });
    const entry = { name: r.name, path: r.path, shots: {} };
    for (const o of origins) {
      const storageState = o.cookies ? loadState(o.cookies) : defaultState;
      const ctx = await browser.newContext({ storageState, ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const errors = [], failed = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
      page.on('requestfailed', (req) => failed.push(`${req.method()} ${req.url().slice(0, 200)} :: ${req.failure()?.errorText || ''}`));
      const target = `${o.url}${r.path}`;
      let finalUrl = target, ok = true;
      try {
        const resp = await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(1500);
        finalUrl = page.url();
        if (resp && resp.status() >= 400) ok = false;
      } catch (e) { ok = false; errors.push('nav: ' + String(e).slice(0, 200)); }
      const png = path.join(rdir, `${o.label}.png`);
      await page.screenshot({ path: png, fullPage: true }).catch(() => {});
      const bounced = /\/login|\/sso\b/.test(finalUrl) && !/\/login|\/sso/.test(r.path);
      entry.shots[o.label] = { png: path.relative(OUTDIR, png), finalUrl, ok, bounced, errors: errors.slice(0, 10), failed: failed.slice(0, 10) };
      await ctx.close();
    }
    fs.writeFileSync(path.join(rdir, 'meta.json'), JSON.stringify(entry, null, 2));
    index.routes.push(entry);
    process.stderr.write(`captured ${r.name} (${r.path})\n`);
  }
  await browser.close();
  fs.writeFileSync(path.join(OUTDIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(JSON.stringify({ ok: true, routes: index.routes.length, outdir: OUTDIR }));
})();
