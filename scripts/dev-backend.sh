#!/usr/bin/env bash
# One-command local Convex backend for development: starts the self-hosted backend in Docker, deploys apps/convex to it and
# pushes the repo-root `.env` onto the deployment. Idempotent; run it again after changing Convex code or `.env`.
#
#   scripts/dev-backend.sh           backend + deploy + env (sign-in codes go to the local mail catcher, see below)
#   REAL_MAIL=1 scripts/dev-backend.sh   leave RESEND_API_URL unset so codes are emailed through Resend
#
# Then, in other terminals:  pnpm dev:mail (prints sign-in codes)  and  pnpm dev:web  (web on :3000).
# Needs Docker and a repo-root `.env` (`pnpm env:init`, see docs/env.md). Prints no secret values.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME=convex-local
# Pinned by digest, same as CI (the :latest of 2026-10-07); bump deliberately.
IMAGE=ghcr.io/convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4
URL=http://127.0.0.1:3210
SITE=http://127.0.0.1:3211

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
[ -f .env ] || { echo "no .env at the repo root: run 'pnpm env:init' first" >&2; exit 1; }

# Cloud containers have the docker CLI but no running daemon.
if ! docker info >/dev/null 2>&1; then
  if [ "$(id -u)" = 0 ] && command -v dockerd >/dev/null; then
    echo "[dev-backend] starting dockerd"
    (nohup dockerd >/tmp/dockerd.log 2>&1 &)
    for _ in $(seq 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  fi
  docker info >/dev/null 2>&1 || { echo "docker daemon is not running" >&2; exit 1; }
fi

fresh=0
if [ -z "$(docker ps -aq -f "name=^${NAME}$")" ]; then
  echo "[dev-backend] creating $NAME"
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull -q "$IMAGE" >/dev/null || {
    echo "could not pull $IMAGE (Convex moved its images from ghcr.io/get-convex to ghcr.io/convex in 2026-10; check the path)" >&2
    exit 1
  }
  docker run -d --name "$NAME" --network host \
    -e INSTANCE_NAME=dorks-dev \
    -e INSTANCE_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
    -e CONVEX_CLOUD_ORIGIN="$URL" -e CONVEX_SITE_ORIGIN="$SITE" -e DO_NOT_REQUIRE_SSL=1 \
    "$IMAGE" >/dev/null
  fresh=1
elif [ -z "$(docker ps -q -f "name=^${NAME}$")" ]; then
  echo "[dev-backend] starting existing $NAME"
  docker start "$NAME" >/dev/null
fi
for _ in $(seq 60); do curl -sf "$URL/version" >/dev/null && break; sleep 1; done
curl -sf "$URL/version" >/dev/null || { docker logs "$NAME" >&2; echo "backend did not become healthy" >&2; exit 1; }

# The admin key is derived from the container's instance secret, so it only changes with a new container.
env_file=apps/convex/.env.local
if [ "$fresh" = 1 ] || ! grep -q '^CONVEX_SELF_HOSTED_ADMIN_KEY=' "$env_file" 2>/dev/null; then
  key="$(docker exec "$NAME" ./generate_admin_key.sh | tail -1)"
  printf 'CONVEX_SELF_HOSTED_URL=%s\nCONVEX_SELF_HOSTED_ADMIN_KEY=%s\n' "$URL" "$key" > "$env_file"
  echo "[dev-backend] wrote $env_file"
fi

cd apps/convex
../../scripts/with-env.sh npx convex dev --once
../../scripts/with-env.sh node scripts/sync-env.mjs

# Deployment-only settings that are not in .env (docs/env.md).
if [ "${REAL_MAIL:-0}" = 1 ]; then
  npx convex env remove RESEND_API_URL >/dev/null 2>&1 || true
else
  npx convex env set RESEND_API_URL http://127.0.0.1:8899/emails >/dev/null
  echo "[dev-backend] sign-in codes go to the local mail catcher: run 'pnpm dev:mail' to see them"
fi
echo "[dev-backend] ready: $URL (site $SITE)"
