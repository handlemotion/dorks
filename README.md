# dorks

pnpm workspace. `pnpm install`, then:

- `pnpm dev:api` — Hono + `Dork` Durable Object on wrangler (:8787)
- `pnpm dev:web` — TanStack Start on Workers via Vite (:3000, proxies `/api` → :8787)
- `cd apps/ios && pnpm start` — Expo
- `pnpm typecheck`

Secrets for local dev go in `apps/api/.dev.vars` (gitignored).

## Local dev

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill ENCRYPTION_KEY (base64 32 bytes)
pnpm --filter @dorks/api db:migrate               # local D1
pnpm dev:api & pnpm dev:web
```

With `RESEND_API_KEY` empty, sign-in codes are printed in the API log (`[dev mailer]`).
Sign-in only works for `ALLOWED_EMAIL_DOMAIN` (default `jaantonio.com`). Use the web origin (:3000) so Better Auth's origin check passes.

## Tests

`pnpm test` runs the API suite inside workerd (real D1 + Durable Objects) and the shared client suite.
