#!/usr/bin/env bash
# Runs the dorks MCP tools inside a REAL Upstash Box: builds the bundle and the driver (test/box-driver.ts), restores a box from the base
# snapshot, uploads both, runs the driver there with the box's own Claude CLI, then deletes the box. The backend is a stand-in: a box
# cannot reach a Convex backend on a developer machine. Run under `doppler run -p dorks -c dev --`; needs UPSTASH_BOX_API_KEY,
# E2E_CLAUDE_TOKEN and a snapshot id (BOX_SNAPSHOT_ID, default: the newest "dorks-base-*" snapshot of the account).
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${UPSTASH_BOX_BASE_URL:-https://us-east-1.box.upstash.com}"
API() { curl -sS -m 180 -H "X-Box-Api-Key: ${UPSTASH_BOX_API_KEY:?}" "$@"; }
JSON() { API -H 'Content-Type: application/json' "$@"; }
field() { node -pe "JSON.parse(require('fs').readFileSync(0)).$1"; }
exec_() { JSON -X POST "$BASE/v2/box/$BOX/exec" -d "$(node -pe 'JSON.stringify({command:["sh","-c",process.argv[1]]})' "$1")" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));process.stdout.write((r.output??"")+(r.error?"\nERR: "+r.error:"")+"\n");process.exit(r.exit_code??1)'; }
: "${E2E_CLAUDE_TOKEN:?}"
SNAP="${BOX_SNAPSHOT_ID:-$(API "$BASE/v2/box/snapshots" | node -pe 'JSON.parse(require("fs").readFileSync(0)).snapshots.filter(s=>s.status==="ready"&&/^dorks-base/.test(s.name)).sort((a,b)=>b.created_at-a.created_at)[0].id')}"
OUT=$(mktemp -d); trap 'rm -rf "$OUT"; [ -n "${BOX:-}" ] && API -X DELETE "$BASE/v2/box/$BOX" >/dev/null && echo "deleted box $BOX"' EXIT
node scripts/build.mjs >/dev/null
DORKS_BUILD_OUT="$OUT/dorks-bridge.mjs" node scripts/build.mjs >/dev/null
npx esbuild test/box-driver.ts --bundle --platform=node --target=node22 --format=esm --outfile="$OUT/driver.mjs" --banner:js="import { createRequire as __cr } from 'node:module';const require = __cr(import.meta.url);" --log-level=warning
BOX=$(JSON -X POST "$BASE/v2/box/from-snapshot" -d "{\"snapshot_id\":\"$SNAP\",\"name\":\"dorks-mcp-e2e\",\"labels\":[\"dorks-mcp-e2e\"],\"env_vars\":{}}" | field id)
echo "box $BOX from snapshot $SNAP"
for _ in $(seq 100); do [ "$(API "$BASE/v2/box/$BOX" | field status)" != creating ] && break; sleep 3; done
for f in dorks-bridge.mjs driver.mjs; do API -X POST "$BASE/v2/box/$BOX/files/upload" -F "paths=/workspace/home/mcp-e2e/$f" -F "files=@$OUT/$f;filename=$f" >/dev/null; done
exec_ 'echo "user=$(id -un) arch=$(uname -m) node=$(node --version) claude=$(claude --version)"; chmod +x /workspace/home/mcp-e2e/dorks-bridge.mjs'
exec_ "cd /workspace/home/mcp-e2e && CLAUDE_CODE_OAUTH_TOKEN='$E2E_CLAUDE_TOKEN' DRIVER_CLI=/workspace/home/mcp-e2e/dorks-bridge.mjs node driver.mjs"
