#!/usr/bin/env bash
# Idempotent bootstrap for Claude Code cloud sessions: Doppler CLI, Cloudflare
# `cf` CLI, and repo dependencies. Safe to run repeatedly.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v doppler >/dev/null; then
  echo "[cloud-setup] installing Doppler CLI"
  curl -Ls --tlsv1.2 --proto "=https" --retry 3 https://cli.doppler.com/install.sh | sh \
    || echo "[cloud-setup] doppler install failed (non-fatal)"
fi

# cf needs Node >= 22.18. The command is also available as `cloudflare`.
if ! command -v cf >/dev/null; then
  echo "[cloud-setup] installing Cloudflare cf CLI"
  npm install --global cf || echo "[cloud-setup] cf install failed (non-fatal)"
fi

if [ ! -d node_modules ]; then
  echo "[cloud-setup] installing repo dependencies"
  corepack enable || true
  # The image's corepack (0.34) cannot run pnpm 12 (it ships bin/pnpm.mjs, corepack looks for pnpm.cjs). Fall back to the npm package.
  if ! pnpm --version >/dev/null 2>&1; then
    echo "[cloud-setup] corepack pnpm is broken; installing pnpm from npm"
    npm install --global "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')" \
      || echo "[cloud-setup] pnpm install failed (non-fatal)"
  fi
  # `pnpm install` runs the Central Icons license check, which needs CENTRAL_LICENSE_KEY; Doppler dev has it.
  install="pnpm install --frozen-lockfile"
  if [ -n "${DOPPLER_TOKEN:-}" ] && command -v doppler >/dev/null; then
    doppler run -p dorks -c dev -- $install || echo "[cloud-setup] pnpm install failed (non-fatal)"
  else
    $install || echo "[cloud-setup] pnpm install failed (non-fatal)"
  fi
fi

echo "[cloud-setup] done"
