# route-wise-screenshot-comparison-tool

**One** cross-workspace route tool + Claude Code plugin. Given any SPA it
extracts the route list, logs in, and then per route produces **either**:

- a **screenshot before/after comparison report** (the original route-merge
  harness, generalized), **or**
- a **per-route VIDEO + interactive-coverage report** — one `.webm` per route
  recorded while a runtime tree-walk exercises every interactive element.

Both modes generate a **token-free** script you can re-trigger any number of
times with **zero Claude in the loop**.

```
extract routes ─▶ ensure login ─▶ ┬─ screenshot every route ─▶ comparison report
 (webpack AST,    (check → curl)   │   (per-origin, full-page)
  or node AST)                     └─ record video + exercise UI ─▶ video+coverage report
                                       (Playwright recordVideo + tree-walk)
```

## Two entrypoints

```bash
# screenshot before/after comparison
cp config/target.env.example config/target.env   # ROUTE_SRC, BASE, LOGIN_API, ORIGINS
./generate-report.sh config/target.env

# per-route video + interactive coverage
cp config/video.env.example  config/video.env    # BASE + one of URL_ONE/ROUTES_JSON/REPO
./generate-video-report.sh config/video.env
```

Re-run either as often as you like; a still-valid cookie and the extracted
routes are reused across runs.

## Route extraction — two paths, one tool

- **`tools/webpack.routes.config.js`** (+ `route-extractor-loader.js` /
  `-plugin.js`): a sub-second single-module webpack compile that AST-parses a
  *pre-configured* route module. Recognises `<Route path>`, `{ path, name }`,
  `createBrowserRouter([...])`, and `{ base, tabs }` tabbed containers.
- **`tools/extract-routes.js`**: a standalone node module callable on **any repo
  path** — it discovers the router file itself and understands the two dominant
  react-router-dom v6 conventions (JSX-element form and object/data-router form)
  plus nesting, and best-effort extracts each route's interactive elements
  (`<Link>`, `<button>`, `<a href>`, `data-testid`). Use this when you don't
  already know the route module. (This folds in the static AST per-route element
  extraction that previously lived in the separate `webpack-explorer` repo — its
  build-time selector map is superseded here by the runtime tree-walk below,
  which exercises *any* live app, not just one with hand-tuned conventions.)

`tools/diff-routes.js` compares two route sets (e.g. a PR's added/removed
routes) to drive a focused capture.

## Login — check first, curl-cookie fallback

`tools/ensure-login.sh` **always checks the existing session first**
(`check-auth.js`). Only if there's no valid session does it **curl the login API
directly** (`cookie-login.js` → `POST $LOGIN_API` → Playwright `storageState`),
then re-verify. No manual browser step.

## Per-route video + coverage (the new mode)

`tools/record-routes.js` records **one `.webm` per route** using Playwright's
built-in `recordVideo` context option (chromium + the bundled ffmpeg — no extra
binary). For each route it deep-links via `history.pushState` (or `--hash` for a
HashRouter), then runs a **recursive lazy-tree traversal**: ENUMERATE the live
DOM (scoped) → classify each element into an interactable **family**
(`visual-interaction.js` registry: button / link / input / select / multiselect /
tab / switch / menu / accordion …) → perform the family's visible action with a
synthetic animated cursor → detect any revealed subtree (modal / menu / listbox /
tabpanel) → **recurse** into it → unwind. Bounded by `--depth`, a visited
cycle-guard, and a per-level `--cap`.

It emits `manifest.json` with a per-route coverage record (discovered /
exercised / revealed-subtrees / modals / per-element family+scenario+depth).
`tools/build-video-report.js` turns that dir into a self-contained `index.html`:
a `<video controls>` per route + a route×interactable-family coverage matrix.

```bash
# single page, one webm:
node tools/record-routes.js --base http://localhost:3000 --url / --out videos
# whole repo's routes:
node tools/record-routes.js --base http://localhost:5000 --repo /path/to/app --out videos
node tools/build-video-report.js --videos videos --out report
node tools/serve-report.js   # OUTDIR=report PORT=5057
```

