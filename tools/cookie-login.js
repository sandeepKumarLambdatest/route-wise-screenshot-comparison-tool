#!/usr/bin/env node
/**
 * cookie-login.js — mint a fresh session by curling the login API DIRECTLY
 * (no browser, no manual step). POSTs {EMAIL_FIELD, PASSWORD_FIELD} to
 * LOGIN_API and harvests every Set-Cookie into a Playwright storageState file
 * that capture-routes.js / check-auth.js consume.
 *
 *   LOGIN_API=https://auth.lambdatest.com/api/login \
 *   ORIGIN=https://accounts.lambdatest.com \
 *   COOKIE_DOMAIN=.lambdatest.com \
 *   EMAIL=... PASSWORD=... \
 *   COOKIES=./reports/.auth/cookies.json node tools/cookie-login.js
 *
 * Exit 0 = cookies written, 2 = login API returned no Set-Cookie, 3 = error.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const {
  LOGIN_API, EMAIL, PASSWORD,
  ORIGIN = '',
  COOKIE_DOMAIN,
  EMAIL_FIELD = 'email',
  PASSWORD_FIELD = 'password',
  EXTRA_BODY = '{}',
} = process.env;
const COOKIES = process.env.COOKIES || './reports/.auth/cookies.json';
if (!LOGIN_API || !EMAIL || !PASSWORD) { console.error('need LOGIN_API, EMAIL, PASSWORD'); process.exit(64); }

function post(urlStr, bodyObj, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(bodyObj);
    const req = lib.request(
      u,
      { method: 'POST', rejectUnauthorized: false, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: buf }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function parseCookie(line, domain) {
  const nv = line.split(';', 1)[0];
  const i = nv.indexOf('=');
  if (i < 0) return null;
  const name = nv.slice(0, i).trim();
  const value = nv.slice(i + 1).trim();
  if (!name) return null;
  return { name, value, domain, path: '/', httpOnly: /httponly/i.test(line), secure: /secure/i.test(line), sameSite: 'Lax' };
}

(async () => {
  try {
    const domain = COOKIE_DOMAIN || (ORIGIN ? `.${new URL(ORIGIN).hostname.replace(/^www\./, '')}` : '');
    if (!domain) { console.error('need COOKIE_DOMAIN or ORIGIN'); process.exit(64); }
    const body = { [EMAIL_FIELD]: EMAIL, [PASSWORD_FIELD]: PASSWORD, ...JSON.parse(EXTRA_BODY) };
    const headers = ORIGIN ? { Origin: ORIGIN, Referer: ORIGIN + '/login' } : {};
    const res = await post(LOGIN_API, body, headers);
    const cookies = (res.setCookie || []).map((l) => parseCookie(l, domain)).filter(Boolean);

    // some APIs return the token in the JSON body instead of Set-Cookie
    if (!cookies.length) {
      try {
        const j = JSON.parse(res.body);
        const token = j.token || j.accessToken || (j.data && (j.data.token || j.data.accessToken));
        if (token) cookies.push({ name: process.env.TOKEN_COOKIE || 'accessToken', value: token, domain, path: '/', httpOnly: false, secure: true, sameSite: 'Lax' });
      } catch { /* not json */ }
    }
    if (!cookies.length) {
      console.error(JSON.stringify({ status: res.status, reason: 'no-set-cookie', bodyHead: res.body.slice(0, 200) }));
      process.exit(2);
    }
    const state = { cookies, origins: [] };
    fs.mkdirSync(path.dirname(COOKIES), { recursive: true });
    fs.writeFileSync(COOKIES, JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ ok: true, status: res.status, cookies: cookies.map((c) => c.name), file: COOKIES }));
    process.exit(0);
  } catch (e) {
    console.error(String(e));
    process.exit(3);
  }
})();
