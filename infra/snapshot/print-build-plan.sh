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

# 1. bridge bundle: one self-contained file (see infra/bridge); it is installed as dorks-bridge, dorks and the gh shim
(cd infra/bridge && pnpm build)

# 2. build box: no env_vars, no agent, no init_command (snapshots keep agent config; keep secrets out)
BOX="$(JSON -X POST "$BASE/v2/box" -d '{"name":"dorks-base-build","runtime":"node","labels":["dorks-base"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"
echo "build box: $BOX"
until [ "$(API "$BASE/v2/box/$BOX" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')" != creating ]; do sleep 2; done
exec_() { JSON -X POST "$BASE/v2/box/$BOX/exec" -d "$(node -pe 'JSON.stringify({command:["sh","-c",process.argv[1]]})' "$1")"; echo; }

# 3. install Claude Code, dorks-bridge (+ the `dorks` CLI and the `gh` shim, which are the same file under other names), the real gh
#    (pinned, checksum-verified) and the gh-stack extension (pinned). The real gh goes to /usr/bin; the shim in /usr/local/bin comes first on PATH.
API -X POST "$BASE/v2/box/$BOX/files/upload" -F "paths=/workspace/home/dorks-bridge.mjs" -F "files=@infra/bridge/dist/cli.mjs;filename=dorks-bridge.mjs"
exec_ 'sudo npm install -g @anthropic-ai/claude-code && sudo install -m 0755 /workspace/home/dorks-bridge.mjs /usr/local/bin/dorks-bridge && rm /workspace/home/dorks-bridge.mjs && sudo ln -sf dorks-bridge /usr/local/bin/dorks && sudo ln -sf dorks-bridge /usr/local/bin/gh'
exec_ 'set -e
case "$(uname -m)" in
  x86_64)  ARCH=amd64; GH_SHA=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386; STACK_SHA=577065033b49d4505730ea0ad43ab1b0374b0d9b1308e9765647a6aa8eba3cb7 ;;
  aarch64) ARCH=arm64; GH_SHA=7862c86c72f43df3a2d93ddde6f473285b4e2af61b494849846827e513ef6484; STACK_SHA=d29684746f337a580667605b34877e5624792bcc390e61473a050bd4839557bf ;;
  *) echo "unsupported architecture $(uname -m)"; exit 1 ;;
esac
T="$(mktemp -d)"; cd "$T"
curl -fsSL -o gh.tgz "https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_$ARCH.tar.gz"
echo "$GH_SHA  gh.tgz" | sha256sum -c -
tar -xzf gh.tgz --strip-components=1
sudo install -m 0755 bin/gh /usr/bin/gh
curl -fsSL -o gh-stack "https://github.com/github/gh-stack/releases/download/v0.2.0/linux-$ARCH"
echo "$STACK_SHA  gh-stack" | sha256sum -c -
EXT="$HOME/.local/share/gh/extensions/gh-stack"; mkdir -p "$EXT"
install -m 0755 gh-stack "$EXT/gh-stack"
printf "owner: github\nname: gh-stack\nhost: github.com\ntag: v0.2.0\nispinned: true\n" > "$EXT/manifest.yml"
rm -rf "$T"'

# 4. verify (check exit_code is 0 in the output). `command -v gh` must be the shim, ahead of the real /usr/bin/gh.
exec_ 'node --version && git --version && claude --version && command -v dorks-bridge && command -v dorks && test "$(command -v gh)" = /usr/local/bin/gh && /usr/bin/gh --version && gh --version && gh stack --help >/dev/null && dorks --help >/dev/null'

# 5. snapshot, then wait for it to be ready
SNAP="$(JSON -X POST "$BASE/v2/box/$BOX/snapshots" -d "{\"name\":\"dorks-base-$STAMP\"}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')"
until [ "$(API "$BASE/v2/box/$BOX/snapshots" | node -pe 'JSON.parse(require("fs").readFileSync(0)).snapshots.find(s=>s.id===process.argv[1])?.status' "$SNAP")" = ready ]; do sleep 2; done
echo "snapshot ready: $SNAP"

# 6. delete the build box (the snapshot is independent of it)
API -X DELETE "$BASE/v2/box/$BOX"
echo
echo "next: cd apps/convex && npx convex env set BASE_SNAPSHOT_ID $SNAP"
PLAN
