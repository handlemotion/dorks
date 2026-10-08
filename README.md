# dorks

pnpm workspace. `pnpm install`, then:

- `pnpm dev` — Convex + web; `pnpm dev:convex`, `pnpm dev:web`, `pnpm dev:ios` individually
- `pnpm dev:api` — Hono + `Dork` Durable Object on wrangler (:8787)
- `pnpm dev:web` — TanStack Start on Workers via Vite (:3000, proxies `/api` → :8787)
- `cd apps/ios && pnpm start` — Expo
- `pnpm typecheck`

Secrets are dotenvx-encrypted files in `secrets/`; see [Local development](docs/secrets/README.md#local-development). With `DOTENV_PRIVATE_KEY_DEV` set, `pnpm dev` starts Convex + web with secrets loaded (`pnpm dev:ios`, `pnpm dev:api` for the others).

## Local dev (legacy API)

```sh
pnpm --filter @dorks/api db:migrate               # local D1
pnpm dev:api & pnpm dev:web
```

With `RESEND_API_KEY` empty, sign-in codes are printed in the API log (`[dev mailer]`).
Sign-in only works for `ALLOWED_EMAIL_DOMAIN` (default `jaantonio.com`). Use the web origin (:3000) so Better Auth's origin check passes.

## Tests

`pnpm test` runs the API suite inside workerd (real D1 + Durable Objects) and the shared client suite.
