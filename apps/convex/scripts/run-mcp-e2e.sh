#!/usr/bin/env bash
# Runs scripts/mcp-e2e.mjs: the dorks MCP tools through a local Convex backend, the real in-box bridge and the REAL Claude CLI.
# Prereqs: `pnpm dev:backend` is up (BOX_PROVIDER=sim), E2E_CLAUDE_TOKEN is in the environment (export it, or put it in the repo-root `.env`),
# and the sim host runs as a user that may start Claude with bypassPermissions (not root). Set RUN_AS_UID to drop privileges for the host.
set -euo pipefail
cd "$(dirname "$0")/.."
export CONVEX_URL=${CONVEX_URL:-http://127.0.0.1:3210} CONVEX_SITE_URL=${CONVEX_SITE_URL:-http://127.0.0.1:3211}
[ -n "${E2E_CLAUDE_TOKEN:-}" ] || { echo "E2E_CLAUDE_TOKEN is required" >&2; exit 1; }
SIM_HOST_KEY=$(npx convex env get SIM_HOST_KEY); BRIDGE_SECRET_KEY=$(npx convex env get BRIDGE_SECRET_KEY)
export SIM_HOST_KEY BRIDGE_SECRET_KEY
OUT=${OUT:-/tmp/dorks-mcp-e2e}; mkdir -p "$OUT"
npx convex run rateLimit:reset >/dev/null # sign-in budgets are per hour and persist
HOST_ENV=(PATH="$PATH" HOME="${HOST_HOME:-$HOME}" DORKS_E2E_ROOT="${DORKS_E2E_ROOT:-$OUT/root}" CONVEX_URL="$CONVEX_URL" SIM_HOST_KEY="$SIM_HOST_KEY" BRIDGE_SECRET_KEY="$BRIDGE_SECRET_KEY" BRIDGE_IMPL=real CLAUDE_BIN="$(command -v claude)" HTTPS_PROXY="${HTTPS_PROXY:-}" NODE_EXTRA_CA_CERTS="${NODE_EXTRA_CA_CERTS:-}")
if [ -n "${RUN_AS_UID:-}" ]; then
  mkdir -p "${HOST_HOME:-$HOME}" "${DORKS_E2E_ROOT:-$OUT/root}" ../../infra/bridge/dist
  chown -R "$RUN_AS_UID" "${HOST_HOME:-$HOME}" "${DORKS_E2E_ROOT:-$OUT/root}" ../../infra/bridge/dist "$OUT"
  setpriv --reuid="$RUN_AS_UID" --regid="$RUN_AS_UID" --init-groups env -i "${HOST_ENV[@]}" node ../../infra/bridge-sim/host.mjs > "$OUT/host.log" 2>&1 &
else
  env -i "${HOST_ENV[@]}" node ../../infra/bridge-sim/host.mjs > "$OUT/host.log" 2>&1 &
fi
HOST=$!
trap 'kill $HOST 2>/dev/null || true' EXIT
sleep 3
node scripts/mcp-e2e.mjs | tee "$OUT/mcp-e2e.log"
