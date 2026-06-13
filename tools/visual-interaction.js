/**
 * visual-interaction.js — synthetic cursor/highlight visual layer + an extensible
 * interactable-FAMILY strategy registry for record-routes.js.
 *
 * Headless video has no OS cursor, so we inject `window.__rrx`: a fixed glowing
 * dot + ring cursor (above app content, never intercepting clicks), a smooth
 * eased moveTo, a click ripple, and an animated highlight box + action label.
 * Harness helpers (ensureLayer/visualClick/visualFill/moveCursorTo) re-inject the
 * layer if an SPA re-render dropped it, then drive cursor+highlight before the
 * real Playwright action.
 *
 * The family REGISTRY classifies an enumerated element (tag/role/aria/class) into
 * an interactable family and performs the visible action, returning
 * { family, scenario, options_total?, options_selected?, revealedHint?, notes }.
 * Dropdowns are just one family; text/checkbox/switch/slider/select/combobox/
 * multiselect/tab/accordion/menu/modal-trigger/popover/link/button all register.
 */

// ── in-page visual layer ─────────────────────────────────────────────────────
const INJECT_VISUAL_LAYER = `(() => {
  if (window.__rrx) return true;
  const root = document.documentElement;
  const mk = (css) => { const d = document.createElement('div'); d.style.cssText = css; root.appendChild(d); return d; };
  const Z = 2147483647;
  const cursor = mk('position:fixed;left:0;top:0;width:24px;height:24px;border-radius:50%;'
    + 'background:radial-gradient(circle,rgba(88,166,255,.95) 0%,rgba(88,166,255,.55) 45%,rgba(88,166,255,0) 70%);'
    + 'box-shadow:0 0 14px 4px rgba(88,166,255,.8);pointer-events:none;z-index:' + Z + ';'
    + 'transform:translate(-50%,-50%);transition:none;will-change:left,top');
  const ring = mk('position:fixed;left:0;top:0;width:40px;height:40px;border-radius:50%;'
    + 'border:2px solid rgba(88,166,255,.7);pointer-events:none;z-index:' + (Z - 1) + ';'
    + 'transform:translate(-50%,-50%);opacity:.7');
  const hl = mk('position:fixed;left:0;top:0;width:0;height:0;border:2px solid #f0b429;border-radius:6px;'
    + 'box-shadow:0 0 0 3px rgba(240,180,41,.25),0 0 18px 3px rgba(240,180,41,.45);'
    + 'pointer-events:none;z-index:' + (Z - 2) + ';opacity:0;transition:opacity .15s,left .25s,top .25s,width .25s,height .25s');
  const badge = mk('position:fixed;left:0;top:0;pointer-events:none;z-index:' + Z + ';'
    + 'font:600 12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#0d1117;background:#f0b429;'
    + 'padding:2px 8px;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,.4);opacity:0;transition:opacity .15s;white-space:nowrap');
  let cx = window.innerWidth / 2, cy = window.innerHeight / 2;
  const place = (x, y) => { cx = x; cy = y; cursor.style.left = ring.style.left = x + 'px'; cursor.style.top = ring.style.top = y + 'px'; };
  place(cx, cy);
  const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const TINT = ['#f0b429', '#58a6ff', '#3fb950', '#d2a8ff', '#ff7b72'];
  window.__rrx = {
    pos: () => ({ x: cx, y: cy }),
    moveTo(x, y, ms) {
      ms = ms || 550;
      const sx = cx, sy = cy, t0 = performance.now();
      return new Promise((res) => {
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms), e = easeInOutCubic(p);
          place(sx + (x - sx) * e, sy + (y - sy) * e);
          if (p < 1) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      });
    },
    ripple(x, y) {
      const r = mk('position:fixed;left:' + x + 'px;top:' + y + 'px;width:12px;height:12px;border-radius:50%;'
        + 'border:2px solid rgba(88,166,255,.9);pointer-events:none;z-index:' + (Z - 1) + ';'
        + 'transform:translate(-50%,-50%) scale(1);opacity:.9;transition:transform .45s ease-out,opacity .45s ease-out');
      requestAnimationFrame(() => { r.style.transform = 'translate(-50%,-50%) scale(5)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    },
    highlight(rect, labelText, depth) {
      const c = TINT[(depth || 0) % TINT.length];
      hl.style.borderColor = c;
      hl.style.boxShadow = '0 0 0 3px ' + c + '40,0 0 18px 3px ' + c + '73';
      hl.style.opacity = '1';
      hl.style.left = rect.x + 'px'; hl.style.top = rect.y + 'px';
      hl.style.width = rect.width + 'px'; hl.style.height = rect.height + 'px';
      if (labelText) {
        badge.style.background = c; badge.textContent = labelText; badge.style.opacity = '1';
        const by = rect.y - 22 < 4 ? rect.y + rect.height + 4 : rect.y - 22;
        badge.style.left = rect.x + 'px'; badge.style.top = by + 'px';
      }
    },
    clearHighlight() { hl.style.opacity = '0'; badge.style.opacity = '0'; },
  };
  return true;
})()`;

