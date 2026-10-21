#!/usr/bin/env bash
# Why this exists: a cloud agent VM starts from a bare image, and in it `pnpm install` fails three ways: the repo's pinned pnpm
# (12.x) does not run under the image's older corepack, the Doppler CLI is missing, and the install runs a license check that
# needs CENTRAL_LICENSE_KEY (which lives in Doppler, see docs/secrets/README.md). Without this the agent boots into a repo it
# cannot build or test. This is the one place that knows how to get from bare image to a working checkout, so set it as the
# setup/install command of every cloud provider we use (AGENTS.md has the exact settings) instead of repeating steps in each.
#
#   bash cloud-setup.sh              Doppler CLI, pinned pnpm, dependencies
#   bash cloud-setup.sh --backend    also start the local Convex backend (needs Docker; see scripts/dev-backend.sh)
#   bash cloud-setup.sh --servers    also start the whole stack (backend, mail, web, sim) in the background and return at once;
#                                    `pnpm dev:wait` blocks until it is up (scripts/dev-up.sh)
#
# Also installs the optional CLIs agents use: Cloudflare `cf` (authenticates from Doppler: `pnpm cf ...`) and GitHub's `gh stack`
# extension (stacked PRs). Idempotent and non-interactive; works as root or a normal user (sudo only if it exists) and from any
# working directory. Needs Node >= 22, network access and DOPPLER_TOKEN in the environment. Exit code is non-zero if a required
# step failed; optional tools only log.
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

# The Doppler installer verifies its package signature with gpgv. Amazon Linux cloud VMs ship only gnupg2-minimal (gpg without
# gpgv), so the install fails and the dependency step below has no CENTRAL_LICENSE_KEY. The full package conflicts with the
# minimal one, hence --allowerasing.
if ! have gpgv; then
  log "installing gnupg (gpgv)"
  if have dnf; then priv dnf install -y -q --allowerasing gnupg2 || log "gnupg install failed; continuing"
  elif have apt-get; then priv apt-get install -y -q gnupg || log "gnupg install failed; continuing"
  else log "no dnf or apt-get; cannot install gnupg"; fi
fi

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

# GitHub CLI + the `gh stack` extension (stacked PRs, optional). `gh extension install` needs api.github.com and a valid gh login;
# cloud VMs often have neither, so fall back to building the extension from the Go module proxy and registering it as a local
# extension (a directory gh-stack/ holding an executable gh-stack in gh's extensions dir).
if ! have gh; then
  log "installing GitHub CLI"
  if have apt-get; then
    priv mkdir -p -m 755 /etc/apt/keyrings \
      && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | priv tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
      && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | priv tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
      && priv apt-get update -q >/dev/null && priv apt-get install -y -q gh >/dev/null || log "gh install failed (optional)"
  elif have dnf; then
    priv dnf install -y -q 'dnf-command(config-manager)' >/dev/null 2>&1
    { priv dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || priv dnf config-manager addrepo --from-repofile=https://cli.github.com/packages/rpm/gh-cli.repo; } >/dev/null 2>&1
    priv dnf install -y -q gh >/dev/null || log "gh install failed (optional)"
  else log "no apt-get or dnf; install gh by hand (optional)"; fi
fi
if have gh && ! gh stack --help >/dev/null 2>&1; then
  log "installing gh stack"
  if ! gh extension install github/gh-stack >/dev/null 2>&1; then
    ext="${XDG_DATA_HOME:-$HOME/.local/share}/gh/extensions/gh-stack"
    if have go && mkdir -p "$ext" && GOBIN="$ext" GOFLAGS=-mod=mod go install github.com/github/gh-stack@latest >/dev/null 2>&1; then :
    else rm -rf "$ext"; log "gh stack install failed (optional; needs api.github.com or Go)"; fi
  fi
fi

# pnpm at the version the repo pins. Corepack ships with Node, but older corepack builds cannot run pnpm 12 (it ships bin/pnpm.mjs,
# they look for pnpm.cjs), so verify it works and fall back to the npm package.
want_pnpm="$(node -p 'require("./package.json").packageManager.split("@")[1]')"
# Only try corepack when pnpm is not already right: `corepack enable` replaces a working pnpm with its shim.
if [ "$(pnpm --version 2>/dev/null)" != "$want_pnpm" ]; then have corepack && corepack enable >/dev/null 2>&1 || true; fi
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

case " $* " in
  *" --servers "*)
    # In the background so a session is usable at once; servers keep running after this script exits.
    dir="${DORKS_DEV_DIR:-/tmp/dorks-dev}"; mkdir -p "$dir"
    log "starting servers in the background (log: $dir/up.log); \`pnpm dev:wait\` blocks until they are up"
    setsid nohup bash scripts/dev-up.sh up >"$dir/up.log" 2>&1 </dev/null &
    echo $! >"$dir/up.pid" # dev:wait keys on this; written here so a wait right after setup cannot miss the start
    ;;
  *" --backend "*)
    log "starting the local backend"
    bash scripts/dev-backend.sh || fail "dev-backend.sh"
    ;;
esac

# What an agent can rely on in this session. cf and gh stack are optional, so they only report.
tools="pnpm $(pnpm --version 2>/dev/null || echo MISSING)"
have doppler && tools="$tools | doppler $(doppler --version 2>/dev/null)" || tools="$tools | doppler MISSING"
if have cf; then
  if [ -n "${DOPPLER_TOKEN:-}" ] && have doppler && doppler run -p dorks -c dev -- cf auth whoami >/dev/null 2>&1; then tools="$tools | cf (Doppler auth ok)"
  else tools="$tools | cf (not authenticated)"; fi
else tools="$tools | cf MISSING"; fi
gh stack --help >/dev/null 2>&1 && tools="$tools | gh stack" || tools="$tools | gh stack MISSING"
log "tools: $tools"

[ "$status" = 0 ] && log "done" || log "done with errors"
exit "$status"
