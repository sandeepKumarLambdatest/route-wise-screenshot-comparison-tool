---
description: Run the full token-free route-screenshot comparison report (webpack extract → login → capture → report → serve)
---

Run the deterministic, **token-free** report pipeline. Do NOT re-implement any
step in the model — just invoke the script and report the served URL.

```bash
cd route-wise-screenshot-comparison-tool && ./generate-report.sh config/target.env
```

The script:
1. webpack-extracts the route list (`tools/webpack.routes.config.js`) → `reports/routes.generated.json`
2. ensures a session — **checks logged-in first**, falls back to curling the login API for a cookie (`tools/ensure-login.sh`)
3. screenshots every route on each configured origin (`tools/capture-routes.js`)
4. builds the static HTML report (`tools/build-report.js`)
5. serves it on `$PORT`

Re-run any number of times; it reuses a still-valid cookie and built routes. The
only thing to surface back to the user is the served URL and the pass/warn/auth
counts printed by step 4.
