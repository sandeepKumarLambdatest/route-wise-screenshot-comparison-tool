---
description: Record a per-route VIDEO + interactive-coverage report for any served SPA (token-free)
---

Record one `.webm` per route while a runtime tree-walk exercises every
interactive element, then build a self-contained HTML report (a `<video>` per
route + a route×interactable-family coverage matrix). Do NOT re-implement any
step in the model — invoke the script and report the served URL + coverage.

```bash
cd route-wise-screenshot-comparison-tool
cp config/video.env.example config/video.env   # set BASE + one of URL_ONE/ROUTES_JSON/REPO
./generate-video-report.sh config/video.env
```

The script:
1. `tools/record-routes.js` — for each route, opens a Playwright `recordVideo`
   context, deep-links the route (history.pushState, or `--hash` for HashRouter),
   then ENUMERATE → classify into an interactable family (`visual-interaction.js`)
   → exercise → detect reveal → recurse into revealed modal/menu/accordion
   subtrees. One `.webm` + a `manifest.json` coverage record per route.
2. `tools/build-video-report.js` — copies the webms into a self-contained dir and
   emits `index.html` (per-route `<video controls>` + coverage matrix).
3. serves it on `$PORT`.

Route source (set exactly one in the env file): `REPO=` (extract via
`extract-routes.js`), `ROUTES_JSON=` (reuse an extracted JSON), or `URL_ONE=`
(a single path). `VIDEO=0` runs the coverage walk with no recording. Re-run any
number of times. Surface back: the served URL and discovered/exercised counts.
