# dorks

pnpm workspace. `pnpm install`, then:

- `pnpm dev` — Convex + web; `pnpm dev:convex`, `pnpm dev:web`, `pnpm dev:ios` individually
- `pnpm dev:api` — Hono + `Dork` Durable Object on wrangler (:8787)
- `pnpm dev:web` — TanStack Start on Workers via Vite (:3000, proxies `/api` → :8787)
- `cd apps/ios && pnpm start` — Expo
- `pnpm typecheck`

Secrets live in Doppler (project `dorks`); see [docs/secrets/README.md](docs/secrets/README.md). With `DOPPLER_TOKEN` set (Conductor workspaces have it), `pnpm dev` starts Convex + web with the `dev` config (`pnpm dev:ios`, `pnpm dev:api` for the others).

## Local dev (legacy API)

```sh
pnpm --filter @dorks/api db:migrate               # local D1
pnpm dev:api & pnpm dev:web
```

With `RESEND_API_KEY` empty, sign-in codes are printed in the API log (`[dev mailer]`).
Sign-in only works for `ALLOWED_EMAIL_DOMAIN` (default `jaantonio.com`). Use the web origin (:3000) so Better Auth's origin check passes.

## Tests

`pnpm test` runs the API suite inside workerd (real D1 + Durable Objects) and the shared client suite.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It uses no real secrets: every key is generated per run.

- **checks**: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r --if-present test` (with a throwaway `apps/api/.dev.vars`).
- **backend-e2e**: starts a self-hosted Convex backend (`ghcr.io/get-convex/convex-backend`, pinned by digest) with `--network host`, deploys `apps/convex` with `npx convex dev --once`, sets throwaway Convex env vars, then runs `apps/convex/scripts/run-e2e.sh` (acceptance + secret scan) and `apps/convex/scripts/web-e2e.mjs` (headless Chrome against `apps/web` dev). On failure the logs and screenshots in `/tmp/dorks-e2e` are uploaded as the `dorks-e2e-logs` artifact (the raw table export is not).

Reproduce locally by following the steps in the workflow; `CHROME_PATH` overrides the Chrome binary used by `web-e2e.mjs`.

Keep CI in step with the backend as other branches land:

- Any new required Convex env var (the GitHub App and Upstash settings, say) must be added to the `set_env` list in the "Deploy functions and set throwaway env" step, using throwaway or sim values only.
- Rate limits keyed by IP or email can trip the e2e, which sends many sign-in codes from `127.0.0.1` within seconds. If the auth work adds env-configurable caps, set CI-specific overrides in the same step.
- A new workspace package (such as `infra/bridge`) is picked up by `pnpm -r` once it is in `pnpm-workspace.yaml`; commit its lockfile changes or `--frozen-lockfile` fails.
