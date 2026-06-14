#!/usr/bin/env bash
# generate-4env-video.sh — per-route VIDEO across N environments (before/after ×
# prod/onprem), side by side, so a reviewer can eyeball a sync diff per route.
#
# The video twin of generate-invig4.sh: instead of 4 screenshots/route it records
# one .webm/route/env (Playwright recordVideo + the runtime interaction tree-walk
# in record-routes.js), then build-4env-video-report.js lays the per-env videos
# out in a grid and serve-report.js serves it.
#
#   ./generate-4env-video.sh config/4env-video.env
#
# Generic — every env is a row in ENVS, nothing app-specific is hardcoded:
#   ROUTES_JSON=/abs/routes.json          (one extract-routes.js JSON, shared)
#   ENVS="key|label|baseURL|cookieJar; key|label|baseURL|cookieJar; ..."
#       cookieJar = '' for an unauthenticated env, or an abs path to a Playwright
#       storageState file (mint with cookie-login.js / ensure-login.sh).
#   CAP, DEPTH, MAX, PORT, RUN, TITLE  — optional knobs.
set -uo pipefail
cd "$(dirname "$0")"

ENVFILE="${1:-config/4env-video.env}"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; } || { echo "no env file $ENVFILE"; exit 1; }

: "${ROUTES_JSON:?set ROUTES_JSON=/abs/routes.json (extract-routes.js output)}"
: "${ENVS:?set ENVS=\"key|label|baseURL|cookieJar; ...\"}"
CAP="${CAP:-6}"; DEPTH="${DEPTH:-1}"; PORT="${PORT:-3010}"
RUN="${RUN:-4env-$(date -u +%Y%m%d-%H%M%S)}"
OUTROOT="reports/$RUN"; VIDROOT="$OUTROOT/videos"; REPORT="$OUTROOT/report"
TITLE="${TITLE:-Per-route Video — multi-environment sync comparison}"
mkdir -p "$VIDROOT"

echo "════════ 4-env VIDEO report :: RUN=$RUN ════════"

# ── 1. record each env ───────────────────────────────────────────────────────
REPORT_ENVS=()
IFS=';' read -ra ROWS <<< "$ENVS"
for row in "${ROWS[@]}"; do
  row="$(echo "$row" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$row" ] && continue
  IFS='|' read -r KEY LABEL BASE JAR <<< "$row"
  OUT="$VIDROOT/$KEY"
  echo "── record $LABEL ($BASE) ──"
  ARGS=(--base "$BASE" --routes "$ROUTES_JSON" --out "$OUT" --cap "$CAP" --depth "$DEPTH")
  [ -n "${MAX:-}" ] && ARGS+=(--max "$MAX")
  [ -n "$JAR" ] && [ -f "$JAR" ] && ARGS+=(--storage "$JAR")
  node tools/record-routes.js "${ARGS[@]}" 2>"$OUT.log" || echo "  (record-routes nonzero for $KEY — continuing)"
  REPORT_ENVS+=(--env "$KEY:$LABEL:$(pwd)/$OUT")
done

# ── 2. build the side-by-side report ─────────────────────────────────────────
echo "── build 4-env report ──"
node tools/build-4env-video-report.js --out "$REPORT" --routes "$ROUTES_JSON" --title "$TITLE" "${REPORT_ENVS[@]}"

# ── 3. serve ─────────────────────────────────────────────────────────────────
if [ "${SERVE:-1}" = "1" ]; then
  pkill -f "serve-report.js" 2>/dev/null || true
  OUTDIR="$REPORT" PORT="$PORT" nohup node tools/serve-report.js >"reports/serve-$RUN.log" 2>&1 &
  sleep 1
  echo "   report: http://0.0.0.0:$PORT/  (dir: $REPORT)"
fi
echo "════════ done ════════"
