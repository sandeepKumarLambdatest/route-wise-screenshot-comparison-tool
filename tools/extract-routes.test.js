#!/usr/bin/env node
/**
 * extract-routes.test.js — convention coverage test for extract-routes.js.
 * Uses inline temp fixtures (no network) covering both react-router-dom v6
 * conventions plus nested/relative/index/catch-all path joining and the
 * graceful-degrade path. Run: node tools/extract-routes.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractRoutes } = require('./extract-routes');

let pass = 0, fail = 0;
function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'er-'));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return dir;
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       got:  ${g}\n       want: ${w}`); }
}
const paths = (r) => r.routes.map((x) => x.path).sort();

// 1. object data-router with nested children + absolute paths
{
  const dir = tmpRepo({
    'src/main.tsx': `
import { createBrowserRouter } from "react-router-dom";
import App from "./App";
import Home from "./pages/Home";
import Contact from "./pages/Contact";
const router = createBrowserRouter([
  { path: "/", element: <App/>, children: [
    { index: true, element: <Home/> },
    { path: "/contact", element: <Contact/> },
  ]},
]);`,
    'src/App.tsx': `export default function App(){return <a href="/contact">c</a>;}`,
    'src/pages/Home.tsx': `export default function Home(){return <div/>;}`,
    'src/pages/Contact.tsx': `export default function Contact(){return <div/>;}`,
  });
  const r = extractRoutes(dir);
  eq('object-router convention', r.convention, 'object-data-router');
  eq('object-router paths', paths(r), ['/', '/contact']);
}

// 2. JSX <Routes>/<Route> nested relative + index + catch-all
{
  const dir = tmpRepo({
    'src/App.js': `
import { Routes, Route } from "react-router-dom";
import Layout from "./Layout";
import About from "./About";
import P from "./P";
import Single from "./Single";
function App(){return (
  <Routes>
    <Route path="/" element={<Layout/>}>
      <Route index element={<About/>} />
      <Route path="about" element={<About/>} />
      <Route path="products" element={<P/>}>
        <Route path=":id" element={<Single/>} />
      </Route>
      <Route path="*" element={<About/>} />
    </Route>
  </Routes>
);}`,
    'src/Layout.js': `export default function Layout(){return <div/>;}`,
    'src/About.js': `export default function About(){return <a href="/">h</a>;}`,
    'src/P.js': `export default function P(){return <div/>;}`,
    'src/Single.js': `export default function Single(){return <div/>;}`,
  });
  const r = extractRoutes(dir);
  eq('jsx convention', r.convention, 'jsx-route-element');
  eq('jsx nested/relative paths', paths(r), ['/', '/*', '/about', '/products', '/products/:id']);
}

// 3. graceful degrade — react app without routing
{
  const dir = tmpRepo({ 'src/App.jsx': `export default function App(){return <button>x</button>;}` });
  const r = extractRoutes(dir);
  eq('degrade convention=none', r.convention, 'none');
  eq('degrade empty routes', r.routes.length, 0);
  eq('degrade has reason', typeof r.reason === 'string' && r.reason.length > 0, true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
