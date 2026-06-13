#!/usr/bin/env node
/**
 * extract-routes.js — standalone, convention-generalized route extractor.
 *
 * Stage-3 of the explorer pipeline (clone -> detect-build -> build&serve ->
 * EXTRACT ROUTES -> route-wise Playwright). Unlike route-extractor-loader.js
 * (which only runs *inside* a webpack build, against one pre-configured source
 * file, and only understands flat `<*Route path>` / flat `{path}` literals),
 * this is a plain node module callable on any repo path. It scans the source
 * tree for whatever file actually declares the routes and understands the two
 * dominant react-router-dom v6 conventions plus nesting:
 *
 *   1. JSX element form:
 *        <Routes>
 *          <Route path="/" element={<Layout/>}>
 *            <Route index element={<Home/>} />     // inherits parent path
 *            <Route path="about" element={<About/>} />   // relative -> joined
 *            <Route path="products" ...>
 *              <Route path=":id" .../>              // -> /products/:id
 *            </Route>
 *          </Route>
 *        </Routes>
 *      (also createRoutesFromElements(<Route .../>))
 *
 *   2. Object/data-router form:
 *        createBrowserRouter([{ path:'/', children:[{ index:true }, {path:'x'}] }])
 *        (also createHashRouter / createMemoryRouter / a bare route-config array
 *         passed to useRoutes(...)).
 *
 * Relative child paths are joined onto the parent; `index` routes resolve to
 * the parent path; absolute child paths (leading '/') override the parent
 * (react-router semantics). Unknown conventions degrade to {routes:[],reason}.
 *
 * Interactive elements per route are best-effort: for each route whose `element`
 * names a local component, the component's source file is parsed for <Link to>,
 * <NavLink to>, <button>, <a href>, and elements carrying data-testid.
 *
 * Usage:
 *   node extract-routes.js <repo-dir> [--json] [--src <subdir>]
 * Output: JSON { generatedAt, repoDir, source, convention, count, routes:[...],
 *                reason? } on stdout.
 */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const traverse = traverseModule.default || traverseModule;

const PARSE_PLUGINS = [
  'jsx', 'typescript', 'classProperties', 'decorators-legacy',
  'optionalChaining', 'nullishCoalescingOperator', 'dynamicImport',
];

