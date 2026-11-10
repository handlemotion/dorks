# Contributor and agent notes

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Running servers

Test changes against running servers, not only unit tests. `scripts/dev-up.sh` runs the stack detached, logs in `/tmp/dorks-dev/<name>.log`:

- `pnpm env:init` once (writes the git-ignored `.env`). `pnpm dev:up` starts whatever is not running; `pnpm dev:wait` blocks until a start in progress finishes and prints status; `pnpm dev:status`, `pnpm dev:down`.
- Convex `http://127.0.0.1:3210` (HTTP actions `:3211`), web `http://localhost:3000`, mail catcher `:8899` (sign-in codes appear in `/tmp/dorks-dev/mail.log`), box simulator (`sim`).
- After changing `apps/convex` code, rerun `pnpm dev:backend` to deploy it; vite reloads web changes itself.
- The e2e scripts in `apps/convex/scripts` (for example `run-e2e.sh`) start their own mail mock on :8899 and their own sim, so stop those first (`pnpm dev:down` leaves the backend and stops mail, web and sim; restart web with `pnpm dev:up` if a script needs it).

## Secrets

- **Never print, log, echo or commit secret values**, and do not `cat .env`. Refer to variables by name; the reference is `docs/env.md`.
- **New env var in code:** read it by its exact name, add a row to `docs/env.md` and the name to the relevant `.env.example`, and add it to the `set_env` list in `.github/workflows/ci.yml` with a throwaway value.
- `VITE_*` / `EXPO_PUBLIC_*` ship to clients: never put a real secret behind those prefixes.
