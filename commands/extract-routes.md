---
description: Webpack-extract the route list from a SPA's route module into routes.generated.json
---

Extract the route list using the webpack tooling (no app build, sub-second).

```bash
cd route-wise-screenshot-comparison-tool
ROUTE_SRC=/abs/path/to/src/routes/index.tsx \
ROUTES_OUT=reports/routes.generated.json \
npx webpack --config tools/webpack.routes.config.js
```

`ROUTE_SRC` is the SPA's route module(s) (comma-separate several). The custom
`route-extractor-loader` parses the AST for `<Route path>`, `{ path, name }`,
`createBrowserRouter([...])`, and `{ base, tabs }` containers, and the
`RouteExtractorPlugin` emits `routes.generated.json`. Report the route count.
