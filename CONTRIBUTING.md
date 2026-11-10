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
| `infra/bridge-sim` | Local sandbox simulator: runs one bridge process per simulated sandbox (`BOX_PROVIDER=sim`). |
| `scripts` | `dev.mjs` (the one-command dev loop) and `e2e.mjs` (the e2e runner). |

## Setup

Needs Node 24, pnpm (the version in `package.json`; `corepack enable`), and [Bun](https://bun.sh) to run the server. The desktop app also needs Rust (see [docs/desktop.md](docs/desktop.md)). No account or secret is needed to install, test or build.

```sh
pnpm install
```

## Dev loop

```sh
pnpm dev                 # real server with simulated sandboxes + web with HMR; prints the URL to open
pnpm dev:server          # only the server and the sandbox simulator
pnpm dev:web             # only the web app (http://localhost:3000)
pnpm dev:mock            # web plus an in-memory mock server, no real server needed
pnpm dev:desktop         # the Tauri app (builds the real server and web UI into it)
```

`pnpm dev` keeps its data in `.dev-data` (git-ignored); delete it for a clean start. It uses fixed, dev-only values for the owner token (`dev-owner-token`) and sandbox host key, so no secret or `.env` is needed. `BRIDGE_IMPL=real pnpm dev` runs the real in-box bridge with a fake Claude CLI instead of the sim bridge. Port `0` picks a free port (`DORKS_UI_PORT=0`). Every variable is in [docs/env.md](docs/env.md).

Outside `pnpm dev` the server's owner token is generated into `<data dir>/secrets.json`. To test against real Boat sandboxes you also need a tunnel URL in `DORKS_PUBLIC_URL` that forwards to the bridge port.

## Tests

```sh
pnpm typecheck                                   # every package
pnpm test                                        # every package that has tests
pnpm --filter @dorks/server test                 # the server (lifecycle, machine, bridge socket), in-memory SQLite
pnpm --filter @dorks/client test                 # client against a fake server
pnpm --filter @dorks/bridge test                 # the bridge
pnpm e2e:server                                  # builds the compiled server, runs its e2e twice (sim bridge, real bridge) incl. a secret scan; needs Bun
CHROME_PATH=<chrome> pnpm e2e:web                # builds the SPA, drives it in headless Chrome against the mock server
pnpm e2e                                         # both
```

Prefer tests that run the real code path over mocks: the server tests use the real lifecycle driver on an in-memory database.

CI (`.github/workflows/ci.yml`) runs typecheck and tests, the server e2e against the compiled binary, and the web e2e against the mock server; `desktop.yml` builds the macOS app. It needs no repository secrets, so it runs on forks. If you add an environment variable the e2e needs, set a throwaway value in the workflow.

## Rules

- Never print, log or commit secret values. Refer to variables by name; do not paste tokens into issues.
- Keep `docs/architecture.md` in step with API changes, and make them additive where you can: the web client, the bridge and the desktop shell all read it.
- Never put a secret behind a `VITE_` prefix.
- Branch from `main`. Small commits, with a message that says why.
