#!/usr/bin/env node
/**
 * build-report.js — turn a capture run (index.json + per-route PNGs) into a
 * self-contained static HTML report: a status grid over all routes + a
 * side-by-side image view per route/origin. No Claude, no network.
 *
 *   OUTDIR=./reports/run node tools/build-report.js
 */
const fs = require('fs');
const path = require('path');

const OUTDIR = process.env.OUTDIR || './reports/run';
const index = JSON.parse(fs.readFileSync(path.join(OUTDIR, 'index.json'), 'utf8'));

const verdict = (e) => {
  const s = Object.values(e.shots);
  if (s.some((x) => x.bounced)) return 'auth';
  if (s.some((x) => !x.ok || x.errors.length)) return 'warn';
  return 'pass';
};
const color = { pass: '#1a7f37', warn: '#9a6700', auth: '#8250df', fail: '#cf222e' };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const counts = { pass: 0, warn: 0, auth: 0, fail: 0 };
const rows = index.routes.map((e) => { const v = verdict(e); counts[v]++; return { e, v }; });

const cell = (e, label) => {
  const s = e.shots[label];
  if (!s) return '<td class="shot">—</td>';
  return `<td class="shot"><a href="${esc(s.png)}" target="_blank"><img loading="lazy" src="${esc(s.png)}" alt="${esc(label)}"></a><div class="cap">${esc(label)} · <a href="${esc(s.finalUrl)}" target="_blank">url</a>${s.errors.length ? ` · <span class="err">${s.errors.length} err</span>` : ''}</div></td>`;
};

const detail = rows.map(({ e, v }) => `
  <section id="${esc(e.name)}" class="route">
    <h3><span class="dot" style="background:${color[v]}"></span>${esc(e.name)} <code>${esc(e.path)}</code> <span class="v">${v.toUpperCase()}</span></h3>
    <table class="shots"><tr>${index.origins.map((o) => cell(e, o)).join('')}</tr></table>
  </section>`).join('\n');

const grid = rows.map(({ e, v }) => `<a class="tile" href="#${esc(e.name)}" style="border-color:${color[v]}"><span class="dot" style="background:${color[v]}"></span>${esc(e.name)}</a>`).join('');

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Route-wise Screenshot Report</title>
<style>
 body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#0d1117;color:#e6edf3}
 header{padding:20px 28px;border-bottom:1px solid #21262d;position:sticky;top:0;background:#0d1117;z-index:5}
 h1{margin:0 0 6px;font-size:20px} .sub{color:#8b949e}
 .legend span{margin-right:14px} .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
 .grid{display:flex;flex-wrap:wrap;gap:8px;padding:18px 28px}
 .tile{display:flex;align-items:center;gap:4px;padding:6px 10px;border:1px solid #30363d;border-left-width:4px;border-radius:6px;color:#e6edf3;text-decoration:none;font-size:12px;background:#161b22}
 .route{padding:18px 28px;border-top:1px solid #21262d} .route h3{display:flex;align-items:center;gap:8px;font-size:16px}
 .route code{color:#79c0ff;background:#161b22;padding:2px 6px;border-radius:4px;font-size:12px} .v{font-size:11px;color:#8b949e;margin-left:auto}
 table.shots{width:100%;border-collapse:collapse;table-layout:fixed} td.shot{vertical-align:top;padding:6px}
 td.shot img{width:100%;max-height:520px;object-fit:contain;object-position:top;border:1px solid #30363d;border-radius:6px;display:block;background:#161b22}
 .cap{font-size:11px;color:#8b949e;margin-top:4px} .cap a{color:#79c0ff} .err{color:#f85149}
 a{color:#79c0ff}
</style></head><body>
<header>
 <h1>Route-wise Screenshot Comparison</h1>
 <div class="sub">${esc(index.generatedAt)} · ${index.routes.length} routes · origins: ${index.origins.map(esc).join(', ')}</div>
 <div class="legend" style="margin-top:8px">
  <span><span class="dot" style="background:${color.pass}"></span>pass ${counts.pass}</span>
  <span><span class="dot" style="background:${color.warn}"></span>warn ${counts.warn}</span>
  <span><span class="dot" style="background:${color.auth}"></span>auth-bounce ${counts.auth}</span>
  <span><span class="dot" style="background:${color.fail}"></span>fail ${counts.fail}</span>
 </div>
</header>
<div class="grid">${grid}</div>
${detail}
</body></html>`;

fs.writeFileSync(path.join(OUTDIR, 'index.html'), html);
console.log(JSON.stringify({ ok: true, report: path.join(OUTDIR, 'index.html'), counts }));