// snapshot of open overlay/portal state, used by detectReveal delta
const REVEAL_SNAPSHOT = `(() => {
  const OVERLAY = '[role=dialog],[aria-modal=true],[role=listbox],[role=menu],.ant-select-dropdown,.MuiMenu-list,.MuiPopover-root,[class*=popover],[class*=Popover],[class*=drawer],[class*=Drawer],.ant-drawer-content,[role=tooltip]';
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
  const overlays = [...document.querySelectorAll(OVERLAY)].filter(vis).length;
  const expanded = [...document.querySelectorAll('[aria-expanded=true]')].length;
  const details = [...document.querySelectorAll('details[open]')].length;
  const tabpanels = [...document.querySelectorAll('[role=tabpanel]')].filter(vis).length;
  return { overlays, expanded, details, tabpanels };
})()`;

// after an action: did a NEW subtree appear? return a scoping token for the
// freshly-revealed container, or null. Tags the container with data-rrx-reveal.
function REVEAL_DETECT(before) {
  return `(() => {
  const before = ${JSON.stringify(before)};
  const OVERLAY = '[role=dialog],[aria-modal=true],[role=listbox],[role=menu],.ant-select-dropdown,.MuiMenu-list,.MuiMenu-paper,.MuiPopover-paper,[class*=popover],[class*=Popover],.ant-drawer-content,[role=tooltip]';
  const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
  const tag = (el, kind) => { if (!el) return null; el.setAttribute('data-rrx-reveal', '1'); return { kind, closer: kind }; };
  // 1) a new overlay/portal node
  const overlays = [...document.querySelectorAll(OVERLAY)].filter(vis);
  if (overlays.length > before.overlays) {
    const el = overlays[overlays.length - 1];
    const dialog = el.closest('[role=dialog],[aria-modal=true],.ant-modal-content,.MuiDialog-paper');
    return tag(dialog || el, dialog ? 'dialog' : (el.matches('[role=listbox],.ant-select-dropdown') ? 'listbox' : el.matches('[role=menu],.MuiMenu-list') ? 'menu' : 'portal'));
  }
  // 2) an aria-expanded flip -> recurse into aria-controls target or adjacent region
  const exp = [...document.querySelectorAll('[aria-expanded=true]')];
  if (exp.length > before.expanded) {
    const trig = exp[exp.length - 1];
    const ctrl = trig.getAttribute('aria-controls');
    let target = ctrl && document.getElementById(ctrl);
    if (!target) target = trig.nextElementSibling && vis(trig.nextElementSibling) ? trig.nextElementSibling : (trig.parentElement);
    return tag(target || trig, 'expanded');
  }
  // 3) a <details> opened
  const det = [...document.querySelectorAll('details[open]')];
  if (det.length > before.details) return tag(det[det.length - 1], 'details');
  // 4) a newly-visible tabpanel
  const tp = [...document.querySelectorAll('[role=tabpanel]')].filter(vis);
  if (tp.length > before.tabpanels) return tag(tp[tp.length - 1], 'tabpanel');
  return null;
})()`;
}

// ── harness helpers (operate on a Playwright page/locator) ───────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureLayer(page) {
  try { await page.evaluate(INJECT_VISUAL_LAYER); } catch { /* re-injected next time */ }
}
async function hasLayer(page) {
  try { return await page.evaluate(() => !!window.__rrx); } catch { return false; }
}
async function bbox(loc) {
  try { return await loc.boundingBox({ timeout: 1500 }); } catch { return null; }
}
async function moveCursorTo(page, x, y, label, depth) {
  try {
    await page.evaluate(async ({ x, y, label, depth }) => {
      if (!window.__rrx) return;
      if (label != null) window.__rrx.highlight({ x: x - 30, y: y - 14, width: 60, height: 28 }, label, depth);
      await window.__rrx.moveTo(x, y, 520);
    }, { x, y, label, depth });
  } catch { /* best-effort */ }
}
async function highlightLoc(page, loc, label, depth) {
  const b = await bbox(loc);
  if (!b) return null;
  try {
    await page.evaluate(({ b, label, depth }) => { if (window.__rrx) window.__rrx.highlight(b, label, depth); }, { b, label, depth });
  } catch { /* */ }
  return b;
}
async function clearHighlight(page) {
  try { await page.evaluate(() => { if (window.__rrx) window.__rrx.clearHighlight(); }); } catch { /* */ }
}