function slug(p) {
  return (
    String(p)
      .replace(/^\/+|\/+$/g, '')
      .replace(/[:*?]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'root'
  );
}
const isTemplated = (p) => /[:*]|\{.*\}/.test(p);

// join a (possibly relative) child path onto a parent, react-router-style
function joinPath(parent, child) {
  if (child == null || child === '') return parent || '/';
  if (child.startsWith('/')) return child === '/' ? '/' : child.replace(/\/+$/, '') || '/';
  const base = (parent || '/').replace(/\/+$/, '');
  return (base + '/' + child).replace(/\/{2,}/g, '/');
}

function parseFile(file) {
  const src = fs.readFileSync(file, 'utf8');
  return { src, ast: parser.parse(src, { sourceType: 'module', plugins: PARSE_PLUGINS, errorRecovery: true }) };
}

// ---- candidate-file discovery ------------------------------------------------
// Walk the source tree, return files that import react-router-dom AND mention a
// route-declaration token. Ranked: more route tokens = more likely the router.
function findRouterFiles(repoDir) {
  const roots = ['src', 'app', 'pages', 'routes', '.'].map((r) => path.join(repoDir, r)).filter(fs.existsSync);
  const seen = new Set();
  const out = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage']);
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full); continue; }
      if (!/\.(jsx?|tsx?|mjs|cjs)$/.test(e.name)) continue;
      if (seen.has(full)) continue;
      seen.add(full);
      let txt;
      try { txt = fs.readFileSync(full, 'utf8'); } catch { continue; }
      // include router files AND bare route-config-array files (path:'…' literals,
      // the admin-template `export const routes = [{path,element}]` convention)
      const hasRouterToken = /react-router|createBrowserRouter|createHashRouter|createMemoryRouter|<Routes|<Route\b|useRoutes|createRoutesFromElements/.test(txt);
      const pathLiterals = (txt.match(/path\s*:\s*['"]/g) || []).length;
      if (!hasRouterToken && pathLiterals < 2) continue;
      const score =
        (txt.match(/<Route\b/g) || []).length * 2 +
        pathLiterals +
        (txt.match(/createBrowserRouter|createHashRouter|createMemoryRouter|createRoutesFromElements|useRoutes/g) || []).length * 3;
      out.push({ file: full, score });
    }
  };
  for (const r of roots) walk(r);
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---- JSX <Route> tree --------------------------------------------------------
function extractJsx(ast) {
  const routes = [];
  let sawRouteEl = false;
  // element name -> "Route"-ish? matches Route, PrivateRoute, *Route guards
  const isRouteName = (nm) => nm && typeof nm.name === 'string' && /Route$/.test(nm.name) && nm.name !== 'Routes';

  function jsxAttr(node, key) {
    const a = node.openingElement.attributes.find((x) => x.name && x.name.name === key);
    if (!a) return undefined;
    if (a.value == null) return true; // boolean attr e.g. `index`
    if (a.value.type === 'StringLiteral') return a.value.value;
    if (a.value.type === 'JSXExpressionContainer') {
      const ex = a.value.expression;
      if (ex.type === 'StringLiteral') return ex.value;
    }
    return undefined;
  }
  // name of the component referenced by element={<Foo/>}
  function elementComponent(node) {
    const a = node.openingElement.attributes.find((x) => x.name && (x.name.name === 'element' || x.name.name === 'component'));
    if (!a || !a.value || a.value.type !== 'JSXExpressionContainer') return null;
    const ex = a.value.expression;
    if (ex.type === 'JSXElement') return ex.openingElement.name && ex.openingElement.name.name || null;
    if (ex.type === 'Identifier') return ex.name;
    return null;
  }

  function walkRoute(node, parentPath) {
    if (node.type !== 'JSXElement') return;
    const nm = node.openingElement.name;
    if (!isRouteName(nm)) {
      // descend into wrappers (e.g. <Routes>, fragments) to find Routes
      for (const c of node.children || []) walkRoute(c, parentPath);
      return;
    }
    sawRouteEl = true;
    const isIndex = jsxAttr(node, 'index') === true;
    const rawPath = jsxAttr(node, 'path');
    const full = isIndex ? (parentPath || '/') : joinPath(parentPath, rawPath);
    if (rawPath != null || isIndex) {
      routes.push({ path: full, component: elementComponent(node), index: isIndex, rawPath: rawPath ?? null });
    }
    for (const c of node.children || []) walkRoute(c, full);
  }

  traverse(ast, {
    JSXElement(p) {
      const nm = p.node.openingElement.name;
      // start at top-level <Routes> or createRoutesFromElements(<Route>)
      if (nm && nm.name === 'Routes') {
        for (const c of p.node.children || []) walkRoute(c, '/');
      } else if (isRouteName(nm) && !p.findParent((pp) => pp.isJSXElement() && pp.node.openingElement.name && (pp.node.openingElement.name.name === 'Routes' || /Route$/.test(pp.node.openingElement.name.name)))) {
        // top-level <Route> not under <Routes> (createRoutesFromElements case)
        walkRoute(p.node, '/');
      }
    },
  });
  return { routes, saw: sawRouteEl };
}

// ---- object data-router config ----------------------------------------------
function extractObjectRouter(ast) {
  const routes = [];
  let sawConfig = false;

  // turn an ObjectExpression route node into {path,index,component,children}
  function readRouteObject(obj) {
    const r = { path: undefined, index: false, component: null, children: null };
    for (const p of obj.properties) {
      if (p.type !== 'ObjectProperty' || !p.key) continue;
      const key = p.key.name || p.key.value;
      const v = p.value;
      if (key === 'path' && v.type === 'StringLiteral') r.path = v.value;
      else if (key === 'index' && (v.type === 'BooleanLiteral')) r.index = v.value;
      else if ((key === 'element' || key === 'Component' || key === 'component')) {
        if (v.type === 'JSXElement') r.component = v.openingElement.name && v.openingElement.name.name || null;
        else if (v.type === 'Identifier') r.component = v.name;
      } else if (key === 'children' && v.type === 'ArrayExpression') {
        r.children = v.elements.filter((e) => e && e.type === 'ObjectExpression');
      }
    }
    return r;
  }
  function walkArray(elements, parentPath) {
    for (const el of elements) {
      if (!el || el.type !== 'ObjectExpression') continue;
      const r = readRouteObject(el);
      const full = r.index ? (parentPath || '/') : joinPath(parentPath, r.path);
      if (r.path != null || r.index) {
        routes.push({ path: full, component: r.component, index: r.index, rawPath: r.path ?? null });
      }
      if (r.children) walkArray(r.children, full);
    }
  }

  traverse(ast, {
    CallExpression(p) {
      const callee = p.node.callee;
      const name = callee && (callee.name || (callee.property && callee.property.name));
      if (!/^(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes)$/.test(name || '')) return;
      const arg = p.node.arguments[0];
      if (arg && arg.type === 'ArrayExpression') { sawConfig = true; walkArray(arg.elements, '/'); }
      else if (arg && arg.type === 'Identifier') {
        // config defined as a variable — resolve it in scope
        const binding = p.scope.getBinding(arg.name);
        if (binding && binding.path.node.type === 'VariableDeclarator' && binding.path.node.init && binding.path.node.init.type === 'ArrayExpression') {
          sawConfig = true; walkArray(binding.path.node.init.elements, '/');
        }
      }
    },
  });
  return { routes, saw: sawConfig };
}

// ---- route-config-array (admin-template convention) -------------------------
// Many advanced templates (coreui/horizon/etc.) declare routes as a bare data
// array — `export const routes = [{path:'/dashboard', element: Dashboard}, ...]`
// — and render it elsewhere via `routes.map(r => <Route path={r.path} .../>)`.
// No createBrowserRouter / no <Route path="literal"> to anchor on, so the two
// extractors above miss it. Here we find the largest top-level array whose
// elements are objects carrying a `path:` string, and read it as a flat config.
function extractConfigArray(ast) {
  const routes = [];
  let best = null, bestScore = 0;
  const scoreArray = (els) =>
    els.filter((e) => e && e.type === 'ObjectExpression' &&
      e.properties.some((pr) => pr.type === 'ObjectProperty' && (pr.key.name || pr.key.value) === 'path' &&
        (pr.value.type === 'StringLiteral'))).length;
  traverse(ast, {
    ArrayExpression(p) {
      // only top-level-ish arrays (declared/exported), not deeply nested literals
      const sc = scoreArray(p.node.elements);
      if (sc > bestScore) { bestScore = sc; best = p.node; }
    },
  });
  if (!best || bestScore < 2) return { routes, saw: false };
  for (const el of best.elements) {
    if (!el || el.type !== 'ObjectExpression') continue;
    let rPath = null, component = null;
    for (const pr of el.properties) {
      if (pr.type !== 'ObjectProperty' || !pr.key) continue;
      const k = pr.key.name || pr.key.value;
      if (k === 'path' && pr.value.type === 'StringLiteral') rPath = pr.value.value;
      else if (k === 'element' || k === 'component' || k === 'Component') {
        if (pr.value.type === 'Identifier') component = pr.value.name;
        else if (pr.value.type === 'JSXElement') component = pr.value.openingElement.name && pr.value.openingElement.name.name;
      }
    }
    if (rPath != null) routes.push({ path: rPath.startsWith('/') ? rPath : '/' + rPath, component, index: false, rawPath: rPath });
  }
  return { routes, saw: routes.length > 0 };
}

// ---- interactive elements per component -------------------------------------
function resolveComponentFile(routerFile, componentName, repoDir, ast) {
  if (!componentName) return null;
  let importSource = null;
  traverse(ast, {
    ImportDeclaration(p) {
      for (const s of p.node.specifiers) {
        if ((s.local && s.local.name) === componentName) importSource = p.node.source.value;
      }
    },
  });
  if (!importSource || !importSource.startsWith('.')) return null;
  const base = path.resolve(path.dirname(routerFile), importSource);
  const cands = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
  for (const c of cands) { const f = base + c; if (fs.existsSync(f) && fs.statSync(f).isFile()) return f; }
  return null;
}

function extractInteractive(file) {
  let ast;
  try { ast = parseFile(file).ast; } catch { return []; }
  const els = [];
  const seen = new Set();
  const push = (type, selector, label) => {
    const k = type + '|' + selector; if (seen.has(k)) return; seen.add(k);
    els.push({ type, selector, label: label || null });
  };
  const strAttr = (node, key) => {
    const a = node.openingElement.attributes.find((x) => x.name && x.name.name === key);
    if (!a || !a.value) return null;
    if (a.value.type === 'StringLiteral') return a.value.value;
    if (a.value.type === 'JSXExpressionContainer' && a.value.expression.type === 'StringLiteral') return a.value.expression.value;
    return null;
  };
  const textOf = (node) => {
    const t = (node.children || []).filter((c) => c.type === 'JSXText').map((c) => c.value.trim()).join(' ').trim();
    return t || null;
  };
  traverse(ast, {
    JSXElement(p) {
      const op = p.node.openingElement;
      const nm = op.name && op.name.name;
      if (!nm) return;
      const testid = strAttr(p.node, 'data-testid');
      if (testid) push('testid', `[data-testid="${testid}"]`, testid);
      if (nm === 'Link' || nm === 'NavLink') {
        const to = strAttr(p.node, 'to'); if (to != null) push('link', `a[href="${to}"]`, textOf(p.node) || to);
      } else if (nm === 'a') {
        const href = strAttr(p.node, 'href'); if (href != null) push('link', `a[href="${href}"]`, textOf(p.node) || href);
      } else if (nm === 'button' || nm === 'Button') {
        push('button', 'button', textOf(p.node));
      } else if (nm === 'input' || nm === 'Input') {
        push('input', `input[type="${strAttr(p.node, 'type') || 'text'}"]`, strAttr(p.node, 'name'));
      } else if (nm === 'select' || nm === 'Select') {
        push('select', 'select', strAttr(p.node, 'name'));
      }
    },
  });
  return els;
}

// ---- main --------------------------------------------------------------------
function extractRoutes(repoDir) {
  const candidates = findRouterFiles(repoDir);
  if (!candidates.length) {
    return { repoDir, source: null, convention: 'none', count: 0, routes: [], reason: 'no file imports react-router or declares routes' };
  }
  for (const cand of candidates) {
    let ast;
    try { ast = parseFile(cand.file).ast; } catch (e) { continue; }
    const jsx = extractJsx(ast);
    const obj = extractObjectRouter(ast);
    const cfg = extractConfigArray(ast);
    // pick the convention that yields the most routes in this file
    let picked = null, convention = null, n = 0;
    if (jsx.routes.length > n) { picked = jsx.routes; convention = 'jsx-route-element'; n = jsx.routes.length; }
    if (obj.routes.length > n) { picked = obj.routes; convention = 'object-data-router'; n = obj.routes.length; }
    if (cfg.routes.length > n) { picked = cfg.routes; convention = 'route-config-array'; n = cfg.routes.length; }
    if (!picked || !picked.length) continue;

    // dedupe by full path, keep first; attach interactive elements per route
    const byPath = new Map();
    for (const r of picked) {
      if (byPath.has(r.path)) continue;
      const cf = resolveComponentFile(cand.file, r.component, repoDir, ast);
      const interactive = cf ? extractInteractive(cf) : [];
      byPath.set(r.path, {
        path: r.path,
        name: slug(r.path),
        templated: isTemplated(r.path),
        index: !!r.index,
        component: r.component || null,
        componentFile: cf ? path.relative(repoDir, cf) : null,
        interactive,
      });
    }
    return {
      repoDir, source: path.relative(repoDir, cand.file), convention,
      count: byPath.size, routes: [...byPath.values()],
    };
  }
  return {
    repoDir, source: candidates[0] ? path.relative(repoDir, candidates[0].file) : null,
    convention: 'unrecognized', count: 0, routes: [],
    reason: 'router file(s) found but no <Route>/createBrowserRouter route literals could be resolved',
  };
}

module.exports = { extractRoutes, findRouterFiles, joinPath, slug };

if (require.main === module) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--'));
  if (!dir || !fs.existsSync(dir)) { console.error('usage: extract-routes.js <repo-dir> [--json]'); process.exit(2); }
  const result = extractRoutes(path.resolve(dir));
  result.generatedAt = new Date().toISOString();
  console.log(JSON.stringify(result, null, 2));
}
