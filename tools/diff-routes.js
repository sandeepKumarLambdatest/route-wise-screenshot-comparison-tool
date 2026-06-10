#!/usr/bin/env node
/* diff-routes.js — map a git-diff changed-file list to the affected route subset, then filter routes.generated.json. */
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const traverse = traverseModule.default || traverseModule;

const ROUTE_SRC = process.env.ROUTE_SRC;
const REPO = process.env.REPO || (ROUTE_SRC && ROUTE_SRC.replace(/\/src\/.*$/, ''));
const ROUTES_JSON = process.env.ROUTES_JSON || './reports/routes.generated.json';
const CHANGED = (process.env.CHANGED_FILES || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const SHARED_DIRS = ['src/components', 'src/common', 'src/utils', 'src/hooks', 'src/store'];
const MAX_IMPORT_DEPTH = parseInt(process.env.IMPORT_DEPTH || '4', 10);
const EXTS = ['.tsx', '.ts', '.jsx', '.js'];

if (!ROUTE_SRC || !REPO) { console.error('need ROUTE_SRC (+ REPO)'); process.exit(64); }

const parse = (src) => parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy', 'optionalChaining', 'nullishCoalescingOperator'] });
const rel = (abs) => path.relative(REPO, abs).replace(/\\/g, '/');

function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const e of EXTS) { if (fs.existsSync(base + e)) return base + e; }
  for (const e of EXTS) { const i = path.join(base, 'index' + e); if (fs.existsSync(i)) return i; }
  if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
    for (const e of EXTS) { const i = path.join(base, 'index' + e); if (fs.existsSync(i)) return i; }
  }
  return fs.existsSync(base) ? base : null;
}

/* path -> { name, component, file } by parsing the route module:
   - const X = React.lazy(() => import('rel'))  →  name X -> resolved file
   - <*Route path="/p" ...> <Comp .../> </*Route>  →  path -> Comp */
function routeComponentMap(srcFile) {
  const ast = parse(fs.readFileSync(srcFile, 'utf8'));
  const lazyOf = {}; // localName -> resolved file
  traverse(ast, {
    VariableDeclarator(p) {
      const id = p.node.id && p.node.id.name;
      if (!id) return;
      let spec = null;
      p.traverse({ CallExpression(ip) { const cal = ip.node.callee; if (cal && cal.type === 'Import' && ip.node.arguments[0] && ip.node.arguments[0].type === 'StringLiteral') spec = ip.node.arguments[0].value; } });
      if (spec) lazyOf[id] = resolveImport(srcFile, spec);
    },
    ImportDeclaration(p) {
      const src = p.node.source.value;
      const f = resolveImport(srcFile, src);
      for (const s of p.node.specifiers) { if (s.local && s.local.name && f) lazyOf[s.local.name] = f; }
    },
  });
  const routes = []; // {path, component, file}
  traverse(ast, {
    JSXElement(p) {
      const open = p.node.openingElement;
      const nm = open.name && open.name.name;
      if (typeof nm !== 'string' || !/Route$/.test(nm)) return;
      const pathAttr = open.attributes.find((a) => a.name && a.name.name === 'path');
      let routePath = null;
      if (pathAttr && pathAttr.value) {
        if (pathAttr.value.type === 'StringLiteral') routePath = pathAttr.value.value;
        else if (pathAttr.value.type === 'JSXExpressionContainer' && pathAttr.value.expression.type === 'StringLiteral') routePath = pathAttr.value.expression.value;
      }
      if (!routePath) return;
      // first JSX child element that is a known lazy component
      let comp = null;
      for (const c of p.node.children) {
        if (c.type === 'JSXElement') {
          const cn = c.openingElement.name && c.openingElement.name.name;
          if (cn && lazyOf[cn]) { comp = cn; break; }
          if (cn && !comp) comp = cn; // remember first even if unresolved
        }
      }
      routes.push({ path: routePath, component: comp, file: comp && lazyOf[comp] ? rel(lazyOf[comp]) : null });
    },
  });
  return routes;
}

/* transitive relative-import closure of a component file, repo-relative set */
const importCache = {};
function importClosure(absFile, depth, seen) {
  if (!absFile || depth < 0 || seen.has(absFile)) return seen;
  seen.add(absFile);
  if (importCache[absFile] === undefined) {
    try {
      const specs = [];
      const ast = parse(fs.readFileSync(absFile, 'utf8'));
      traverse(ast, {
        ImportDeclaration(p) { specs.push(p.node.source.value); },
        CallExpression(p) { const c = p.node.callee; if (c && c.type === 'Import' && p.node.arguments[0] && p.node.arguments[0].type === 'StringLiteral') specs.push(p.node.arguments[0].value); },
      });
      importCache[absFile] = specs.map((s) => resolveImport(absFile, s)).filter(Boolean);
    } catch { importCache[absFile] = []; }
  }
  for (const dep of importCache[absFile]) importClosure(dep, depth - 1, seen);
  return seen;
}

function affected(routes, changed) {
  const changedSet = new Set(changed);
  const sharedChanged = changed.filter((f) => SHARED_DIRS.some((d) => f.startsWith(d + '/')));
  const out = [];
  for (const r of routes) {
    if (!r.file) continue;
    // own-folder subtree only when the component is an index.* in its own dir
    // (e.g. .../ForgotPassword/index.tsx); a flat file (.../containers/Signup.tsx)
    // shares the bucket dir with siblings, so subtree there would over-match.
    const isIndex = /\/index\.[jt]sx?$/.test(r.file);
    const dir = isIndex ? r.file.replace(/\/index\.[jt]sx?$/, '') : null;
    let hit = false, why = '';
    // (1) component IS a changed file  (2) changed file under component's own folder
    for (const c of changed) {
      if (c === r.file) { hit = true; why = 'component'; break; }
      if (dir && c.startsWith(dir + '/')) { hit = true; why = 'dir-subtree'; break; }
    }
    // (3) shared-dir change transitively imported by component
    if (!hit && sharedChanged.length) {
      const abs = path.resolve(REPO, r.file);
      const closure = [...importClosure(abs, MAX_IMPORT_DEPTH, new Set())].map(rel);
      const cs = new Set(closure);
      const imp = sharedChanged.find((c) => cs.has(c));
      if (imp) { hit = true; why = 'import:' + imp; }
    }
    if (hit) out.push({ ...r, why });
  }
  return out;
}

const routes = routeComponentMap(ROUTE_SRC);
if (process.env.DUMP_MAP) { console.log(JSON.stringify(routes, null, 2)); process.exit(0); }
const aff = affected(routes, CHANGED);
const affPaths = new Set(aff.map((r) => r.path));

// filter routes.generated.json to the affected paths (keep its shape)
const gen = JSON.parse(fs.readFileSync(ROUTES_JSON, 'utf8'));
const subset = gen.routes.filter((r) => affPaths.has(r.path));
const result = { generatedAt: new Date().toISOString(), source: gen.source, mode: 'diff', changed: CHANGED, count: subset.length, routes: subset, affectedDetail: aff };

if (process.env.FILTER_OUT) { fs.writeFileSync(process.env.FILTER_OUT, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ changed: CHANGED.length, affectedRoutes: subset.length, paths: [...affPaths], detail: aff.map((r) => `${r.path} <- ${r.why}`) }, null, 2));