// cursor -> bbox center -> highlight+label -> smooth move -> ripple -> pause -> real click
async function visualClick(page, loc, label, depth) {
  if (!(await hasLayer(page))) await ensureLayer(page);
  const b = await bbox(loc);
  if (b) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    try {
      await page.evaluate(({ b, label, depth }) => { if (window.__rrx) window.__rrx.highlight(b, label, depth); }, { b, label, depth });
    } catch { /* */ }
    await moveCursorTo(page, cx, cy, null, depth);
    try { await page.evaluate(({ cx, cy }) => { if (window.__rrx) window.__rrx.ripple(cx, cy); }, { cx, cy }); } catch { /* */ }
    await sleep(360);
  }
  await loc.click({ timeout: 2500 });
}

async function visualFill(page, loc, value, label, depth) {
  if (!(await hasLayer(page))) await ensureLayer(page);
  const b = await bbox(loc);
  if (b) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    try { await page.evaluate(({ b, label, depth }) => { if (window.__rrx) window.__rrx.highlight(b, label, depth); }, { b, label, depth }); } catch { /* */ }
    await moveCursorTo(page, cx, cy, null, depth);
    await sleep(200);
  }
  await loc.click({ timeout: 1500 }).catch(() => {});
  try { await loc.fill(''); } catch { /* */ }
  await loc.pressSequentially(value, { delay: 45, timeout: 4000 });
}

// ── family registry ──────────────────────────────────────────────────────────
// Each: { name, match(elInfo)->bool, interact(page, loc, ctx)->result }.
// elInfo = enumerated descriptor {type,role,tag,haspopup,expanded,multiselectable,classHint,...}.
// ctx = { depth, scenario, label }. result drives manifest + recursion.

const ci = (s) => (s || '').toLowerCase();
const cls = (e) => ci(e.classHint);
// prefix a scope selector onto EACH comma-branch (a bare prefix only binds the first)
const scoped = (prefix, sel) => prefix ? sel.split(',').map((s) => prefix + s.trim()).join(',') : sel;

// after a trigger opens a dropdown/menu, resolve the just-revealed option
// container (aria-controls target, adjacent listbox/menu, or the last visible
// portal) and tag it data-rrx-scope so option queries stay SCOPED to it.
async function markOpenScope(page, triggerToken) {
  try {
    return await page.evaluate((tok) => {
      document.querySelectorAll('[data-rrx-scope]').forEach((e) => e.removeAttribute('data-rrx-scope'));
      const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const s = getComputedStyle(el); return s.display !== 'none' && s.visibility !== 'hidden'; };
      const trig = tok ? document.querySelector('[data-rrx="' + tok + '"]') : null;
      let box = null;
      if (trig) {
        const c = trig.getAttribute('aria-controls');
        if (c) box = document.getElementById(c);
        if (!box || !vis(box)) { let n = trig.nextElementSibling; while (n && !vis(n)) n = n.nextElementSibling; if (n && n.matches('[role=listbox],[role=menu],.ant-select-dropdown,.MuiMenu-list')) box = n; }
      }
      if (!box || !vis(box)) {
        const cand = [...document.querySelectorAll('[role=listbox],[role=menu],.ant-select-dropdown,.MuiMenu-list,.MuiPopover-paper')].filter(vis);
        box = cand[cand.length - 1] || null;
      }
      if (box) { box.setAttribute('data-rrx-scope', '1'); return true; }
      return false;
    }, triggerToken);
  } catch { return false; }
}

