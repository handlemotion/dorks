# Convex (backend deployment, deploy key, env vars)

Provides: `CONVEX_DEPLOY_KEY` (`convex`, prod only); the deployment URLs for `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL` (`web`) and `EXPO_PUBLIC_CONVEX_URL`, `EXPO_PUBLIC_CONVEX_SITE_URL` (`ios`); and the destination for every `shared` + `convex` runtime secret.

Official docs (checked 2026-10-07): [Deploy keys](https://docs.convex.dev/cli/deploy-key-types), [Environment variables](https://docs.convex.dev/production/environment-variables), [`convex deploy`](https://docs.convex.dev/cli/reference/deploy).

## Dev vs prod

Convex env vars are **per deployment**, so the dev and prod deployments hold different values for the same names. Dev: `pnpm dev:convex` syncs `secrets/.env.dorks_dev` into the dev deployment automatically (`apps/convex/scripts/dev.mjs`). Prod: you set them on the production deployment yourself (below). `CONVEX_CLOUD_URL` and `CONVEX_SITE_URL` are built in; never set them.

## Steps (prod)

1. Create the project/production deployment at https://dashboard.convex.dev (team plan: start Free; see `docs/convex-spike.md` for limits).
2. URLs: `https://<deployment-name>.convex.cloud` (client) and `https://<deployment-name>.convex.site` (HTTP actions / auth). Put them in `secrets/.env.dorks_prod`:
   ```sh
   printf %s "https://<name>.convex.cloud" | scripts/set-secret.sh prod VITE_CONVEX_URL
   printf %s "https://<name>.convex.site"  | scripts/set-secret.sh prod VITE_CONVEX_SITE_URL
   printf %s "https://<name>.convex.cloud" | scripts/set-secret.sh prod EXPO_PUBLIC_CONVEX_URL
   printf %s "https://<name>.convex.site"  | scripts/set-secret.sh prod EXPO_PUBLIC_CONVEX_SITE_URL
   ```
3. Deploy key: open the production deployment's settings (`https://dashboard.convex.dev/deployment/settings`) -> **Deploy keys** -> **Generate a deploy key**, name it (e.g. `ci`), enable `deployment:deploy`. CLI alternative: `npx convex deployment token create ci --deployment prod` after `npx convex login`. A production key looks like `prod:<name>|...`.
   ```sh
   scripts/set-secret.sh prod CONVEX_DEPLOY_KEY
   ```
   Do not put a deploy key (or `CONVEX_DEPLOYMENT`) in `dev`: it overrides which deployment the CLI targets.
4. Set the runtime env vars on the **production** deployment (names: every runtime row with unit `shared` or `convex` in the [inventory](../inventory.md), except `SIM_HOST_KEY`, the `CONVEX_*`/`CLOUDFLARE_*` deploy rows and the `VITE_*`/`EXPO_PUBLIC_*` rows). Safest: open the production deployment's **Settings -> Environment Variables** in the dashboard and paste each value (print with `pnpm exec dotenvx get NAME -f secrets/.env.dorks_prod`; needs the prod key; the output stays on your terminal). CLI: `npx convex env set NAME` reads the value from stdin when none is given (that is how `apps/convex/scripts/dev.mjs` avoids argv), e.g. `printenv GITHUB_APP_PRIVATE_KEY | npx convex env set GITHUB_APP_PRIVATE_KEY` inside `pnpm exec dotenvx run -f secrets/.env.dorks_prod -- sh -c '...'`, authenticated for the prod deployment (`npx convex env --help` shows the flag/variable that selects it; not verified here). Never echo values to the terminal.
5. Do **not** set `SIM_HOST_KEY` or `RESEND_API_URL` on prod.
