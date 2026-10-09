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
  pnpm install --frozen-lockfile || echo "[cloud-setup] pnpm install failed (non-fatal)"
fi

echo "[cloud-setup] done"
