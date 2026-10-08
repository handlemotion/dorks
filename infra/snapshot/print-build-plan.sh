#!/usr/bin/env bash
# Prints (does NOT run) the Upstash Box API calls that build the dorks base snapshot. See README.md.
# Safe to run anywhere: it needs no credentials and makes no network calls. Review the output, then run it yourself
# with UPSTASH_BOX_API_KEY set. Wire format: docs/upstash-box.md.
set -euo pipefail
cat <<'PLAN'
#!/usr/bin/env bash
set -euo pipefail
: "${UPSTASH_BOX_API_KEY:?set UPSTASH_BOX_API_KEY}"
BASE="${UPSTASH_BOX_BASE_URL:-https://us-east-1.box.upstash.com}"
API() { curl -fsS -H "X-Box-Api-Key: $UPSTASH_BOX_API_KEY" "$@"; }
JSON() { API -H 'Content-Type: application/json' "$@"; }
STAMP="$(date +%Y%m%d)"

# 1. bridge tarball (see infra/bridge for its real build command)
TGZ="$(cd infra/bridge && npm pack --silent | tail -1)"

# 2. build box: no env_vars, no agent, no init_command (snapshots keep agent config; keep secrets out)
BOX="$(JSON -X POST "$BASE/v2/box" -d '{"name":"dorks-base-build","runtime":"node","labels":["dorks-base"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"
echo "build box: $BOX"
until [ "$(API "$BASE/v2/box/$BOX" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')" != creating ]; do sleep 2; done
exec_() { JSON -X POST "$BASE/v2/box/$BOX/exec" -d "$(node -pe 'JSON.stringify({command:["sh","-c",process.argv[1]]})' "$1")"; echo; }

# 3. install Claude Code + dorks-bridge
API -X POST "$BASE/v2/box/$BOX/files/upload" -F "paths=/workspace/home/dorks-bridge.tgz" -F "files=@infra/bridge/$TGZ;filename=dorks-bridge.tgz"
exec_ 'sudo npm install -g @anthropic-ai/claude-code /workspace/home/dorks-bridge.tgz && rm /workspace/home/dorks-bridge.tgz'

# 4. verify (check exit_code is 0 in the output)
exec_ 'node --version && git --version && claude --version && command -v dorks-bridge'

# 5. snapshot, then wait for it to be ready
SNAP="$(JSON -X POST "$BASE/v2/box/$BOX/snapshots" -d "{\"name\":\"dorks-base-$STAMP\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"
until [ "$(API "$BASE/v2/box/$BOX/snapshots" | node -pe 'JSON.parse(require("fs").readFileSync(0)).snapshots.find(s=>s.id===process.argv[1])?.status' "$SNAP")" = ready ]; do sleep 2; done
echo "snapshot ready: $SNAP"

# 6. delete the build box (the snapshot is independent of it)
API -X DELETE "$BASE/v2/box/$BOX"
echo
echo "next: cd apps/convex && npx convex env set BASE_SNAPSHOT_ID $SNAP"
PLAN
