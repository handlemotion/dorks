#!/usr/bin/env bash
# Generic cloud-VM bootstrap. Copy to the repo root as `cloud-setup.sh`, edit ONLY the config block, and set
# `bash cloud-setup.sh` as the setup command of every cloud provider (see SKILL.md next to this file for why and how).
#
#   bash cloud-setup.sh          secrets CLI, package manager at the pinned version, dependencies
#   bash cloud-setup.sh --full   also run FULL_SETUP_CMD (e.g. start a local backend; slow, so opt-in)
#
# Idempotent, non-interactive, works as root or not (sudo only if present) and from any working directory.
# Exit code is non-zero if a required step failed.

# ---- per-repo config: the only part to edit (each can be overridden from the environment) -------------------------
NODE_MIN="${NODE_MIN:-22}"                      # minimum major version of Node the repo needs
SECRETS_PROJECT="${SECRETS_PROJECT:-}"          # Doppler project to run the install under; empty = no secrets manager
SECRETS_CONFIG="${SECRETS_CONFIG:-dev}"         # Doppler config (never a production one)
EXTRA_NPM_TOOLS="${EXTRA_NPM_TOOLS:-}"          # optional CLIs to `npm i -g`, space separated; failures are only logged
FULL_SETUP_CMD="${FULL_SETUP_CMD:-}"            # run by --full, e.g. "bash scripts/dev-backend.sh"
# --------------------------------------------------------------------------------------------------------------------

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

log() { echo "[cloud-setup] $*"; }
status=0
fail() { log "FAILED: $*"; status=1; }
have() { command -v "$1" >/dev/null 2>&1; }
# Elevated only when not root and sudo exists (never prompts).
priv() { if [ "$(id -u)" = 0 ]; then "$@"; elif have sudo; then sudo -n "$@"; else "$@"; fi; }
# Global npm install: default prefix, then sudo, then ~/.local (needs no root; its bin dir goes on PATH for this script).
npm_global() {
  npm install --global "$@" >/dev/null 2>&1 && return 0
  priv npm install --global "$@" >/dev/null 2>&1 && return 0
  npm install --global --prefix "$HOME/.local" "$@" >/dev/null 2>&1 && { export PATH="$HOME/.local/bin:$PATH"; hash -r; return 0; }
  return 1
}

have node || { fail "node >= $NODE_MIN is required; use the provider's Node image, nvm, or your package manager"; exit "$status"; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge "$NODE_MIN" ] || log "warning: Node is older than $NODE_MIN"

# Secrets CLI. Cloud VMs have none, and the install may need a secret (a license check, a private registry token).
if [ -n "$SECRETS_PROJECT" ] && ! have doppler; then
  log "installing Doppler CLI"
  curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | priv sh || log "doppler install failed; continuing without it"
fi

for tool in $EXTRA_NPM_TOOLS; do have "$tool" || npm_global "$tool" || log "$tool install failed (optional)"; done

# Package manager, chosen by lockfile. For pnpm, verify the binary actually runs at the version `packageManager` pins: older corepack
# builds on cloud images cannot run newer pnpm (they look for bin/pnpm.cjs, pnpm 12 ships bin/pnpm.mjs), so fall back to the npm package.
have corepack && corepack enable >/dev/null 2>&1 || true
if [ -f pnpm-lock.yaml ]; then
  want="$(node -p 'try{require("./package.json").packageManager.split("@")[1]}catch(e){""}')"
  if [ -n "$want" ] && [ "$(pnpm --version 2>/dev/null)" != "$want" ]; then
    log "installing pnpm@$want from npm"
    npm_global "pnpm@$want" || fail "could not install pnpm@$want"
  fi
  install=(pnpm install --frozen-lockfile)
elif [ -f yarn.lock ]; then install=(corepack yarn install --immutable)
elif [ -f package-lock.json ]; then install=(npm ci)
else fail "no lockfile (pnpm-lock.yaml, yarn.lock or package-lock.json) found"; install=(true)
fi

# Install under the secrets config when a token is present, so install-time secrets resolve; otherwise plain.
log "installing dependencies with ${install[0]}"
if [ -n "$SECRETS_PROJECT" ] && [ -n "${DOPPLER_TOKEN:-}" ] && have doppler; then
  doppler run -p "$SECRETS_PROJECT" -c "$SECRETS_CONFIG" -- "${install[@]}" || fail "dependency install"
else
  [ -z "$SECRETS_PROJECT" ] || log "no DOPPLER_TOKEN: an install that needs a secret will fail; set it in the provider's secrets"
  "${install[@]}" || fail "dependency install"
fi

if [ "${1:-}" = "--full" ] && [ -n "$FULL_SETUP_CMD" ]; then
  log "running: $FULL_SETUP_CMD"
  bash -c "$FULL_SETUP_CMD" || fail "$FULL_SETUP_CMD"
fi

[ "$status" = 0 ] && log "done" || log "done with errors"
exit "$status"
