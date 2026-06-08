/**
 * route-extractor-plugin.js — RouteExtractorPlugin.
 *
 * Emits `routes.generated.json` as a real webpack asset from whatever the
 * route-extractor-loader harvested during the compilation, and also writes a
 * copy to OUT_JSON (default <output.path>/routes.generated.json) so downstream
 * token-free steps can read it without unpacking the bundle.
 */
const fs = require('fs');
const path = require('path');
const store = require('./route-store');

class RouteExtractorPlugin {
  constructor(opts = {}) {
    this.outJson = opts.outJson || null;
    this.assetName = opts.assetName || 'routes.generated.json';
  }
  apply(compiler) {
    const { webpack } = compiler;
    compiler.hooks.thisCompilation.tap('RouteExtractorPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        { name: 'RouteExtractorPlugin', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
        () => {
          const payload = {
            generatedAt: new Date().toISOString(),
            source: store.source,
            error: store.error,
            count: store.routes.length,
            routes: store.routes,
          };
          const json = JSON.stringify(payload, null, 2);
          compilation.emitAsset(this.assetName, new webpack.sources.RawSource(json));
          const out = this.outJson || path.join(compiler.options.output.path, this.assetName);
          try {
            fs.mkdirSync(path.dirname(out), { recursive: true });
            fs.writeFileSync(out, json);
          } catch (e) {
            compilation.warnings.push(new Error(`RouteExtractorPlugin: ${e.message}`));
          }
        }
      );
    });
    compiler.hooks.done.tap('RouteExtractorPlugin', () => {
      process.stderr.write(`[RouteExtractorPlugin] ${store.routes.length} routes extracted from ${store.source}\n`);
    });
  }
}
module.exports = RouteExtractorPlugin;
