# Secrets

**Encrypted env files in git are the source of truth** ([dotenvx](https://dotenvx.com/docs), v2.33 validated 2026-10-08). Every secret and env var dorks needs lives in `secrets/.env.dev` and `secrets/.env.prod`, each value encrypted individually. The files are committed; only the private keys stay out of git. No account, no service, no network.

- [inventory.md](inventory.md): every variable (name, unit, envs, used by, generated vs external, status).
- [providers/](providers/): step-by-step guides to get each external value ([Resend](providers/resend.md), [GitHub App](providers/github-app.md), [Upstash Box](providers/upstash-box.md), [Expo push](providers/expo-push.md), [Convex](providers/convex.md), [Cloudflare](providers/cloudflare.md)).
- [reuse-in-other-repos.md](reuse-in-other-repos.md): the same setup for any repo.

## Files and keys

| | dev | prod |
| --- | --- | --- |
| Encrypted values (committed) | `secrets/.env.dev` | `secrets/.env.prod` |
| Private key (never committed) | `DOTENV_PRIVATE_KEY_DEV` | `DOTENV_PRIVATE_KEY_PROD` |
| Who holds it | Conductor repo env, every agent/workspace, devs | **You / password manager / CI only** |

- The public key is inside each file, so anyone can **add or overwrite** values without being able to **read** them (validated). That is how agents can seed prod without seeing it. Because overwriting is possible, review every `secrets/.env.prod` diff in PRs.
- Locally the keys can sit in `secrets/.env.keys` (gitignored, dotenvx writes it on first `set`). Conductor/CI use the env vars instead.
- A leaked **dev** key decrypts all git history of dev values. Keep dev values low-value (sim mode, dev tokens); real third-party prod credentials go only in `.env.prod`.
- Rotating a key means decrypting the file (`dotenvx decrypt -f secrets/.env.prod`), deleting its entry in `secrets/.env.keys`, and re-encrypting (`dotenvx encrypt -f ...`, which makes a new keypair). If the old key may have leaked, also rotate the underlying secrets: old git history stays decryptable with the old key.
- `staging` is not used: one production target, no CI.

## Naming and layout

- **Secret names are exactly the env var name the code reads.** Names are unique across units, so there is one file per env instead of per-unit folders. The inventory's "unit" column records which app owns/reads each value (`shared`, `convex`, `web`, `ios`, `api`).
- Public build-time values (`VITE_*`, `EXPO_PUBLIC_*`) are config, not secrets, but live here too so there is one place to look. They ship to browsers/devices: never put a real secret behind those prefixes.
- Dummy values for things a human must obtain are `REPLACE_ME__<PROVIDER>` (status `dummy` in the inventory). A dummy in prod means that feature is not ready.
- **Real values are never committed in plaintext, pasted into issues/chat, or logged.** `.env*` is gitignored except `*.example` and the two encrypted files.

## One-time setup (human steps)

`scripts/seed-secrets.sh` has already created both files (generated values + dummies). You need to place the keys:

1. Open `secrets/.env.keys` (synced to your Mac if Sync files is on; otherwise read it in the workspace terminal). Do not paste its contents into chat.
2. Save **both** keys in your password manager (1Password etc.).
3. In Conductor, add `DOTENV_PRIVATE_KEY_DEV` to the environment for this repo, the same way the other repo env vars are set (local: `.conductor/settings.local.toml` under `[environment_variables]`; cloud: the cloud environment config). **Do not add the prod key to Conductor.**
4. Merge to `main` (encrypted files must reach `main` for other workspaces and cloud boxes), then delete `secrets/.env.keys` from any shared machine.
5. Fill the dummies with the provider guides (see "Adding or changing a secret").

## Adding or changing a secret

```sh
scripts/set-secret.sh prod RESEND_API_KEY                  # prompts silently; no private key needed
scripts/set-secret.sh dev  NEW_KEY --generate b64          # random 32 bytes (b64|hex), never printed
printf %s "$VALUE" | scripts/set-secret.sh prod SOME_NAME  # from stdin
```

Then commit `secrets/.env.*`. For a brand-new secret also: read it in code by exact name, add a row to [inventory.md](inventory.md) and the name to the unit's `.env.example`, and add it to the table in `scripts/seed-secrets.sh`. Multi-line values (PEM) work: pipe the file in.

## Who reads them

| Consumer | How it gets values |
| --- | --- |
| Local dev servers | `scripts/with-secrets.sh` -> `dotenvx run --strict` (see [Local development](#local-development)) |
| Convex functions | Read the _deployment's_ env. Dev: `apps/convex/scripts/dev.mjs` pushes them. Prod: you set them on the production deployment ([Convex guide](providers/convex.md)) |
| Web / iOS builds | `VITE_*` / `EXPO_PUBLIC_*` injected at build time |
| Legacy api Worker | `wrangler.jsonc` `secrets.required` names; prod via `wrangler secret put` |
| CI / deploys | `CONVEX_DEPLOY_KEY`, `CLOUDFLARE_*` (no CI exists yet; give CI the prod key as a CI secret) |

## Open decision: syncing to hosting providers

Not decided; nothing is configured. Prod values are copied by hand using the provider guides. If wanted later: a small script can run `DORKS_ENV=prod scripts/with-secrets.sh convex -- ...` to push to Convex (`convex env set`) and Cloudflare (`wrangler secret put`), with no extra service. Hosted managers offer first-party syncs (e.g. Infisical documents a Cloudflare Workers sync); we gave those up in exchange for no SaaS dependency.

## Local development

```sh
pnpm install     # installs dotenvx
# have DOTENV_PRIVATE_KEY_DEV in the environment (Conductor sets it), or secrets/.env.keys locally
pnpm dev
```

| Command | Starts | Notes |
| --- | --- | --- |
| `pnpm dev` | Convex + web in parallel | |
| `pnpm dev:convex` | `convex dev` after syncing function env | |
| `pnpm dev:web` | Vite on :3000 | |
| `pnpm dev:ios` | Expo | |
| `pnpm dev:api` | legacy Hono + Durable Object on wrangler :8787 | |

`DORKS_ENV=prod` loads the prod file (needs the prod key; use deliberately, e.g. `DORKS_ENV=prod scripts/with-secrets.sh web -- pnpm --filter @dorks/web build`). To run anything else: `scripts/with-secrets.sh <unit> -- <command>`.

How each process gets env:

- **api (wrangler)**: `secrets.required` in `wrangler.jsonc` makes wrangler read those names from the process env. Non-secret `vars` stay in `wrangler.jsonc`. A leftover `apps/api/.dev.vars` takes priority (the wrapper warns); delete it.
- **web (Vite)** / **ios (Expo)**: `VITE_*` / `EXPO_PUBLIC_*` are read from the process env at dev/build time (public values). After changing them for Expo, restart with `--clear`.
- **convex**: functions read the deployment's env, so `apps/convex/scripts/dev.mjs` pushes every `process.env.NAME` the functions use (scanned from `convex/`, `CONVEX_*` excluded) with `convex env set`, values via stdin. Names missing from `secrets/.env.dev` are listed and left alone. Deployment selection (`CONVEX_DEPLOYMENT` or self-hosted URL/admin key) is `convex dev`'s own gitignored `apps/convex/.env.local`.

Running without dotenvx: every app has a `:local` script that skips the wrapper (`pnpm --filter @dorks/api dev:local`, etc.); supply env yourself via the gitignored `apps/api/.dev.vars`, `apps/web/.env.local`, `apps/ios/.env.local`, or `npx convex env set`.

### Troubleshooting

- **`no decryption key`**: set `DOTENV_PRIVATE_KEY_DEV` (see One-time setup) or put `secrets/.env.keys` in place.
- **`DECRYPTION_FAILED`**: wrong key for that file (dev key cannot read prod), or the file was re-encrypted: get the current key from the password manager.
- **A value looks like `encrypted:...` at runtime**: something ran `dotenvx` without `--strict`. Always go through `scripts/with-secrets.sh`.
- **Convex says an env var is not set**: it was reported under "not in secrets/.env.dev" by `convex dev`; add it with `scripts/set-secret.sh dev NAME` and restart.
- **Changes not picked up**: values are read once at process start; restart the dev server.
