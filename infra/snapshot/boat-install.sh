#!/usr/bin/env bash
set -euo pipefail

test "$(uname -m)" = x86_64
test -f "$HOME/dorks-bridge.mjs"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
sudo install -m 0755 "$HOME/dorks-bridge.mjs" /usr/local/bin/dorks-bridge
sudo ln -sf dorks-bridge /usr/local/bin/dorks
sudo npm install -g @openai/codex@0.166.0

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

curl -fsSL -o gh.tgz https://github.com/cli/cli/releases/download/v2.102.0/gh_2.102.0_linux_amd64.tar.gz
echo "bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386  gh.tgz" | sha256sum -c -
tar -xzf gh.tgz --strip-components=1
sudo install -m 0755 bin/gh /usr/bin/gh

curl -fsSL -o gh-stack https://github.com/github/gh-stack/releases/download/v0.2.0/linux-amd64
echo "577065033b49d4505730ea0ad43ab1b0374b0d9b1308e9765647a6aa8eba3cb7  gh-stack" | sha256sum -c -
extension="$HOME/.local/share/gh/extensions/gh-stack"
mkdir -p "$extension"
install -m 0755 gh-stack "$extension/gh-stack"
printf 'owner: github\nname: gh-stack\nhost: github.com\ntag: v0.2.0\nispinned: true\n' > "$extension/manifest.yml"

sudo ln -sf dorks-bridge /usr/local/bin/gh

git --version
claude --version
codex --version
test "$(command -v gh)" = /usr/local/bin/gh
/usr/bin/gh --version
gh stack --help >/dev/null
dorks --help >/dev/null
command -v flock >/dev/null
rm "$HOME/dorks-bridge.mjs" "$HOME/boat-install.sh"
