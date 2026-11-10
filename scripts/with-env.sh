#!/usr/bin/env bash
# Runs a command with the variables from the repo-root `.env` exported (create it with `pnpm env:init`).
# Variables already set in the environment win over the file. Prints no values.
#
#   scripts/with-env.sh pnpm --filter @dorks/web dev
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$root/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    name="${line%%=*}"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    [ -n "${!name+x}" ] && continue
    value="${line#*=}"
    # Strip one pair of surrounding quotes.
    case "$value" in \"*\") value="${value#\"}"; value="${value%\"}" ;; \'*\') value="${value#\'}"; value="${value%\'}" ;; esac
    export "$name=$value"
  done < "$root/.env"
fi
exec "$@"
