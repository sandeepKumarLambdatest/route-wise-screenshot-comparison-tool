/**
 * webpack.routes.config.js — the webpack config Claude Code's plugin runs to
 * EXTRACT the route list. Point ROUTE_SRC at the target SPA's route module(s)
 * (a comma-separated list is allowed) and run:
 *
 *   ROUTE_SRC=/path/to/src/routes/index.tsx \
 *   ROUTES_OUT=./reports/routes.generated.json \
 *   npx webpack --config tools/webpack.routes.config.js
 *
 * The custom loader replaces the route module body with a static export, so the
 * real app graph is never compiled — extraction is a sub-second single-module
 * build. Output: routes.generated.json (also emitted as a webpack asset).
 */
const path = require('path');
const RouteExtractorPlugin = require('./route-extractor-plugin');

const ROUTE_SRC = process.env.ROUTE_SRC;
if (!ROUTE_SRC) {
  throw new Error('Set ROUTE_SRC=/abs/path/to/routes/index.tsx (the SPA route module to extract).');
}
const entries = ROUTE_SRC.split(',').map((s) => s.trim()).filter(Boolean);
const OUT_JSON = process.env.ROUTES_OUT ? path.resolve(process.env.ROUTES_OUT) : null;
const OUT_DIR = path.resolve(process.env.ROUTES_OUT_DIR || './reports/.webpack-routes');

module.exports = {
  mode: 'development',
  devtool: false,
  entry: entries.reduce((acc, e, i) => ({ ...acc, [`route-src-${i}`]: path.resolve(e) }), {}),
  output: { path: OUT_DIR, filename: '[name].extracted.js' },
  resolve: { extensions: ['.tsx', '.ts', '.jsx', '.js'] },
  module: {
    rules: [
      {
        test: new RegExp(entries.map((e) => path.resolve(e).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')),
        use: [{ loader: path.resolve(__dirname, 'route-extractor-loader.js') }],
      },
    ],
  },
  plugins: [new RouteExtractorPlugin({ outJson: OUT_JSON })],
  stats: 'errors-warnings',
};
