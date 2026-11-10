# Contributor and agent notes

Start with [CONTRIBUTING.md](CONTRIBUTING.md) (layout, dev loop, tests) and [docs/architecture.md](docs/architecture.md) (the contract between server, web, bridge and desktop shell).

## Branching

- Branch from and target `main` by default.
- Only continue on, or branch from, another feature branch when the work truly stacks on unmerged changes (it cannot work without them). If unsure, use `main`.

## Running things

Test changes against running servers, not only unit tests.

- Server: `pnpm --filter @dorks/server dev` (Bun). Use `DORKS_DATA_DIR=<temp dir>` and `DORKS_UI_PORT=0 DORKS_BRIDGE_PORT=0` to avoid touching real data or colliding with another running instance. It prints one JSON `ready` line with the ports.
- Web against the mock server: `pnpm --filter @dorks/web dev:mock`.
- The root `dev:*` scripts and `infra/bridge-sim` still target the Convex backend that is being removed; do not rely on them.

## Secrets

- **Never print, log, echo or commit secret values.** The server's keys live in `<data dir>/secrets.json`; do not `cat` it. Refer to variables by name; the reference is `docs/env.md`.
- **New env var in code:** read it by its exact name in `apps/server/src/config.ts` and add a row to `docs/env.md`. Prefer a stored setting when a user should change it from the UI.
- `VITE_*` values ship to browsers: never put a real secret behind that prefix.
