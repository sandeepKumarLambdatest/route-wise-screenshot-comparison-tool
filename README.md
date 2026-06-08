# route-wise-screenshot-comparison-tool

A **Claude Code plugin** + standalone CLI that produces a route-by-route
screenshot **comparison report** for any SPA — and, crucially, generates a
script you can trigger **any number of times with zero Claude tokens**.

It generalizes the proven route-merge before/after harness into a packaged,
config-driven tool.

## What it does

```
webpack extract routes ─▶ ensure login ─▶ screenshot every route ─▶ HTML report ─▶ serve
   (AST, no app build)    (check → curl)     (per-origin, full-page)   (status grid)
```

1. **Webpack route extraction.** `tools/webpack.routes.config.js` runs webpack
   with a custom loader (`route-extractor-loader.js`) + plugin
   (`route-extractor-plugin.js`) that AST-parse the SPA's route module and emit
   `reports/routes.generated.json`. The loader short-circuits the import graph,
   so it's a sub-second single-module compile — no full app build needed.
   Recognises `<Route path>`, `{ path, name }`, `createBrowserRouter([...])`,
   and `{ base, tabs }` tabbed containers (expanded to one route per tab).

2. **Login — check first, curl-cookie fallback.** `tools/ensure-login.sh`
   **always checks the existing session first** (`check-auth.js` loads the
   cookie jar and confirms a protected route doesn't bounce to `/login`). Only
   if there's no valid session does it **curl the login API directly**
   (`cookie-login.js` → `POST $LOGIN_API` → harvest `Set-Cookie`/token into a
   Playwright `storageState`), then re-verify. No manual browser step.

3. **Capture.** `tools/capture-routes.js` screenshots every (non-templated)
   route on each configured origin at 1920×1080 full-page, with the authed
   cookie injected, recording console errors + failed requests per route.

4. **Report.** `tools/build-report.js` builds a self-contained `index.html`:
   a status grid (pass / warn / auth-bounce / fail) over all routes plus a
   side-by-side image view per route. `serve-report.js` serves it.

## Token-free re-run

```bash
cp config/target.env.example config/target.env   # edit ROUTE_SRC, BASE, LOGIN_API, ORIGINS
./generate-report.sh config/target.env           # re-run as often as you like — no Claude in the loop
```

A still-valid cookie and the extracted routes are reused across runs.

## As a Claude Code plugin

The repo is a CC plugin: `.claude-plugin/plugin.json` registers every webpack /
login / capture tool under `tools`, and `commands/` exposes
`/extract-routes`, `/generate-report`, and `/serve-report`. The commands tell
Claude to **invoke the scripts**, never to re-do the work in-model — so a report
costs no tokens.

## Install

```bash
npm install                              # @babel/parser, @babel/traverse, playwright-core, webpack
npx playwright-core install chromium     # or reuse an existing chromium
```

## Layout

| Path | Role |
|------|------|
| `tools/webpack.routes.config.js` | webpack config that extracts routes |
| `tools/route-extractor-loader.js` | AST loader → route literals |
| `tools/route-extractor-plugin.js` | emits `routes.generated.json` |
| `tools/check-auth.js` | is the stored cookie still valid? |
| `tools/cookie-login.js` | curl the login API → cookie jar |
| `tools/ensure-login.sh` | check-first, curl-fallback orchestrator |
| `tools/capture-routes.js` | screenshot each route per origin |
| `tools/build-report.js` | static HTML comparison report |
| `tools/serve-report.js` | static server |
| `generate-report.sh` | the one token-free entrypoint |
| `config/target.env.example` | all configuration |
