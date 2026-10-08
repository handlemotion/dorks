#!/usr/bin/env bash
# Run a command with decrypted secrets from secrets/.env.<env> (dotenvx).
#
#   scripts/with-secrets.sh <unit> -- <command...>
#
# <unit> is the app directory name under apps/ (api, web, convex, ios). All units read the same file; names are unique
# across units (see docs/secrets/inventory.md). Environment is DORKS_ENV (default: dev).
#
# Key: DOTENV_PRIVATE_KEY_<ENV> in the environment (Conductor / CI), or secrets/.env.keys (local, gitignored).
# --strict makes a missing/wrong key a hard failure; without it dotenvx would inject the ciphertext and exit 0.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit="${1:?usage: with-secrets.sh <unit> -- <command...>}"
shift
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "with-secrets: no command given" >&2; exit 2; }

env_name="${DORKS_ENV:-dev}"
file="$root/secrets/.env.$env_name"
[[ -f "$file" ]] || { echo "with-secrets: $file not found (DORKS_ENV must be dev or prod)" >&2; exit 1; }

dotenvx="$root/node_modules/.bin/dotenvx"
[[ -x "$dotenvx" ]] || { echo "with-secrets: run 'pnpm install' first" >&2; exit 127; }

key_var="DOTENV_PRIVATE_KEY_$(tr '[:lower:]' '[:upper:]' <<<"$env_name")"
if [[ -z "${!key_var:-}" && ! -f "$root/secrets/.env.keys" ]]; then
  echo "with-secrets: no decryption key. Set $key_var in the environment (Conductor repo env / CI)," >&2
  echo "              or place secrets/.env.keys from the password manager. See docs/secrets/README.md." >&2
  exit 1
fi

# wrangler prefers apps/api/.dev.vars over process env, which would silently shadow these secrets.
if [[ "$unit" == "api" && -f "$root/apps/api/.dev.vars" ]]; then
  echo "with-secrets: apps/api/.dev.vars exists and overrides secrets/ for wrangler. Delete it." >&2
fi

exec "$dotenvx" run --strict --quiet -f "$file" -fk "$root/secrets/.env.keys" -- "$@"
