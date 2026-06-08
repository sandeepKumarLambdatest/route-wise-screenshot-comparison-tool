#!/usr/bin/env bash
# ensure-login.sh — guarantee a valid session before capture.
#
# ALWAYS checks logged-in state FIRST. Only if the stored cookie is invalid (or
# absent) does it fall back to minting one by curling the login API directly.
# Reads config from the env file passed as $1 (see config/target.env.example).
#
#   tools/ensure-login.sh config/target.env
#
# Exit 0 = a valid session exists at $COOKIES; non-zero = could not authenticate.
set -uo pipefail
cd "$(dirname "$0")/.."

ENVFILE="${1:-config/target.env}"
[ -f "$ENVFILE" ] && { set -a; . "$ENVFILE"; set +a; }
# secrets file (creds) kept out of the repo env; optional
[ -n "${CRED_FILE:-}" ] && [ -f "$CRED_FILE" ] && { set -a; . "$CRED_FILE"; set +a; }

: "${BASE:?set BASE (the SPA origin, e.g. https://accounts.lambdatest.com)}"
export COOKIES="${COOKIES:-./reports/.auth/cookies.json}"
export CHECK_URL="${CHECK_URL:-/dashboard}"

echo "[ensure-login] 1/2 checking existing session at $BASE$CHECK_URL ..."
if node tools/check-auth.js; then
  echo "[ensure-login] reusing valid session ($COOKIES)"
  exit 0
fi

echo "[ensure-login] 2/2 no valid session — minting via login API ($LOGIN_API) ..."
: "${LOGIN_API:?set LOGIN_API to enable curl-cookie fallback}"
: "${EMAIL:?set EMAIL (or via CRED_FILE)}"
: "${PASSWORD:?set PASSWORD (or via CRED_FILE)}"
export ORIGIN="${ORIGIN:-$BASE}"
if ! node tools/cookie-login.js; then
  echo "[ensure-login] cookie-login FAILED" >&2
  exit 1
fi

echo "[ensure-login] re-verifying minted session ..."
if node tools/check-auth.js; then
  echo "[ensure-login] authenticated."
  exit 0
fi
echo "[ensure-login] session still invalid after login API call" >&2
exit 1
