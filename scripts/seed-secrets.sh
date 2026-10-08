#!/usr/bin/env bash
# Create every inventory secret in secrets/.env.dev and secrets/.env.prod. Idempotent: names already present are skipped,
# so re-running never rotates a generated value. Source of truth for what exists: docs/secrets/inventory.md.
#
#   scripts/seed-secrets.sh [--dry-run]
#
# Generated values are piped straight into dotenvx (never printed). First run creates secrets/.env.keys (gitignored):
# save DOTENV_PRIVATE_KEY_DEV / _PROD in the password manager, then see docs/secrets/README.md.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dry=0; [[ "${1:-}" == "--dry-run" ]] && dry=1
mkdir -p "$root/secrets"

# unit|name|kind|dev|prod     kind: gen-b64 | gen-hex | cfg | ext
#   gen-*: random per environment.  cfg: literal from dev/prod columns.  ext: dummy REPLACE_ME__<column value>.  "-": skip.
SECRETS=(
  "shared|BETTER_AUTH_SECRET|gen-b64|x|x"
  "shared|ENCRYPTION_KEY|gen-b64|x|x"
  "shared|RESEND_API_KEY|ext|RESEND|RESEND"
  "shared|ALLOWED_EMAIL_DOMAIN|cfg|jaantonio.com|jaantonio.com"
  "shared|BOX_PROVIDER|cfg|sim|upstash"
  "shared|BASE_SNAPSHOT_ID|cfg|sim-snapshot|REPLACE_ME__UPSTASH_BOX_SNAPSHOT"
  "shared|GITHUB_APP_ID|ext|GITHUB_APP|GITHUB_APP"
  "shared|GITHUB_APP_PRIVATE_KEY|ext|GITHUB_APP|GITHUB_APP"
  "shared|GITHUB_WEBHOOK_SECRET|gen-hex|x|x"
  "shared|UPSTASH_BOX_API_KEY|ext|UPSTASH_BOX|UPSTASH_BOX"
  "shared|EXPO_ACCESS_TOKEN|ext|EXPO|EXPO"
  "shared|CLOUDFLARE_API_TOKEN|ext|-|CLOUDFLARE"
  "shared|CLOUDFLARE_ACCOUNT_ID|ext|-|CLOUDFLARE"
  "convex|BRIDGE_SECRET_KEY|gen-hex|x|x"
  "convex|SIM_HOST_KEY|gen-hex|x|-"
  "convex|GITHUB_APP_CLIENT_ID|ext|GITHUB_APP|GITHUB_APP"
  "convex|GITHUB_APP_CLIENT_SECRET|ext|GITHUB_APP|GITHUB_APP"
  "convex|SITE_URL|cfg|http://localhost:3000|REPLACE_ME__WEB_ORIGIN"
  "convex|CONVEX_DEPLOY_KEY|ext|-|CONVEX"
  "web|VITE_CONVEX_URL|cfg|http://127.0.0.1:3210|REPLACE_ME__CONVEX_URL"
  "web|VITE_CONVEX_SITE_URL|cfg|http://127.0.0.1:3211|REPLACE_ME__CONVEX_SITE_URL"
  "ios|EXPO_PUBLIC_CONVEX_URL|cfg|http://127.0.0.1:3210|REPLACE_ME__CONVEX_URL"
  "ios|EXPO_PUBLIC_CONVEX_SITE_URL|cfg|http://127.0.0.1:3211|REPLACE_ME__CONVEX_SITE_URL"
)

created=0 skipped=0
for env in dev prod; do
  file="$root/secrets/.env.$env"
  echo "== $env"
  for row in "${SECRETS[@]}"; do
    IFS='|' read -r unit name kind dev_v prod_v <<<"$row"
    v="$([[ $env == dev ]] && echo "$dev_v" || echo "$prod_v")"
    [[ "$v" == "-" ]] && continue
    if [[ -f "$file" ]] && grep -q "^$name=" "$file"; then skipped=$((skipped + 1)); continue; fi
    echo "  $name ($unit, $kind)"
    created=$((created + 1)); ((dry)) && continue
    case "$kind" in
      gen-b64) "$root/scripts/set-secret.sh" "$env" "$name" --generate b64 ;;
      gen-hex) "$root/scripts/set-secret.sh" "$env" "$name" --generate hex ;;
      cfg)     printf %s "$v" | "$root/scripts/set-secret.sh" "$env" "$name" ;;
      ext)     printf %s "REPLACE_ME__$v" | "$root/scripts/set-secret.sh" "$env" "$name" ;;
    esac
  done
done
echo "done: $created created, $skipped already existed"