const FAMILIES = [
  {
    name: 'text',
    match: (e) => e.tag === 'textarea' || e.contenteditable || (e.tag === 'input' && /^(text|email|search|tel|url|password|number|)$/.test(ci(e.inputType))),
    async interact(page, loc, ctx) {
      await visualFill(page, loc, 'Sample text', 'type', ctx.depth);
      return { family: 'text', scenario: 'fill', notes: 'typed sample value' };
    },
  },
  {
    name: 'slider',
    match: (e) => (e.tag === 'input' && ci(e.inputType) === 'range') || e.role === 'slider',
    async interact(page, loc, ctx) {
      await highlightLoc(page, loc, 'set slider', ctx.depth);
      await loc.focus().catch(() => {});
      for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight').catch(() => {}); await sleep(80); }
      return { family: 'slider', scenario: 'increment', notes: 'arrow-key increment x5' };
    },
  },
  {
    name: 'switch',
    match: (e) => e.role === 'switch' || /switch|toggle/.test(cls(e)),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'toggle on', ctx.depth);
      await sleep(300);
      await visualClick(page, loc, 'toggle off', ctx.depth).catch(() => {});
      return { family: 'switch', scenario: 'on-off', notes: 'toggled on then off' };
    },
  },
  {
    name: 'checkbox',
    match: (e) => e.tag === 'input' && /^(checkbox|radio)$/.test(ci(e.inputType)),
    async interact(page, loc, ctx) {
      const isRadio = ci(ctx.el.inputType) === 'radio';
      await visualClick(page, loc, isRadio ? 'pick radio' : 'toggle', ctx.depth);
      return { family: isRadio ? 'radio' : 'checkbox', scenario: isRadio ? 'pick-one' : 'toggle', notes: '' };
    },
  },
  {
    name: 'native-select',
    match: (e) => e.tag === 'select',
    async interact(page, loc, ctx) {
      const multiple = await loc.evaluate((s) => s.multiple).catch(() => false);
      const vals = await loc.evaluate((s) => [...s.options].map((o) => o.value).filter(Boolean)).catch(() => []);
      const total = vals.length;
      if (multiple) {
        const n = Math.max(1, Math.ceil(total / 2));
        const pick = vals.slice(0, n);
        await highlightLoc(page, loc, `select ${n} of ${total}`, ctx.depth);
        await loc.selectOption(pick, { timeout: 2000 }).catch(() => {});
        return { family: 'native-select', scenario: 'x-of-n', options_total: total, options_selected: pick.length, notes: 'multiple' };
      }
      await highlightLoc(page, loc, 'select option', ctx.depth);
      const idx = Math.min(1, total - 1);
      if (total) await loc.selectOption(vals[idx], { timeout: 2000 }).catch(() => loc.selectOption(vals[0], { timeout: 2000 }).catch(() => {}));
      return { family: 'native-select', scenario: 'single', options_total: total, options_selected: total ? 1 : 0, notes: '' };
    },
  },
  {
    name: 'multiselect',
    match: (e) => e.multiselectable || /ant-select-multiple|multiselect|multi-select|tag-input|css-.*-multiValue/.test(cls(e))
      || (e.role === 'listbox' && e.multiselectable),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'open multiselect', ctx.depth);
      await sleep(450);
      const marked = await markOpenScope(page, ctx.el.token);
      const optSel = '[role=option],[role=menuitemcheckbox],.ant-select-item-option,li[role=option]';
      const scenario = ctx.scenario || 'x-of-n';
      let selected = 0, total = 0, used = scenario;
      try {
        const prefix = marked ? '[data-rrx-scope] ' : '';
        const optS = scoped(prefix, optSel);
        const opts = page.locator(optS);
        total = await opts.count().catch(() => 0);
        // a "select all" control among the options shouldn't inflate the option count
        const allBtn = page.locator(scoped(prefix, '[data-sa],button,[role=option],[role=menuitemcheckbox],label,.ant-select-item') + ':has-text("elect all")').first();
        const hasAll = await allBtn.count().catch(() => 0);
        if (scenario === 'select-all') {
          if (hasAll) {
            await visualClick(page, allBtn, 'select all', ctx.depth + 1).catch(() => {});
            selected = total;
          } else {
            const cap = Math.min(total, 8);
            for (let i = 0; i < cap; i++) { await opts.nth(i).click({ timeout: 1200 }).catch(() => {}); selected++; await sleep(120); }
            if (total > cap) process.stderr && process.stderr.write(`    multiselect select-all capped ${cap}/${total}\n`);
          }
          used = 'select-all';
        } else if (scenario === 'toggle') {
          const cap = Math.min(total, 3);
          for (let i = 0; i < cap; i++) { await opts.nth(i).click({ timeout: 1200 }).catch(() => {}); selected++; await sleep(120); }
          if (cap > 0) { await opts.nth(0).click({ timeout: 1200 }).catch(() => {}); selected = Math.max(0, selected - 1); await sleep(120); }
        } else {
          const n = Math.max(1, Math.ceil(total / 2));
          for (let i = 0; i < n; i++) { await opts.nth(i).click({ timeout: 1200 }).catch(() => {}); selected++; await sleep(120); }
        }
      } catch { /* best-effort */ }
      await page.keyboard.press('Escape').catch(() => {});
      await page.evaluate(() => document.querySelectorAll('[data-rrx-scope]').forEach((e) => e.removeAttribute('data-rrx-scope'))).catch(() => {});
      await sleep(200);
      return { family: 'multiselect', scenario: used, options_total: total, options_selected: selected, notes: 'multi options' };
    },
  },
  {
    name: 'combobox',
    match: (e) => e.role === 'combobox' || ci(e.haspopup) === 'listbox'
      || /MuiSelect-select|ant-select(?!-multiple)|css-.*-control|chakra-select/.test(cls(e)),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'open dropdown', ctx.depth);
      await sleep(420);
      const marked = await markOpenScope(page, ctx.el.token);
      const optSel = '[role=option],.ant-select-item-option,li[role=option],[role=menuitem]';
      let total = 0, selected = 0;
      try {
        const opts = page.locator(scoped(marked ? '[data-rrx-scope] ' : '', optSel));
        total = await opts.count().catch(() => 0);
        for (let i = 0; i < Math.min(2, total); i++) { await highlightLoc(page, opts.nth(i), 'hover option', ctx.depth + 1); await sleep(160); }
        const pick = Math.min(1, total - 1);
        if (total) { await visualClick(page, opts.nth(pick), 'pick option', ctx.depth + 1).catch(() => {}); selected = 1; }
      } catch { /* */ }
      await page.evaluate(() => document.querySelectorAll('[data-rrx-scope]').forEach((e) => e.removeAttribute('data-rrx-scope'))).catch(() => {});
      await sleep(200);
      return { family: 'combobox', scenario: 'single', options_total: total, options_selected: selected, notes: 'custom single-select' };
    },
  },
  {
    name: 'tab',
    match: (e) => e.role === 'tab',
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'switch tab', ctx.depth);
      await sleep(350);
      return { family: 'tab', scenario: 'activate', notes: 'reveals tabpanel' };
    },
  },
  {
    name: 'accordion',
    match: (e) => e.tag === 'summary' || (e.expanded != null && e.role !== 'combobox' && ci(e.haspopup) !== 'menu')
      || /accordion|collapse|disclosure|expand/.test(cls(e)),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'expand', ctx.depth);
      await sleep(350);
      return { family: 'accordion', scenario: 'expand', notes: 'reveals panel' };
    },
  },
  {
    name: 'menu',
    match: (e) => ci(e.haspopup) === 'menu' || ci(e.haspopup) === 'true' || e.role === 'menuitem'
      || /menu-button|dropdown-toggle/.test(cls(e)),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'open menu', ctx.depth);
      await sleep(380);
      return { family: 'menu', scenario: 'open', notes: 'reveals menu/submenu' };
    },
  },
  {
    name: 'modal-trigger',
    match: (e) => /modal|dialog/.test(cls(e)) || /modal|dialog/.test(ci(e.descriptor)),
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'open modal', ctx.depth);
      await sleep(450);
      return { family: 'modal-trigger', scenario: 'open', notes: 'reveals dialog' };
    },
  },
  {
    name: 'popover',
    match: (e) => /popover|tooltip|popup/.test(cls(e)) || ci(e.haspopup) === 'dialog',
    async interact(page, loc, ctx) {
      await visualClick(page, loc, 'open popover', ctx.depth);
      await sleep(350);
      return { family: 'popover', scenario: 'open', notes: 'reveals popover' };
    },
  },
  {
    name: 'link',
    match: (e) => e.tag === 'a' || e.type === 'link',
    async interact(page, loc, ctx) {
      if (ctx.el.chrome) return { family: 'link', scenario: 'skip-nav', notes: 'chrome nav link, not clicked', skip: true };
      await visualClick(page, loc, 'click link', ctx.depth);
      await sleep(250);
      return { family: 'link', scenario: 'click', notes: '' };
    },
  },
  {
    name: 'button', // generic fallback
    match: () => true,
    async interact(page, loc, ctx) {
      await visualClick(page, loc, ctx.label || 'click', ctx.depth);
      await sleep(280);
      return { family: 'button', scenario: 'click', notes: 'generic' };
    },
  },
];

function classify(el) {
  for (const f of FAMILIES) { try { if (f.match(el)) return f; } catch { /* */ } }
  return FAMILIES[FAMILIES.length - 1];
}

module.exports = {
  INJECT_VISUAL_LAYER, REVEAL_SNAPSHOT, REVEAL_DETECT,
  ensureLayer, hasLayer, moveCursorTo, highlightLoc, clearHighlight,
  visualClick, visualFill, bbox, markOpenScope,
  FAMILIES, classify,
};
