# dorks

Run coding agents (Claude Code, Codex) in your own [Boat](https://boat.dev) sandboxes and drive them from one UI: a chat per task, PRs that the agent keeps working on until they merge. Your sandboxes, your Boat account, your Claude or ChatGPT sign-in; nothing is hosted for you. Site: [dorks.build](https://dorks.build).

> **Status: in transition.** The project is moving from a hosted-service design to a local-first, single-owner app (a macOS app that runs everything on your machine). Until that lands, you run it from source as described below. See [docs/env.md](docs/env.md) for configuration.

## How it works

- **Backend:** a [Convex](https://convex.dev) app (`apps/convex`) holds dorks, the transcript and the lifecycle state machine. It runs on the open-source self-hosted Convex backend.
- **Web:** a React app (`apps/web`) for chats and settings.
- **Sandboxes:** each dork is a Boat sandbox created from a base snapshot ([docs/boat.md](docs/boat.md)). Inside it, `dorks-bridge` (`infra/bridge`) runs the agent and talks to the backend.
- **Autonomy:** a dork opens PRs, subscribes to them and keeps fixing CI failures, review comments and conflicts ([docs/autonomy.md](docs/autonomy.md)).

The sandbox's bridge connects *out* to the backend, so a backend on your machine needs a public URL that Boat's cloud can reach.

## Run from source

Needs Node 24, pnpm (version pinned in `package.json`; `corepack enable`) and Docker.

```sh
pnpm install
pnpm env:init      # writes .env with generated secrets (git-ignored)
pnpm dev:backend   # self-hosted Convex in Docker, deploys apps/convex, pushes .env (rerun after backend changes)
pnpm dev:mail      # prints sign-in codes
pnpm dev:web       # web on http://localhost:3000
```

Or detached in one command: `pnpm dev:up` (`pnpm dev:status`, `pnpm dev:down`; logs in `/tmp/dorks-dev`).

By default `.env` uses `BOX_PROVIDER=sim`, a local simulator (`pnpm dev:sim`; `BRIDGE_IMPL=real pnpm dev:sim` runs the real bridge against a fake Claude CLI). For real sandboxes set `BOX_PROVIDER=boat`, `BOAT_API_KEY`, `BASE_SNAPSHOT_ID` and `DORKS_OWNER_EMAIL`; see [docs/boat.md](docs/boat.md).

### Running the real agent against the simulator

Set `E2E_CLAUDE_TOKEN` (a `claude setup-token` value) in your environment. The Claude CLI refuses `--permission-mode bypassPermissions` as root, so on a root-only machine run the sim host as an unprivileged user with a writable `HOME`, a writable `infra/bridge/dist` and `DORKS_E2E_ROOT` set to a directory it owns:

```sh
scripts/with-env.sh setpriv --reuid=1000 --regid=1000 --init-groups env -i PATH="$PATH" HOME=/tmp/u-home DORKS_E2E_ROOT=/tmp/u-e2e \
  CONVEX_URL=http://127.0.0.1:3210 SIM_HOST_KEY="$SIM_HOST_KEY" BRIDGE_SECRET_KEY="$BRIDGE_SECRET_KEY" BRIDGE_IMPL=real CLAUDE_BIN="$(command -v claude)" \
  node infra/bridge-sim/host.mjs
```

Bridge-level check without Convex: `CLAUDE_CODE_OAUTH_TOKEN=$E2E_CLAUDE_TOKEN pnpm --filter @dorks/bridge test live`, as that same user. `apps/convex/scripts/e2e.mjs` has one timing check ("mid-turn") that only holds for the simulator's slow streaming; with the real CLI treat it as a smoke test.

## Tests

`pnpm typecheck` and `pnpm test` run the Convex suite (lifecycle machine, normalizer, crypto, GitHub, functions via `convex-test`), the bridge suite and the shared client suite.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`, and needs no repository secrets (every key is generated per run), so it works on forks.

- **checks**: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm -r --if-present test`.
- **backend-e2e**: starts a self-hosted Convex backend (`ghcr.io/convex/convex-backend`, pinned by digest), deploys `apps/convex`, sets throwaway env vars, then runs `apps/convex/scripts/run-e2e.sh` (acceptance and secret scan) and `apps/convex/scripts/web-e2e.mjs` (headless Chrome against `apps/web`). On failure the logs and screenshots in `/tmp/dorks-e2e` are uploaded as an artifact.

Keep CI in step with the backend: a new required Convex env var must be added to the `set_env` list in the "Deploy functions and set throwaway env" step, using throwaway or sim values only, and a new workspace package must be in `pnpm-workspace.yaml` with its lockfile changes committed.

## License

[Apache-2.0](LICENSE).
