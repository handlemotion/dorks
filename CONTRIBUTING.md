# Contributing

Dorks is a local-first app. Read [docs/architecture.md](docs/architecture.md) first: it explains the pieces and the wire protocols, and it is the contract between the server, the web UI, the bridge and the desktop shell.

## Layout

| Path | What |
|---|---|
| `apps/server` | The local server: SQLite, lifecycle machine, timers, Boat driver, GitHub poller, UI API, bridge socket. Bun at runtime, tests run on Node. |
| `apps/web` | The UI, a static React SPA. |
| `apps/desktop` | Tauri 2 macOS shell that supervises the server. |
| `packages/client` | Typed client, live stream and React hooks for the UI API, plus an in-memory mock server. |
| `packages/shared` | Wire types shared by the server, bridge and clients (zod). |
| `packages/ui` | shadcn-style components used by the web app. |
| `infra/bridge` | The agent bridge that runs inside each Boat sandbox. |
| `infra/snapshot` | Installer for the Boat base snapshot. |
| `infra/bridge-sim` | Local sandbox simulator (see "Known stale pieces"). |
| `apps/convex` | The previous Convex backend. Being removed; do not extend it. |

## Setup

Needs Node 24, pnpm (the version in `package.json`; `corepack enable`), and [Bun](https://bun.sh) to run the server. The desktop app also needs Rust (see [docs/desktop.md](docs/desktop.md)). No account or secret is needed to install, test or build.

```sh
pnpm install
```

## Dev loop

```sh
pnpm --filter @dorks/server dev                  # server on 127.0.0.1:4747 (UI) and :4748 (bridge)
pnpm --filter @dorks/web dev                     # web on http://localhost:3000
pnpm --filter @dorks/web dev:mock                # web plus an in-memory mock server, no real server needed
pnpm --filter @dorks/desktop dev                 # the Tauri app with a stub sidecar
```

Use a throwaway data directory when you do not want to touch your real data: `DORKS_DATA_DIR=/tmp/dorks-dev pnpm --filter @dorks/server dev`. Port `0` picks a free port (`DORKS_UI_PORT=0`). Every variable is in [docs/env.md](docs/env.md).

The server's owner token is generated into `<data dir>/secrets.json`. To test against real Boat sandboxes you also need a tunnel URL in `DORKS_PUBLIC_URL` that forwards to the bridge port.

## Tests

```sh
pnpm typecheck                                   # every package
pnpm test                                        # every package that has tests
pnpm --filter @dorks/server test                 # the server (lifecycle, machine, bridge socket), in-memory SQLite
pnpm --filter @dorks/client test                 # client against a fake server
pnpm --filter @dorks/bridge test                 # the bridge
pnpm --filter @dorks/web build && CHROME_PATH=<chrome> pnpm --filter @dorks/web e2e   # browser run against the mock server
```

Prefer tests that run the real code path over mocks: the server tests use the real lifecycle driver on an in-memory database.

CI (`.github/workflows/ci.yml`) runs typecheck and tests, and the web e2e against the mock server. It needs no repository secrets, so it runs on forks. If you add an environment variable the e2e needs, set a throwaway value in the workflow.

## Rules

- Never print, log or commit secret values. Refer to variables by name; do not paste tokens into issues.
- Keep `docs/architecture.md` in step with API changes, and make them additive where you can: the web client, the bridge and the desktop shell all read it.
- Never put a secret behind a `VITE_` prefix.
- Branch from `main`. Small commits, with a message that says why.

## Known stale pieces

The Convex removal is in progress, so these still point at the old backend and do not work against `apps/server`: the root scripts `dev`, `dev:backend`, `dev:up`, `dev:status`, `dev:wait`, `dev:down`, `dev:sim`, `dev:mail`, `dev:convex`, `env:init`, `infra/bridge-sim`, and the `backend-e2e` CI job. Use the per-package commands above until they are replaced.
