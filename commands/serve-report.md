---
description: Serve an already-built route screenshot report directory over HTTP
---

Serve a previously generated report without re-running capture.

```bash
cd route-wise-screenshot-comparison-tool
OUTDIR=reports/<run-dir> PORT=5056 node tools/serve-report.js
```

Pick the newest `reports/run-*` dir unless the user names one. Report the URL.
