#!/usr/bin/env bash
# generate-video-report.sh — token-free per-route VIDEO + coverage report.
# Records one .webm per route (Playwright recordVideo) while a runtime tree-walk
# exercises each route's interactive elements, then builds a self-contained HTML
# report (<video> per route + route×family coverage matrix) and serves it.
#
#   ./generate-video-report.sh [config/video.env]
#
# Route source (one of, set in the env file):
#   REPO=/abs/path/to/spa        extract routes from the repo (extract-routes.js)
#   ROUTES_JSON=/abs/routes.json reuse a pre-extracted extract-routes.js JSON
#   URL_ONE=/some/path           record a SINGLE path (direct full-page nav)
# plus BASE=http://host:port (the served app).
#
# Knobs: OUT, REPORT, PORT, MAX, CAP, DEPTH, HASH=1, TEMPLATED=1, SERVE=0, VIDEO=0.
# VIDEO=0 still produces the coverage report (no recording) — screenshot-only
# users keep generate-report.sh; this is the video twin.
set -uo pipefail
cd "$(dirname "$0")"

ENVFILE="${1:-config/video.env}"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; } || echo "(no env file $ENVFILE — using inline env)"

: "${BASE:?set BASE=http://host:port (the served app)}"
RUN="${RUN:-vrun-$(date -u +%Y%m%d-%H%M%S)}"
OUT="${OUT:-reports/$RUN/videos}"
REPORT="${REPORT:-reports/$RUN/report}"
PORT="${PORT:-5057}"

REC_ARGS=(--base "$BASE" --out "$OUT")
if   [ -n "${URL_ONE:-}" ]; then     REC_ARGS+=(--url "$URL_ONE")
elif [ -n "${ROUTES_JSON:-}" ]; then REC_ARGS+=(--routes "$ROUTES_JSON")
elif [ -n "${REPO:-}" ]; then        REC_ARGS+=(--repo "$REPO")
else echo "set one of URL_ONE / ROUTES_JSON / REPO in $ENVFILE"; exit 1; fi
[ -n "${MAX:-}" ]   && REC_ARGS+=(--max "$MAX")
[ -n "${CAP:-}" ]   && REC_ARGS+=(--cap "$CAP")
[ -n "${DEPTH:-}" ] && REC_ARGS+=(--depth "$DEPTH")
[ "${HASH:-0}" = "1" ]      && REC_ARGS+=(--hash)
[ "${TEMPLATED:-0}" = "1" ] && REC_ARGS+=(--templated)

echo "════════ route-wise VIDEO report :: RUN=$RUN ════════"

echo "── 1/3 record routes (video=${VIDEO:-1}) ──"
if [ "${VIDEO:-1}" = "0" ]; then
  echo "   VIDEO=0 — coverage walk only, no .webm recorded"
  REC_ARGS+=(--novideo)
fi
node tools/record-routes.js "${REC_ARGS[@]}"

echo "── 2/3 build video + coverage report ──"
RPT_ARGS=(--videos "$OUT" --out "$REPORT")
[ -n "${ROUTES_JSON:-}" ] && RPT_ARGS+=(--routes "$ROUTES_JSON")
[ -n "${COVERAGE_JSON:-}" ] && RPT_ARGS+=(--coverage "$COVERAGE_JSON")
node tools/build-video-report.js "${RPT_ARGS[@]}"

echo "── 3/3 serve ──"
if [ "${SERVE:-1}" = "1" ]; then
  pkill -f "serve-report.js" 2>/dev/null || true
  OUTDIR="$REPORT" PORT="$PORT" nohup node tools/serve-report.js >"reports/serve-$RUN.log" 2>&1 &
  sleep 1
  echo "   report: http://0.0.0.0:$PORT/  (dir: $REPORT)"
else
  echo "   SERVE=0 — open $REPORT/index.html"
fi
echo "════════ done ════════"
