#!/usr/bin/env node
/**
 * check-auth.js — is the stored cookie jar still a valid session?
 *
 * Loads cookies.json (Playwright storageState shape), hits CHECK_URL on BASE,
 * and reports authed=true iff we did NOT bounce to /login or /sso.
 * Exit 0 = authed (reuse), 2 = not authed (must (re)login), 3 = error.
 *
 *   BASE=https://accounts.lambdatest.com CHECK_URL=/details/profile \
 *   COOKIES=./reports/.auth/cookies.json node tools/check-auth.js
 */
const fs = require('fs');
const { chromium } = require('playwright-core');

const { BASE } = process.env;
const CHECK_URL = process.env.CHECK_URL || '/dashboard';
const COOKIES = process.env.COOKIES || './reports/.auth/cookies.json';
if (!BASE) { console.error('need BASE'); process.exit(64); }

(async () => {
  if (!fs.existsSync(COOKIES)) { console.log(JSON.stringify({ authed: false, reason: 'no-cookie-file' })); process.exit(2); }
  let state;
  try { state = JSON.parse(fs.readFileSync(COOKIES, 'utf8')); } catch (e) { console.error(String(e)); process.exit(3); }
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--ignore-certificate-errors'] });
  try {
    const ctx = await browser.newContext({ storageState: state, ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE.replace(/\/$/, '')}${CHECK_URL}`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(2500);
    const url = page.url();
    const authed = !/\/login|\/sso\b/.test(url);
    console.log(JSON.stringify({ authed, url }));
    await browser.close();
    process.exit(authed ? 0 : 2);
  } catch (e) {
    console.error(String(e));
    await browser.close().catch(() => {});
    process.exit(3);
  }
})();
