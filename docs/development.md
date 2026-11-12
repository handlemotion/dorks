# Development

For working on a checkout (yours or a fork). The project does not take outside pull requests; see [CONTRIBUTING.md](../CONTRIBUTING.md).

Dorks is a local-first app. Read [docs/architecture.md](architecture.md) first: it explains the pieces and the wire protocols, and it is the contract between the server, the web UI, the bridge and the desktop shell.

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

Needs Node 24, pnpm (the version in `package.json`; `corepack enable`), and [Bun](https://bun.sh) to run the server. The desktop app also needs Rust (see [docs/desktop.md](desktop.md)). No account or secret is needed to install, test or build.

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

`pnpm dev` seeds missing settings with dummy credentials and prepares a simulated snapshot, so you can open the printed URL and create a chat immediately (`acme/demo`). Replies are simulated, including when the real bridge uses the fake Claude CLI; this does not call an AI provider or GitHub. The composer supports text, image attachments (the + button, paste or drop; Claude receives them as images), agent selection and, for Claude, the model and effort the agent reports (the fake CLI and the sim offer fake models).

`pnpm dev` keeps its data in `.dev-data` (git-ignored); delete it for a clean start. It uses fixed, dev-only values for the owner token (`dev-owner-token`) and sandbox host key, so no secret or `.env` is needed. `BRIDGE_IMPL=real pnpm dev` runs the real in-box bridge with a fake Claude CLI instead of the sim bridge. Port `0` picks a free port (`DORKS_UI_PORT=0`). Every variable is in [docs/env.md](env.md).

Outside `pnpm dev` the server's owner token is generated into `<data dir>/secrets.json`. To test against real Boat sandboxes you also need a tunnel URL in `DORKS_PUBLIC_URL` that forwards to the bridge port.

## Tests

```sh
pnpm check                                       # vp check: format check + Oxlint (`complexity` is an error); config in the root vite.config.ts
pnpm typecheck                                   # every package
pnpm test                                        # every package that has tests
pnpm --filter @dorks/server test                 # the server (lifecycle, machine, bridge socket), in-memory SQLite
pnpm --filter @dorks/client test                 # the live-feed client logic (SSE, tailing, optimistic send)
pnpm --filter @dorks/bridge test                 # the bridge
pnpm e2e                                         # builds the compiled server, runs its e2e twice (sim bridge, real bridge) incl. a secret scan; needs Bun
```

The JS toolchain is [Vite+](https://viteplus.dev) (`vite-plus`, the `vp` CLI): `vp dev` / `vp build` for the web app, `vp test` (Vitest) for every package's tests, `vp lint` / `vp check` for linting. Import test helpers from `vite-plus/test` and config helpers from `vite-plus`, not `vitest` or `vite` (a lint rule enforces it). `vp fmt` is set to the house style but not enforced yet. Its version is pinned once in the `catalog` in `pnpm-workspace.yaml`.

Prefer tests that run the real code path over mocks: the server tests use the real lifecycle driver on an in-memory database.

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests and the server e2e against the compiled binary; `desktop.yml` builds the macOS app. It needs no repository secrets, so it runs on forks. If you add an environment variable the e2e needs, set a throwaway value in the workflow.

## Server code: Effect on Hono

The server is moving to [Effect](https://effect.website) (v4). New server code is written in Effect, and code you rework moves over:

- **HTTP**: Hono stays the HTTP layer (routing, CORS, owner-token auth, SSE). Each UI API route is an Effect program
  (`apps/server/src/http/route.ts`): it decodes its body with `Schema`, calls services through `AppEnv`, and fails with a typed
  `ApiError` that becomes the `{ error: { code, message } }` answer. A service's `AppFail` maps to `ApiError`; anything else is a
  defect, logged and answered with a generic 500.
- **Boat driver** (`lib/boatHttp.ts`, `lib/boat.ts`, `lib/boatSnapshots.ts`): one `BoatError`, schema-decoded responses, and shared
  `pollUntil` / `retryWhile` loops. The drivers keep their Promise interfaces (`core/box.ts`, `core/snapshot.ts`) by running the
  effects at that edge.
- **Scheduler** (`lifecycle/scheduler.ts`): the timer loop is one fiber woken by a `Latch`; jobs run as fibers in a `FiberSet`.

`Effect.runPromise` rejects with the original error, so `instanceof` checks on `BoatError` and `BoxNotFoundError` keep working
across the edge.

## Rules

- Never print, log or commit secret values. Refer to variables by name; do not paste tokens into issues.
- Keep `docs/architecture.md` in step with API changes, and make them additive where you can: the web client, the bridge and the desktop shell all read it.
- Never put a secret behind a `VITE_` prefix.
- Branch from `main`. Small commits, with a message that says why.
- Keep functions under Oxlint's `complexity` limit (20, `pnpm lint`): split branchy code into named helpers or handler maps rather than disabling the rule.

## Real Claude, no Boat or tunnel

To see real Claude Code work through the whole stack without a Boat account or a tunnel, run the real bridge locally with the real CLI:

```sh
BRIDGE_IMPL=real CLAUDE_BIN="$(command -v claude)" DORKS_E2E_ROOT=/tmp/de pnpm dev
```

Then put a real `claudeToken` in place of the dummy one with `PUT /api/settings` (from a script, never echoed). Repos come from a local
git remote (`acme/demo`), so pushes stay on this machine and `gh` is not signed in. Keep `DORKS_E2E_ROOT` short: the bridge's unix socket
lives under it and the path limit is about 108 characters. As root (a CI or cloud container), the CLI refuses `bypassPermissions`: create
an unprivileged user and add `CLAUDE_RUN_AS=<user>`, which the sim host passes to the bridge (privilege separation, as in
[infra/bridge/README.md](../infra/bridge/README.md)).

## Live chat from the web UI

Doppler is optional: account credentials are encrypted settings, not environment variables. For a live run, start the server
outside `pnpm dev` (which always selects the simulator):

```sh
DORKS_DATA_DIR="$PWD/.context/live-data" DORKS_UI_PORT=4747 DORKS_BRIDGE_PORT=4748 DORKS_PUBLIC_URL=https://your-tunnel.example bun run apps/server/src/main.ts
pnpm dev:web
```

Forward the tunnel to **4748**, the bridge listener. Open `http://localhost:3000` and connect to `http://127.0.0.1:4747` using
the owner token from `.context/live-data/secrets.json` (read it privately; never paste it in chat or logs). Complete onboarding:

- Boat API key (and organization id if needed), with snapshot/sandbox permissions; see [Boat](boat.md). Saving it builds the base snapshot.
- Claude token from `claude setup-token`, or a configured Boat ChatGPT environment for Codex.
- GitHub token with access to the test repository; see [GitHub](github.md).

Wait for Prepare Boat to finish, choose a real `owner/repo`, and send a small task. Check that text streams, a follow-up gets a
reply, Stop interrupts, reload preserves the transcript, and a message after idle sleep wakes the sandbox. Tokens from a Doppler
project/config can be submitted to `PUT /api/settings` by a local script without printing them; Dorks does not read Doppler token
variables itself. Deployment credentials are optional and go in Settings → Secrets only if the task needs them.
