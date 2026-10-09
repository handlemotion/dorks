#!/usr/bin/env bash
# Why this exists: a cloud agent VM starts from a bare image, and in it `pnpm install` fails three ways: the repo's pinned pnpm
# (12.x) does not run under the image's older corepack, the Doppler CLI is missing, and the install runs a license check that
# needs CENTRAL_LICENSE_KEY (which lives in Doppler, see docs/secrets/README.md). Without this the agent boots into a repo it
# cannot build or test. This is the one place that knows how to get from bare image to a working checkout, so set it as the
# setup/install command of every cloud provider we use (AGENTS.md has the exact settings) instead of repeating steps in each.
#
#   bash cloud-setup.sh              Doppler CLI, pinned pnpm, dependencies
#   bash cloud-setup.sh --backend    also start the local Convex backend (needs Docker; see scripts/dev-backend.sh)
#
# Idempotent and non-interactive; works as root or a normal user (sudo only if it exists) and from any working directory. Needs
# Node >= 22, network access and DOPPLER_TOKEN in the environment. Exit code is non-zero if a required step failed.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log() { echo "[cloud-setup] $*"; }
status=0
fail() { log "FAILED: $*"; status=1; }

# Run a command with elevated rights only if we are not root and sudo exists.
priv() { if [ "$(id -u)" = 0 ]; then "$@"; elif command -v sudo >/dev/null; then sudo -n "$@"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }
# Global npm install: the default prefix, then sudo, then ~/.local (no root needed; its bin dir is put on PATH for this script).
npm_global() {
  npm install --global "$@" >/dev/null 2>&1 && return 0
  priv npm install --global "$@" >/dev/null 2>&1 && return 0
  npm install --global --prefix "$HOME/.local" "$@" >/dev/null 2>&1 && { export PATH="$HOME/.local/bin:$PATH"; hash -r; return 0; }
  return 1
}

have node || { fail "node is required (>= 22); install it first (the provider's Node image, nvm, or your package manager)"; exit "$status"; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || log "warning: Node $node_major found, this repo expects >= 22"

# Doppler CLI: where every secret comes from.
if ! have doppler; then
  log "installing Doppler CLI"
  curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | priv sh || log "doppler install failed; continuing without it"
fi

# Cloudflare `cf` CLI (deploys), optional; it needs Node >= 22.18.
if ! have cf && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'; then
  log "installing Cloudflare cf CLI"
  npm_global cf || log "cf install failed (optional)"
fi

# pnpm at the version the repo pins. Corepack ships with Node, but older corepack builds cannot run pnpm 12 (it ships bin/pnpm.mjs,
# they look for pnpm.cjs), so verify it works and fall back to the npm package.
want_pnpm="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
have corepack && corepack enable >/dev/null 2>&1 || true
if [ "$(pnpm --version 2>/dev/null)" != "$want_pnpm" ]; then
  log "installing pnpm@$want_pnpm from npm"
  npm_global "pnpm@$want_pnpm" || fail "could not install pnpm@$want_pnpm"
fi

# Dependencies. The install runs a license check that reads CENTRAL_LICENSE_KEY, so run it with the Doppler `dev` env.
if have pnpm; then
  log "installing repo dependencies"
  if [ -n "${DOPPLER_TOKEN:-}" ] && have doppler; then
    doppler run -p dorks -c dev -- pnpm install --frozen-lockfile || fail "pnpm install"
  else
    [ -n "${CENTRAL_LICENSE_KEY:-}" ] || log "no DOPPLER_TOKEN or CENTRAL_LICENSE_KEY: the Central Icons license check will fail"
    pnpm install --frozen-lockfile || fail "pnpm install (set DOPPLER_TOKEN, see docs/secrets/README.md)"
  fi
fi

if [ "${1:-}" = "--backend" ]; then
  log "starting the local backend"
  bash scripts/dev-backend.sh || fail "dev-backend.sh"
fi

[ "$status" = 0 ] && log "done" || log "done with errors"
exit "$status"