**Video on/off is a flag.** `VIDEO=0` (or `record-routes.js --novideo`) runs the
same coverage tree-walk with no recording — so screenshot-only / coverage-only
use still works.

**Authenticated routes.** `record-routes.js --storage cookies.json` loads a
Playwright `storageState` cookie jar into every recording context, so auth-gated
routes render real content instead of bouncing to `/login`. Mint the jar with
`tools/cookie-login.js` (curls the login API → storageState) or
`tools/ensure-login.sh`.

## Multi-environment video sync report (before/after × prod/onprem)

`generate-4env-video.sh` records one `.webm` **per route per environment** and
`tools/build-4env-video-report.js` lays them out in a per-route grid (one column
per env), so a reviewer can eyeball a sync diff for each route across all N envs
side by side. It is the video twin of `generate-invig4.sh` (which does the same
for screenshots). Everything is a knob — each env is a `key|label|baseURL|cookieJar`
row in `ENVS`; nothing app-specific is hardcoded.

```bash
cp config/4env-video.env.example config/4env-video.env   # ROUTES_JSON + ENVS rows (+ per-env cookie jars)
./generate-4env-video.sh config/4env-video.env           # records all envs, builds + serves on PORT (default 3010)
```

The report dir is self-contained (`index.html` + `<key>/<route>.webm` + a
`report-manifest.json`); serve it with `serve-report.js` on a DevSpace-mapped
port for a public URL.

## As a Claude Code plugin (installs across workspaces)

The repo is a CC plugin published via `.claude-plugin/marketplace.json`. Install
it into any workspace through the marketplace mechanism (`~/.claude/plugins/`):

```bash
claude plugin marketplace add /abs/path/to/route-wise-screenshot-comparison-tool
claude plugin install route-wise-screenshot-comparison-tool
```

`.claude-plugin/plugin.json` registers every tool (webpack/AST extraction, login,
capture, **record-routes**, **build-video-report**, both entrypoints) under
`tools`, and `commands/` exposes `/extract-routes`, `/generate-report`,
`/record-report`, and `/serve-report`. The commands tell Claude to **invoke the
scripts**, never to re-do the work in-model — so a report costs no tokens.
Nothing is hardcoded to a specific app: every target (base URL set, route list /
repo, login API) is a config knob, so the same plugin drives any SPA.

## Install

```bash
npm install                              # @babel/parser, @babel/traverse, playwright-core, webpack
npx playwright-core install chromium     # full chromium (video needs it, not headless_shell) + bundled ffmpeg
```

## Layout

| Path | Role |
|------|------|
| `tools/webpack.routes.config.js` | webpack config that extracts routes (pre-configured module) |
| `tools/route-extractor-loader.js` / `-plugin.js` | AST loader + emitter for the webpack path |
| `tools/extract-routes.js` | standalone any-repo route + interactive-element extractor |
| `tools/diff-routes.js` | added/removed route diff between two route sets |
| `tools/check-auth.js` / `cookie-login.js` / `ensure-login.sh` | check-first, curl-fallback login |
| `tools/capture-routes.js` | screenshot each route per origin |
| `tools/record-routes.js` | per-route `.webm` + runtime interactive-coverage tree-walk |
| `tools/visual-interaction.js` | interactable-family registry + synthetic cursor/highlight |
| `tools/build-report.js` | static HTML screenshot comparison report |
| `tools/build-video-report.js` | static HTML video + coverage-matrix report (single env) |
| `tools/build-4env-video-report.js` | static HTML per-route video grid across N envs (sync diff) |
| `tools/serve-report.js` | static server (serves `.png`/`.webm`/`.mp4`) |
| `generate-report.sh` | screenshot-comparison entrypoint |
| `generate-video-report.sh` | video + coverage entrypoint (single env) |
| `generate-4env-video.sh` | per-route video across N envs, side-by-side sync report |
| `generate-invig4.sh` | 4-env prod/onprem before/after screenshot matrix |
| `config/target.env.example` / `config/video.env.example` / `config/4env-video.env.example` | all configuration |
