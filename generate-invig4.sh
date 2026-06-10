#!/usr/bin/env bash
# generate-invig4.sh — the 4-screenshot-per-route prod-onprem-sync report.
#
# Four origins on the fae34c workspace (built+served by lt-autopilot's
# invig-sync-build.sh), two auth groups:
#   prod   group :3001 before / :3003 after  -> auth.lambdatest.com, accessToken, .lambdatest.com
#   onprem group :3000 before / :3002 after  -> hyperexecute-onprem-auth, accessToken, .hyperexecute.cloud
#
# Per route the report row reads:  prod-before | prod-after | onprem-before | onprem-after
# so prod before/after and onprem before/after sit side by side.
#
# Token-free + deterministic. Re-run any time.
#   ./generate-invig4.sh
#
# Env-config requirement (already injected live into each build/env-config.js):
#   onprem builds need REACT_APP_JWT_COOKIE_NAME:"accessToken" or the SPA reads
#   the baked staging cookie name and bounces to /login. prod builds need a prod
#   env-config (auth.lambdatest.com) instead of the empty window.env={} stub.
set -uo pipefail
cd "$(dirname "$0")"

AUTH=reports/.auth
mkdir -p "$AUTH"
ABS="$(pwd)/$AUTH"

PORT="${PORT:-5057}"
RUN="${RUN:-invig4-$(date -u +%Y%m%d-%H%M%S)}"
export OUTDIR="reports/$RUN"
export ROUTES_JSON="${ROUTES_JSON:-reports/routes.generated.json}"

# Served URLs (fixed by prefix+port; proxy-envs already exist for fae34c).
U_ONPREM_BEFORE=https://hyperexecute-onprem-before-fae34c-3000.hyperexecute.cloud
U_PROD_BEFORE=https://before-fae34c-3001.lambdatest.com
U_ONPREM_AFTER=https://hyperexecute-onprem-after-fae34c-3002.hyperexecute.cloud
U_PROD_AFTER=https://after-fae34c-3003.lambdatest.com

echo "════════ invig 4-origin route report :: RUN=$RUN ════════"

# ── 1. mint onprem session ──────────────────────────────────────────────────
echo "── mint onprem cookies ──"
set -a; . "$HOME/.claude/secrets/onprem_ezztt_account.env"; set +a
LOGIN_API="https://hyperexecute-onprem-auth.hyperexecute.cloud/api/login" \
ORIGIN="$U_ONPREM_AFTER" COOKIE_DOMAIN=".hyperexecute.cloud" \
EMAIL="$ONPREM_EMAIL" PASSWORD="$ONPREM_PASSWORD" \
COOKIES="$AUTH/onprem-cookies.json" node tools/cookie-login.js \
  | sed -E 's/(eyJ[A-Za-z0-9_.-]{6})[A-Za-z0-9_.-]+/\1…/g' || { echo "onprem login failed"; exit 1; }

# ── 2. mint prod session ────────────────────────────────────────────────────
echo "── mint prod cookies ──"
set -a; . "$HOME/.claude/secrets/prod_hypauto_account.env"; set +a
LOGIN_API="https://auth.lambdatest.com/api/login" \
ORIGIN="https://accounts.lambdatest.com" COOKIE_DOMAIN=".lambdatest.com" \
EMAIL="$PROD_EMAIL" PASSWORD="$PROD_PASSWORD" \
COOKIES="$AUTH/prod-cookies.json" node tools/cookie-login.js \
  | sed -E 's/(eyJ[A-Za-z0-9_.-]{6})[A-Za-z0-9_.-]+/\1…/g' || { echo "prod login failed"; exit 1; }

# ── 3. verify each origin is authed (fail loud, never ship login pages) ──────
echo "── verify auth on all 4 origins ──"
chk() { BASE="$1" CHECK_URL="/details/profile" COOKIES="$2" node tools/check-auth.js 2>/dev/null | grep -q '"authed":true' && echo OK || echo BOUNCED; }
S1=$(chk "$U_PROD_BEFORE"   "$ABS/prod-cookies.json");   echo "   :3001 prod-before   $S1"
S2=$(chk "$U_PROD_AFTER"    "$ABS/prod-cookies.json");   echo "   :3003 prod-after    $S2"
S3=$(chk "$U_ONPREM_BEFORE" "$ABS/onprem-cookies.json"); echo "   :3000 onprem-before $S3"
S4=$(chk "$U_ONPREM_AFTER"  "$ABS/onprem-cookies.json"); echo "   :3002 onprem-after  $S4"
if [ "$S1$S2$S3$S4" != "OKOKOKOK" ] && [ "${ALLOW_BOUNCE:-0}" != "1" ]; then
  echo "!! one or more origins bounced to /login — aborting (set ALLOW_BOUNCE=1 to override)"; exit 2
fi

# ── 4. capture 4 origins, per-origin cookie jar ─────────────────────────────
echo "── capture (${ROUTES_JSON}) ──"
export ORIGINS="prod-before=$U_PROD_BEFORE=$ABS/prod-cookies.json;prod-after=$U_PROD_AFTER=$ABS/prod-cookies.json;onprem-before=$U_ONPREM_BEFORE=$ABS/onprem-cookies.json;onprem-after=$U_ONPREM_AFTER=$ABS/onprem-cookies.json"
node tools/capture-routes.js

# ── 5. build + serve ────────────────────────────────────────────────────────
echo "── build report ──"
node tools/build-report.js
if [ "${SERVE:-1}" = "1" ]; then
  pkill -f "serve-report.js" 2>/dev/null || true
  OUTDIR="$OUTDIR" PORT="$PORT" nohup node tools/serve-report.js >"reports/serve-$RUN.log" 2>&1 &
  sleep 1
  echo "   report: http://0.0.0.0:$PORT/  (dir: $OUTDIR)"
fi
echo "════════ done ════════"
