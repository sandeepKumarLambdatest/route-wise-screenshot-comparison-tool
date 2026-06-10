/**
 * route-extractor-loader.js — a webpack loader.
 *
 * Applied ONLY to the configured route source file. Instead of letting webpack
 * traverse the real (huge) import graph, this loader parses the file's AST,
 * harvests every route `path` / `base`+`tabs` literal, stashes the result on a
 * shared singleton (read by RouteExtractorPlugin), and returns a tiny no-import
 * CJS module. That keeps the compiled graph to a single module — fast, and it
 * never needs ts-loader/babel-loader for the rest of the app.
 *
 * Recognises:
 *   <Route|*Route path="/foo" />                  (react-router JSX incl. Private/PublicRoute guards)
 *   { path: '/foo', name: 'foo' }                 (route config objects)
 *   createBrowserRouter([{ path: '/foo' }, ...])  (data-router arrays)
 *   { base: '/security', tabs: ['a','b'] }        (tabbed containers → expanded)
 */
const parser = require('@babel/parser');
const traverseModule = require('@babel/traverse');
const traverse = traverseModule.default || traverseModule;
const store = require('./route-store');

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

module.exports = function routeExtractorLoader(source) {
  const found = new Map(); // path -> {path,name,templated}
  const add = (p, name) => {
    if (typeof p !== 'string' || !p.startsWith('/')) return;
    if (!found.has(p)) found.set(p, { path: p, name: name || slug(p), templated: isTemplated(p) });
  };

  let ast;
  try {
    ast = parser.parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript', 'classProperties', 'decorators-legacy', 'optionalChaining', 'nullishCoalescingOperator'],
    });
  } catch (e) {
    store.error = `parse failed: ${e.message}`;
    return 'module.exports = ' + JSON.stringify({ routes: [], error: store.error }) + ';';
  }

  traverse(ast, {
    // <Route path="/foo" />
    JSXOpeningElement(path) {
      const nm = path.node.name;
      if (!nm || typeof nm.name !== 'string' || !/Route$/.test(nm.name)) return;
      const attr = path.node.attributes.find((a) => a.name && a.name.name === 'path');
      if (attr && attr.value && attr.value.type === 'StringLiteral') add(attr.value.value);
    },
    // object literals: { path, name } and { base, tabs }
    ObjectExpression(path) {
      const props = {};
      for (const p of path.node.properties) {
        if (p.type !== 'ObjectProperty' || !p.key) continue;
        const key = p.key.name || p.key.value;
        if (p.value.type === 'StringLiteral') props[key] = p.value.value;
        else if (p.value.type === 'ArrayExpression' && key === 'tabs')
          props.tabs = p.value.elements.filter((e) => e && e.type === 'StringLiteral').map((e) => e.value);
      }
      if (props.base && Array.isArray(props.tabs)) {
        add(props.base, props.name || slug(props.base));
        for (const t of props.tabs) add(`${props.base}/${t}`, `${props.name || slug(props.base)}-${slug(t)}`);
      } else if (props.path) {
        add(props.path, props.name);
      }
    },
  });

  const routes = [...found.values()];
  store.routes = routes;
  store.source = this.resourcePath;
  return 'module.exports = ' + JSON.stringify({ routes }) + ';';
};
