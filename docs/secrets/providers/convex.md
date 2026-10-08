# Convex (backend deployment, deploy key, env vars)

Provides: `CONVEX_DEPLOY_KEY` (`convex`, prod only); the deployment URLs for `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` (`web`) and `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_SITE_URL` (`ios`); and the destination for every `shared` + `convex` runtime secret.

Official docs (checked 2026-10-07): [Deploy keys](https://docs.convex.dev/cli/deploy-key-types), [Environment variables](https://docs.convex.dev/production/environment-variables), [`convex deploy`](https://docs.convex.dev/cli/reference/deploy).

## Dev vs prod

Convex env vars are **per deployment**, so the dev and prod deployments hold different values for the same names. Dev: `pnpm dev:convex` syncs the Doppler `dev` config into the dev deployment automatically (`apps/convex/scripts/sync-env.mjs`). Prod: a human runs `pnpm push:convex-env` (below). `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` are built in; never set them.

## Steps (prod)

1. Create the project/production deployment at https://dashboard.convex.dev (team plan: start Free; see `docs/convex-spike.md` for limits).
2. URLs: `https://<deployment-name>.convex.cloud` (client) and `https://<deployment-name>.convex.site` (HTTP actions / auth). Set them in Doppler `dorks` -> `prd` (dashboard): `VITE_CONVEX_URL` and `EXPO_PUBLIC_CONVEX_URL` = the `.convex.cloud` URL; `VITE_CONVEX_SITE_URL` and `EXPO_PUBLIC_CONVEX_SITE_URL` = the `.convex.site` URL.
3. Deploy key: open the production deployment's settings (`https://dashboard.convex.dev/deployment/settings`) -> **Deploy keys** -> **Generate a deploy key**, name it (e.g. `ci`), enable `deployment:deploy`. CLI alternative: `npx convex deployment token create ci --deployment prod` after `npx convex login`. A production key looks like `prod:<name>|...`.
   Put it in Doppler `dorks` -> `prd` as `CONVEX_DEPLOY_KEY` (dashboard).
   Do not put a deploy key (or `CONVEX_DEPLOYMENT`) in `dev`: it overrides which deployment the CLI targets.
4. Push the runtime env vars to the **production** deployment. Doppler has no managed Convex sync, so a human runs, from the repo root:
   ```sh
   pnpm push:convex-env
   ```
   That is `doppler run -p dorks -c prd -- pnpm --filter @dorks/convex sync-env`: it finds every `process.env.NAME` the Convex code reads (as in dev), skips `CONVEX_*` and `REPLACE_ME__*` placeholders, and sets each with `convex env set` over stdin. `CONVEX_DEPLOY_KEY` (from `prd`) selects the production deployment, so it must be a real key first (with the placeholder the command fails and sets nothing). Values are never printed. Rerun after changing a prod value. Unverified against a real production deployment.
5. Do **not** set `SIM_HOST_KEY` or `RESEND_API_URL` on prod.
