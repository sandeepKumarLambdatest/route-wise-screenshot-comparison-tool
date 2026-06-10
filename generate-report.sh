#!/usr/bin/env bash
# generate-report.sh — the ONE token-free entrypoint. Re-run as often as you
# like; NO Claude in the loop, fully deterministic.
#
#   ./generate-report.sh [config/target.env]
#
# Pipeline:
#   1. webpack extract routes      -> reports/routes.generated.json
#   2. ensure-login (check → curl)  -> reports/.auth/cookies.json
#   3. capture every route          -> reports/<RUN>/<route>/<origin>.png + meta
#   4. build static HTML report     -> reports/<RUN>/index.html
#   5. serve it (unless SERVE=0)     -> http://0.0.0.0:$PORT
#
# All knobs come from the env file (see config/target.env.example).
set -uo pipefail
cd "$(dirname "$0")"

ENVFILE="${1:-config/target.env}"
[ -f "$ENVFILE" ] || { echo "missing env file: $ENVFILE (copy config/target.env.example)"; exit 1; }
set -a; . "$ENVFILE"; set +a
[ -n "${CRED_FILE:-}" ] && [ -f "$CRED_FILE" ] && { set -a; . "$CRED_FILE"; set +a; }

RUN="${RUN:-run-$(date -u +%Y%m%d-%H%M%S)}"
export OUTDIR="${OUTDIR:-reports/$RUN}"
export ROUTES_OUT="${ROUTES_OUT:-reports/routes.generated.json}"
export ROUTES_JSON="$ROUTES_OUT"
export COOKIES="${COOKIES:-reports/.auth/cookies.json}"
export PORT="${PORT:-5056}"

echo "════════ route-wise screenshot report :: RUN=$RUN ════════"

echo "── 1/5 webpack route extraction ──"
if [ "${SKIP_EXTRACT:-0}" = "1" ]; then
  echo "   SKIP_EXTRACT=1 — reusing pre-filtered $ROUTES_OUT"
else
  : "${ROUTE_SRC:?set ROUTE_SRC=/abs/path/to/src/routes/index.tsx in $ENVFILE}"
  npx --no-install webpack --config tools/webpack.routes.config.js \
    || npx webpack --config tools/webpack.routes.config.js
fi
echo "   routes: $(node -e "console.log(require('./'+process.env.ROUTES_OUT).count)" 2>/dev/null || echo '?')"

echo "── 2/5 ensure login (check first, curl-cookie fallback) ──"
if ! tools/ensure-login.sh "$ENVFILE"; then
  [ "${LOGIN_BEST_EFFORT:-0}" = "1" ] \
    && echo "login failed — LOGIN_BEST_EFFORT=1, continuing (private routes will show auth-bounce, not faked)" \
    || { echo "login failed — aborting"; exit 1; }
fi

echo "── 3/5 capture routes ──"
: "${ORIGINS:?set ORIGINS in $ENVFILE, e.g. \"before=https://a;after=https://b\"}"
node tools/capture-routes.js

echo "── 4/5 build report ──"
node tools/build-report.js

echo "── 5/5 serve ──"
if [ "${SERVE:-1}" = "1" ]; then
  pkill -f "serve-report.js" 2>/dev/null || true
  OUTDIR="$OUTDIR" PORT="$PORT" nohup node tools/serve-report.js >"reports/serve-$RUN.log" 2>&1 &
  sleep 1
  echo "   report: http://0.0.0.0:$PORT/  (dir: $OUTDIR)"
else
  echo "   SERVE=0 — open $OUTDIR/index.html"
fi
echo "════════ done ════════"
