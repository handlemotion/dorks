#!/usr/bin/env bash
# Starts the sim box host + log capture, runs the e2e, then greps backend logs and a full data export for secrets.
set -euo pipefail
cd "$(dirname "$0")/.."
export CONVEX_URL=${CONVEX_URL:-http://127.0.0.1:3210} CONVEX_SITE_URL=${CONVEX_SITE_URL:-http://127.0.0.1:3211}
SIM_HOST_KEY=$(npx convex env get SIM_HOST_KEY); BRIDGE_SECRET_KEY=$(npx convex env get BRIDGE_SECRET_KEY)
export SIM_HOST_KEY BRIDGE_SECRET_KEY
export HEARTBEAT_MS=${HEARTBEAT_MS:-30000}
OUT=${OUT:-/tmp/dorks-e2e}; mkdir -p $OUT
node ../../infra/bridge-sim/host.mjs > $OUT/host.log 2>&1 & HOST=$!
npx convex logs > $OUT/convex.log 2>&1 & LOGS=$!
trap 'kill $HOST $LOGS 2>/dev/null || true' EXIT
sleep 2
SECRETS_OUT=$OUT/needles.json node scripts/e2e.mjs | tee $OUT/e2e.log
sleep 2
rm -f $OUT/export.zip; npx convex export --path $OUT/export.zip >/dev/null 2>&1
rm -rf $OUT/export && mkdir -p $OUT/export && { (cd $OUT/export && unzip -q ../export.zip) || [ $? -le 2 ]; }  # unzip exits 1-2 on Convex's export zip (warnings)
node scripts/scan-secrets.mjs $OUT
