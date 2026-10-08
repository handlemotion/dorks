#!/usr/bin/env bash
# Encrypt one value into secrets/.env.<env> without echoing it. Needs no private key (public key is in the file).
#
#   scripts/set-secret.sh <dev|prod> NAME            # prompts silently (or reads stdin when piped)
#   scripts/set-secret.sh prod NAME --generate b64   # random 32 bytes (b64 | hex), never printed
#
# Overwrites an existing value: review the secrets/ diff before committing.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_name="${1:?usage: set-secret.sh <dev|prod> NAME [--generate b64|hex]}"; name="${2:?NAME required}"
[[ "$env_name" =~ ^(dev|prod)$ ]] || { echo "env must be dev or prod" >&2; exit 2; }
[[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "bad name" >&2; exit 2; }

if [[ "${3:-}" == "--generate" ]]; then
  enc=$([[ "${4:-}" == "hex" ]] && echo hex || echo base64)
  val="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString(process.argv[1]))' "$enc")"
  [[ ${#val} -ge 43 ]] || { echo "generation failed" >&2; exit 1; }
elif [[ -t 0 ]]; then
  read -rs -p "$name ($env_name): " val; echo >&2
else
  val="$(cat)"
fi
[[ -n "$val" ]] || { echo "empty value, nothing set" >&2; exit 1; }

"$root/node_modules/.bin/dotenvx" set "$name" "$val" -f "$root/secrets/.env.$env_name" -fk "$root/.env.keys" >/dev/null
echo "set $name in secrets/.env.$env_name" >&2
