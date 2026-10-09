# Secrets

**[Doppler](https://docs.doppler.com) is the source of truth** for every secret and env var dorks needs: project `dorks`, configs `dev` and `prd`. Nothing is stored in git.

- [inventory.md](inventory.md): every variable (name, unit, envs, used by, generated vs external, status).
- [providers/](providers/): how to get each external value ([Resend](providers/resend.md), [GitHub App](providers/github-app.md), [Upstash Box](providers/upstash-box.md), [Expo push](providers/expo-push.md), [Convex](providers/convex.md), [Cloudflare](providers/cloudflare.md)).
- [reuse-in-other-repos.md](reuse-in-other-repos.md): the same setup for another repo.

## The setup, and why

| Decision | Why |
| --- | --- |
| **One Doppler service account (`Conductor`), token in `DOPPLER_TOKEN`**, set once per machine in Conductor's Shared env | Zero per-workspace setup: a fresh workspace has the CLI (cloud image) and the token, so `pnpm dev` just works. One credential per machine serves every repo. |
| **Project and config are explicit on the command line** (`doppler run -p dorks -c dev -- ...`) | A service-account token has no built-in project/config, and a repo-level `doppler.yaml` is only read by `doppler setup`, which writes per-machine state (`~/.doppler`); `doppler run` alone ignores it (tested, CLI 3.77). Flags need no setup step and cannot collide across repos. So there is no `doppler.yaml` in the repo. |
| **No `DOPPLER_PROJECT` / `DOPPLER_CONFIG` env vars** | They would be machine-global, so two repos sharing one machine would collide. Per-repo flags in `package.json` do not. |
| **Names are the exact env var the code reads**, unique across units | One flat config per env instead of per-app configs; the inventory's "unit" column records the owner. |
| `dev` and `prd` only | One production target; no staging. |

Multi-repo layout: each repo has its own Doppler **project** (same names `dev`/`prd`), and its scripts name it (`-p <repo>`). The shared `DOPPLER_TOKEN` is granted access to each project in Doppler; no repo holds a credential. Recipe: [reuse-in-other-repos.md](reuse-in-other-repos.md).

Doppler also injects its built-ins (`DOPPLER_PROJECT`, `DOPPLER_CONFIG`, `DOPPLER_ENVIRONMENT`) into every `doppler run`; ignore them.

## Local development

```sh
pnpm install
pnpm dev          # Convex + web with Doppler `dev` secrets
```

Needs the Doppler CLI and `DOPPLER_TOKEN` in the environment (Conductor workspaces already have both).

| Command | Starts |
| --- | --- |
| `pnpm dev` | Convex + web in parallel |
| `pnpm dev:convex` | `convex dev` after syncing function env (`apps/convex/scripts/sync-env.mjs`) |
| `pnpm dev:web` | Vite on :3000 |
| `pnpm dev:ios` | Expo |

Anything else: `doppler run -p dorks -c dev -- <cmd>` from the repo root.

How each process gets env:

- **web (Vite)** / **ios (Expo)**: `VITE_*` / `EXPO_PUBLIC_*` are read from the process env at dev/build time (public values; after changing them for Expo, restart with `--clear`).
- **convex**: functions read the _deployment's_ env, not the shell. `sync-env.mjs` pushes every `process.env.NAME` the functions use (scanned from `convex/`, `CONVEX_*` excluded) with `convex env set`, values via stdin. Names missing from Doppler, or still `REPLACE_ME__*`, are listed and left alone on the deployment. Deployment selection is `convex dev`'s own gitignored `apps/convex/.env.local`.
- **CI** uses no Doppler. It has one real secret, the GitHub Actions repository secret `CENTRAL_LICENSE_KEY` (needed by `pnpm install`, see the inventory); every other value is generated inline in `.github/workflows/ci.yml`.

Values are read once at process start; restart after changing one. Changes in Doppler apply to the next `doppler run`.

### Troubleshooting

- **`Doppler Error: ... token`** or `You must specify a config`: `DOPPLER_TOKEN` is missing or revoked in this environment (or the `-p/-c` flags were dropped).
- **Convex says an env var is not set**: it was listed as missing or placeholder by `convex dev`. Add it (see below) and restart.

## Agent rules

- **Never print, log, echo, read or commit secret values.** No `doppler secrets get`, `secrets download`, `doppler run -- printenv/env`, `cat .env*`, or anything that sends values to the terminal, a file or chat. Names only: `doppler secrets -p dorks -c dev --only-names`.
- **No prod.** Never run any command with `-c prd` (read or write). Prod values are edited by a human in the Doppler dashboard.
- **Add or change a dev secret** (value must not be echoed):
  - generated: `node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' | doppler secrets set NAME -p dorks -c dev --no-interactive` (`hex` for hex);
  - config value: `printf %s 'value' | doppler secrets set NAME -p dorks -c dev --no-interactive`;
  - external value only a human has: set `REPLACE_ME__<PROVIDER>` and ask the human to fill it in the dashboard.
  Check that the name exists first (`--only-names`); do not overwrite an existing value you did not create.
- **New env var in code:** read it by its exact name; add a row to [inventory.md](inventory.md) and the name to the unit's `.env.example`; create it in `dev` as above (and name it in the PR so a human creates it in `prd`).
- `VITE_*` / `EXPO_PUBLIC_*` ship to clients: never put a real secret behind those prefixes.

## Humans: prod

Edit `prd` in the Doppler dashboard (project `dorks`). Do not paste values into issues or chat. The `Conductor` token's reach into `prd` is a decision still open (the token can currently list `prd` names); prod values must not be read by agents either way.

- **Convex prod env:** `pnpm push:convex-env` ([Convex guide](providers/convex.md)).
- **Cloudflare Workers:** Doppler's documented path is a CLI pipe into `wrangler secret bulk` ([Cloudflare guide](providers/cloudflare.md)).
- **Placeholders:** values that a human must obtain are `REPLACE_ME__<PROVIDER>`. A placeholder in `prd` means that feature is not ready; the Convex push skips them.
